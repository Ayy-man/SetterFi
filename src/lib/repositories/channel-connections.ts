/**
 * Metadata-only channel connection reads for coach and cutover surfaces.
 *
 * Credential envelopes are intentionally absent from both the query and the return type. Provider
 * capability is resolved from Contract A metadata without invoking the token-decrypting resolver.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

import {
  resolveMessagingCapabilities,
  type IdentityProvider,
  type MessagingCapabilities,
  type MessagingChannel,
} from "@/lib/integrations/types";

export const CHANNEL_CONNECTION_STATES = [
  "disconnected",
  "connecting",
  "pending_review",
  "ready",
  "live",
  "error",
  "expired",
  "blocked_permanent",
  "flagged",
  "restricted",
] as const;
export type ChannelConnectionState = (typeof CHANNEL_CONNECTION_STATES)[number];

export type ChannelConnectionView = {
  id: string;
  channel: MessagingChannel;
  channelLabel: string;
  state: ChannelConnectionState;
  externalAccountLabel: string | null;
  capabilities: MessagingCapabilities;
  receipts: {
    oauthCompletedAt: string | null;
    assetVerifiedAt: string | null;
    webhookSubscribedAt: string | null;
    signedRoundTripAt: string | null;
  };
  /**
   * Why the connection is in the state it is in, as the provider or the writer recorded it, and
   * when its credential stops being usable. Both are read straight off the row and never
   * synthesised: screen 1f opens on "Instagram revoked the token when the account password
   * changed", and a surface that can only say "not connected" is asking an operator to go find
   * that sentence somewhere else. When the column is empty the surface says so rather than
   * guessing a cause -- an unrecorded reason is a fact, and an invented one is a fabrication.
   *
   * This is metadata about the credential, never the credential: `access_token` stays out of the
   * query and out of this type, as the file header requires.
   */
  error: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ChannelConnectionRow = {
  id: string;
  tenant_id: string;
  channel: MessagingChannel;
  provider: IdentityProvider;
  state: ChannelConnectionState;
  external_account_label: string | null;
  oauth_completed_at: string | null;
  asset_verified_at: string | null;
  webhook_subscribed_at: string | null;
  signed_round_trip_at: string | null;
  error: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type ChannelConnectionSource = (tenantId: string) => Promise<readonly ChannelConnectionRow[]>;

const CHANNEL_LABELS: Readonly<Record<MessagingChannel, string>> = {
  instagram: "Instagram",
  messenger: "Facebook Messenger",
  sms: "Text messages (SMS)",
  whatsapp: "WhatsApp",
  webchat: "Web chat",
};

async function loadLiveConnections(tenantId: string): Promise<readonly ChannelConnectionRow[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("channel_connections")
    .select(`
      id, tenant_id, channel, provider, state, external_account_label, oauth_completed_at,
      asset_verified_at, webhook_subscribed_at, signed_round_trip_at, error, token_expires_at,
      created_at, updated_at
    `)
    .eq("tenant_id", tenantId)
    .order("channel", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) throw new Error("CHANNEL_CONNECTION_READ_FAILED");
  return (data ?? []) as unknown as ChannelConnectionRow[];
}

export async function listChannelConnections(
  tenantId: string,
  source: ChannelConnectionSource = loadLiveConnections,
): Promise<ChannelConnectionView[]> {
  const expectedTenant = tenantId.trim();
  if (!expectedTenant) throw new Error("EXPECTED_TENANT_REQUIRED");
  const rows = await source(expectedTenant);
  if (rows.some((row) => row.tenant_id !== expectedTenant)) {
    throw new Error("CHANNEL_CONNECTION_TENANT_MISMATCH");
  }
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    channelLabel: CHANNEL_LABELS[row.channel],
    state: row.state,
    externalAccountLabel: row.external_account_label,
    capabilities: resolveMessagingCapabilities(row.provider, row.channel),
    receipts: {
      oauthCompletedAt: row.oauth_completed_at,
      assetVerifiedAt: row.asset_verified_at,
      webhookSubscribedAt: row.webhook_subscribed_at,
      signedRoundTripAt: row.signed_round_trip_at,
    },
    error: row.error ?? null,
    tokenExpiresAt: row.token_expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
