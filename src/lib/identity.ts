/**
 * Provider identity normalization and inbound persistence.
 *
 * Provider identifiers are the only automatic identity key. Phone and email are useful duplicate
 * signals, but treating either as proof can splice two people's histories together, so this module
 * deliberately never turns a field match into a merge.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

import {
  IDENTITY_PROVIDERS,
  MESSAGING_CHANNELS,
  type IdentityProvider,
  type MessagingChannel,
  type NormalizedInboundAttribution,
  type NormalizedIdentity,
  type ProviderWindow,
} from "@/lib/integrations/types";

export {
  IDENTITY_PROVIDERS,
  MESSAGING_CHANNELS,
  type IdentityProvider,
  type MessagingChannel,
  type NormalizedIdentity,
  type ProviderWindow,
};

export type PersistInboundIdentityInput = {
  identity: NormalizedIdentity;
  providerAccountId: string | null;
  providerWindow: ProviderWindow | null;
  providerMessageId: string;
  body: string;
  contactName: string | null;
  attribution?: NormalizedInboundAttribution | null;
};

export type PersistedInboundIdentity = {
  tenantId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  messageInserted: boolean;
  disclosurePending: boolean;
  providerWindowExpiresAt: string | null;
};

export type IdentityMatch =
  | { kind: "provider_identity"; contactId: string }
  | { kind: "suspected_duplicate"; candidateContactIds: string[] }
  | { kind: "new_contact" };

type InboundRpcRow = {
  contact_id: string;
  conversation_id: string;
  message_id: string;
  message_inserted: boolean;
  disclosure_pending: boolean;
  provider_window_expires_at: string | null;
};

export type PersistInboundIdentityDependencies = {
  persistInbound: (args: Record<string, unknown>) => Promise<InboundRpcRow>;
  verifyTenantLinks: (input: {
    tenantId: string;
    contactId: string;
    conversationId: string;
    messageId: string;
  }) => Promise<boolean>;
};

function required(value: string, error: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(error);
  return normalized;
}

export function normalizeIdentity(input: NormalizedIdentity): NormalizedIdentity {
  return {
    provider: input.provider,
    channel: input.channel,
    externalId: required(input.externalId, "PROVIDER_IDENTITY_ID_REQUIRED"),
    normalizedPhone: input.normalizedPhone?.trim() || null,
    normalizedEmail: input.normalizedEmail?.trim().toLowerCase() || null,
  };
}

export function classifyIdentityMatch(input: {
  providerContactId: string | null;
  phoneMatchContactIds: string[];
  emailMatchContactIds: string[];
}): IdentityMatch {
  if (input.providerContactId) {
    return { kind: "provider_identity", contactId: input.providerContactId };
  }

  const candidates = [...new Set([...input.phoneMatchContactIds, ...input.emailMatchContactIds])];
  return candidates.length > 0
    ? { kind: "suspected_duplicate", candidateContactIds: candidates.sort() }
    : { kind: "new_contact" };
}

async function liveDependencies(): Promise<PersistInboundIdentityDependencies> {
  const client = createSupabaseServiceClient();
  return {
    persistInbound: async (args) => {
      const { data, error } = await client.rpc("persist_inbound_message", args);
      if (error) throw new Error(`PERSIST_INBOUND_MESSAGE_FAILED:${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("PERSIST_INBOUND_MESSAGE_EMPTY");
      return row as InboundRpcRow;
    },
    verifyTenantLinks: async ({ tenantId, contactId, conversationId, messageId }) => {
      const [contact, conversation, message] = await Promise.all([
        client.from("contacts").select("tenant_id").eq("id", contactId).single(),
        client.from("conversations").select("tenant_id").eq("id", conversationId).single(),
        client.from("messages").select("tenant_id").eq("id", messageId).single(),
      ]);
      if (contact.error || conversation.error || message.error) {
        throw new Error("INBOUND_TENANT_READBACK_FAILED");
      }
      return [contact.data, conversation.data, message.data].every(
        (row) => row?.tenant_id === tenantId,
      );
    },
  };
}

function normalizeProviderWindow(
  identity: NormalizedIdentity,
  providerWindow: ProviderWindow | null,
) {
  if (identity.provider === "ghl") {
    if (providerWindow !== null) throw new Error("DURABLE_PROVIDER_WINDOW_FORBIDDEN");
    return null;
  }
  if (!providerWindow) throw new Error("META_PROVIDER_WINDOW_REQUIRED");
  const observedAt = new Date(providerWindow.observedAt);
  const expiresAt = new Date(providerWindow.expiresAt);
  if (
    Number.isNaN(observedAt.valueOf()) || Number.isNaN(expiresAt.valueOf()) ||
    expiresAt <= observedAt
  ) {
    throw new Error("PROVIDER_WINDOW_INVALID");
  }
  return {
    observedAt: observedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    source: providerWindow.source,
  };
}

function normalizePersistenceInput(input: PersistInboundIdentityInput): PersistInboundIdentityInput {
  const providerAccountId = input.providerAccountId?.trim() || null;
  if (input.identity.provider === "ghl" && !providerAccountId) {
    throw new Error("GHL_PROVIDER_ACCOUNT_ID_REQUIRED");
  }
  if (input.identity.provider !== "ghl" && providerAccountId) {
    throw new Error("NON_GHL_PROVIDER_ACCOUNT_ID_FORBIDDEN");
  }
  if (input.identity.provider !== "meta_direct" && input.attribution) {
    throw new Error("NON_META_ATTRIBUTION_FORBIDDEN");
  }
  const adId = input.attribution?.adId?.trim() || null;
  const adRef = input.attribution?.ref?.trim() || null;
  const ctwaClid = input.attribution?.ctwaClid?.trim() || null;
  const adTitle = input.attribution?.adsContextData.adTitle?.trim() || null;
  const postId = input.attribution?.adsContextData.postId?.trim() || null;
  const attribution = adId || adRef || ctwaClid || adTitle || postId || input.attribution?.source
    ? {
        adId,
        source: input.attribution?.source === "ADS" ? "ADS" as const : null,
        ref: adRef,
        adsContextData: {
          ...(adTitle ? { adTitle } : {}),
          ...(postId ? { postId } : {}),
        },
        ctwaClid,
      }
    : null;
  return {
    ...input,
    providerAccountId,
    identity: normalizeIdentity(input.identity),
    providerWindow: normalizeProviderWindow(input.identity, input.providerWindow),
    attribution,
  };
}

export async function persistInboundIdentity(
  tenantId: string,
  input: PersistInboundIdentityInput,
  dependencies?: PersistInboundIdentityDependencies,
): Promise<PersistedInboundIdentity> {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  const normalized = normalizePersistenceInput(input);
  const identity = normalized.identity;
  const providerWindow = normalized.providerWindow;
  const deps = dependencies ?? (await liveDependencies());
  const row = await deps.persistInbound({
    p_expected_tenant: expectedTenant,
    p_provider: identity.provider,
    p_channel: identity.channel,
    p_provider_identity_id: identity.externalId,
    p_provider_account_id: normalized.providerAccountId,
    p_normalized_phone: identity.normalizedPhone,
    p_normalized_email: identity.normalizedEmail,
    p_provider_message_id: required(normalized.providerMessageId, "PROVIDER_MESSAGE_ID_REQUIRED"),
    p_body: required(normalized.body, "INBOUND_BODY_REQUIRED"),
    p_contact_name: normalized.contactName?.trim() || null,
    p_provider_window_observed_at: providerWindow?.observedAt ?? null,
    p_provider_window_expires_at: providerWindow?.expiresAt ?? null,
    p_provider_window_source: providerWindow?.source ?? null,
    p_ad_id: normalized.attribution?.adId ?? null,
    p_ad_source: normalized.attribution?.source ?? null,
    p_ad_ref: normalized.attribution?.ref ?? null,
    p_ads_context_data: normalized.attribution?.adsContextData ?? {},
    p_ctwa_clid: normalized.attribution?.ctwaClid ?? null,
  });

  const linked = await deps.verifyTenantLinks({
    tenantId: expectedTenant,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
  });
  if (!linked) throw new Error("INBOUND_TENANT_MISMATCH");

  return {
    tenantId: expectedTenant,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    messageInserted: row.message_inserted,
    disclosurePending: row.disclosure_pending,
    providerWindowExpiresAt: row.provider_window_expires_at,
  };
}
