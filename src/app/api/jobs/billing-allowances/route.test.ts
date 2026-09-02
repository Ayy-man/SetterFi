import { describe, expect, it, vi } from "vitest";
import { createBillingAllowanceJobHandler } from "@/app/api/jobs/billing-allowances/handler";

const request = (secret = "secret") => new Request("https://app.test/api/jobs/billing-allowances", { method: "POST", headers: { authorization: `Bearer ${secret}` } });
describe("billing allowance job", () => {
  it("is parent-flagged, secret bounded, and returns persisted action counts", async () => {
    const run = vi.fn().mockResolvedValue({ selected: 2, acted: 1, failed: 0 });
    const handler = createBillingAllowanceJobHandler({ enabled: () => true, secret: "secret", run });
    expect((await handler(request("wrong"))).status).toBe(401);
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ selected: 2, acted: 1, failed: 0 });
  });

  it("stays absent while Phase 6 is off", async () => {
    const run = vi.fn();
    expect((await createBillingAllowanceJobHandler({ enabled: () => false, secret: "secret", run })(request())).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });
});
