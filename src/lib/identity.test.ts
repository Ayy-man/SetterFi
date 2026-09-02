import { describe, expect, it, vi } from "vitest";

import {
  classifyIdentityMatch,
  normalizeIdentity,
  persistInboundIdentity,
  type PersistInboundIdentityDependencies,
  type PersistInboundIdentityInput,
} from "@/lib/identity";
import {
  authorizeHumanActor,
  createHumanTaggedCommand,
  DIRECT_META_MESSAGING_CAPABILITIES,
  GHL_MESSAGING_CAPABILITIES,
} from "@/lib/integrations/types";

const inbound: PersistInboundIdentityInput = {
  identity: {
    provider: "ghl",
    channel: "sms",
    externalId: "lead-42",
    normalizedPhone: "+15551234567",
    normalizedEmail: null,
  },
  providerAccountId: "location-a",
  providerWindow: null,
  providerMessageId: "message-1",
  body: "Hello",
  contactName: "Alex",
};

function identityStore(): PersistInboundIdentityDependencies {
  const contacts = new Map<string, string>();
  let sequence = 0;
  return {
    persistInbound: async (args) => {
      const key = [
        args.p_expected_tenant,
        args.p_provider,
        args.p_channel,
        args.p_provider_identity_id,
      ].join(":");
      const contactId = contacts.get(key) ?? `contact-${(sequence += 1)}`;
      contacts.set(key, contactId);
      return {
        contact_id: contactId,
        conversation_id: `conversation-${contactId}`,
        message_id: String(args.p_provider_message_id),
        message_inserted: true,
        disclosure_pending: true,
        provider_window_expires_at: (args.p_provider_window_expires_at as string | null) ?? null,
      };
    },
    verifyTenantLinks: async () => true,
  };
}

describe("provider identity", () => {
  it("normalizes display fields without changing the provider identity key", () => {
    expect(
      normalizeIdentity({
        ...inbound.identity,
        externalId: " provider-key ",
        normalizedEmail: " Lead@Example.COM ",
      }),
    ).toEqual({
      provider: "ghl",
      channel: "sms",
      externalId: "provider-key",
      normalizedPhone: "+15551234567",
      normalizedEmail: "lead@example.com",
    });
  });

  it("raises a suspected duplicate instead of merging on a phone match", () => {
    expect(
      classifyIdentityMatch({
        providerContactId: null,
        phoneMatchContactIds: ["contact-b", "contact-a"],
        emailMatchContactIds: [],
      }),
    ).toEqual({
      kind: "suspected_duplicate",
      candidateContactIds: ["contact-a", "contact-b"],
    });
  });

  it("replays one provider identity into one tenant contact but separates another tenant", async () => {
    const dependencies = identityStore();
    const first = await persistInboundIdentity("tenant-a", inbound, dependencies);
    const replay = await persistInboundIdentity(
      "tenant-a",
      { ...inbound, providerMessageId: "message-2" },
      dependencies,
    );
    const otherTenant = await persistInboundIdentity("tenant-b", inbound, dependencies);

    expect(replay.contactId).toBe(first.contactId);
    expect(otherTenant.contactId).not.toBe(first.contactId);
  });

  it("passes normalized identity and a direct Meta provider window to the RPC atomically", async () => {
    const dependencies = identityStore();
    const persistInbound = vi.spyOn(dependencies, "persistInbound");
    const providerWindow = {
      observedAt: "2026-08-17T10:00:00.000Z",
      expiresAt: "2026-08-18T10:00:00.000Z",
      source: "derived_24h" as const,
    };

    const persisted = await persistInboundIdentity("tenant-a", {
      ...inbound,
      identity: {
        provider: "meta_direct",
        channel: "messenger",
        externalId: " person-42 ",
        normalizedPhone: null,
        normalizedEmail: " Lead@Example.COM ",
      },
      providerAccountId: null,
      providerWindow,
    }, dependencies);

    expect(persistInbound).toHaveBeenCalledWith(expect.objectContaining({
      p_provider: "meta_direct",
      p_channel: "messenger",
      p_provider_identity_id: "person-42",
      p_provider_account_id: null,
      p_normalized_email: "lead@example.com",
      p_provider_window_observed_at: providerWindow.observedAt,
      p_provider_window_expires_at: providerWindow.expiresAt,
      p_provider_window_source: "derived_24h",
    }));
    expect(persisted.providerWindowExpiresAt).toBe(providerWindow.expiresAt);
  });

  it("passes only normalized first-touch attribution fields to inbound persistence", async () => {
    const dependencies = identityStore();
    const persistInbound = vi.spyOn(dependencies, "persistInbound");
    await persistInboundIdentity("tenant-a", {
      ...inbound,
      identity: {
        provider: "meta_direct",
        channel: "instagram",
        externalId: "ig-sid-1",
        normalizedPhone: null,
        normalizedEmail: null,
      },
      providerAccountId: null,
      providerWindow: {
        observedAt: "2026-08-17T10:00:00.000Z",
        expiresAt: "2026-08-18T10:00:00.000Z",
        source: "provider",
      },
      attribution: {
        adId: " ad-1 ",
        source: "ADS",
        ref: " funding-ref ",
        adsContextData: { adTitle: " Funding guide ", postId: " post-1 " },
        ctwaClid: null,
      },
    }, dependencies);

    expect(persistInbound).toHaveBeenCalledWith(expect.objectContaining({
      p_ad_id: "ad-1",
      p_ad_source: "ADS",
      p_ad_ref: "funding-ref",
      p_ads_context_data: { adTitle: "Funding guide", postId: "post-1" },
      p_ctwa_clid: null,
    }));
  });

  it("rejects an empty external identity before the RPC", async () => {
    const dependencies = identityStore();
    const persistInbound = vi.spyOn(dependencies, "persistInbound");

    await expect(persistInboundIdentity("tenant-a", {
      ...inbound,
      identity: { ...inbound.identity, externalId: "  " },
    }, dependencies)).rejects.toThrow("PROVIDER_IDENTITY_ID_REQUIRED");
    expect(persistInbound).not.toHaveBeenCalled();
  });

  it("requires exact GHL account custody and forbids it for direct Meta", async () => {
    const dependencies = identityStore();
    const persistInbound = vi.spyOn(dependencies, "persistInbound");
    await expect(persistInboundIdentity("tenant-a", {
      ...inbound,
      providerAccountId: null,
    }, dependencies)).rejects.toThrow("GHL_PROVIDER_ACCOUNT_ID_REQUIRED");
    await expect(persistInboundIdentity("tenant-a", {
      ...inbound,
      identity: { ...inbound.identity, provider: "meta_direct", channel: "messenger" },
      providerAccountId: "location-a",
      providerWindow: {
        observedAt: "2026-08-17T10:00:00.000Z",
        expiresAt: "2026-08-18T10:00:00.000Z",
        source: "provider",
      },
    }, dependencies)).rejects.toThrow("NON_GHL_PROVIDER_ACCOUNT_ID_FORBIDDEN");
    expect(persistInbound).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid direct Meta windows before the RPC", async () => {
    const dependencies = identityStore();
    const persistInbound = vi.spyOn(dependencies, "persistInbound");
    const identity = { ...inbound.identity, provider: "meta_direct" as const, channel: "instagram" as const };

    await expect(persistInboundIdentity("tenant-a", {
      ...inbound,
      identity,
      providerAccountId: null,
      providerWindow: null,
    }, dependencies)).rejects.toThrow("META_PROVIDER_WINDOW_REQUIRED");
    await expect(persistInboundIdentity("tenant-a", {
      ...inbound,
      identity,
      providerAccountId: null,
      providerWindow: {
        observedAt: "2026-08-18T10:00:00.000Z",
        expiresAt: "2026-08-17T10:00:00.000Z",
        source: "provider",
      },
    }, dependencies)).rejects.toThrow("PROVIDER_WINDOW_INVALID");
    expect(persistInbound).not.toHaveBeenCalled();
  });

  it("keeps all GHL capabilities durable and direct Meta capabilities channel-specific", () => {
    expect(Object.values(GHL_MESSAGING_CAPABILITIES)).toEqual(
      Array.from({ length: 5 }, () => ({ windowed: false, postWindow: "none", templates: false })),
    );
    expect(DIRECT_META_MESSAGING_CAPABILITIES.instagram).toEqual({
      windowed: true,
      postWindow: "none",
      templates: false,
    });
    expect(DIRECT_META_MESSAGING_CAPABILITIES.whatsapp).toEqual({
      windowed: true,
      postWindow: "template",
      templates: true,
    });
    expect(DIRECT_META_MESSAGING_CAPABILITIES.sms.windowed).toBe(false);
    expect(DIRECT_META_MESSAGING_CAPABILITIES.webchat.windowed).toBe(false);
  });

  it("constructs a human-tag command only with verified human actor proof", () => {
    expect(() => authorizeHumanActor({ userId: "user-1", authorized: false })).toThrow(
      "HUMAN_ACTOR_PROOF_REQUIRED",
    );
    const actor = authorizeHumanActor({ userId: " user-1 ", authorized: true });
    expect(createHumanTaggedCommand({
      channel: "messenger",
      recipientExternalId: "recipient-1",
      body: "A human reply",
    }, actor)).toMatchObject({ kind: "human_tag", actor: { userId: "user-1" } });
  });

  it("fails before returning when the read-back does not belong to the expected tenant", async () => {
    await expect(
      persistInboundIdentity("tenant-a", inbound, {
        ...identityStore(),
        verifyTenantLinks: async () => false,
      }),
    ).rejects.toThrow("INBOUND_TENANT_MISMATCH");
  });
});
