import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";
import { createJobReceiptExecution } from "@/lib/jobs/job-receipts";
import { createTierChangeReconcileJobHandler } from "./handler";

const request = (secret = "secret") => new Request("https://app.test/api/jobs/tier-change-reconcile", {
  method: "POST", headers: { authorization: `Bearer ${secret}` },
});

const result = { selected: 2, pending: 1, completed: 1, terminalFailed: 0, notified: 1, errors: 0 };

describe("tier-change reconciliation job", () => {
  it("requires the alert-event gate and the cron secret", async () => {
    const run = vi.fn().mockResolvedValue(result);
    expect((await createTierChangeReconcileJobHandler({ enabled: () => false, secret: "secret", run })(request())).status).toBe(404);
    expect((await createTierChangeReconcileJobHandler({ enabled: () => true, secret: null, run })(request())).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns the provider-confirmed reconciliation counters", async () => {
    const response = await createTierChangeReconcileJobHandler({ enabled: () => true, secret: "secret", run: async () => result })(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  });

  it("writes its receipt with the complete reconciliation counters", async () => {
    const calls: Array<{ key: string; counters: Record<string, number> }> = [];
    const execute = vi.fn(async (key, work, options) => {
      const output = await work();
      calls.push({ key, counters: options?.counters?.(output) ?? {} });
      return output;
    });
    await createTierChangeReconcileJobHandler({ enabled: () => true, secret: "secret", execute: execute as never, run: async () => result })(request());
    expect(calls).toEqual([{ key: "tier-change-reconcile", counters: result }]);
  });

  it("returns 200 and records skipped when the Stripe driver is deliberately unavailable", async () => {
    const finished: unknown[] = [];
    const execute = createJobReceiptExecution({
      start: async () => ({ id: "receipt-1", started_at: "2026-09-05T00:00:00.000Z" }),
      finish: async (input) => { finished.push(input); },
    });
    const response = await createTierChangeReconcileJobHandler({
      enabled: () => true,
      secret: "secret",
      execute,
      run: async () => {
        throw new DriverConfigurationError("stripe", ["SETTERFI_STRIPE_DRIVER"]);
      },
    })(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ skipped: "driver_not_configured" });
    expect(finished).toEqual([expect.objectContaining({
      outcome: "skipped",
      errorDetail: "SETTERFI_STRIPE_DRIVER",
      counters: { skipped: "driver_not_configured" },
    })]);
  });
});
