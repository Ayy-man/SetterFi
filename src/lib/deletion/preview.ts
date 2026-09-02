/**
 * Tenant-bound deletion previews backed by the database preview RPC.
 *
 * The RPC owns authorization and its short-lived UUID. This layer adds a non-PII cascade digest,
 * so counts changing after preview force a fresh operator review before the destructive RPC runs.
 */

import { createHash } from "node:crypto";

import { createSupabaseServiceClient } from "@/lib/supabase/server";

import type {
  DeletionCascadeCounts,
  DeletionPreview,
  DeletionPreviewTokenClaims,
  DeletionProviderEffect,
  DeletionSnapshot,
} from "./contracts";

const PREVIEW_TTL_MS = 15 * 60_000;

type PreviewRpcResult = {
  previewToken: string;
  auditId: number;
  conversations: number;
  appointments: number;
  identities: number;
  mergedContacts: number;
  contactNotes: number;
  unmatchedObjections: number;
  mergeAuditsRedacted: number;
  snapshotDigest: string;
  providerTargetDigest: string;
};

export type DeletionPreviewDependencies = {
  previewRpc(input: {
    expectedTenantId: string;
    contactId: string;
    actorId: string;
  }): Promise<PreviewRpcResult>;
  loadSnapshot(tenantId: string, contactId: string): Promise<DeletionSnapshot>;
  now(): Date;
};

export class DeletionPreviewError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DeletionPreviewError";
  }
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new DeletionPreviewError(code);
  return normalized;
}

export function normalizeDeletionReason(reason: string) {
  return required(reason, "CONTACT_DELETE_REASON_REQUIRED");
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseRpcResult(value: unknown): PreviewRpcResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeletionPreviewError("DELETION_PREVIEW_RPC_INVALID");
  }
  const row = value as Record<string, unknown>;
  const conversations = count(row.conversations);
  const appointments = count(row.appointments);
  const identities = count(row.identities);
  const mergedContacts = count(row.mergedContacts);
  const contactNotes = count(row.contactNotes);
  const unmatchedObjections = count(row.unmatchedObjections);
  const mergeAuditsRedacted = count(row.mergeAuditsRedacted);
  const snapshotDigest = typeof row.snapshotDigest === "string" ? row.snapshotDigest : null;
  const providerTargetDigest = typeof row.providerTargetDigest === "string"
    ? row.providerTargetDigest
    : null;
  if (typeof row.previewToken !== "string" || typeof row.auditId !== "number" ||
    conversations === null || appointments === null || identities === null ||
    mergedContacts === null || contactNotes === null || unmatchedObjections === null ||
    mergeAuditsRedacted === null ||
    !snapshotDigest?.match(/^[0-9a-f]{64}$/) || !providerTargetDigest?.match(/^[0-9a-f]{64}$/)) {
    throw new DeletionPreviewError("DELETION_PREVIEW_RPC_INVALID");
  }
  return {
    previewToken: row.previewToken,
    auditId: row.auditId,
    conversations,
    appointments,
    identities,
    mergedContacts,
    contactNotes,
    unmatchedObjections,
    mergeAuditsRedacted,
    snapshotDigest,
    providerTargetDigest,
  };
}

function fromRpcData(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") throw new DeletionPreviewError("DELETION_PREVIEW_RPC_INVALID");
  const source = row as Record<string, unknown>;
  return parseRpcResult({
    previewToken: source.previewToken ?? source.preview_token,
    auditId: source.auditId ?? source.audit_id,
    conversations: source.conversations,
    appointments: source.appointments,
    identities: source.identities,
    mergedContacts: source.mergedContacts ?? source.merged_contacts,
    contactNotes: source.contactNotes ?? source.contact_notes,
    unmatchedObjections: source.unmatchedObjections ?? source.unmatched_objections,
    mergeAuditsRedacted: source.mergeAuditsRedacted ?? source.merge_audits_redacted,
    snapshotDigest: source.snapshotDigest ?? source.snapshot_digest,
    providerTargetDigest: source.providerTargetDigest ?? source.provider_target_digest,
  });
}

function providerEffects(snapshot: DeletionSnapshot): DeletionProviderEffect[] {
  const ghlTargets = new Set(
    snapshot.identities
      .filter((identity) => identity.provider === "ghl" && identity.providerContactId)
      .map((identity) => identity.providerContactId),
  );
  const effects: DeletionProviderEffect[] = [];
  if (ghlTargets.size > 0) {
    effects.push({
      kind: "provider_contact_delete",
      provider: "ghl",
      state: "pending",
      targetCount: ghlTargets.size,
      label: "Connected contact provider",
    });
  }
  if (snapshot.identities.some((identity) => identity.provider === "meta_direct")) {
    effects.push({
      kind: "thread_scope_limitation",
      provider: "meta",
      state: "outside_setterfi_scope",
      label: "Connected social inbox",
      explanation: "Messages in the connected social inbox remain outside SetterFi deletion.",
    });
  }
  return effects;
}

export function deletionCountsDigest(snapshot: Pick<DeletionSnapshot, "counts" | "revision">) {
  const orderedCounts = Object.keys(snapshot.counts)
    .sort()
    .map((key) => [key, snapshot.counts[key as keyof DeletionCascadeCounts]]);
  return createHash("sha256")
    .update(JSON.stringify({ counts: orderedCounts, revision: snapshot.revision }), "utf8")
    .digest("hex");
}

function encodeClaims(claims: DeletionPreviewTokenClaims) {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

export function decodeDeletionPreviewToken(token: string): DeletionPreviewTokenClaims {
  let parsed: unknown;
  try {
    const text = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(text, "utf8").toString("base64url") !== token) {
      throw new Error("non-canonical");
    }
    parsed = JSON.parse(text);
  } catch {
    throw new DeletionPreviewError("DELETION_PREVIEW_TOKEN_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DeletionPreviewError("DELETION_PREVIEW_TOKEN_INVALID");
  }
  const claims = parsed as Record<string, unknown>;
  const exactKeys = [
    "actorId", "contactId", "countsDigest", "expiresAt", "issuedAt", "providerTargetDigest",
    "reasonRequired", "rpcToken", "tenantId", "version",
  ];
  if (JSON.stringify(Object.keys(claims).sort()) !== JSON.stringify(exactKeys) ||
    claims.version !== 1 || claims.reasonRequired !== true ||
    !["tenantId", "contactId", "actorId", "rpcToken", "countsDigest", "providerTargetDigest", "issuedAt", "expiresAt"]
      .every((key) => typeof claims[key] === "string" && (claims[key] as string).length > 0)) {
    throw new DeletionPreviewError("DELETION_PREVIEW_TOKEN_INVALID");
  }
  return claims as DeletionPreviewTokenClaims;
}

async function liveDependencies(): Promise<DeletionPreviewDependencies> {
  const client = createSupabaseServiceClient();
  return {
    previewRpc: async ({ expectedTenantId, contactId, actorId }) => {
      const { data, error } = await client.rpc("preview_contact_deletion", {
        p_expected_tenant: expectedTenantId,
        p_contact_id: contactId,
        p_actor_id: actorId,
      });
      if (error) throw new DeletionPreviewError("DELETION_PREVIEW_RPC_FAILED");
      return fromRpcData(data);
    },
    loadSnapshot: loadDeletionSnapshot,
    now: () => new Date(),
  };
}

export async function loadDeletionSnapshot(
  tenantId: string,
  contactId: string,
): Promise<DeletionSnapshot> {
  const client = createSupabaseServiceClient();
  const [contactResult, mergedResult, metadataResult] = await Promise.all([
    client.from("contacts").select("id, tenant_id, merged_into_contact_id")
      .eq("tenant_id", tenantId).eq("id", contactId).maybeSingle(),
    client.from("contacts").select("id").eq("tenant_id", tenantId)
      .eq("merged_into_contact_id", contactId),
    client.rpc("get_contact_deletion_cluster_metadata", {
      p_expected_tenant: tenantId,
      p_contact_id: contactId,
    }),
  ]);
  if (contactResult.error || !contactResult.data || mergedResult.error ||
    metadataResult.error || contactResult.data.merged_into_contact_id !== null) {
    throw new DeletionPreviewError("DELETION_PREVIEW_READ_FAILED");
  }
  const contactIds = [String(contactResult.data.id),
    ...(mergedResult.data ?? []).map((row) => String(row.id))].sort();
  const metadata = (Array.isArray(metadataResult.data) ? metadataResult.data[0] : metadataResult.data) as
    Record<string, unknown> | null;
  const rawMetadataContactIds = metadata?.contactIds ?? metadata?.contact_ids;
  const metadataContactIds = Array.isArray(rawMetadataContactIds)
    ? rawMetadataContactIds.map(String).sort()
    : null;
  const mergeAuditsRedacted = count(metadata?.mergeAuditsRedacted ?? metadata?.merge_audits_redacted);
  if (!metadataContactIds || JSON.stringify(metadataContactIds) !== JSON.stringify(contactIds) ||
    mergeAuditsRedacted === null) {
    throw new DeletionPreviewError("DELETION_PREVIEW_CLUSTER_METADATA_INVALID");
  }
  const clusterList = `(${contactIds.join(",")})`;
  const [conversationResult, appointmentResult, identityResult, noteResult] =
    await Promise.all([
      client.from("conversations").select("id").eq("tenant_id", tenantId).in("contact_id", contactIds),
      client.from("appointments").select("id").eq("tenant_id", tenantId).in("contact_id", contactIds),
      client.from("contact_identities")
        .select("id, channel, provider, provider_identity_id, provider_account_id, ghl_install_id, normalized_phone, normalized_email")
        .eq("tenant_id", tenantId).in("contact_id", contactIds),
      client.from("contact_notes").select("id, updated_at").eq("tenant_id", tenantId)
        .in("contact_id", contactIds),
    ]);
  if (conversationResult.error || appointmentResult.error || identityResult.error ||
    noteResult.error) {
    throw new DeletionPreviewError("DELETION_PREVIEW_READ_FAILED");
  }
  const conversationIds = (conversationResult.data ?? []).map((row) => String(row.id));
  const appointmentIds = (appointmentResult.data ?? []).map((row) => String(row.id));
  const [messageResult, followupResult, evalResult, billableResult] = await Promise.all([
    conversationIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client.from("messages").select("id").eq("tenant_id", tenantId).in("conversation_id", conversationIds),
    conversationIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client.from("followups").select("id").eq("tenant_id", tenantId)
          .in("conversation_id", conversationIds),
    client.from("eval_cases").select("id")
      .or(`source_contact_id.in.${clusterList}${conversationIds.length > 0 ? `,source_conversation_id.in.(${conversationIds.join(",")})` : ""}`),
    appointmentIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client.from("billable_events").select("id, quantity, appointment_id")
          .eq("tenant_id", tenantId).in("appointment_id", appointmentIds),
  ]);
  if (messageResult.error || followupResult.error || evalResult.error || billableResult.error) {
    throw new DeletionPreviewError("DELETION_PREVIEW_READ_FAILED");
  }
  const messageIds = (messageResult.data ?? []).map((row) => String(row.id));
  const [traceResult, unmatchedResult] = await Promise.all([
    messageIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client.from("message_traces").select("message_id, trace")
          .in("message_id", messageIds),
    conversationIds.length === 0 && messageIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client.from("unmatched_objections").select("id, updated_at")
          .or(`${conversationIds.length > 0 ? `conversation_id.in.(${conversationIds.join(",")})` : ""}${conversationIds.length > 0 && messageIds.length > 0 ? "," : ""}${messageIds.length > 0 ? `message_id.in.(${messageIds.join(",")})` : ""}`),
  ]);
  if (traceResult.error || unmatchedResult.error) {
    throw new DeletionPreviewError("DELETION_PREVIEW_READ_FAILED");
  }

  const identities = (identityResult.data ?? []).map((row) => {
    const normalizedIdentifier = typeof row.normalized_phone === "string"
      ? row.normalized_phone
      : typeof row.normalized_email === "string"
        ? row.normalized_email
        : String(row.provider_identity_id);
    const providerAccountId = typeof row.provider_account_id === "string"
      ? row.provider_account_id.trim() : null;
    const ghlInstallId = typeof row.ghl_install_id === "string" ? row.ghl_install_id : null;
    if (row.provider === "ghl" && (!providerAccountId || !ghlInstallId)) {
      throw new DeletionPreviewError("GHL_IDENTITY_ACCOUNT_REMEDIATION_REQUIRED");
    }
    return {
      id: String(row.id),
      channel: row.channel,
      provider: row.provider,
      normalizedIdentifier,
      identifierLast4: normalizedIdentifier.slice(-4) || null,
      providerContactId: row.provider === "ghl" ? String(row.provider_identity_id) : null,
      providerAccountId: row.provider === "ghl" ? providerAccountId : null,
      ghlInstallId: row.provider === "ghl" ? ghlInstallId : null,
    };
  });
  const billableEvents = (billableResult.data ?? []).map((row) => ({
    id: String(row.id),
    quantity: Number(row.quantity),
    appointmentId: String(row.appointment_id),
  }));
  const revision = createHash("sha256").update(JSON.stringify({
    contacts: contactIds,
    conversations: conversationIds.sort(),
    appointments: appointmentIds.sort(),
    identities: identities.map((row) =>
      `${row.id}:${row.channel}:${row.provider}:${row.providerAccountId ?? ""}:${row.ghlInstallId ?? ""}`
    ).sort(),
    contactNotes: (noteResult.data ?? []).map((row) => `${row.id}:${row.updated_at}`).sort(),
    followups: (followupResult.data ?? []).map((row) => String(row.id)).sort(),
    messages: messageIds.sort(),
    messageTraces: (traceResult.data ?? []).map((row) => JSON.stringify(row)).sort(),
    unmatchedObjections: (unmatchedResult.data ?? []).map((row) => `${row.id}:${row.updated_at}`).sort(),
    mergeAuditsRedacted,
    evalCases: (evalResult.data ?? []).map((row) => String(row.id)).sort(),
    billableEvents: billableEvents.map((row) => row.id).sort(),
  }), "utf8").digest("hex");
  return {
    tenantId: String(contactResult.data.tenant_id),
    contactId: String(contactResult.data.id),
    contactIds,
    revision,
    counts: {
      mergedContacts: contactIds.length - 1,
      identities: identities.length,
      contactNotes: noteResult.data?.length ?? 0,
      conversations: conversationIds.length,
      messages: messageIds.length,
      messageTraces: traceResult.data?.length ?? 0,
      followups: followupResult.data?.length ?? 0,
      appointments: appointmentIds.length,
      unmatchedObjections: unmatchedResult.data?.length ?? 0,
      mergeAuditsRedacted,
      billableEventsDetached: billableEvents.length,
      evalCasesSevered: evalResult.data?.length ?? 0,
    },
    identities,
    billableEvents,
    evalCaseIds: (evalResult.data ?? []).map((row) => String(row.id)),
  };
}

export async function previewLeadDeletion(
  input: { tenantId: string; contactId: string; actorId: string },
  dependencies?: DeletionPreviewDependencies,
): Promise<DeletionPreview> {
  const tenantId = required(input.tenantId, "EXPECTED_TENANT_REQUIRED");
  const contactId = required(input.contactId, "CONTACT_ID_REQUIRED");
  const actorId = required(input.actorId, "ACTOR_ID_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  const rpc = parseRpcResult(await deps.previewRpc({ expectedTenantId: tenantId, contactId, actorId }));
  const snapshot = await deps.loadSnapshot(tenantId, contactId);
  if (snapshot.tenantId !== tenantId || snapshot.contactId !== contactId) {
    throw new DeletionPreviewError("DELETION_PREVIEW_SCOPE_MISMATCH");
  }
  if (rpc.conversations !== snapshot.counts.conversations ||
    rpc.appointments !== snapshot.counts.appointments || rpc.identities !== snapshot.counts.identities ||
    rpc.mergedContacts !== snapshot.counts.mergedContacts ||
    rpc.contactNotes !== snapshot.counts.contactNotes ||
    rpc.unmatchedObjections !== snapshot.counts.unmatchedObjections ||
    rpc.mergeAuditsRedacted !== snapshot.counts.mergeAuditsRedacted) {
    throw new DeletionPreviewError("DELETION_PREVIEW_COUNTS_CHANGED");
  }
  const issuedAt = deps.now();
  const claims: DeletionPreviewTokenClaims = {
    version: 1,
    tenantId,
    contactId,
    actorId,
    rpcToken: rpc.previewToken,
    countsDigest: rpc.snapshotDigest,
    providerTargetDigest: rpc.providerTargetDigest,
    reasonRequired: true,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + PREVIEW_TTL_MS).toISOString(),
  };
  return {
    tenantId,
    contactId,
    actorId,
    token: encodeClaims(claims),
    expiresAt: claims.expiresAt,
    reasonRequired: true,
    counts: snapshot.counts,
    providerEffects: providerEffects(snapshot),
    receipt: {
      actionKey: "contact.delete.preview",
      auditId: rpc.auditId,
      previewedAt: claims.issuedAt,
    },
  };
}
