import { describe, expect, it } from "vitest";

import {
  CHANNEL_CONNECTION_STATES,
  listChannelConnections,
} from "@/lib/repositories/channel-connections";

function row(tenantId = "tenant-a") {
  return {
    id: "connection-a",
    tenant_id: tenantId,
    channel: "whatsapp" as const,
    provider: "meta_direct" as const,
    state: "ready" as const,
    external_account_label: "Business messaging number",
    oauth_completed_at: "2026-08-17T10:00:00.000Z",
    asset_verified_at: "2026-08-17T10:05:00.000Z",
    webhook_subscribed_at: "2026-08-17T10:10:00.000Z",
    signed_round_trip_at: null,
    error: null,
    token_expires_at: null,
    created_at: "2026-08-17T09:00:00.000Z",
    updated_at: "2026-08-17T10:10:00.000Z",
    credential_envelope: "canary-credential-value",
    access_token: "canary-token-value",
  };
}

describe("listChannelConnections", () => {
  it("returns provider-neutral metadata and capabilities without credential-bearing fields", async () => {
    const result = await listChannelConnections("tenant-a", async () => [row()]);
    expect(result).toEqual([
      {
        id: "connection-a",
        channel: "whatsapp",
        channelLabel: "WhatsApp",
        state: "ready",
        externalAccountLabel: "Business messaging number",
        capabilities: { windowed: true, postWindow: "template", templates: true },
        receipts: {
          oauthCompletedAt: "2026-08-17T10:00:00.000Z",
          assetVerifiedAt: "2026-08-17T10:05:00.000Z",
          webhookSubscribedAt: "2026-08-17T10:10:00.000Z",
          signedRoundTripAt: null,
        },
        error: null,
        tokenExpiresAt: null,
        createdAt: "2026-08-17T09:00:00.000Z",
        updatedAt: "2026-08-17T10:10:00.000Z",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("canary");
    expect(result[0]).not.toHaveProperty("provider");
  });

  it("rejects a cross-tenant row even though the live client uses service-role custody", async () => {
    await expect(
      listChannelConnections("tenant-a", async () => [row("tenant-b")]),
    ).rejects.toThrow("CHANNEL_CONNECTION_TENANT_MISMATCH");
  });

  it("pins every persisted connection state for schema drift", () => {
    expect(CHANNEL_CONNECTION_STATES).toEqual([
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
    ]);
  });
});
