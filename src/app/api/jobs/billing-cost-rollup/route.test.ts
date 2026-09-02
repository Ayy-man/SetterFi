import { describe, expect, it, vi } from "vitest";
import { createBillingCostRollupJobHandler } from "@/app/api/jobs/billing-cost-rollup/handler";

const request = () => new Request("https://app.test/api/jobs/billing-cost-rollup", { method: "POST", headers: { authorization: "Bearer secret" } });
describe("billing cost rollup job", () => {
  it("keeps incomplete production margin absent", async () => {
    const run = vi.fn().mockResolvedValue([{ rollupId: "r", tenantId: "t", complete: false, missingSources: ["messaging", "embedding"] }]);
    const response = await createBillingCostRollupJobHandler({ enabled: () => true, secret: "secret", run })(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.rollups[0]).not.toHaveProperty("marginCents");
    expect(JSON.stringify(body.rollups[0])).not.toContain("0\"");
  });

  it("requires the cron secret and parent flag", async () => {
    const run = vi.fn().mockResolvedValue([]);
    expect((await createBillingCostRollupJobHandler({ enabled: () => true, secret: null, run })(request())).status).toBe(401);
    expect((await createBillingCostRollupJobHandler({ enabled: () => false, secret: "secret", run })(request())).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });
});
