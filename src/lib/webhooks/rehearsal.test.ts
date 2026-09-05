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
    recordAudit: vi.fn(async () => audit),
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

const audit = {
  auditId: "a1",
  actionKey: "conversation.rehearsal.played" as const,
  label: "Rehearsal logged",
  ariaLabel: "Rehearsal turn recorded in the audit log",
};

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

  it("marks the receipt as a rehearsal in its payload, where the claim path can still process it", async () => {
    const dependencies = harness();
    await rehearseLeadTurn(input, dependencies);
    const write = vi.mocked(dependencies.persistReceipt).mock.calls[0][0];
    expect(write.payload.raw).toEqual({ rehearsal: true, actorId: "u1" });
    expect("signatureVerified" in write).toBe(false);
  });

  it("derives the event id from the caller's idempotency key so a retry lands on the same receipt", async () => {
    const dependencies = harness();
    await rehearseLeadTurn({ ...input, idempotencyKey: "0f2c9d3e-1b6a-4c8d-9e0f-123456789abc" }, dependencies);
    const write = vi.mocked(dependencies.persistReceipt).mock.calls[0][0];
    const eventId = "rehearsal:c1:0f2c9d3e-1b6a-4c8d-9e0f-123456789abc";
    expect(write.providerEventId).toBe(`t1:${eventId}:${eventId}`);
    const events = (write.payload.normalized as { events: Array<Record<string, unknown>> }).events;
    expect(events[0].eventId).toBe("rehearsal:c1:0f2c9d3e-1b6a-4c8d-9e0f-123456789abc");
    expect(events[0].providerMessageId).toBe(events[0].eventId);
  });

  it("reuses the receipt a retried key already wrote instead of persisting a second one", async () => {
    const existing = {
      id: "r-existing", provider: "meta" as const, providerEventId: "x", tenantId: "t1",
      eventType: "InboundMessage", payload: {}, status: "processed" as const,
    };
    const dependencies = harness({ findReceipt: vi.fn(async () => existing as never) });
    const outcome = await rehearseLeadTurn({ ...input, idempotencyKey: "0f2c9d3e-1b6a-4c8d-9e0f-123456789abc" }, dependencies);
    expect(dependencies.persistReceipt).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.findReceipt!).mock.calls[0][0]).toEqual({
      provider: "meta",
      providerEventId: "t1:rehearsal:c1:0f2c9d3e-1b6a-4c8d-9e0f-123456789abc:rehearsal:c1:0f2c9d3e-1b6a-4c8d-9e0f-123456789abc",
      tenantId: "t1",
    });
    expect(outcome.receiptId).toBe("r-existing");
    expect(outcome.replayed).toBe(true);
    // The replay still reads its audit row back; the RPC returns the row the first submit wrote.
    expect(dependencies.recordAudit).toHaveBeenCalledWith({
      tenantId: "t1", conversationId: "c1", actorId: "u1", receiptId: "r-existing",
    });
    expect(outcome.audit).toEqual(audit);
  });

  it("reports a replay the claim refused as in flight while the first submit still holds the lease", async () => {
    const leased = {
      id: "r-leased", provider: "meta" as const, providerEventId: "x", tenantId: "t1",
      eventType: "InboundMessage", payload: {}, status: "received" as const,
    };
    const dependencies = harness({
      findReceipt: vi.fn(async () => leased as never),
      // The claim RPC hands out nothing while the original request's lease is live.
      processReceipt: vi.fn(async () => null),
      readOutcome: vi.fn(async () => ({
        receiptStatus: "received" as const, error: null, conversationStatus: "agent", reply: null,
      })),
    });
    const outcome = await rehearseLeadTurn({ ...input, idempotencyKey: "0f2c9d3e-1b6a-4c8d-9e0f-123456789abc" }, dependencies);
    expect(outcome).toMatchObject({
      receiptId: "r-leased", replayed: true, inFlight: true, receiptStatus: "received", turn: null, error: null,
    });
    expect(dependencies.persistReceipt).not.toHaveBeenCalled();
  });

  it("does not call a replay in flight once its receipt is terminal, even though the claim refused it", async () => {
    const finished = {
      id: "r-done", provider: "meta" as const, providerEventId: "x", tenantId: "t1",
      eventType: "InboundMessage", payload: {}, status: "processed" as const,
    };
    const dependencies = harness({
      findReceipt: vi.fn(async () => finished as never),
      processReceipt: vi.fn(async () => null),
    });
    const outcome = await rehearseLeadTurn({ ...input, idempotencyKey: "0f2c9d3e-1b6a-4c8d-9e0f-123456789abc" }, dependencies);
    expect(outcome).toMatchObject({ replayed: true, inFlight: false, receiptStatus: "processed" });
  });

  it("does not call a first submit in flight when its own claim came back empty; that is a failure to report", async () => {
    const dependencies = harness({
      processReceipt: vi.fn(async () => null),
      readOutcome: vi.fn(async () => ({
        receiptStatus: "received" as const, error: null, conversationStatus: "agent", reply: null,
      })),
    });
    const outcome = await rehearseLeadTurn(input, dependencies);
    expect(outcome).toMatchObject({ replayed: false, inFlight: false, receiptStatus: "received", turn: null });
  });

  it("logs the line against its receipt before the processor runs, and returns the audit read back", async () => {
    const order: string[] = [];
    const dependencies = harness({
      recordAudit: vi.fn(async () => { order.push("audit"); return audit; }),
      processReceipt: vi.fn(async () => { order.push("process"); return { kind: "batch" as const, events: [] }; }),
    });
    const outcome = await rehearseLeadTurn(input, dependencies);
    expect(dependencies.recordAudit).toHaveBeenCalledWith({
      tenantId: "t1", conversationId: "c1", actorId: "u1", receiptId: "r1",
    });
    expect(order).toEqual(["audit", "process"]);
    expect(outcome.audit).toEqual(audit);
    expect(outcome.audit.auditId).toBe("a1");
  });

  it("does not play a line it could not log", async () => {
    const dependencies = harness({
      recordAudit: vi.fn(async () => { throw new Error("REHEARSAL_AUDIT_REFUSED:denied"); }),
    });
    await expect(rehearseLeadTurn(input, dependencies)).rejects.toThrow("REHEARSAL_AUDIT_REFUSED");
    expect(dependencies.processReceipt).not.toHaveBeenCalled();
    expect(dependencies.readOutcome).not.toHaveBeenCalled();
  });

  it("reads the outcome back by the event it wrote, not by whatever was newest", async () => {
    const dependencies = harness();
    await rehearseLeadTurn(input, dependencies);
    const write = vi.mocked(dependencies.persistReceipt).mock.calls[0][0];
    const events = (write.payload.normalized as { events: Array<Record<string, unknown>> }).events;
    expect(dependencies.readOutcome).toHaveBeenCalledWith({
      tenantId: "t1",
      conversationId: "c1",
      receiptId: "r1",
      eventId: events[0].eventId,
    });
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
