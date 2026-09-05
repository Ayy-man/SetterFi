import { describe, expect, it } from "vitest";

import { demoDraftFollowupContent, listFollowups } from "@/lib/repositories/followups";

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

describe("demoDraftFollowupContent", () => {
  const draft = { body: "SETTERFI_DEMO_PLACEHOLDER_FOLLOWUP_VALUE_NUDGE_BODY", isDemo: true };

  it("lets a demo tenant send a demo-flagged draft as explicitly labelled freeform copy", () => {
    expect(demoDraftFollowupContent({ isDemo: true }, draft)).toEqual({
      kind: "freeform",
      body: "[DRAFT] SETTERFI_DEMO_PLACEHOLDER_FOLLOWUP_VALUE_NUDGE_BODY",
    });
  });

  it("blocks a production tenant on draft copy rather than sending it", () => {
    expect(demoDraftFollowupContent({ isDemo: false }, draft)).toEqual({
      kind: "unavailable",
      reason: "approved_followup_copy_required",
    });
  });

  it("blocks a draft that is not demo-labelled even on a demo tenant", () => {
    expect(demoDraftFollowupContent({ isDemo: true }, { ...draft, isDemo: false }).kind).toBe("unavailable");
    expect(demoDraftFollowupContent({ isDemo: true }, { body: "Hi there", isDemo: true }).kind).toBe("unavailable");
    expect(demoDraftFollowupContent({ isDemo: true }, { body: "  ", isDemo: true }).kind).toBe("unavailable");
  });
});
