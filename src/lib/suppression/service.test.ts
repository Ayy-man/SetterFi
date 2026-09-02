import { describe, expect, it, vi } from "vitest";

import type { SendToLeadResult } from "@/lib/sends/contracts";
import {
  createMockSuppressionProviderPort,
  processSuppressionControl,
  type InboundControlInput,
  type KeywordSuppressionWrite,
  type SuppressionIdentity,
  type SuppressionRepository,
  type SuppressionServiceDependencies,
} from "@/lib/suppression/service";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const SMS_IDENTITY = "44444444-4444-4444-8444-444444444444";
const META_IDENTITY = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-08-17T12:00:00.000Z";

const inbound: InboundControlInput = {
  tenantId: TENANT,
  contactId: CONTACT,
  conversationId: CONVERSATION,
  inboundIdentityId: SMS_IDENTITY,
  channel: "sms",
  body: "synthetic-control",
  providerMessageId: "synthetic-inbound-1",
  occurredAt: NOW,
  isTest: true,
};

const identities: readonly SuppressionIdentity[] = [
  {
    tenantId: TENANT,
    contactId: CONTACT,
    identityId: SMS_IDENTITY,
    provider: "ghl",
    channel: "sms",
    recipientExternalId: "synthetic-sms",
    providerIdentityId: "synthetic-sms",
    normalizedIdentifier: "+15555550100",
    suppressionId: "66666666-6666-4666-8666-666666666666",
  },
  {
    tenantId: TENANT,
    contactId: CONTACT,
    identityId: META_IDENTITY,
    provider: "meta_direct",
    channel: "instagram",
    recipientExternalId: "synthetic-meta",
    providerIdentityId: "synthetic-meta",
    normalizedIdentifier: "synthetic-meta",
    suppressionId: "77777777-7777-4777-8777-777777777777",
  },
];

const sent: SendToLeadResult = {
  kind: "sent",
  channel: "sms",
  receipt: {
    tenantId: TENANT,
    contactId: CONTACT,
    conversationId: CONVERSATION,
    identityId: SMS_IDENTITY,
    purpose: "stop_confirmation",
    idempotencyKey: "control:stop:synthetic-inbound-1",
    decidedAt: NOW,
    auditId: 10,
    providerMessageId: "synthetic-provider-message",
    messageId: "88888888-8888-4888-8888-888888888888",
    persistedAt: NOW,
  },
};

function harness(local: Partial<KeywordSuppressionWrite> = {}) {
  const order: string[] = [];
  const repository: SuppressionRepository = {
    loadContactIdentities: vi.fn(async () => identities),
    recordKeywordSuppression: vi.fn(async () => {
      order.push("local");
      return {
        suppressionIds: identities.map((identity) => identity.suppressionId!),
        confirmationReserved: true,
        auditId: 20,
        ...local,
      };
    }),
    recordProviderResult: vi.fn(async ({ confirmed }) => {
      order.push(confirmed ? "provider-confirmed" : "provider-unconfirmed");
      return 21;
    }),
    clearIdentitySuppression: vi.fn(async () => {
      order.push("local-clear");
      return 22;
    }),
    markStopConfirmationSent: vi.fn(async () => {
      order.push("confirmation-readback");
      return true;
    }),
  };
  const gateway = {
    send: vi.fn(async () => {
      order.push("confirmation-send");
      return sent;
    }),
  };
  const baseProvider = createMockSuppressionProviderPort(() => NOW);
  const provider = {
    suppress: vi.fn(async (input) => {
      order.push("provider-suppress");
      return baseProvider.suppress(input);
    }),
    clear: vi.fn(async (input) => {
      order.push("provider-clear");
      return baseProvider.clear(input);
    }),
    readBack: vi.fn(async (input) => {
      order.push("provider-readback");
      return baseProvider.readBack(input);
    }),
  };
  const dependencies: SuppressionServiceDependencies = {
    repository,
    provider,
    gateway,
    hashIdentifier: (value) => value === "+15555550100" ? "a".repeat(64) : "b".repeat(64),
    classify: () => ({ kind: "stop", tier: "keyword", matched: "stop" }),
    now: () => NOW,
  };
  return { dependencies, repository, provider, gateway, order };
}

describe("processSuppressionControl", () => {
  it("commits tenant-wide local STOP before one confirmation and provider read-back", async () => {
    const { dependencies, repository, gateway, order } = harness();
    const result = await processSuppressionControl(inbound, dependencies);
    expect(result).toMatchObject({
      kind: "stop",
      localAuditId: 20,
      provider: "confirmed",
      confirmation: { kind: "sent" },
    });
    expect(repository.recordKeywordSuppression).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      contactId: CONTACT,
      channels: ["sms", "instagram"],
      identifierHashes: ["a".repeat(64), "b".repeat(64)],
      source: "stop_keyword",
    }));
    expect(gateway.send).toHaveBeenCalledOnce();
    expect(order[0]).toBe("local");
    expect(order.indexOf("confirmation-send")).toBeLessThan(order.indexOf("provider-suppress"));
  });

  it("does not send a second confirmation for a replayed STOP", async () => {
    const { dependencies, gateway } = harness({ confirmationReserved: false });
    const result = await processSuppressionControl(inbound, dependencies);
    expect(result).toMatchObject({ kind: "stop", confirmation: "not_reserved" });
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it("does not send a confirmation after the five-minute control window", async () => {
    const { dependencies, gateway } = harness();
    dependencies.now = () => "2026-08-17T12:05:00.001Z";
    const result = await processSuppressionControl(inbound, dependencies);
    expect(result).toMatchObject({ kind: "stop", confirmation: "expired" });
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it("keeps local STOP authoritative when provider read-back fails", async () => {
    const { dependencies, provider, repository } = harness();
    vi.mocked(provider.readBack).mockRejectedValue(new Error("synthetic provider failure"));
    const result = await processSuppressionControl(inbound, dependencies);
    expect(result).toMatchObject({ kind: "stop", provider: "unconfirmed" });
    expect(repository.recordProviderResult).toHaveBeenCalledWith(expect.objectContaining({
      confirmed: false,
      error: "PROVIDER_SUPPRESSION_READBACK_FAILED",
    }));
  });

  it("returns copy_unapproved from the gateway without marking a confirmation sent", async () => {
    const { dependencies, gateway, repository } = harness();
    vi.mocked(gateway.send).mockResolvedValue({
      kind: "refused",
      reason: "copy_unapproved",
      receipt: {
        tenantId: TENANT,
        contactId: CONTACT,
        conversationId: CONVERSATION,
        identityId: SMS_IDENTITY,
        purpose: "stop_confirmation",
        idempotencyKey: "control:stop:synthetic-inbound-1",
        decidedAt: NOW,
        auditId: null,
      },
    });
    const result = await processSuppressionControl(inbound, dependencies);
    expect(result).toMatchObject({
      kind: "stop",
      confirmation: { kind: "refused", reason: "copy_unapproved" },
    });
    expect(repository.markStopConfirmationSent).not.toHaveBeenCalled();
  });

  it("answers HELP through the gateway without mutating suppression", async () => {
    const { dependencies, repository, gateway } = harness();
    dependencies.classify = () => ({ kind: "help", matched: "help" });
    const result = await processSuppressionControl(inbound, dependencies);
    expect(result.kind).toBe("help");
    expect(repository.recordKeywordSuppression).not.toHaveBeenCalled();
    expect(gateway.send).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "help_confirmation",
    }));
  });

  it("leaves every local identity suppressed when START provider proof is absent", async () => {
    const { dependencies, provider, repository, gateway } = harness();
    dependencies.classify = () => ({ kind: "start", matched: "start" });
    vi.mocked(provider.readBack).mockResolvedValue({
      providerOperationId: "mismatched-operation",
      suppressed: false,
      observedAt: NOW,
    });
    const result = await processSuppressionControl(inbound, dependencies);
    expect(result).toEqual({
      kind: "start",
      provider: "unconfirmed",
      localAuditId: null,
      confirmation: null,
    });
    expect(repository.clearIdentitySuppression).not.toHaveBeenCalled();
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it("clears only the inbound identity and channel after START provider proof", async () => {
    const { dependencies, repository, gateway, order } = harness();
    dependencies.classify = () => ({ kind: "start", matched: "start" });
    const result = await processSuppressionControl(inbound, dependencies);
    expect(result).toMatchObject({ kind: "start", provider: "confirmed", localAuditId: 22 });
    expect(repository.clearIdentitySuppression).toHaveBeenCalledWith({
      tenantId: TENANT,
      contactId: CONTACT,
      identityId: SMS_IDENTITY,
      identifierHash: "a".repeat(64),
      providerConfirmed: true,
    });
    expect(repository.clearIdentitySuppression).toHaveBeenCalledOnce();
    expect(gateway.send).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "start_confirmation",
      nominatedIdentityId: SMS_IDENTITY,
    }));
    expect(order.indexOf("provider-readback")).toBeLessThan(order.indexOf("local-clear"));
    expect(order.indexOf("local-clear")).toBeLessThan(order.indexOf("confirmation-send"));
  });

  it("keeps a shared Meta/GHL suppression local when the GHL clear cannot be read back", async () => {
    const { dependencies, repository, provider, gateway } = harness();
    const shared: readonly SuppressionIdentity[] = [
      {
        ...identities[0],
        identityId: SMS_IDENTITY,
        provider: "ghl",
        channel: "whatsapp",
        normalizedIdentifier: "+15555550100",
        suppressionId: "99999999-9999-4999-8999-999999999999",
      },
      {
        ...identities[1],
        identityId: META_IDENTITY,
        provider: "meta_direct",
        channel: "whatsapp",
        normalizedIdentifier: "+15555550100",
        suppressionId: "99999999-9999-4999-8999-999999999999",
      },
    ];
    vi.mocked(repository.loadContactIdentities).mockResolvedValue(shared);
    dependencies.classify = () => ({ kind: "start", matched: "start" });
    vi.mocked(provider.readBack).mockImplementation(async (request) => ({
      providerOperationId: `mock-suppression:${request.idempotencyKey}`,
      suppressed: request.provider === "ghl",
      observedAt: NOW,
    }));

    const result = await processSuppressionControl({
      ...inbound,
      inboundIdentityId: META_IDENTITY,
      channel: "whatsapp",
    }, dependencies);

    expect(result).toMatchObject({ kind: "start", provider: "unconfirmed" });
    expect(provider.clear).toHaveBeenCalledTimes(2);
    expect(repository.clearIdentitySuppression).not.toHaveBeenCalled();
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it("clears a shared Meta/GHL suppression only after both providers confirm absence", async () => {
    const { dependencies, repository, provider, gateway, order } = harness();
    const shared: readonly SuppressionIdentity[] = [
      {
        ...identities[0],
        provider: "ghl",
        channel: "whatsapp",
        normalizedIdentifier: "+15555550100",
        suppressionId: "99999999-9999-4999-8999-999999999999",
      },
      {
        ...identities[1],
        provider: "meta_direct",
        channel: "whatsapp",
        normalizedIdentifier: "+15555550100",
        suppressionId: "99999999-9999-4999-8999-999999999999",
      },
    ];
    vi.mocked(repository.loadContactIdentities).mockResolvedValue(shared);
    dependencies.classify = () => ({ kind: "start", matched: "start" });

    const result = await processSuppressionControl({
      ...inbound,
      inboundIdentityId: META_IDENTITY,
      channel: "whatsapp",
    }, dependencies);

    expect(result).toMatchObject({ kind: "start", provider: "confirmed", localAuditId: 22 });
    expect(provider.clear).toHaveBeenCalledTimes(2);
    expect(provider.clear).toHaveBeenCalledWith(expect.objectContaining({ provider: "ghl" }));
    expect(provider.clear).toHaveBeenCalledWith(expect.objectContaining({ provider: "meta_direct" }));
    expect(repository.clearIdentitySuppression).toHaveBeenCalledOnce();
    expect(order.filter((entry) => entry === "provider-readback")).toHaveLength(2);
    expect(order.lastIndexOf("provider-readback")).toBeLessThan(order.indexOf("local-clear"));
    expect(gateway.send).toHaveBeenCalledOnce();
  });
});
