import { describe, expect, it, vi } from "vitest";

import {
  createProviderConnectionCommandService,
  selectConnectionCommandDriver,
  type ProviderConnectionCommandDependencies,
} from "./provider-connection-commands";

const connection = {
  id: "connection-1", tenantId: "tenant-1", provider: "ghl" as const,
  channel: "sms" as const, isDemo: false,
};

function dependencies() {
  return {
    loadConnection: vi.fn<ProviderConnectionCommandDependencies["loadConnection"]>(async () => connection),
    execute: vi.fn<ProviderConnectionCommandDependencies["execute"]>(async () => ({ outcome: "verified", code: "PROVIDER_READ_OK", evidence: { verified: true } })),
    beginReauthorization: vi.fn<ProviderConnectionCommandDependencies["beginReauthorization"]>(async () => ({ outcome: "started", code: "OAUTH_STARTED", evidence: {} })),
    claimReplay: vi.fn<ProviderConnectionCommandDependencies["claimReplay"]>(async () => ({ replayed: true, alreadyCompleted: false })),
    record: vi.fn<ProviderConnectionCommandDependencies["record"]>(async (input) => ({
      receiptId: "receipt-1", auditId: 12, replayed: false, outcome: input.result.outcome,
    })),
    channelEvents: undefined as ProviderConnectionCommandDependencies["channelEvents"],
    environment: { SETTERFI_GHL_DRIVER: "real" } as ProviderConnectionCommandDependencies["environment"],
  } satisfies ProviderConnectionCommandDependencies;
}

describe("provider connection command service", () => {
  it.each([
    ["test", undefined, "verified"],
    ["template_sync", undefined, "verified"],
    ["disconnect", undefined, "verified"],
    ["reconnect", undefined, "started"],
    ["replay", "webhook-1", "replayed"],
  ] as const)("records the %s success path", async (command, sourceReceiptId, expectedOutcome) => {
    const deps = dependencies();
    if (command === "replay") {
      deps.execute.mockResolvedValueOnce({ outcome: "replayed", code: "WEBHOOK_REPLAY_DISPATCHED", evidence: {} });
    }
    const service = createProviderConnectionCommandService(deps);
    await expect(service.run({
      tenantId: "tenant-1", connectionId: "connection-1", actorId: "actor-1", command,
      idempotencyKey: `${command}-success`, ...(sourceReceiptId ? { sourceReceiptId } : {}),
    })).resolves.toMatchObject({ outcome: expectedOutcome });
  });

  it.each([
    ["test", undefined], ["template_sync", undefined], ["disconnect", undefined],
    ["reconnect", undefined], ["replay", "webhook-1"],
  ] as const)("records the %s failure path as not verified", async (command, sourceReceiptId) => {
    const deps = dependencies();
    if (command === "reconnect") deps.beginReauthorization.mockRejectedValueOnce(new Error("unavailable"));
    else deps.execute.mockRejectedValueOnce(new Error("unavailable"));
    const service = createProviderConnectionCommandService(deps);
    await expect(service.run({
      tenantId: "tenant-1", connectionId: "connection-1", actorId: "actor-1", command,
      idempotencyKey: `${command}-failure`, ...(sourceReceiptId ? { sourceReceiptId } : {}),
    })).resolves.toMatchObject({ outcome: "not_verified", code: "PROVIDER_COMMAND_UNAVAILABLE" });
  });

  it("records real probe success and an unavailable probe as not verified", async () => {
    const deps = dependencies();
    const service = createProviderConnectionCommandService(deps);
    await expect(service.run({ tenantId: "tenant-1", connectionId: "connection-1", actorId: "actor-1", command: "test", idempotencyKey: "test-ok" }))
      .resolves.toMatchObject({ outcome: "verified", code: "PROVIDER_READ_OK" });

    deps.execute.mockRejectedValueOnce(new Error("network"));
    await expect(service.run({ tenantId: "tenant-1", connectionId: "connection-1", actorId: "actor-1", command: "test", idempotencyKey: "test-failed" }))
      .resolves.toMatchObject({ outcome: "not_verified", code: "PROVIDER_COMMAND_UNAVAILABLE" });
  });

  it("refuses mock work for a real tenant and production mock selection throws", () => {
    expect(() => selectConnectionCommandDriver(connection, { SETTERFI_GHL_DRIVER: "mock" }))
      .toThrow("MOCK_DRIVER_REFUSED_FOR_REAL_TENANT");
    expect(() => selectConnectionCommandDriver({ ...connection, isDemo: true }, {
      SETTERFI_GHL_DRIVER: "mock", NODE_ENV: "production",
    })).toThrow();
  });

  it("never lets a demo mock read as a real provider verification", async () => {
    const deps = dependencies();
    deps.loadConnection.mockResolvedValue({ ...connection, isDemo: true });
    deps.environment = { SETTERFI_GHL_DRIVER: "mock" };
    const service = createProviderConnectionCommandService(deps);
    await expect(service.run({ tenantId: "tenant-1", connectionId: "connection-1", actorId: "actor-1", command: "test", idempotencyKey: "mock-test" }))
      .resolves.toMatchObject({ outcome: "not_verified", code: "MOCK_PROVIDER_NOT_VERIFIED" });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("does not execute an already-completed replay a second time", async () => {
    const deps = dependencies();
    deps.claimReplay.mockResolvedValue({ replayed: false, alreadyCompleted: true });
    const service = createProviderConnectionCommandService(deps);
    const result = await service.run({ tenantId: "tenant-1", connectionId: "connection-1", actorId: "actor-1", command: "replay", idempotencyKey: "replay-1", sourceReceiptId: "webhook-1" });
    expect(result).toMatchObject({ outcome: "replayed", code: "REPLAY_ALREADY_COMPLETED" });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("records template sync success and disconnect failures without claiming a disconnect", async () => {
    const deps = dependencies();
    const service = createProviderConnectionCommandService(deps);
    await expect(service.run({ tenantId: "tenant-1", connectionId: "connection-1", actorId: "actor-1", command: "template_sync", idempotencyKey: "templates-1" }))
      .resolves.toMatchObject({ outcome: "verified", code: "PROVIDER_READ_OK" });

    deps.execute.mockRejectedValueOnce(new Error("revoke timeout"));
    await expect(service.run({ tenantId: "tenant-1", connectionId: "connection-1", actorId: "actor-1", command: "disconnect", idempotencyKey: "disconnect-1" }))
      .resolves.toMatchObject({ outcome: "not_verified", code: "PROVIDER_COMMAND_UNAVAILABLE" });
    expect(deps.record).toHaveBeenLastCalledWith(expect.objectContaining({
      command: "disconnect",
      result: expect.objectContaining({ providerRevoked: false }),
    }));
  });

  it("emits a durable channel-disconnected fact only after provider revocation is recorded", async () => {
    const deps = dependencies();
    const emit = vi.fn(async () => ({ notificationIds: ["notification-1"] }));
    deps.channelEvents = { emit };
    deps.environment = {
      SETTERFI_GHL_DRIVER: "real",
      SETTERFI_PHASE8_LIVE: "true",
      SETTERFI_PHASE8_ALERTS_LIVE: "true",
      SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE: "true",
    };
    deps.execute.mockResolvedValueOnce({
      outcome: "verified",
      code: "PROVIDER_REVOKED",
      evidence: { providerRevoked: true },
      providerRevoked: true,
    });
    const service = createProviderConnectionCommandService(deps);
    await service.run({
      tenantId: "tenant-1", connectionId: "connection-1", actorId: "actor-1",
      command: "disconnect", idempotencyKey: "disconnect-notice",
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      key: "channel.disconnected",
      connectionId: "connection-1",
      commandReceiptId: "receipt-1",
    }));
  });

  it("keeps the prior credential outside reauthorization until the provider completes it", async () => {
    const deps = dependencies();
    const priorCredential = { envelope: "existing" };
    deps.beginReauthorization.mockImplementation(async () => {
      expect(priorCredential).toEqual({ envelope: "existing" });
      throw new Error("provider declined");
    });
    const service = createProviderConnectionCommandService(deps);
    await service.run({ tenantId: "tenant-1", connectionId: "connection-1", actorId: "actor-1", command: "reconnect", idempotencyKey: "reauth-1" });
    expect(priorCredential).toEqual({ envelope: "existing" });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ outcome: "not_verified" }) }));
  });
});
