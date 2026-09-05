import { describe, expect, it, vi } from "vitest";

import { rehearseLeadTurn, type RehearsalDependencies } from "./rehearsal";

const thread = {
  isDemo: true,
  isTest: true,
  channel: "messenger",
  identity: {
    provider: "meta_direct" as const,
    channel: "messenger" as const,
    externalId: "psid-1",
    normalizedPhone: null,
    normalizedEmail: null,
    providerAccountId: "page-1",
  },
};

function harness(overrides: Partial<RehearsalDependencies> = {}) {
  const receipt = {
    id: "r1",
    provider: "meta" as const,
    providerEventId: "x",
    tenantId: "t1",
    eventType: "InboundMessage",
    payload: {},
    status: "received" as const,
  };
  const dependencies: RehearsalDependencies = {
    loadThread: vi.fn(async () => thread),
    persistReceipt: vi.fn(async () => receipt as never),
    processReceipt: vi.fn(async () => ({ kind: "batch" as const, events: [] })),
    readOutcome: vi.fn(async () => ({
      receiptStatus: "processed" as const,
      error: null,
      conversationStatus: "agent",
      reply: null,
    })),
    now: () => new Date("2026-09-05T02:00:00.000Z"),
    ...overrides,
  };
  return dependencies;
}

const input = { tenantId: "t1", conversationId: "c1", actorId: "u1", body: "Is this legit?" };

describe("rehearseLeadTurn", () => {
  it("refuses anything but a demo tenant's test thread with a lead identity", async () => {
    await expect(rehearseLeadTurn(input, harness({ loadThread: async () => null })))
      .rejects.toThrow("REHEARSAL_CONVERSATION_NOT_FOUND");
    await expect(rehearseLeadTurn(input, harness({ loadThread: async () => ({ ...thread, isDemo: false }) })))
      .rejects.toThrow("REHEARSAL_THREAD_NOT_REHEARSABLE");
    await expect(rehearseLeadTurn(input, harness({ loadThread: async () => ({ ...thread, isTest: false }) })))
      .rejects.toThrow("REHEARSAL_THREAD_NOT_REHEARSABLE");
    await expect(rehearseLeadTurn(input, harness({ loadThread: async () => ({ ...thread, identity: null }) })))
      .rejects.toThrow("REHEARSAL_IDENTITY_REQUIRED");
  });

  it("writes a tenant-scoped receipt shaped like a provider webhook and runs the processor on it", async () => {
    const dependencies = harness();
    await rehearseLeadTurn(input, dependencies);
    const write = vi.mocked(dependencies.persistReceipt).mock.calls[0][0];
    expect(write.provider).toBe("meta");
    expect(write.tenantId).toBe("t1");
    expect(write.eventType).toBe("InboundMessage");
    expect(write.providerEventId.startsWith("t1:rehearsal:c1:")).toBe(true);
    const events = (write.payload.normalized as { events: Array<Record<string, unknown>> }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "message",
      body: "Is this legit?",
      externalAccountId: "page-1",
      identity: { channel: "messenger", provider: "meta_direct", externalId: "psid-1" },
      providerWindow: { source: "derived_24h" },
    });
    expect(write.payload.raw).toEqual({ rehearsal: true, actorId: "u1" });
    expect(dependencies.processReceipt).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
  });

  it("names what the processor did, and calls a quiet-hours refusal a deferral", async () => {
    const refused = await rehearseLeadTurn(input, harness({
      processReceipt: async () => ({
        kind: "batch",
        events: [{ kind: "refused", eventId: "e", reason: "test_recipient_not_verified" } as never],
      }),
    }));
    expect(refused.turn).toEqual({ kind: "refused", reason: "test_recipient_not_verified" });

    const deferred = await rehearseLeadTurn(input, harness({
      processReceipt: async () => ({
        kind: "batch",
        events: [{ kind: "refused", eventId: "e", reason: "quiet_hours" } as never],
      }),
    }));
    expect(deferred.turn).toEqual({ kind: "deferred", reason: "quiet_hours" });

    const unclaimed = await rehearseLeadTurn(input, harness({ processReceipt: async () => null }));
    expect(unclaimed.turn).toBeNull();
  });

  it("keeps a processor failure as the outcome's error instead of throwing it away", async () => {
    const outcome = await rehearseLeadTurn(input, harness({
      processReceipt: async () => { throw new Error("CHANNEL_CONNECTION_UNAVAILABLE"); },
    }));
    expect(outcome.error).toBe("CHANNEL_CONNECTION_UNAVAILABLE");
    expect(outcome.receiptId).toBe("r1");
  });
});
