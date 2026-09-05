import { describe, expect, it, vi } from "vitest";
import { createAdminFollowupCopyHandler } from "./handler";

const request = (body: unknown) => new Request("https://setterfi.test/api/admin/followup-copy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const body = { tenantId: "tenant-a", templateId: "template-a", decision: "approved", reason: "Copy is accurate." };

describe("POST /api/admin/followup-copy", () => {
  it("uses the platform admin identity, requires a reason, and returns an audit receipt", async () => {
    const decide = vi.fn(async () => ({ templateId: "template-a", status: "approved" as const, auditId: "71" }));
    const response = await createAdminFollowupCopyHandler({ session: async () => ({ userId: "admin-a", role: "admin" }), decide })(request(body));
    expect(decide).toHaveBeenCalledWith({ tenantId: "tenant-a", templateId: "template-a", actorId: "admin-a", decision: "approved", reason: "Copy is accurate." });
    await expect(response.json()).resolves.toMatchObject({ audit: { auditId: "71", actionKey: "followup_copy.approved" } });
  });

  it("refuses a coach and an empty reason before the repository", async () => {
    const decide = vi.fn();
    const coach = await createAdminFollowupCopyHandler({ session: async () => ({ userId: "coach-a", role: "coach" }), decide })(request(body));
    const empty = await createAdminFollowupCopyHandler({ session: async () => ({ userId: "admin-a", role: "admin" }), decide })(request({ ...body, reason: " " }));
    expect(coach.status).toBe(403); expect(empty.status).toBe(409); expect(decide).not.toHaveBeenCalled();
  });
});
