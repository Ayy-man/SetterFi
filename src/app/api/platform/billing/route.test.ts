import { describe, expect, it, vi } from "vitest";
import { createPlatformBillingHandlers } from "@/app/api/platform/billing/handler";

const post = (body: unknown) => new Request("https://app.test/api/platform/billing", { method: "POST", body: JSON.stringify(body) });
function operations() {
  return { listCorrections: vi.fn().mockResolvedValue([{ requestId: "r", reason: "duplicate" }]), updateTier: vi.fn(), setTenantOverride: vi.fn(), decideCorrection: vi.fn(), setTenantStatus: vi.fn() };
}
describe("platform billing route", () => {
  it("gives success the exact read-only correction projection without economics", async () => {
    const ops = operations();
    const handlers = createPlatformBillingHandlers({ enabled: () => true, session: async () => ({ userId: "success", role: "success" }), operations: ops });
    const body = await (await handlers.GET()).json();
    expect(body).toEqual({ corrections: [{ requestId: "r", reason: "duplicate" }] });
    expect(JSON.stringify(body)).not.toMatch(/cost|margin|price/i);
    expect((await handlers.POST(post({ action: "decide_correction" }))).status).toBe(403);
    expect(ops.decideCorrection).not.toHaveBeenCalled();
  });

  it("allows owner correction decisions only through receipt-returning operations", async () => {
    const ops = operations();
    ops.decideCorrection.mockResolvedValue({ state: "approved", requestId: "r", decisionId: "d", offsetEventId: "o", requestAuditId: 1, decisionAuditId: 2 });
    const handlers = createPlatformBillingHandlers({ enabled: () => true, session: async () => ({ userId: "owner", role: "owner" }), operations: ops });
    const response = await handlers.POST(post({ action: "decide_correction", tenantId: "t", requestId: "r", decision: "approved", reason: "verified" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { state: "approved", requestId: "r", decisionId: "d", offsetEventId: "o", requestAuditId: 1, decisionAuditId: 2 } });
  });
});
