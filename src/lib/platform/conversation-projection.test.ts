import { describe, expect, it, vi } from "vitest";

import {
  parsePlatformHumanConversationQueue,
  platformConversationQueueLive,
  readPlatformHumanConversationQueue,
} from "./conversation-projection";

const payload = {
  audit_id: 42,
  conversations: [{
    conversation_id: "conversation-a",
    tenant_id: "tenant-a",
    tenant_name: "Northstar Coaching",
    channel: "instagram",
    status: "needs_human",
    status_reason: "lead_requested_human",
    waiting_since: "2026-09-22T09:00:00.000Z",
    waiting_seconds: 3600,
  }],
};

describe("platform human conversation projection", () => {
  it("keeps the cross-tenant read behind Phase 2 and its own exact opt-in flag", () => {
    expect(platformConversationQueueLive({})).toBe(false);
    expect(platformConversationQueueLive({ SETTERFI_PLATFORM_CONVERSATION_QUEUE_LIVE: " true " })).toBe(false);
    expect(platformConversationQueueLive({ SETTERFI_PHASE2_LIVE: "true" })).toBe(false);
    expect(platformConversationQueueLive({
      SETTERFI_PHASE2_LIVE: "true",
      SETTERFI_PLATFORM_CONVERSATION_QUEUE_LIVE: "TRUE",
    })).toBe(false);
    expect(platformConversationQueueLive({
      SETTERFI_PHASE2_LIVE: "true",
      SETTERFI_PLATFORM_CONVERSATION_QUEUE_LIVE: " true ",
    })).toBe(true);
  });

  it("projects queue metadata and deliberately excludes lead content", () => {
    expect(parsePlatformHumanConversationQueue(payload)).toEqual({
      conversations: [{
        conversationId: "conversation-a",
        tenantId: "tenant-a",
        tenantName: "Northstar Coaching",
        channel: "instagram",
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
    });
  });

  it("calls only the database-authorized global RPC without a tenant selector", async () => {
    const rpc = vi.fn().mockResolvedValue(payload);
    await expect(readPlatformHumanConversationQueue("platform-user", { rpc })).resolves.toMatchObject({
      conversations: [{ tenantId: "tenant-a" }],
    });
    expect(rpc).toHaveBeenCalledWith("read_platform_human_conversation_queue", {
      p_actor_id: "platform-user",
    });
  });

  it("rejects malformed or transcript-shaped queue data instead of returning it", () => {
    expect(() => parsePlatformHumanConversationQueue({ ...payload, audit_id: null })).toThrow(
      "PLATFORM_CONVERSATION_QUEUE_AUDIT_MISSING",
    );
    expect(() => parsePlatformHumanConversationQueue({
      ...payload,
      conversations: [{ ...payload.conversations[0], status: "human" }],
    })).toThrow("PLATFORM_CONVERSATION_QUEUE_STATUS_INVALID");
    expect(() => parsePlatformHumanConversationQueue({
      ...payload,
      conversations: [{ ...payload.conversations[0], channel: "email" }],
    })).toThrow("PLATFORM_CONVERSATION_QUEUE_CHANNEL_INVALID");
  });
});
