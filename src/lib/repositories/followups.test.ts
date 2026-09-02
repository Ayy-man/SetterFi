import { describe, expect, it } from "vitest";

import { listFollowups } from "@/lib/repositories/followups";

const row = (tenantId = "tenant-a") => ({
  id: "followup-1",
  tenant_id: tenantId,
  conversation_id: "conversation-1",
  purpose: "lead_magnet",
  touch_no: 1,
  status: "scheduled" as const,
  scheduled_at: "2026-08-18T10:00:00.000Z",
  sent_at: null,
  canceled_reason: null,
  paused_at: null,
  deferred_count: 0,
  attempt_count: 1,
  is_test: true,
  conversation: { contact_id: "contact-1", channel: "sms" as const },
});

describe("listFollowups", () => {
  it("returns persisted scheduler state within the expected tenant", async () => {
    await expect(listFollowups("tenant-a", {}, async () => [row()])).resolves.toEqual([{
      id: "followup-1",
      conversationId: "conversation-1",
      contactId: "contact-1",
      channel: "sms",
      purpose: "lead_magnet",
      touchNo: 1,
      status: "scheduled",
      scheduledAt: "2026-08-18T10:00:00.000Z",
      sentAt: null,
      canceledReason: null,
      pausedAt: null,
      deferredCount: 0,
      attemptCount: 1,
      isTest: true,
    }]);
  });

  it("fails closed when a service-role source crosses tenants", async () => {
    await expect(listFollowups("tenant-a", {}, async () => [row("tenant-b")]))
      .rejects.toThrow("FOLLOWUP_TENANT_MISMATCH");
  });
});
