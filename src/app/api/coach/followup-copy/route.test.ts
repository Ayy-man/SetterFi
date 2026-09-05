import { describe, expect, it, vi } from "vitest";
import { createCoachFollowupCopyHandlers } from "./handler";

const actor = { userId: "coach-a", tenantId: "tenant-a", role: "coach" as const, impersonatingTenant: null, impersonationSessionId: null };
const request = (method: string, body?: unknown) => new Request("https://setterfi.test/api/coach/followup-copy", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

function dependencies() {
  const list = vi.fn(async () => []); const save = vi.fn(async () => ({ templateId: "template-a", status: "draft" as const, auditId: "44" })); const submit = vi.fn(async () => ({ templateId: "template-a", status: "submitted" as const, auditId: "45" }));
  return { list, save, submit, handlers: createCoachFollowupCopyHandlers({ session: async () => actor, list, save, submit }) };
}

describe("/api/coach/followup-copy", () => {
  it("uses the signed-in tenant and emits an audited draft receipt", async () => {
    const deps = dependencies(); const response = await deps.handlers.PUT(request("PUT", { channel: "sms", purpose: "value_nudge", body: "Still interested?" }));
    expect(deps.save).toHaveBeenCalledWith({ tenantId: "tenant-a", actorId: "coach-a", channel: "sms", purpose: "value_nudge", body: "Still interested?" });
    await expect(response.json()).resolves.toMatchObject({ templateId: "template-a", audit: { auditId: "44", actionKey: "followup_copy.draft.saved" } });
  });

  it("refuses a caller-selected approval status and does not write", async () => {
    const deps = dependencies(); const response = await deps.handlers.PUT(request("PUT", { channel: "sms", purpose: "value_nudge", body: "x", status: "approved" }));
    expect(response.status).toBe(409); expect(deps.save).not.toHaveBeenCalled();
  });

  it("submits only an existing template id under the signed-in tenant", async () => {
    const deps = dependencies(); const response = await deps.handlers.POST(request("POST", { templateId: "template-a" }));
    expect(deps.submit).toHaveBeenCalledWith({ tenantId: "tenant-a", actorId: "coach-a", templateId: "template-a" });
    await expect(response.json()).resolves.toMatchObject({ audit: { actionKey: "followup_copy.submitted" } });
  });
});
