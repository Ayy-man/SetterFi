import { describe, expect, it, vi } from "vitest";

import {
  createTenantHealthRollupJobHandler,
  type TenantHealthRollupResult,
} from "@/app/api/jobs/tenant-health-rollup/handler";

const request = () => new Request("https://app.test/api/jobs/tenant-health-rollup", {
  method: "POST",
  headers: { authorization: "Bearer secret" },
});

function result(overrides: Partial<TenantHealthRollupResult> = {}): TenantHealthRollupResult {
  return {
    day: "2026-08-30",
    tenantsWritten: 4,
    signalsWritten: 16,
    backfilledRows: 11,
    backfillFrom: "2026-07-31",
    backfillTo: "2026-08-29",
    ...overrides,
  };
}

describe("tenant health rollup job", () => {
  it("reports what each writer actually wrote", async () => {
    const run = vi.fn().mockResolvedValue(result());
    const response = await createTenantHealthRollupJobHandler({
      enabled: () => true, secret: "secret", run,
    })(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      day: "2026-08-30", tenantsWritten: 4, signalsWritten: 16, backfilledRows: 11,
    });
  });

  it("writes a receipt carrying both counts, like every other cron", async () => {
    const counters: Record<string, number>[] = [];
    const keys: string[] = [];
    const execute = vi.fn(async (jobKey, work, options) => {
      keys.push(jobKey);
      const value = await work();
      counters.push(options?.counters?.(value) ?? {});
      return value;
    });

    await createTenantHealthRollupJobHandler({
      enabled: () => true,
      secret: "secret",
      execute: execute as never,
      run: async () => result(),
    })(request());

    expect(keys).toEqual(["tenant-health-rollup"]);
    expect(counters[0]).toEqual({ tenantsWritten: 4, signalsWritten: 16, backfilledRows: 11 });
  });

  it("requires the cron secret and the analytics flag", async () => {
    const run = vi.fn().mockResolvedValue(result());
    expect((await createTenantHealthRollupJobHandler({
      enabled: () => true, secret: null, run,
    })(request())).status).toBe(401);
    expect((await createTenantHealthRollupJobHandler({
      enabled: () => false, secret: "secret", run,
    })(request())).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a failed write as unavailable rather than as an empty rollup", async () => {
    const response = await createTenantHealthRollupJobHandler({
      enabled: () => true,
      secret: "secret",
      run: async () => { throw new Error("TENANT_HEALTH_SNAPSHOT_WRITE_FAILED"); },
    })(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Tenant health rollup unavailable." });
  });
});
