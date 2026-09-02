import { describe, expect, it, vi } from "vitest";

import {
  resolveMetaConnection,
  resolveOutboundCapabilityWindow,
  type ConnectionResolverDependencies,
} from "@/lib/integrations/connection-resolver";

type TestConnection = Awaited<
  ReturnType<ConnectionResolverDependencies["loadConnections"]>
>[number];

const readyMeta: TestConnection = {
  id: "connection-1",
  tenant_id: "tenant-a",
  channel: "messenger" as const,
  provider: "meta_direct" as const,
  state: "ready",
  external_account_id: "page-1",
  external_ref: { account_id: "legacy-page" },
};

function dependencies(
  connections: readonly TestConnection[] = [readyMeta],
): ConnectionResolverDependencies {
  return {
    loadConnections: async () => connections,
    loadCredentialEnvelope: async () => ({ version: 1 }),
    loadConversation: async ({ tenantId, conversationId }) => ({
      id: conversationId,
      tenant_id: tenantId,
      channel: "messenger",
      provider_window_expires_at: "2026-08-18T10:00:00.000Z",
    }),
    decryptCredential: () => "access-token-canary",
  };
}

describe("connection resolver", () => {
  it("turns exactly one ready Meta row into only the Meta driver connection", async () => {
    const resolved = await resolveMetaConnection("tenant-a", "messenger", dependencies());

    expect(resolved).toEqual({
      senderId: "page-1",
      accessToken: "access-token-canary",
      host: "https://graph.facebook.com",
    });
    expect(Object.keys(resolved).sort()).toEqual(["accessToken", "host", "senderId"]);
  });

  it("selects the Instagram host without exposing connection metadata", async () => {
    const resolved = await resolveMetaConnection("tenant-a", "instagram", dependencies([{
      ...readyMeta,
      channel: "instagram",
      state: "live",
    }]));
    expect(resolved.host).toBe("https://graph.instagram.com");
    expect(resolved).not.toHaveProperty("tenant_id");
    expect(resolved).not.toHaveProperty("credential_envelope");
  });

  it("rejects cross-tenant, missing, ambiguous, demoted and wrong-provider rows", async () => {
    const cases = [
      [{ ...readyMeta, tenant_id: "tenant-b" }],
      [],
      [readyMeta, { ...readyMeta, id: "connection-2", state: "live" }],
      [{ ...readyMeta, state: "disconnected" }],
      [{ ...readyMeta, provider: "ghl" as const }],
    ];
    const expected = [
      "CHANNEL_CONNECTION_UNAVAILABLE",
      "CHANNEL_CONNECTION_UNAVAILABLE",
      "CHANNEL_CONNECTION_AMBIGUOUS",
      "CHANNEL_CONNECTION_UNAVAILABLE",
      "META_CONNECTION_PROVIDER_MISMATCH",
    ];
    for (const [index, rows] of cases.entries()) {
      await expect(resolveMetaConnection(
        "tenant-a",
        "messenger",
        dependencies(rows),
      )).rejects.toThrow(expected[index]);
    }
  });

  it("refuses missing credentials and unsupported legacy envelopes inside the server path", async () => {
    await expect(resolveMetaConnection("tenant-a", "messenger", {
      ...dependencies(),
      loadCredentialEnvelope: async () => null,
    })).rejects.toThrow("META_CREDENTIAL_UNAVAILABLE");

    const decryptCredential = vi.fn(() => {
      throw new Error("CREDENTIAL_ENVELOPE_VERSION_UNSUPPORTED");
    });
    await expect(resolveMetaConnection("tenant-a", "messenger", {
      ...dependencies(),
      decryptCredential,
    })).rejects.toThrow("CREDENTIAL_ENVELOPE_VERSION_UNSUPPORTED");
    expect(decryptCredential).toHaveBeenCalledOnce();
  });

  it("loads a metadata-only capability and provider-window context for outbound policy", async () => {
    const resolved = await resolveOutboundCapabilityWindow(
      "tenant-a",
      "conversation-1",
      "messenger",
      dependencies(),
    );

    expect(resolved).toEqual({
      connectionId: "connection-1",
      provider: "meta_direct",
      channel: "messenger",
      capabilities: { windowed: true, postWindow: "none", templates: false },
      providerWindowExpiresAt: "2026-08-18T10:00:00.000Z",
    });
    expect(resolved).not.toHaveProperty("accessToken");
  });

  it("keeps a durable GHL channel usable with a null provider window", async () => {
    const ghl = { ...readyMeta, provider: "ghl" as const, channel: "sms" as const };
    const deps: ConnectionResolverDependencies = {
      ...dependencies(),
      loadConnections: async () => [ghl],
      loadConversation: async ({ tenantId, conversationId }) => ({
        id: conversationId,
        tenant_id: tenantId,
        channel: "sms",
        provider_window_expires_at: null,
      }),
    };

    const resolved = await resolveOutboundCapabilityWindow(
      "tenant-a",
      "conversation-1",
      "sms",
      deps,
    );
    expect(resolved.capabilities).toEqual({
      windowed: false,
      postWindow: "none",
      templates: false,
    });
    expect(resolved.providerWindowExpiresAt).toBeNull();
  });
});
