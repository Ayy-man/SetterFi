import { describe, expect, it, vi } from "vitest";

import type { ConversationRead } from "@/lib/repositories/conversations";

import { createRehearseHandler } from "./handler";

const conversation: ConversationRead = {
  id: "c1",
  contactId: "k1",
  contactName: "Lead One",
  channel: "sms",
  status: "agent",
  statusReason: null,
  takenOverBy: null,
  unreadByCoach: false,
  disclosurePending: false,
  isDemo: true,
  isTest: true,
  qualification: { creditRange: null, fundingGoal: null, timeline: null, businessStage: null, outcome: null },
  appointment: null,
  proposedSlots: null,
  messages: [],
} as unknown as ConversationRead;

const actor = { userId: "u1", tenantId: "t1", role: "coach" } as never;

function handler(overrides: Partial<Parameters<typeof createRehearseHandler>[0]> = {}) {
  return createRehearseHandler({
    enabled: () => true,
    session: async () => actor,
    rehearse: async () => ({
      receiptId: "r1",
      receiptStatus: "processed",
      error: null,
      turn: { kind: "sent", reason: null },
      conversationStatus: "agent",
      reply: { messageId: "m2", body: "Hi", providerMessageId: "simulated:abc", simulated: true },
    }),
    loadConversation: async () => conversation,
    ...overrides,
  });
}

function post(body: unknown) {
  return new Request("http://localhost/api/conversations/c1/rehearse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: "c1" }) };

describe("rehearse handler", () => {
  it("is not there while the flag is off", async () => {
    const response = await handler({ enabled: () => false })(post({ body: "hi" }), context);
    expect(response.status).toBe(404);
  });

  it("refuses without a session and refuses an impersonated one", async () => {
    expect((await handler({ session: async () => null })(post({ body: "hi" }), context)).status).toBe(401);
    const impersonated = { ...(actor as object), impersonatingTenant: "t2" } as never;
    expect((await handler({ session: async () => impersonated })(post({ body: "hi" }), context)).status).toBe(403);
  });

  it("takes exactly one key, the lead's words, and bounds it", async () => {
    expect((await handler()(post({ body: "" }), context)).status).toBe(400);
    expect((await handler()(post({ body: "hi", extra: 1 }), context)).status).toBe(400);
    expect((await handler()(post("not json"), context)).status).toBe(400);
    expect((await handler()(post({ body: "x".repeat(1_001) }), context)).status).toBe(400);
  });

  it("accepts a UUID idempotency key beside the body and nothing else", async () => {
    const rehearse = vi.fn(async () => ({
      receiptId: "r1", receiptStatus: "processed" as const, error: null, turn: null, conversationStatus: "agent", reply: null,
    }));
    const key = "0f2c9d3e-1b6a-4c8d-9e0f-123456789abc";
    const accepted = await handler({ rehearse })(post({ body: "hi", idempotencyKey: key }), context);
    expect(accepted.status).toBe(200);
    expect(rehearse).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: key }));
    expect((await handler()(post({ body: "hi", idempotencyKey: "not-a-uuid" }), context)).status).toBe(400);
    expect((await handler()(post({ body: "hi", idempotencyKey: 7 }), context)).status).toBe(400);
  });

  it("passes tenant and actor from the session, never from the body, and returns the reloaded thread", async () => {
    const rehearse = vi.fn(async () => ({
      receiptId: "r1",
      receiptStatus: "processed" as const,
      error: null,
      turn: { kind: "no_send", reason: null },
      conversationStatus: "agent",
      reply: null,
    }));
    const response = await handler({ rehearse })(post({ body: "  Is this legit?  " }), context);
    expect(response.status).toBe(200);
    expect(rehearse).toHaveBeenCalledWith({
      tenantId: "t1",
      conversationId: "c1",
      actorId: "u1",
      body: "Is this legit?",
    });
    const payload = await response.json();
    expect(payload.conversation.id).toBe("c1");
    expect(payload.rehearsal.receiptId).toBe("r1");
  });

  it("names the refusal when the thread is not rehearsable, and the code when processing fails", async () => {
    const refused = await handler({
      rehearse: async () => { throw new Error("REHEARSAL_THREAD_NOT_REHEARSABLE"); },
    })(post({ body: "hi" }), context);
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("REHEARSAL_THREAD_NOT_REHEARSABLE");

    const failed = await handler({
      rehearse: async () => { throw new Error("WEBHOOK_RECEIPT_WRITE_FAILED:boom"); },
    })(post({ body: "hi" }), context);
    expect(failed.status).toBe(500);
    expect((await failed.json()).code).toBe("WEBHOOK_RECEIPT_WRITE_FAILED");
  });
});
