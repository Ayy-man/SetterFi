import { describe, expect, it, vi } from "vitest";

import type { AlertActor } from "@/lib/auth/actors";
import type { PlatformHumanConversationQueue } from "@/lib/platform/conversation-projection";

import { createPlatformConversationQueueHandler } from "./handler";

const queue: PlatformHumanConversationQueue = {
  conversations: [{
    conversationId: "conversation-a",
    tenantId: "tenant-a",
    tenantName: "Northstar Coaching",
    channel: "sms",
    status: "needs_human",
    statusReason: "lead_requested_human",
    waitingSince: "2026-09-22T09:00:00.000Z",
    waitingSeconds: 3600,
  }],
  audit: {
    id: "42",
    actionKey: "platform.conversation_queue.read",
    microcopy: "Human queue view logged",
    ariaLabel: "Cross-tenant human conversation queue view recorded in the audit log",
  },
};

function actor(role: AlertActor["role"]): AlertActor {
  return {
    userId: "actor-a",
    role,
    tenantId: role === "coach" ? "tenant-a" : null,
    impersonatingTenant: null,
    impersonationSessionId: null,
    affiliateAccess: false,
  };
}

describe("GET /api/platform/conversations", () => {
  it("stays absent until the rollout gate is enabled", async () => {
    const session = vi.fn().mockResolvedValue(actor("admin"));
    const read = vi.fn();
    const response = await createPlatformConversationQueueHandler({
      enabled: () => false, session, read,
    })();
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a coach before the read can run, even when a tenant id is supplied in the URL", async () => {
    const read = vi.fn();
    const handler = createPlatformConversationQueueHandler({
      enabled: () => true,
      session: async () => actor("coach"),
      read,
    });
    const response = await handler(new Request("https://setterfi.test/api/platform/conversations?tenantId=tenant-b"));
    expect(response.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the audited global projection for a platform support actor", async () => {
    const read = vi.fn().mockResolvedValue(queue);
    const response = await createPlatformConversationQueueHandler({
      enabled: () => true,
      session: async () => actor("success"),
      read,
    })();
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledWith("actor-a");
    await expect(response.json()).resolves.toEqual({ queue });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not disclose database authorization failures", async () => {
    const response = await createPlatformConversationQueueHandler({
      enabled: () => true,
      session: async () => actor("owner"),
      read: async () => { throw new Error("PHASE2_PLATFORM_ACTOR_FORBIDDEN"); },
    })();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Human conversation queue is unavailable." });
  });
});
