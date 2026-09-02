import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RouteActor } from "@/lib/auth/actors";
import { NO_CLAIMS } from "@/lib/auth/claims";
import type { ConversationRead } from "@/lib/repositories/conversations";

import { createConversationDetailHandler } from "./handler";
import { createConversationReadHandler } from "./read/handler";

const actor: RouteActor = {
  ...NO_CLAIMS,
  userId: "coach-a",
  role: "coach",
  tenantId: "tenant-a",
};

const unreadConversation: ConversationRead = {
  id: "thread-stable-id",
  contactId: "contact-a",
  contactName: "Synthetic lead",
  channel: "sms",
  status: "needs_human",
  statusReason: "lead_requested_human",
  takenOverBy: null,
  unreadByCoach: true,
  disclosurePending: false,
  currentStepAsks: 0,
  isDemo: false,
  isTest: true,
  lastActivityAt: "2026-09-11T00:00:00.000Z",
  qualification: { credit: null, goal: null, timeline: null, outcome: null },
  appointment: null,
  messages: [],
};

function context(id = unreadConversation.id) {
  return { params: Promise.resolve({ id }) };
}

function getRequest(id = unreadConversation.id) {
  return new Request(`https://setterfi.test/api/conversations/${id}`);
}

function readRequest(id = unreadConversation.id) {
  return new Request(`https://setterfi.test/api/conversations/${id}/read`, { method: "POST" });
}

beforeEach(() => {
  vi.stubEnv("SETTERFI_PHASE1_LIVE", "true");
  vi.stubEnv("SETTERFI_PHASE3_LIVE", "true");
});

afterEach(() => vi.unstubAllEnvs());

describe("conversation thread detail and read acknowledgement", () => {
  it("resolves the stable path identifier directly, even when no inbox filter contains it", async () => {
    const getConversation = vi.fn(async (tenantId: string, conversationId: string) =>
      tenantId === "tenant-a" && conversationId === unreadConversation.id ? unreadConversation : null,
    );
    const response = await createConversationDetailHandler({
      session: async () => actor,
      getConversation,
    })(getRequest(), context());

    expect(response.status).toBe(200);
    expect(getConversation).toHaveBeenCalledWith("tenant-a", unreadConversation.id);
    await expect(response.json()).resolves.toMatchObject({
      conversation: { id: unreadConversation.id, unreadByCoach: true },
    });
  });

  it("acknowledges a read without assigning or changing the thread lifecycle", async () => {
    const acknowledge = vi.fn(async () => ({
      conversationId: unreadConversation.id,
      unreadByCoach: false as const,
      status: "needs_human" as const,
      takenOverBy: null,
    }));
    const persisted = { ...unreadConversation, unreadByCoach: false };
    const getConversation = vi.fn(async () => persisted);
    const response = await createConversationReadHandler({
      session: async () => actor,
      acknowledge,
      getConversation,
    })(readRequest(), context());

    expect(response.status).toBe(200);
    expect(acknowledge).toHaveBeenCalledWith({
      tenantId: "tenant-a", conversationId: unreadConversation.id, actorId: "coach-a",
    });
    await expect(response.json()).resolves.toMatchObject({
      conversation: { unreadByCoach: false, status: "needs_human", takenOverBy: null },
    });
  });

  it("refuses an unauthenticated or cross-tenant read without returning thread data", async () => {
    const acknowledge = vi.fn(async () => {
      throw new Error("EXPECTED_TENANT_MISMATCH:conversation");
    });
    const getConversation = vi.fn(async () => unreadConversation);
    const unauthenticated = await createConversationReadHandler({
      session: async () => null,
      acknowledge,
      getConversation,
    })(readRequest(), context());
    const crossTenant = await createConversationReadHandler({
      session: async () => ({ ...actor, tenantId: "tenant-b" }),
      acknowledge,
      getConversation,
    })(readRequest(), context());

    expect([unauthenticated.status, crossTenant.status]).toEqual([401, 409]);
    expect(getConversation).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
});
