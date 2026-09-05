import { describe, expect, it, vi } from "vitest";
import { createBillingCostRollupJobHandler, rollupIsEstimate } from "@/app/api/jobs/billing-cost-rollup/handler";

const request = () => new Request("https://app.test/api/jobs/billing-cost-rollup", { method: "POST", headers: { authorization: "Bearer secret" } });
describe("billing cost rollup job", () => {
  it("keeps incomplete production margin absent", async () => {
    const run = vi.fn().mockResolvedValue([{ rollupId: "r", tenantId: "t", complete: false, missingSources: ["messaging", "embedding"], estimate: true }]);
    const response = await createBillingCostRollupJobHandler({ enabled: () => true, secret: "secret", run })(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.rollups[0]).not.toHaveProperty("marginCents");
    expect(JSON.stringify(body.rollups[0])).not.toContain("0\"");
  });

  it("reports open-period rows as estimates on the receipt and in the job counters", async () => {
    const rows = [
      { rollupId: "open", tenantId: "t1", complete: true, missingSources: [], estimate: true, marginCents: 900 },
      { rollupId: "closed", tenantId: "t2", complete: true, missingSources: [], estimate: false, marginCents: 400 },
    ];
    const counters: unknown[] = [];
    const execute = (async (_jobKey: string, work: () => Promise<unknown>, options?: { counters?: (result: never) => unknown }) => {
      const result = await work();
      counters.push(options?.counters?.(result as never));
      return result;
    }) as never;
    const response = await createBillingCostRollupJobHandler({
      enabled: () => true, secret: "secret", execute, run: vi.fn().mockResolvedValue(rows),
    })(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.rollups.map((row: { rollupId: string; estimate: boolean }) => [row.rollupId, row.estimate]))
      .toEqual([["open", true], ["closed", false]]);
    expect(counters).toEqual([{ selected: 2, complete: 2, estimates: 1 }]);
  });

  it("calls a roll-up an estimate only while it was computed before its window closed", () => {
    expect(rollupIsEstimate({ computed_at: "2026-09-05T02:00:00.000Z", window_end: "2026-09-30T00:00:00.000Z" })).toBe(true);
    expect(rollupIsEstimate({ computed_at: "2026-09-30T02:00:00.000Z", window_end: "2026-09-30T00:00:00.000Z" })).toBe(false);
    expect(rollupIsEstimate({ computed_at: "2026-09-30T00:00:00.000Z", window_end: "2026-09-30T00:00:00.000Z" })).toBe(false);
  });

  it("requires the cron secret and parent flag", async () => {
    const run = vi.fn().mockResolvedValue([]);
    expect((await createBillingCostRollupJobHandler({ enabled: () => true, secret: null, run })(request())).status).toBe(401);
    expect((await createBillingCostRollupJobHandler({ enabled: () => false, secret: "secret", run })(request())).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });
});
