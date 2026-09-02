/**
 * Tenant-safe wrapper for the atomic provider cutover RPC.
 *
 * The database owns the transaction. This service validates complete open-contact coverage before
 * calling it, then proves connection, identity, conversation, message-count, and audit readback.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

import type { IdentityProvider, MessagingChannel } from "@/lib/integrations/types";

export type ProviderIdentityBackfill = {
  outgoingExternalId: string;
  incomingExternalId: string;
  contactId: string;
};

export type SwitchProviderInput = {
  expectedTenantId: string;
  channel: MessagingChannel;
  outgoingConnectionId: string;
  incomingConnectionId: string;
  backfill: readonly ProviderIdentityBackfill[];
  actorUserId: string;
  reason: string;
  idempotencyKey: string;
};

export type SwitchProviderResult = {
  state: "live";
  appliedIdentityCount: number;
  auditId: number;
  outgoingConnectionId: string;
  incomingConnectionId: string;
};

type SwitchConnectionFact = {
  id: string;
  tenantId: string;
  channel: MessagingChannel;
  provider: IdentityProvider;
  state: string;
};

type SwitchConversationFact = {
  id: string;
  tenantId: string;
  contactId: string;
  messageCount: number;
};

type SwitchIdentityFact = {
  tenantId: string;
  contactId: string;
  provider: IdentityProvider;
  externalId: string;
};

export type ProviderSwitchSnapshot = {
  connections: readonly SwitchConnectionFact[];
  openConversations: readonly SwitchConversationFact[];
  identities: readonly SwitchIdentityFact[];
};

type SwitchRpcRow = { state: string; applied_identity_count: number; audit_id: number };
type SwitchAudit = { id: number; tenantId: string; action: string; targetId: string | null };

export type ProviderSwitchDependencies = {
  switchProvider(args: Record<string, unknown>): Promise<SwitchRpcRow>;
  loadSnapshot(tenantId: string, channel: MessagingChannel): Promise<ProviderSwitchSnapshot>;
  loadAudit(tenantId: string, auditId: number): Promise<SwitchAudit | null>;
};

export class ProviderSwitchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderSwitchError";
  }
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new ProviderSwitchError(code);
  return normalized;
}

function singleSwitch(data: unknown): SwitchRpcRow {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new ProviderSwitchError("PROVIDER_SWITCH_FAILED");
  const value = row as Record<string, unknown>;
  if (typeof value.state !== "string" || typeof value.applied_identity_count !== "number" ||
    typeof value.audit_id !== "number") {
    throw new ProviderSwitchError("PROVIDER_SWITCH_FAILED");
  }
  return {
    state: value.state,
    applied_identity_count: value.applied_identity_count,
    audit_id: value.audit_id,
  };
}

async function liveDependencies(): Promise<ProviderSwitchDependencies> {
  const client = createSupabaseServiceClient();
  return {
    switchProvider: async (args) => {
      const { data, error } = await client.rpc("switch_channel_provider", args);
      if (error) throw new Error(error.message);
      return singleSwitch(data);
    },
    loadSnapshot: async (tenantId, channel) => {
      const [connectionsResult, conversationsResult, identitiesResult] = await Promise.all([
        client
          .from("channel_connections")
          .select("id, tenant_id, channel, provider, state")
          .eq("tenant_id", tenantId)
          .eq("channel", channel),
        client
          .from("conversations")
          .select("id, tenant_id, contact_id, messages(count)")
          .eq("tenant_id", tenantId)
          .eq("channel", channel)
          .in("status", ["agent", "needs_human", "human", "nurture"]),
        client
          .from("contact_identities")
          .select("tenant_id, contact_id, provider, provider_identity_id")
          .eq("tenant_id", tenantId)
          .eq("channel", channel),
      ]);
      if (connectionsResult.error || conversationsResult.error || identitiesResult.error) {
        throw new ProviderSwitchError("PROVIDER_SWITCH_READBACK_FAILED");
      }
      const connections = (connectionsResult.data ?? []).map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        channel: row.channel as MessagingChannel,
        provider: row.provider as IdentityProvider,
        state: String(row.state),
      }));
      const openConversations = (conversationsResult.data ?? []).map((row) => {
        const counts = row.messages as unknown;
        const count = Array.isArray(counts) && counts[0] && typeof counts[0] === "object"
          ? Number((counts[0] as Record<string, unknown>).count)
          : 0;
        return {
          id: String(row.id),
          tenantId: String(row.tenant_id),
          contactId: String(row.contact_id),
          messageCount: count,
        };
      });
      const identities = (identitiesResult.data ?? []).map((row) => ({
        tenantId: String(row.tenant_id),
        contactId: String(row.contact_id),
        provider: row.provider as IdentityProvider,
        externalId: String(row.provider_identity_id),
      }));
      return { connections, openConversations, identities };
    },
    loadAudit: async (tenantId, auditId) => {
      const { data, error } = await client
        .from("audit_log")
        .select("id, tenant_id, action, target_id")
        .eq("tenant_id", tenantId)
        .eq("id", auditId)
        .maybeSingle();
      if (error) throw new ProviderSwitchError("PROVIDER_SWITCH_READBACK_FAILED");
      return data
        ? {
            id: Number(data.id),
            tenantId: String(data.tenant_id),
            action: String(data.action),
            targetId: typeof data.target_id === "string" ? data.target_id : null,
          }
        : null;
    },
  };
}

function normalizedBackfill(backfill: readonly ProviderIdentityBackfill[]) {
  const normalized = backfill.map((item) => ({
    outgoingExternalId: required(item.outgoingExternalId, "IDENTITY_BACKFILL_INVALID"),
    incomingExternalId: required(item.incomingExternalId, "IDENTITY_BACKFILL_INVALID"),
    contactId: required(item.contactId, "IDENTITY_BACKFILL_INVALID"),
  }));
  if (new Set(normalized.map((item) => item.contactId)).size !== normalized.length ||
    new Set(normalized.map((item) => item.incomingExternalId)).size !== normalized.length) {
    throw new ProviderSwitchError("IDENTITY_BACKFILL_INVALID");
  }
  return normalized;
}

function connection(
  snapshot: ProviderSwitchSnapshot,
  expectedTenant: string,
  channel: MessagingChannel,
  id: string,
) {
  const row = snapshot.connections.find((candidate) => candidate.id === id);
  if (!row || row.tenantId !== expectedTenant || row.channel !== channel) {
    throw new ProviderSwitchError("PROVIDER_SWITCH_SCOPE_MISMATCH");
  }
  return row;
}

function assertSnapshotTenant(
  snapshot: ProviderSwitchSnapshot,
  tenantId: string,
  channel: MessagingChannel,
) {
  if (snapshot.connections.some((row) => row.tenantId !== tenantId || row.channel !== channel) ||
    snapshot.openConversations.some((row) => row.tenantId !== tenantId) ||
    snapshot.identities.some((row) => row.tenantId !== tenantId)) {
    throw new ProviderSwitchError("PROVIDER_SWITCH_SCOPE_MISMATCH");
  }
}

function conversationFacts(rows: readonly SwitchConversationFact[]) {
  return new Map(rows.map((row) => [row.id, `${row.contactId}:${row.messageCount}`]));
}

function mapProviderSwitchError(error: unknown): never {
  if (error instanceof ProviderSwitchError) throw error;
  const message = error instanceof Error ? error.message : "";
  const known = [
    "IDENTITY_BACKFILL_REQUIRED",
    "IDEMPOTENCY_PAYLOAD_MISMATCH",
  ].find((code) => message.includes(code));
  if (known) throw new ProviderSwitchError(known);
  if (message.includes("IDENTITY_CONFLICT") || message.includes("BACKFILL_INVALID") ||
    message.includes("SWITCH_STATE_INVALID") || message.includes("SWITCH_PAIR_INVALID")) {
    throw new ProviderSwitchError("PROVIDER_SWITCH_CONFLICT");
  }
  throw new ProviderSwitchError("PROVIDER_SWITCH_FAILED");
}

export async function switchChannelProvider(
  input: SwitchProviderInput,
  dependencies?: ProviderSwitchDependencies,
): Promise<SwitchProviderResult> {
  const tenantId = required(input.expectedTenantId, "EXPECTED_TENANT_REQUIRED");
  const outgoingConnectionId = required(
    input.outgoingConnectionId,
    "OUTGOING_CONNECTION_ID_REQUIRED",
  );
  const incomingConnectionId = required(
    input.incomingConnectionId,
    "INCOMING_CONNECTION_ID_REQUIRED",
  );
  if (outgoingConnectionId === incomingConnectionId) {
    throw new ProviderSwitchError("PROVIDER_SWITCH_PAIR_INVALID");
  }
  const actorUserId = required(input.actorUserId, "ACTOR_USER_ID_REQUIRED");
  const reason = required(input.reason, "PROVIDER_SWITCH_REASON_REQUIRED");
  const idempotencyKey = required(input.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
  const backfill = normalizedBackfill(input.backfill);
  const deps = dependencies ?? (await liveDependencies());

  try {
    const before = await deps.loadSnapshot(tenantId, input.channel);
    assertSnapshotTenant(before, tenantId, input.channel);
    const outgoing = connection(before, tenantId, input.channel, outgoingConnectionId);
    const incoming = connection(before, tenantId, input.channel, incomingConnectionId);
    const alreadyApplied = outgoing.state === "disconnected" && incoming.state === "live";
    if (!alreadyApplied && (outgoing.state !== "live" || incoming.state !== "ready")) {
      throw new ProviderSwitchError("PROVIDER_SWITCH_CONFLICT");
    }
    if (outgoing.provider === incoming.provider) {
      throw new ProviderSwitchError("PROVIDER_SWITCH_CONFLICT");
    }

    const mappedContacts = new Set(backfill.map((item) => item.contactId));
    if (before.openConversations.some((conversation) => !mappedContacts.has(conversation.contactId))) {
      throw new ProviderSwitchError("IDENTITY_BACKFILL_REQUIRED");
    }
    if (backfill.some((item) => !before.identities.some((identity) =>
      identity.provider === outgoing.provider && identity.contactId === item.contactId &&
      identity.externalId === item.outgoingExternalId
    ))) {
      throw new ProviderSwitchError("PROVIDER_SWITCH_CONFLICT");
    }

    const row = await deps.switchProvider({
      p_expected_tenant: tenantId,
      p_channel: input.channel,
      p_outgoing_connection_id: outgoingConnectionId,
      p_incoming_connection_id: incomingConnectionId,
      p_backfill: backfill,
      p_actor_id: actorUserId,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
    });
    if (row.state !== "live" || row.applied_identity_count !== backfill.length) {
      throw new ProviderSwitchError("PROVIDER_SWITCH_READBACK_MISMATCH");
    }

    const [after, audit] = await Promise.all([
      deps.loadSnapshot(tenantId, input.channel),
      deps.loadAudit(tenantId, row.audit_id),
    ]);
    assertSnapshotTenant(after, tenantId, input.channel);
    const outgoingAfter = connection(after, tenantId, input.channel, outgoingConnectionId);
    const incomingAfter = connection(after, tenantId, input.channel, incomingConnectionId);
    if (outgoingAfter.state !== "disconnected" || incomingAfter.state !== "live" ||
      after.connections.filter((candidate) => candidate.state === "live").length !== 1) {
      throw new ProviderSwitchError("PROVIDER_SWITCH_READBACK_MISMATCH");
    }
    if (JSON.stringify([...conversationFacts(after.openConversations)].sort()) !==
      JSON.stringify([...conversationFacts(before.openConversations)].sort())) {
      throw new ProviderSwitchError("PROVIDER_SWITCH_READBACK_MISMATCH");
    }
    if (backfill.some((item) => !after.identities.some((identity) =>
      identity.provider === incoming.provider && identity.contactId === item.contactId &&
      identity.externalId === item.incomingExternalId
    ))) {
      throw new ProviderSwitchError("PROVIDER_SWITCH_READBACK_MISMATCH");
    }
    if (!audit || audit.id !== row.audit_id || audit.tenantId !== tenantId ||
      audit.action !== "channel.provider.switched" || audit.targetId !== incomingConnectionId) {
      throw new ProviderSwitchError("PROVIDER_SWITCH_READBACK_MISMATCH");
    }
    return {
      state: "live",
      appliedIdentityCount: row.applied_identity_count,
      auditId: row.audit_id,
      outgoingConnectionId,
      incomingConnectionId,
    };
  } catch (error) {
    mapProviderSwitchError(error);
  }
}
