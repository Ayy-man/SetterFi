import { createSupabaseServiceClient } from "@/lib/supabase/server";

import { decryptCredential } from "./credential-envelope";
import type { MetaConnection } from "./meta";
import {
  resolveMessagingCapabilities,
  type IdentityProvider,
  type MessagingCapabilities,
  type MessagingChannel,
} from "./types";

type ConnectionRow = {
  id: string;
  tenant_id: string;
  channel: MessagingChannel;
  provider: IdentityProvider;
  state: string;
  external_account_id: string | null;
  external_ref: unknown;
};

type ConversationRow = {
  id: string;
  tenant_id: string;
  channel: MessagingChannel;
  provider_window_expires_at: string | null;
};

export type ConnectionResolverDependencies = {
  loadConnections(input: {
    tenantId: string;
    channel: MessagingChannel;
  }): Promise<readonly ConnectionRow[]>;
  loadCredentialEnvelope(connectionId: string): Promise<unknown | null>;
  loadConversation(input: {
    tenantId: string;
    conversationId: string;
  }): Promise<ConversationRow | null>;
  decryptCredential(value: unknown): string;
};

export type OutboundCapabilityWindowContext = {
  connectionId: string;
  provider: IdentityProvider;
  channel: MessagingChannel;
  capabilities: MessagingCapabilities;
  providerWindowExpiresAt: string | null;
};

export class ConnectionResolverError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ConnectionResolverError";
  }
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new ConnectionResolverError(code);
  return normalized;
}

function externalRef(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function eligibleConnection(
  rows: readonly ConnectionRow[],
  tenantId: string,
  channel: MessagingChannel,
) {
  const scoped = rows.filter((row) =>
    row.tenant_id === tenantId && row.channel === channel && ["ready", "live"].includes(row.state)
  );
  if (scoped.length === 0) throw new ConnectionResolverError("CHANNEL_CONNECTION_UNAVAILABLE");
  if (scoped.length !== 1) throw new ConnectionResolverError("CHANNEL_CONNECTION_AMBIGUOUS");
  return scoped[0];
}

async function liveDependencies(): Promise<ConnectionResolverDependencies> {
  const client = createSupabaseServiceClient();
  return {
    loadConnections: async ({ tenantId, channel }) => {
      const { data, error } = await client
        .from("channel_connections")
        .select("id, tenant_id, channel, provider, state, external_account_id, external_ref")
        .eq("tenant_id", tenantId)
        .eq("channel", channel);
      if (error) throw new ConnectionResolverError("CHANNEL_CONNECTION_LOOKUP_FAILED");
      return (data ?? []) as ConnectionRow[];
    },
    loadCredentialEnvelope: async (connectionId) => {
      const { data, error } = await client
        .from("channel_connection_secrets")
        .select("credential_envelope")
        .eq("channel_connection_id", connectionId)
        .maybeSingle();
      if (error) throw new ConnectionResolverError("CHANNEL_CREDENTIAL_LOOKUP_FAILED");
      return data?.credential_envelope ?? null;
    },
    loadConversation: async ({ tenantId, conversationId }) => {
      const { data, error } = await client
        .from("conversations")
        .select("id, tenant_id, channel, provider_window_expires_at")
        .eq("tenant_id", tenantId)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new ConnectionResolverError("CONVERSATION_LOOKUP_FAILED");
      return data as ConversationRow | null;
    },
    decryptCredential,
  };
}

async function resolverDependencies(dependencies?: ConnectionResolverDependencies) {
  return dependencies ?? liveDependencies();
}

export async function resolveMetaConnection(
  tenantId: string,
  channel: MessagingChannel,
  dependencies?: ConnectionResolverDependencies,
): Promise<MetaConnection> {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  if (!["instagram", "messenger", "whatsapp"].includes(channel)) {
    throw new ConnectionResolverError("META_CHANNEL_UNSUPPORTED");
  }
  const deps = await resolverDependencies(dependencies);
  const connection = eligibleConnection(
    await deps.loadConnections({ tenantId: expectedTenant, channel }),
    expectedTenant,
    channel,
  );
  if (connection.provider !== "meta_direct") {
    throw new ConnectionResolverError("META_CONNECTION_PROVIDER_MISMATCH");
  }
  const ref = externalRef(connection.external_ref);
  const senderId = connection.external_account_id
    ?? (typeof ref.account_id === "string" ? ref.account_id : null);
  if (!senderId?.trim()) throw new ConnectionResolverError("META_SENDER_ID_UNAVAILABLE");
  const envelope = await deps.loadCredentialEnvelope(connection.id);
  if (!envelope) throw new ConnectionResolverError("META_CREDENTIAL_UNAVAILABLE");

  return {
    senderId: senderId.trim(),
    accessToken: deps.decryptCredential(envelope),
    host: channel === "instagram"
      ? "https://graph.instagram.com"
      : "https://graph.facebook.com",
  };
}

export async function resolveOutboundCapabilityWindow(
  tenantId: string,
  conversationId: string,
  channel: MessagingChannel,
  dependencies?: ConnectionResolverDependencies,
): Promise<OutboundCapabilityWindowContext> {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  const expectedConversation = required(conversationId, "CONVERSATION_ID_REQUIRED");
  const deps = await resolverDependencies(dependencies);
  const connection = eligibleConnection(
    await deps.loadConnections({ tenantId: expectedTenant, channel }),
    expectedTenant,
    channel,
  );
  const conversation = await deps.loadConversation({
    tenantId: expectedTenant,
    conversationId: expectedConversation,
  });
  if (
    !conversation || conversation.tenant_id !== expectedTenant ||
    conversation.id !== expectedConversation || conversation.channel !== channel
  ) {
    throw new ConnectionResolverError("CONVERSATION_SCOPE_MISMATCH");
  }
  return {
    connectionId: connection.id,
    provider: connection.provider,
    channel,
    capabilities: resolveMessagingCapabilities(connection.provider, channel),
    providerWindowExpiresAt: conversation.provider_window_expires_at,
  };
}
