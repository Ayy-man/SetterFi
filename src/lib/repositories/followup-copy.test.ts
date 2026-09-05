import { describe, expect, it } from "vitest";

import { listFollowupCopy } from "./followup-copy";

const row = (tenantId = "tenant-a") => ({
  id: "template-a", tenant_id: tenantId, channel: "sms" as const, name: "followup:value_nudge",
  body: "A short follow-up.", status: "draft", rejection_detail: null, updated_at: "2026-10-13T10:00:00.000Z",
});

describe("listFollowupCopy", () => {
  it("maps only the persisted local follow-up template contract", async () => {
    await expect(listFollowupCopy("tenant-a", async () => [row()])).resolves.toEqual([{
      id: "template-a", tenantId: "tenant-a", channel: "sms", purpose: "value_nudge",
      body: "A short follow-up.", status: "draft", rejectionDetail: null, updatedAt: "2026-10-13T10:00:00.000Z",
    }]);
  });

  it("fails closed when a service-role read crosses tenants", async () => {
    await expect(listFollowupCopy("tenant-a", async () => [row("tenant-b")])).rejects.toThrow("FOLLOWUP_COPY_READ_FAILED");
  });

  it("refuses a row outside the closed cadence purpose registry", async () => {
    await expect(listFollowupCopy("tenant-a", async () => [{ ...row(), name: "followup:invented" }]))
      .rejects.toThrow("FOLLOWUP_COPY_PURPOSE_INVALID");
  });
});
