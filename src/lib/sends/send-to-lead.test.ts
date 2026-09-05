import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";
import {
  createProviderDispatchPort,
  type ProviderDispatchDependencies,
} from "@/lib/sends/provider-dispatch";
import {
  sendToLead,
  type SendEligibility,
  type SendPersistencePort,
  type SendTarget,
  type SendToLeadDependencies,
} from "@/lib/sends/send-to-lead";
import type { SendToLeadRequest } from "@/lib/sends/contracts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const IDENTITY = "44444444-4444-4444-8444-444444444444";
const FOLLOWUP = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-08-17T12:00:00.000Z";
const HASH = "a".repeat(64);

const baseRequest: SendToLeadRequest = {
  tenantId: TENANT,
  contactId: CONTACT,
  conversationId: CONVERSATION,
  nominatedIdentityId: IDENTITY,
  purpose: "follow_up",
  content: { kind: "freeform", body: "Synthetic test message" },
  idempotencyKey: "send:test:1",
  occurredAt: NOW,
  isTest: false,
};

const target: SendTarget = {
  tenantId: TENANT,
  contactId: CONTACT,
  identityId: IDENTITY,
  provider: "ghl",
  channel: "sms",
  recipientExternalId: "synthetic-recipient",
  normalizedIdentifier: "+15555550100",
};

const eligibility: SendEligibility = {
  state: "opted_in",
  source: "platform_admin",
  expiresAt: null,
  evidence: null,
  replyInTurn: false,
  conversationChannel: "sms",
  targetChannel: "sms",
  providerWindowOpen: true,
  capabilityFeed: {},
  templateApproved: false,
  originalScheduledAt: NOW,
  deferredCount: 0,
  followupId: FOLLOWUP,
};

function harness(overrides: Partial<SendToLeadDependencies> = {}) {
  const order: string[] = [];
  const persistence: SendPersistencePort = {
    loadReplay: vi.fn(async () => { order.push("replay"); return null; }),
    resolveTarget: vi.fn(async () => { order.push("target"); return target; }),
    isTestRecipientVerified: vi.fn(async () => { order.push("test-recipient"); return true; }),
    hasDeletionTombstone: vi.fn(async () => { order.push("tombstone"); return false; }),
    hasLiveSuppression: vi.fn(async () => { order.push("suppression"); return false; }),
    loadEligibility: vi.fn(async () => { order.push("eligibility"); return eligibility; }),
    loadControlCopy: vi.fn(async () => ({ approved: true, body: "Synthetic control copy" })),
    recordRefusal: vi.fn(async () => 41),
    persistDeferred: vi.fn(async () => ({ followupId: FOLLOWUP, auditId: 42 })),
    persistDiscarded: vi.fn(async () => ({ followupId: FOLLOWUP, auditId: 43 })),
    claimDispatch: vi.fn(async ({ content }) => {
      order.push("claim");
      return {
        kind: "claimed" as const,
        claimToken: "77777777-7777-4777-8777-777777777777",
        dispatchContent: content,
      };
    }),
    recordProviderAcceptance: vi.fn(async () => { order.push("accepted"); return true; }),
    markDispatchIndeterminate: vi.fn(async () => undefined),
    releaseUndispatchedClaim: vi.fn(async () => undefined),
    persistSend: vi.fn(async ({ dispatch }) => ({
      providerMessageId: dispatch.providerMessageId,
      messageId: "66666666-6666-4666-8666-666666666666",
      auditId: 44,
      persistedAt: NOW,
    })),
  };
  const dependencies: SendToLeadDependencies = {
    phaseEnabled: () => true,
    persistence,
    hashIdentifier: () => HASH,
    quietHours: { resolve: vi.fn(async () => ({ kind: "send_now" as const })) },
    dispatch: {
      send: vi.fn(async () => ({ providerMessageId: "provider-message-1", acceptedAt: NOW })),
    },
    now: () => NOW,
    ...overrides,
  };
  return { dependencies, persistence, order };
}

describe("sendToLead", () => {
  it("returns an evidence-complete sent result after every ordered check", async () => {
    const { dependencies, order } = harness();
    const result = await sendToLead(baseRequest, dependencies);
    expect(result).toEqual({
      kind: "sent",
      channel: "sms",
      receipt: {
        tenantId: TENANT,
        contactId: CONTACT,
        conversationId: CONVERSATION,
        identityId: IDENTITY,
        purpose: "follow_up",
        idempotencyKey: "send:test:1",
        decidedAt: NOW,
        auditId: 44,
        providerMessageId: "provider-message-1",
        messageId: "66666666-6666-4666-8666-666666666666",
        persistedAt: NOW,
      },
    });
    expect(order).toEqual([
      "target", "replay", "tombstone", "suppression", "eligibility", "claim", "accepted",
    ]);
  });

  it("dispatches the claim-time SMS body and marks standing-consent sends as campaign initiated", async () => {
    const { dependencies, persistence } = harness();
    vi.mocked(persistence.claimDispatch).mockResolvedValue({
      kind: "claimed",
      claimToken: "77777777-7777-4777-8777-777777777777",
      dispatchContent: {
        kind: "freeform",
        body: "Synthetic test message\n\nMsg & data rates may apply. Reply STOP to opt out.",
      },
    });

    await sendToLead(baseRequest, dependencies);

    expect(persistence.claimDispatch).toHaveBeenCalledWith(expect.objectContaining({
      campaignInitiated: true,
    }));
    expect(dependencies.dispatch.send).toHaveBeenCalledWith(expect.objectContaining({
      content: {
        kind: "freeform",
        body: "Synthetic test message\n\nMsg & data rates may apply. Reply STOP to opt out.",
      },
    }));
  });

  it("does not mark an inbound reply-in-turn as campaign initiated", async () => {
    const { dependencies, persistence } = harness();
    vi.mocked(persistence.loadEligibility).mockResolvedValue({
      ...eligibility,
      state: "reply_only",
      source: "inbound_message",
      replyInTurn: true,
    });

    await sendToLead({ ...baseRequest, purpose: "agent_reply" }, dependencies);

    expect(persistence.claimDispatch).toHaveBeenCalledWith(expect.objectContaining({
      campaignInitiated: false,
    }));
  });

  it("lets an unverified test recipient through only when the dispatch route is simulated", async () => {
    const { dependencies, persistence } = harness();
    vi.mocked(persistence.isTestRecipientVerified).mockResolvedValue(false);
    dependencies.dispatch.simulates = vi.fn(async () => true);
    const result = await sendToLead({ ...baseRequest, isTest: true }, dependencies);
    expect(result.kind).toBe("sent");
    expect(persistence.isTestRecipientVerified).not.toHaveBeenCalled();
    expect(persistence.hasDeletionTombstone).toHaveBeenCalled();

    dependencies.dispatch.simulates = vi.fn(async () => false);
    const refused = await sendToLead({ ...baseRequest, isTest: true }, dependencies);
    expect(refused.kind === "refused" && refused.reason).toBe("test_recipient_not_verified");
  });

  it("refuses an unverified test recipient before suppression, eligibility, or dispatch", async () => {
    const { dependencies, persistence, order } = harness();
    vi.mocked(persistence.isTestRecipientVerified).mockResolvedValue(false);
    const result = await sendToLead({ ...baseRequest, isTest: true }, dependencies);
    expect(result.kind === "refused" && result.reason).toBe("test_recipient_not_verified");
    expect(order).toEqual(["target", "replay"]);
    expect(persistence.isTestRecipientVerified).toHaveBeenCalledOnce();
    expect(persistence.loadEligibility).not.toHaveBeenCalled();
    expect(dependencies.dispatch.send).not.toHaveBeenCalled();
  });

  it("checks the peppered tombstone before contact-dependent eligibility", async () => {
    const { dependencies, persistence, order } = harness();
    vi.mocked(persistence.hasDeletionTombstone).mockResolvedValue(true);
    const result = await sendToLead(baseRequest, dependencies);
    expect(result.kind === "refused" && result.reason).toBe("suppressed");
    expect(order).toEqual(["target", "replay"]);
    expect(persistence.hasDeletionTombstone).toHaveBeenCalledOnce();
    expect(persistence.loadEligibility).not.toHaveBeenCalled();
  });

  it.each([
    { state: "unverified" as const, source: "imported_attested" as const, expiresAt: null },
    { state: "opted_in" as const, source: "imported_attested" as const, expiresAt: null },
    { state: "conversation" as const, source: "inbound_message" as const, expiresAt: "2026-08-16T12:00:00Z" },
    { state: "reply_only" as const, source: "inbound_message" as const, expiresAt: null },
  ])("refuses campaign evidence that cannot authorize the target channel: %j", async (consent) => {
    const { dependencies, persistence } = harness();
    vi.mocked(persistence.loadEligibility).mockResolvedValue({
      ...eligibility,
      ...consent,
      conversationChannel: "instagram",
      targetChannel: "sms",
    });
    const result = await sendToLead(baseRequest, dependencies);
    expect(result.kind === "refused" && result.reason).toBe("no_consent_basis");
    expect(dependencies.quietHours.resolve).not.toHaveBeenCalled();
    expect(dependencies.dispatch.send).not.toHaveBeenCalled();
  });

  it("defers once with the persisted follow-up and audit receipt", async () => {
    const { dependencies } = harness({
      quietHours: {
        resolve: async () => ({
          kind: "defer_once",
          at: "2026-08-18T12:15:00.000Z",
          timezoneSource: "npa",
          leadLocalTimes: ["America/New_York: 7:00 AM"],
          allowedWindow: "8:00 AM–8:00 PM",
        }),
      },
    });
    const result = await sendToLead(baseRequest, dependencies);
    expect(result).toMatchObject({
      kind: "deferred",
      reason: "quiet_hours",
      scheduledAt: "2026-08-18T12:15:00.000Z",
      timezoneSource: "npa",
      followupId: FOLLOWUP,
      receipt: { auditId: 42 },
    });
    expect(dependencies.dispatch.send).not.toHaveBeenCalled();
  });

  it("requires an explicit human confirmation before bypassing quiet hours", async () => {
    const quietHours = {
      resolve: vi.fn(async () => ({
        kind: "defer_once" as const,
        at: "2026-08-18T12:15:00.000Z",
        timezoneSource: "contact" as const,
        leadLocalTimes: ["America/New_York: 7:00 AM"],
        allowedWindow: "8:00 AM–8:00 PM",
      })),
    };
    const { dependencies, persistence } = harness({ quietHours });
    const request = { ...baseRequest, purpose: "human_reply" as const };

    await expect(sendToLead(request, dependencies)).resolves.toMatchObject({
      kind: "confirmation_required",
      reason: "quiet_hours",
      leadLocalTimes: ["America/New_York: 7:00 AM"],
      allowedWindow: "8:00 AM–8:00 PM",
    });
    expect(persistence.persistDeferred).not.toHaveBeenCalled();
    expect(dependencies.dispatch.send).not.toHaveBeenCalled();

    await expect(sendToLead({ ...request, humanQuietHoursOverride: true }, dependencies))
      .resolves.toMatchObject({ kind: "sent" });
    expect(dependencies.dispatch.send).toHaveBeenCalledOnce();
  });

  it("discards a closed provider window when capability cannot send", async () => {
    const { dependencies, persistence } = harness();
    vi.mocked(persistence.loadEligibility).mockResolvedValue({
      ...eligibility,
      providerWindowOpen: false,
      targetChannel: "instagram",
    });
    vi.mocked(persistence.resolveTarget).mockResolvedValue({ ...target, channel: "instagram" });
    const result = await sendToLead(baseRequest, dependencies);
    expect(result).toMatchObject({ kind: "discarded", reason: "provider_window_closed" });
    expect(dependencies.dispatch.send).not.toHaveBeenCalled();
  });

  it("uses only approved link-free control copy and bypasses suppression and quiet hours", async () => {
    const { dependencies, persistence } = harness();
    vi.mocked(persistence.hasLiveSuppression).mockResolvedValue(true);
    const request = { ...baseRequest, purpose: "stop_confirmation" as const };
    const result = await sendToLead(request, dependencies);
    expect(result.kind).toBe("sent");
    expect(dependencies.quietHours.resolve).not.toHaveBeenCalled();
    expect(dependencies.dispatch.send).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "stop_confirmation",
      content: { kind: "freeform", body: "Synthetic control copy" },
    }));
  });

  it("refuses placeholder or promotional control copy instead of accepting a bypass boolean", async () => {
    const { dependencies, persistence } = harness();
    vi.mocked(persistence.loadControlCopy).mockResolvedValue({
      approved: true,
      body: "SETTERFI_DEMO_PLACEHOLDER_STOP_COPY https://example.test",
    });
    const result = await sendToLead(
      { ...baseRequest, purpose: "stop_confirmation" },
      dependencies,
    );
    expect(result.kind === "refused" && result.reason).toBe("copy_unapproved");
    expect(dependencies.dispatch.send).not.toHaveBeenCalled();
  });

  it("returns provider_unconfirmed when acceptance cannot be persisted and read back", async () => {
    const { dependencies, persistence } = harness();
    vi.mocked(persistence.persistSend).mockResolvedValue(null);
    const result = await sendToLead(baseRequest, dependencies);
    expect(result.kind === "refused" && result.reason).toBe("provider_unconfirmed");
  });

  it("allows only one concurrent caller to cross the physical dispatch boundary", async () => {
    const { dependencies, persistence } = harness();
    let releaseDispatch!: () => void;
    const dispatchBlocked = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    vi.mocked(dependencies.dispatch.send).mockImplementation(async () => {
      await dispatchBlocked;
      return { providerMessageId: "provider-concurrent", acceptedAt: NOW };
    });
    vi.mocked(persistence.claimDispatch)
      .mockResolvedValueOnce({
        kind: "claimed",
        claimToken: "77777777-7777-4777-8777-777777777777",
        dispatchContent: baseRequest.content,
      })
      .mockResolvedValueOnce({ kind: "in_progress" });

    const first = sendToLead(baseRequest, dependencies);
    await vi.waitFor(() => expect(dependencies.dispatch.send).toHaveBeenCalledOnce());
    const second = await sendToLead(baseRequest, dependencies);
    releaseDispatch();

    expect(second).toMatchObject({ kind: "refused", reason: "provider_unconfirmed" });
    await expect(first).resolves.toMatchObject({ kind: "sent" });
    expect(dependencies.dispatch.send).toHaveBeenCalledOnce();
  });

  it("resumes local persistence after provider acceptance without sending again", async () => {
    const { dependencies, persistence } = harness();
    vi.mocked(persistence.claimDispatch)
      .mockResolvedValueOnce({
        kind: "claimed",
        claimToken: "77777777-7777-4777-8777-777777777777",
        dispatchContent: baseRequest.content,
      })
      .mockResolvedValueOnce({
        kind: "resume_accepted",
        claimToken: "88888888-8888-4888-8888-888888888888",
        dispatch: { providerMessageId: "provider-message-1", acceptedAt: NOW },
      });
    vi.mocked(persistence.persistSend)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        providerMessageId: "provider-message-1",
        messageId: "66666666-6666-4666-8666-666666666666",
        auditId: 44,
        persistedAt: NOW,
      });

    await expect(sendToLead(baseRequest, dependencies)).resolves.toMatchObject({
      kind: "refused", reason: "provider_unconfirmed",
    });
    await expect(sendToLead(baseRequest, dependencies)).resolves.toMatchObject({ kind: "sent" });
    expect(dependencies.dispatch.send).toHaveBeenCalledOnce();
    expect(persistence.recordProviderAcceptance).toHaveBeenCalledOnce();
    expect(persistence.persistSend).toHaveBeenLastCalledWith(expect.objectContaining({
      claimToken: "88888888-8888-4888-8888-888888888888",
    }));
  });

  it("records an uncertain provider failure and never retries an indeterminate attempt", async () => {
    const { dependencies, persistence } = harness();
    vi.mocked(dependencies.dispatch.send).mockRejectedValueOnce(new Error("fetch failed"));
    vi.mocked(persistence.claimDispatch)
      .mockResolvedValueOnce({
        kind: "claimed",
        claimToken: "77777777-7777-4777-8777-777777777777",
        dispatchContent: baseRequest.content,
      })
      .mockResolvedValueOnce({ kind: "indeterminate" });

    await expect(sendToLead(baseRequest, dependencies)).resolves.toMatchObject({
      kind: "refused", reason: "provider_unconfirmed",
    });
    await expect(sendToLead(baseRequest, dependencies)).resolves.toMatchObject({
      kind: "refused", reason: "provider_unconfirmed",
    });
    expect(dependencies.dispatch.send).toHaveBeenCalledOnce();
    expect(persistence.markDispatchIndeterminate).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "fetch failed",
    }));
  });

  it("releases a claim when configuration fails before a provider request can start", async () => {
    const { dependencies, persistence } = harness();
    vi.mocked(dependencies.dispatch.send).mockRejectedValue(
      new DriverConfigurationError("ghl", ["GHL_CLIENT_ID"]),
    );

    await expect(sendToLead(baseRequest, dependencies)).rejects.toMatchObject({
      code: "DRIVER_CONFIGURATION_ERROR",
    });
    expect(persistence.releaseUndispatchedClaim).toHaveBeenCalledWith({
      request: baseRequest,
      claimToken: "77777777-7777-4777-8777-777777777777",
    });
    expect(persistence.markDispatchIndeterminate).not.toHaveBeenCalled();
  });

  it("returns the prior evidence-complete result for an idempotent replay", async () => {
    const { dependencies, persistence } = harness();
    const prior = {
      kind: "refused" as const,
      reason: "suppressed" as const,
      receipt: {
        tenantId: TENANT,
        contactId: CONTACT,
        conversationId: CONVERSATION,
        identityId: IDENTITY,
        purpose: "follow_up" as const,
        idempotencyKey: "send:test:1",
        decidedAt: NOW,
        auditId: 10,
      },
    };
    vi.mocked(persistence.loadReplay).mockResolvedValue(prior);
    await expect(sendToLead(baseRequest, dependencies)).resolves.toEqual(prior);
    expect(persistence.claimDispatch).not.toHaveBeenCalled();
    expect(dependencies.dispatch.send).not.toHaveBeenCalled();
  });
});

describe("createProviderDispatchPort", () => {
  function providerHarness(environment: Record<string, string | undefined>) {
    const send = vi.fn(async () => ({ providerMessageId: "provider-message-2" }));
    const dependencies: ProviderDispatchDependencies = {
      environment,
      resolveRoute: async () => ({ provider: "ghl", approvedTemplate: null }),
      createMock: () => ({ provider: "ghl", verifyWebhook: async () => true,
        normalizeInbound: async () => ({ events: [] }), capabilities: () => ({ windowed: false, postWindow: "none", templates: false }), send }),
      createReal: () => ({ provider: "ghl", verifyWebhook: async () => true,
        normalizeInbound: async () => ({ events: [] }), capabilities: () => ({ windowed: false, postWindow: "none", templates: false }), send }),
      now: () => NOW,
    };
    return { port: createProviderDispatchPort(dependencies), send };
  }

  const dispatchInput = {
    tenantId: TENANT,
    conversationId: CONVERSATION,
    identityId: IDENTITY,
    channel: "sms" as const,
    recipientExternalId: "synthetic-recipient",
    purpose: "agent_reply" as const,
    content: { kind: "freeform" as const, body: "Synthetic test message" },
    idempotencyKey: "send:test:2",
  };

  it("selects the explicit mock driver without provider credentials", async () => {
    const { port, send } = providerHarness({ SETTERFI_GHL_DRIVER: "mock" });
    await expect(port.send(dispatchInput)).resolves.toEqual({
      providerMessageId: "provider-message-2",
      acceptedAt: NOW,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "send:test:2" }));
  });

  it("keeps a send simulated once it has told the gateway that tenant simulates", async () => {
    const simulatedSend = vi.fn(async () => ({ providerMessageId: "simulated:abc" }));
    const send = vi.fn(async () => ({ providerMessageId: "provider-message-2" }));
    const driver = (provider: "ghl" | "meta_direct") => ({ provider, verifyWebhook: async () => true,
      normalizeInbound: async () => ({ events: [] }), capabilities: () => ({ windowed: false, postWindow: "none" as const, templates: false }), send });
    const port = createProviderDispatchPort({
      environment: { SETTERFI_GHL_DRIVER: "mock" },
      simulatedTenant: async () => true,
      // The tenant row flipped between the gateway's allowlist question and the route read.
      resolveRoute: async () => ({ provider: "ghl", approvedTemplate: null, simulated: false }),
      createMock: driver,
      createReal: () => driver("ghl"),
      createSimulated: (provider) => ({ ...driver(provider), send: simulatedSend }),
      now: () => NOW,
    });
    expect(await port.simulates?.({ tenantId: TENANT })).toBe(true);
    await expect(port.send(dispatchInput)).resolves.toMatchObject({ providerMessageId: "simulated:abc" });
    expect(simulatedSend).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed with named configuration when real dispatch is explicitly selected", async () => {
    const { port } = providerHarness({ SETTERFI_GHL_DRIVER: "real" });
    await expect(port.send(dispatchInput)).rejects.toEqual(expect.objectContaining({
      name: "DriverConfigurationError",
      code: "DRIVER_CONFIGURATION_ERROR",
      variableNames: expect.arrayContaining(["GHL_CLIENT_ID", "GHL_CLIENT_SECRET"]),
    } satisfies Partial<DriverConfigurationError>));
  });
});
