/**
 * Provider-first orchestration for immediate contact deletion.
 *
 * A provider read-absent receipt is required before the one local RPC. Retry receipts contain no
 * identity values and can skip a repeated provider mutation while still re-reading absence.
 */

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { contactDeleteLive, type EnvironmentSource } from "@/lib/env-contract";
import type {
  DeletionMutationReceipt,
  DeletionProviderInput,
  DeletionProviderPort,
} from "@/lib/sends/contracts";
import { hashSuppressionIdentifier } from "@/lib/suppression/identifier-hash";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import type {
  DeleteLeadResult,
  DeletionIntent,
  DeletionProviderEvidence,
  DeletionReadback,
  DeletionRetryReceipt,
  DeletionSnapshot,
} from "./contracts";
import { createLiveGhlDeletionProviderPort } from "./ghl-provider";
import {
  decodeDeletionPreviewToken,
  loadDeletionSnapshot,
  normalizeDeletionReason,
} from "./preview";

type DeleteRpcRow = { deleted: boolean; audit_id: number };
type CompletedDeletion = {
  auditId: number;
  tombstoneCount: number;
  providerEvidence: DeletionProviderEvidence;
};
type ProviderTarget = {
  providerContactId: string;
  providerAccountId: string;
  ghlInstallId: string;
};

export type DeleteLeadInput = {
  tenantId: string;
  contactId: string;
  actorId: string;
  reason: string;
  previewToken: string;
  idempotencyKey: string;
  retry?: DeletionRetryReceipt | null;
};

export type DeleteLeadDependencies = {
  liveEnabled: boolean;
  loadSnapshot(tenantId: string, contactId: string): Promise<DeletionSnapshot>;
  loadCompleted(input: {
    tenantId: string;
    contactId: string;
    idempotencyDigest: string;
  }): Promise<CompletedDeletion | null>;
  beginIntent(input: {
    tenantId: string;
    contactId: string;
    actorId: string;
    reason: string;
    previewToken: string;
    leaseToken: string;
    idempotencyDigest: string;
    snapshotDigest: string;
    providerTargetDigest: string;
  }): Promise<DeletionIntent>;
  renewIntent(input: { tenantId: string; intentId: string; leaseToken: string }): Promise<void>;
  releaseIntent(input: { tenantId: string; intentId: string; leaseToken: string }): Promise<void>;
  checkpointIntent(input: {
    tenantId: string;
    actorId: string;
    intentId: string;
    leaseToken: string;
    providerEvidence: DeletionProviderEvidence;
  }): Promise<DeletionIntent>;
  provider: DeletionProviderPort;
  deleteRpc(args: Record<string, unknown>): Promise<DeleteRpcRow>;
  loadReadback(input: {
    tenantId: string;
    contactId: string;
    contactIds: readonly string[];
    auditId: number;
    tombstoneHashes: readonly string[];
    evalCaseIds: readonly string[];
    billableEventIds: readonly string[];
  }): Promise<DeletionReadback>;
  hashIdentifier(normalizedIdentifier: string): string;
  now(): Date;
};

export class DeleteLeadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DeleteLeadError";
  }
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new DeleteLeadError(code);
  return normalized;
}

function idempotencyDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function targetFrame(target: ProviderTarget) {
  return [target.providerAccountId, target.ghlInstallId, target.providerContactId]
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
}

function providerTargetDigest(targets: readonly ProviderTarget[]) {
  const framed = targets.map(targetFrame)
    .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
    .join("");
  return createHash("sha256").update(framed, "utf8").digest("hex");
}

function parseDeletionIntent(value: unknown): DeletionIntent {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new DeleteLeadError("CONTACT_DELETE_INTENT_INVALID");
  }
  const source = row as Record<string, unknown>;
  const id = source.intentId ?? source.intent_id ?? source.id;
  const status = source.status;
  const providerEvidence = providerEvidenceFromPayload(
    source.providerEvidence ?? source.provider_evidence ?? null,
  );
  if (typeof id !== "string" ||
    (status !== "claimed" && status !== "provider_confirmed" && status !== "completed") ||
    (status !== "claimed" && !providerEvidence)) {
    throw new DeleteLeadError("CONTACT_DELETE_INTENT_INVALID");
  }
  return { id, status, providerEvidence };
}

function parseDeleteRpc(value: unknown): DeleteRpcRow {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") throw new DeleteLeadError("CONTACT_DELETE_RPC_INVALID");
  const result = row as Record<string, unknown>;
  if (typeof result.deleted !== "boolean" || typeof result.audit_id !== "number") {
    throw new DeleteLeadError("CONTACT_DELETE_RPC_INVALID");
  }
  return { deleted: result.deleted, audit_id: result.audit_id };
}

function providerTargets(snapshot: DeletionSnapshot) {
  const targets = new Map<string, ProviderTarget>();
  for (const identity of snapshot.identities) {
    if (identity.provider !== "ghl" || !identity.providerContactId) continue;
    if (!identity.providerAccountId || !identity.ghlInstallId) {
      throw new DeleteLeadError("GHL_IDENTITY_ACCOUNT_REMEDIATION_REQUIRED");
    }
    const target = {
      providerContactId: identity.providerContactId,
      providerAccountId: identity.providerAccountId,
      ghlInstallId: identity.ghlInstallId,
    };
    targets.set(targetFrame(target), target);
  }
  return [...targets.entries()].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  )
    .map(([, target]) => target);
}

function providerInput(
  input: { tenantId: string; contactId: string; idempotencyKey: string },
  target: ProviderTarget,
  index: number,
): DeletionProviderInput {
  return {
    tenantId: input.tenantId,
    contactId: input.contactId,
    ...target,
    idempotencyKey: `${input.idempotencyKey}:provider:${index}`,
  };
}

function retryReceipt(input: {
  tenantId: string;
  contactId: string;
  idempotencyDigest: string;
  providerDeleteReceipts: DeletionMutationReceipt[];
  providerEvidence: DeletionProviderEvidence | null;
}): DeletionRetryReceipt {
  return { version: 1, ...input };
}

function validRetry(
  retry: DeletionRetryReceipt | null | undefined,
  expected: { tenantId: string; contactId: string; idempotencyDigest: string },
) {
  if (!retry) return null;
  if (retry.version !== 1 || retry.tenantId !== expected.tenantId ||
    retry.contactId !== expected.contactId || retry.idempotencyDigest !== expected.idempotencyDigest) {
    throw new DeleteLeadError("CONTACT_DELETE_RETRY_INVALID");
  }
  return retry;
}

function auditPayloadIsPrivate(snapshot: DeletionSnapshot, payload: unknown) {
  const serialized = JSON.stringify(payload);
  return snapshot.identities.every((identity) =>
    !serialized.includes(identity.normalizedIdentifier) &&
    (!identity.providerContactId || !serialized.includes(identity.providerContactId))
    && (!identity.providerAccountId || !serialized.includes(identity.providerAccountId))
    && (!identity.ghlInstallId || !serialized.includes(identity.ghlInstallId))
  );
}

function assertReadback(
  readback: DeletionReadback,
  input: {
    tenantId: string;
    contactId: string;
    reason: string;
    auditId: number;
    snapshot: DeletionSnapshot;
    tombstones: readonly { channel: string; hash: string; last4: string | null }[];
    providerReceipt: Readonly<Record<string, unknown>>;
  },
) {
  if (!readback.contactAbsent || !readback.audit || readback.audit.id !== input.auditId ||
    readback.audit.tenantId !== input.tenantId || readback.audit.action !== "contact.delete" ||
    readback.audit.targetId !== input.contactId || readback.audit.reason !== input.reason) {
    throw new DeleteLeadError("CONTACT_DELETE_READBACK_INVALID");
  }
  if (!auditPayloadIsPrivate(input.snapshot, readback.audit.payload)) {
    throw new DeleteLeadError("CONTACT_DELETE_PRIVATE_DATA_LEAK");
  }
  if (!isDeepStrictEqual(readback.audit.payload.provider_receipt, input.providerReceipt)) {
    throw new DeleteLeadError("CONTACT_DELETE_PROVIDER_EVIDENCE_READBACK_INVALID");
  }
  const expectedTombstones = input.tombstones
    .map((row) => `${row.channel}:${row.hash}:${row.last4 ?? ""}:${input.auditId}`).sort();
  const actualTombstones = readback.tombstones
    .map((row) => {
      if (row.tenantId !== input.tenantId) throw new DeleteLeadError("CONTACT_DELETE_READBACK_INVALID");
      return `${row.channel}:${row.identifierHash}:${row.identifierLast4 ?? ""}:${row.deletionAuditId}`;
    }).sort();
  if (JSON.stringify(actualTombstones) !== JSON.stringify(expectedTombstones)) {
    throw new DeleteLeadError("CONTACT_DELETE_TOMBSTONE_READBACK_INVALID");
  }
  if (readback.evalCases.length !== input.snapshot.evalCaseIds.length ||
    readback.evalCases.some((row) => row.sourceTenantId !== null ||
      row.sourceConversationId !== null || row.sourceMessageId !== null ||
      row.sourceContactId !== null || !row.provenanceSevered || !row.quarantined)) {
    throw new DeleteLeadError("CONTACT_DELETE_PROVENANCE_READBACK_INVALID");
  }
  const expectedBillable = input.snapshot.billableEvents
    .map((row) => `${row.id}:${row.quantity}`).sort();
  const actualBillable = readback.billableEvents.map((row) => {
    if (row.appointmentId !== null || row.appointmentDetachedAt === null) {
      throw new DeleteLeadError("CONTACT_DELETE_BILLING_READBACK_INVALID");
    }
    return `${row.id}:${row.quantity}`;
  }).sort();
  if (JSON.stringify(actualBillable) !== JSON.stringify(expectedBillable)) {
    throw new DeleteLeadError("CONTACT_DELETE_BILLING_READBACK_INVALID");
  }
}

export function createMockDeletionProviderPort(): DeletionProviderPort {
  return {
    deleteContact: async (input) => ({
      providerOperationId: createHash("sha256")
        .update(`${input.contactId}:${input.idempotencyKey}`, "utf8").digest("hex").slice(0, 24),
      acceptedAt: new Date(0).toISOString(),
    }),
    readAbsent: async (input) => ({
      providerOperationId: createHash("sha256")
        .update(`${input.contactId}:${input.idempotencyKey}`, "utf8").digest("hex").slice(0, 24),
      absent: true,
      observedAt: new Date(0).toISOString(),
    }),
  };
}

function providerEvidenceFromPayload(value: unknown): DeletionProviderEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.kind === "not_applicable") return { kind: "not_applicable" };
  if (row.kind !== "confirmed_absent" || !Array.isArray(row.receipts)) return null;
  const receipts = row.receipts.flatMap((receipt) => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return [];
    const item = receipt as Record<string, unknown>;
    return typeof item.providerOperationId === "string" && typeof item.acceptedAt === "string" &&
      typeof item.observedAt === "string"
      ? [{
          providerOperationId: item.providerOperationId,
          acceptedAt: item.acceptedAt,
          observedAt: item.observedAt,
        }]
      : [];
  });
  return receipts.length === row.receipts.length ? { kind: "confirmed_absent", receipts } : null;
}

async function liveDependencies(environment: EnvironmentSource): Promise<DeleteLeadDependencies> {
  const client = createSupabaseServiceClient();
  return {
    liveEnabled: contactDeleteLive(environment),
    loadSnapshot: loadDeletionSnapshot,
    loadCompleted: async ({ tenantId, contactId, idempotencyDigest: expectedDigest }) => {
      const { data: audit, error: auditError } = await client.from("audit_log")
        .select("id, payload").eq("tenant_id", tenantId).eq("action", "contact.delete")
        .eq("target_type", "contact").eq("target_id", contactId)
        .order("id", { ascending: false }).limit(1).maybeSingle();
      if (auditError) throw new DeleteLeadError("CONTACT_DELETE_COMPLETION_READ_FAILED");
      if (!audit) return null;
      const payload = audit.payload as Record<string, unknown> | null;
      const providerReceipt = payload?.provider_receipt;
      if (!providerReceipt || typeof providerReceipt !== "object" || Array.isArray(providerReceipt)) {
        throw new DeleteLeadError("CONTACT_DELETE_COMPLETION_INVALID");
      }
      const receipt = providerReceipt as Record<string, unknown>;
      if (receipt.idempotencyDigest !== expectedDigest) {
        throw new DeleteLeadError("IDEMPOTENCY_PAYLOAD_MISMATCH");
      }
      const providerEvidence = providerEvidenceFromPayload(receipt.providerEvidence);
      if (!providerEvidence) throw new DeleteLeadError("CONTACT_DELETE_COMPLETION_INVALID");
      const { count, error } = await client.from("suppression_tombstones")
        .select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)
        .eq("deletion_audit_id", Number(audit.id));
      if (error || count === null) throw new DeleteLeadError("CONTACT_DELETE_COMPLETION_READ_FAILED");
      return { auditId: Number(audit.id), tombstoneCount: count, providerEvidence };
    },
    beginIntent: async (input) => {
      const { data, error } = await client.rpc("begin_contact_deletion_intent", {
        p_expected_tenant: input.tenantId,
        p_contact_id: input.contactId,
        p_actor_id: input.actorId,
        p_reason: input.reason,
        p_preview_token: input.previewToken,
        p_lease_token: input.leaseToken,
        p_idempotency_digest: input.idempotencyDigest,
        p_snapshot_digest: input.snapshotDigest,
        p_provider_target_digest: input.providerTargetDigest,
      });
      if (error) throw new DeleteLeadError("CONTACT_DELETE_INTENT_BEGIN_FAILED");
      return parseDeletionIntent(data);
    },
    renewIntent: async (input) => {
      const { error } = await client.rpc("renew_contact_deletion_lease", {
        p_expected_tenant: input.tenantId,
        p_intent_id: input.intentId,
        p_lease_token: input.leaseToken,
      });
      if (error) throw new DeleteLeadError("CONTACT_DELETE_LEASE_LOST");
    },
    releaseIntent: async (input) => {
      const { error } = await client.rpc("release_contact_deletion_lease", {
        p_expected_tenant: input.tenantId,
        p_intent_id: input.intentId,
        p_lease_token: input.leaseToken,
      });
      if (error) throw new DeleteLeadError("CONTACT_DELETE_LEASE_RELEASE_FAILED");
    },
    checkpointIntent: async (input) => {
      const { data, error } = await client.rpc("checkpoint_contact_deletion_provider", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_intent_id: input.intentId,
        p_lease_token: input.leaseToken,
        p_provider_evidence: input.providerEvidence,
      });
      if (error) throw new DeleteLeadError("CONTACT_DELETE_INTENT_CHECKPOINT_FAILED");
      return parseDeletionIntent(data);
    },
    provider: createLiveGhlDeletionProviderPort(),
    deleteRpc: async (args) => {
      const { data, error } = await client.rpc("finalize_contact_deletion_intent", args);
      if (error) throw new DeleteLeadError("CONTACT_DELETE_RPC_FAILED");
      return parseDeleteRpc(data);
    },
    loadReadback: async ({
      tenantId, contactIds, auditId, tombstoneHashes, evalCaseIds, billableEventIds,
    }) => {
      const [contactResult, tombstoneResult, evalResult, billableResult, auditResult] =
        await Promise.all([
          client.from("contacts").select("id").eq("tenant_id", tenantId).in("id", [...contactIds]),
          client.from("suppression_tombstones")
            .select("tenant_id, channel, identifier_hash, identifier_last4, deletion_audit_id")
            .eq("tenant_id", tenantId).in("identifier_hash", [...tombstoneHashes]),
          evalCaseIds.length === 0
            ? Promise.resolve({ data: [], error: null })
            : client.from("eval_cases")
                .select("source_tenant_id, source_conversation_id, source_message_id, source_contact_id, provenance_severed, quarantined")
                .in("id", [...evalCaseIds]),
          billableEventIds.length === 0
            ? Promise.resolve({ data: [], error: null })
            : client.from("billable_events")
                .select("id, appointment_id, appointment_detached_at, quantity")
                .eq("tenant_id", tenantId).in("id", [...billableEventIds]),
          client.from("audit_log").select("id, tenant_id, action, target_id, reason, payload")
            .eq("id", auditId).maybeSingle(),
        ]);
      if (contactResult.error || tombstoneResult.error || evalResult.error ||
        billableResult.error || auditResult.error) {
        throw new DeleteLeadError("CONTACT_DELETE_READBACK_FAILED");
      }
      return {
        contactAbsent: (contactResult.data ?? []).length === 0,
        tombstones: (tombstoneResult.data ?? []).map((row) => ({
          tenantId: String(row.tenant_id),
          channel: row.channel,
          identifierHash: String(row.identifier_hash),
          identifierLast4: typeof row.identifier_last4 === "string" ? row.identifier_last4 : null,
          deletionAuditId: Number(row.deletion_audit_id),
        })),
        evalCases: (evalResult.data ?? []).map((row) => ({
          sourceTenantId: typeof row.source_tenant_id === "string" ? row.source_tenant_id : null,
          sourceConversationId: typeof row.source_conversation_id === "string" ? row.source_conversation_id : null,
          sourceMessageId: typeof row.source_message_id === "string" ? row.source_message_id : null,
          sourceContactId: typeof row.source_contact_id === "string" ? row.source_contact_id : null,
          provenanceSevered: Boolean(row.provenance_severed),
          quarantined: Boolean(row.quarantined),
        })),
        billableEvents: (billableResult.data ?? []).map((row) => ({
          id: String(row.id),
          appointmentId: typeof row.appointment_id === "string" ? row.appointment_id : null,
          appointmentDetachedAt: typeof row.appointment_detached_at === "string"
            ? row.appointment_detached_at
            : null,
          quantity: Number(row.quantity),
        })),
        audit: auditResult.data
          ? {
              id: Number(auditResult.data.id),
              tenantId: String(auditResult.data.tenant_id),
              action: "contact.delete" as const,
              targetId: String(auditResult.data.target_id),
              reason: String(auditResult.data.reason),
              payload: auditResult.data.payload as Readonly<Record<string, unknown>>,
            }
          : null,
      };
    },
    hashIdentifier: (value) => hashSuppressionIdentifier(value, environment),
    now: () => new Date(),
  };
}

async function confirmProviderAbsence(input: {
  tenantId: string;
  contactId: string;
  idempotencyKey: string;
  targets: readonly ProviderTarget[];
  retry: DeletionRetryReceipt | null;
  provider: DeletionProviderPort;
  renew(): Promise<void>;
}): Promise<
  | { kind: "confirmed"; evidence: DeletionProviderEvidence; deleteReceipts: DeletionMutationReceipt[] }
  | { kind: "incomplete"; result: Extract<DeleteLeadResult, { kind: "incomplete" }> }
> {
  if (input.targets.length === 0) {
    return { kind: "confirmed", evidence: { kind: "not_applicable" }, deleteReceipts: [] };
  }
  let deleteReceipts = input.retry?.providerDeleteReceipts ?? [];
  if (deleteReceipts.length === 0) {
    try {
      deleteReceipts = [];
      for (const [index, target] of input.targets.entries()) {
        const providerTarget = providerInput(input, target, index);
        await input.renew();
        const before = await input.provider.readAbsent(providerTarget);
        if (before.absent) {
          deleteReceipts.push({
            providerOperationId: before.providerOperationId,
            acceptedAt: before.observedAt,
          });
        } else {
          await input.renew();
          deleteReceipts.push(await input.provider.deleteContact(providerTarget));
        }
      }
    } catch {
      return {
        kind: "incomplete",
        result: { kind: "incomplete", stage: "provider_delete", reason: "provider_delete_failed", retry: null },
      };
    }
  }
  if (deleteReceipts.length !== input.targets.length) {
    throw new DeleteLeadError("CONTACT_DELETE_RETRY_INVALID");
  }
  const serializedReceipts = JSON.stringify(deleteReceipts);
  if (input.targets.some((target) =>
    serializedReceipts.includes(target.providerContactId) ||
    serializedReceipts.includes(target.providerAccountId) ||
    serializedReceipts.includes(target.ghlInstallId)
  )) {
    return {
      kind: "incomplete",
      result: {
        kind: "incomplete",
        stage: "provider_delete",
        reason: "provider_receipt_private",
        retry: null,
      },
    };
  }
  const readReceipts: Extract<DeletionProviderEvidence, { kind: "confirmed_absent" }>["receipts"] = [];
  try {
    for (const [index, target] of input.targets.entries()) {
      await input.renew();
      const readback = await input.provider.readAbsent(providerInput(input, target, index));
      const mutation = deleteReceipts[index];
      if (!readback.absent || readback.providerOperationId !== mutation.providerOperationId) {
        return {
          kind: "incomplete",
          result: {
            kind: "incomplete",
            stage: "provider_readback",
            reason: "provider_absence_unconfirmed",
            retry: retryReceipt({
              tenantId: input.tenantId,
              contactId: input.contactId,
              idempotencyDigest: idempotencyDigest(input.idempotencyKey),
              providerDeleteReceipts: deleteReceipts,
              providerEvidence: null,
            }),
          },
        };
      }
      readReceipts.push({
        providerOperationId: mutation.providerOperationId,
        acceptedAt: mutation.acceptedAt,
        observedAt: readback.observedAt,
      });
    }
  } catch {
    return {
      kind: "incomplete",
      result: {
        kind: "incomplete",
        stage: "provider_readback",
        reason: "provider_absence_unconfirmed",
        retry: retryReceipt({
          tenantId: input.tenantId,
          contactId: input.contactId,
          idempotencyDigest: idempotencyDigest(input.idempotencyKey),
          providerDeleteReceipts: deleteReceipts,
          providerEvidence: null,
        }),
      },
    };
  }
  return {
    kind: "confirmed",
    evidence: { kind: "confirmed_absent", receipts: readReceipts },
    deleteReceipts,
  };
}

export async function deleteLead(
  input: DeleteLeadInput,
  dependencies?: DeleteLeadDependencies,
  environment: EnvironmentSource = process.env,
): Promise<DeleteLeadResult> {
  const tenantId = required(input.tenantId, "EXPECTED_TENANT_REQUIRED");
  const contactId = required(input.contactId, "CONTACT_ID_REQUIRED");
  const actorId = required(input.actorId, "ACTOR_ID_REQUIRED");
  const reason = normalizeDeletionReason(input.reason);
  const key = required(input.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
  const digest = idempotencyDigest(key);
  const leaseToken = randomUUID();
  const deps = dependencies ?? (await liveDependencies(environment));
  if (!deps.liveEnabled) {
    return { kind: "refused", stage: "gate", reason: "contact_delete_disabled" };
  }
  const completed = await deps.loadCompleted({ tenantId, contactId, idempotencyDigest: digest });
  if (completed) {
    return {
      kind: "deleted",
      auditId: completed.auditId,
      providerEvidence: completed.providerEvidence,
      tombstoneCount: completed.tombstoneCount,
      replayed: true,
    };
  }
  let claims;
  try {
    claims = decodeDeletionPreviewToken(input.previewToken);
  } catch {
    return { kind: "refused", stage: "preview", reason: "preview_invalid" };
  }
  if (claims.tenantId !== tenantId || claims.contactId !== contactId || claims.actorId !== actorId ||
    claims.reasonRequired !== true) {
    return { kind: "refused", stage: "preview", reason: "preview_invalid" };
  }
  const snapshot = await deps.loadSnapshot(tenantId, contactId);
  if (snapshot.tenantId !== tenantId || snapshot.contactId !== contactId) {
    return { kind: "refused", stage: "preview", reason: "preview_stale" };
  }
  // A legacy retry receipt is accepted only as a consistency check. Provider progress is resumed
  // exclusively from the database intent, never from a caller-controlled wrapper.
  validRetry(input.retry, { tenantId, contactId, idempotencyDigest: digest });
  const targets = providerTargets(snapshot);
  let intent: DeletionIntent;
  try {
    intent = await deps.beginIntent({
      tenantId,
      contactId,
      actorId,
      reason,
      previewToken: claims.rpcToken,
      leaseToken,
      idempotencyDigest: digest,
      snapshotDigest: claims.countsDigest,
      providerTargetDigest: providerTargetDigest(targets),
    });
  } catch {
    return { kind: "refused", stage: "preview", reason: "preview_stale" };
  }

  try {

  let providerEvidence = intent.providerEvidence;
  let deleteReceipts: DeletionMutationReceipt[] = [];
  if (intent.status === "claimed") {
    const provider = await confirmProviderAbsence({
      tenantId,
      contactId,
      idempotencyKey: key,
      targets,
      retry: null,
      provider: deps.provider,
      renew: () => deps.renewIntent({ tenantId, intentId: intent.id, leaseToken }),
    });
    if (provider.kind === "incomplete") return provider.result;
    providerEvidence = provider.evidence;
    deleteReceipts = provider.deleteReceipts;
    try {
      await deps.renewIntent({ tenantId, intentId: intent.id, leaseToken });
      intent = await deps.checkpointIntent({
        tenantId,
        actorId,
        intentId: intent.id,
        leaseToken,
        providerEvidence,
      });
    } catch {
      return {
        kind: "incomplete",
        stage: "local_delete",
        reason: "provider_checkpoint_failed",
        retry: retryReceipt({
          tenantId,
          contactId,
          idempotencyDigest: digest,
          providerDeleteReceipts: deleteReceipts,
          providerEvidence,
        }),
      };
    }
  }
  if (!providerEvidence || intent.status === "claimed") {
    return {
      kind: "incomplete",
      stage: "local_delete",
      reason: "provider_checkpoint_unconfirmed",
      retry: null,
    };
  }

  const tombstonesByKey = new Map<string, { channel: string; hash: string; last4: string | null }>();
  for (const identity of snapshot.identities) {
    const hash = deps.hashIdentifier(identity.normalizedIdentifier);
    const key = `${identity.channel}:${hash}`;
    if (!tombstonesByKey.has(key)) {
      tombstonesByKey.set(key, {
        channel: identity.channel,
        hash,
        last4: identity.identifierLast4,
      });
    }
  }
  const tombstones = [...tombstonesByKey.values()];
  const providerReceipt = {
    intentId: intent.id,
    providerEvidence,
    idempotencyDigest: digest,
    verifiedAt: deps.now().toISOString(),
  };
  if (!auditPayloadIsPrivate(snapshot, providerReceipt)) {
    return {
      kind: "incomplete",
      stage: "provider_readback",
      reason: "provider_evidence_private",
      retry: null,
    };
  }
  let rpc: DeleteRpcRow;
  try {
    await deps.renewIntent({ tenantId, intentId: intent.id, leaseToken });
    rpc = parseDeleteRpc(await deps.deleteRpc({
      p_expected_tenant: tenantId,
      p_actor_id: actorId,
      p_intent_id: intent.id,
      p_lease_token: leaseToken,
      p_tombstone_channels: tombstones.map((row) => row.channel),
      p_tombstone_hashes: tombstones.map((row) => row.hash),
      p_tombstone_last4s: tombstones.map((row) => row.last4),
      p_provider_receipt: providerReceipt,
    }));
  } catch {
    return {
      kind: "incomplete",
      stage: "local_delete",
      reason: "local_delete_failed",
      retry: retryReceipt({
        tenantId,
        contactId,
        idempotencyDigest: digest,
        providerDeleteReceipts: deleteReceipts,
        providerEvidence,
      }),
    };
  }
  let readback: DeletionReadback;
  try {
    readback = await deps.loadReadback({
      tenantId,
      contactId,
      contactIds: snapshot.contactIds,
      auditId: rpc.audit_id,
      tombstoneHashes: tombstones.map((row) => row.hash),
      evalCaseIds: snapshot.evalCaseIds,
      billableEventIds: snapshot.billableEvents.map((row) => row.id),
    });
    assertReadback(readback, {
      tenantId,
      contactId,
      reason,
      auditId: rpc.audit_id,
      snapshot,
      tombstones,
      providerReceipt,
    });
  } catch {
    return {
      kind: "incomplete",
      stage: "local_readback",
      reason: "local_deletion_unconfirmed",
      retry: retryReceipt({
        tenantId,
        contactId,
        idempotencyDigest: digest,
        providerDeleteReceipts: deleteReceipts,
        providerEvidence,
      }),
    };
  }
  return {
    kind: "deleted",
    auditId: rpc.audit_id,
    providerEvidence,
    tombstoneCount: readback.tombstones.length,
    replayed: !rpc.deleted,
  };
  } finally {
    try {
      await deps.releaseIntent({ tenantId, intentId: intent.id, leaseToken });
    } catch {
      // Lease expiry still makes the intent recoverable; a release failure cannot rewrite outcome.
    }
  }
}
