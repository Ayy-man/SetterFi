import { describe, expect, it, vi } from "vitest";

import type { PlatformSmokeResult } from "@/lib/operations/smoke";
import { createPlatformSmokeJobHandler } from "./handler";

const passing: PlatformSmokeResult = {
  ok: true,
  checks: [
    { key: "platform-measurement", ok: true, ms: 120 },
    { key: "system-health", ok: true, ms: 40 },
  ],
};
const failing: PlatformSmokeResult = {
  ok: false,
  checks: [
    { key: "platform-measurement", ok: false, ms: 90, error: "MeasurementEvidenceError: PLATFORM_PROVISIONING_PERFORMANCE_INVALID" },
    { key: "system-health", ok: true, ms: 40 },
  ],
};

function authorizedRequest() {
  return new Request("http://local/api/jobs/platform-smoke", { headers: { authorization: "Bearer synthetic-secret" } });
}

type ExecuteOptions = {
  counters?: (result: never) => Record<string, unknown>;
  outcome?: (result: never) => string;
  errorDetail?: (result: never) => string | null;
};

type RecordedReceipt = { job: string; counters?: Record<string, unknown>; outcome?: string; errorDetail?: string | null };

/** Runs the work and records what the receipt would hold, handing the result back untouched. */
function recordingExecute(receipts: RecordedReceipt[]) {
  return vi.fn(async (job: string, work: () => Promise<unknown>, options?: ExecuteOptions) => {
    const result = await work();
    receipts.push({
      job,
      counters: options?.counters?.(result as never),
      outcome: options?.outcome?.(result as never),
      errorDetail: options?.errorDetail?.(result as never),
    });
    return result;
  });
}

describe("platform smoke cron job", () => {
  it("requires the cron bearer before running", async () => {
    const run = vi.fn(async () => passing);
    const handler = createPlatformSmokeJobHandler({ secret: "synthetic-secret", run });
    expect((await handler(new Request("http://local/api/jobs/platform-smoke"))).status).toBe(401);
    expect((await handler(new Request("http://local/api/jobs/platform-smoke", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to run at all without a configured secret", async () => {
    const run = vi.fn(async () => passing);
    expect((await createPlatformSmokeJobHandler({ secret: null, run })(authorizedRequest())).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns the check list as-is when every check passes", async () => {
    const response = await createPlatformSmokeJobHandler({ secret: "synthetic-secret", run: async () => passing })(authorizedRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(passing);
  });

  it("writes a succeeded receipt with the check count under the platform-smoke key", async () => {
    const receipts: RecordedReceipt[] = [];
    const response = await createPlatformSmokeJobHandler({ secret: "synthetic-secret", run: async () => passing, execute: recordingExecute(receipts) as never })(authorizedRequest());
    expect(response.status).toBe(200);
    expect(receipts).toEqual([
      { job: "platform-smoke", counters: { checks: 2, failed: 0 }, outcome: "succeeded", errorDetail: null },
    ]);
  });

  it("writes a failed receipt naming the failing keys, and answers 503, when any check fails", async () => {
    const receipts: RecordedReceipt[] = [];
    const response = await createPlatformSmokeJobHandler({ secret: "synthetic-secret", run: async () => failing, execute: recordingExecute(receipts) as never })(authorizedRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(failing);
    expect(receipts).toEqual([{
      job: "platform-smoke",
      counters: { checks: 2, failed: 1, failed_keys: ["platform-measurement"] },
      outcome: "failed",
      errorDetail: "platform-measurement: MeasurementEvidenceError: PLATFORM_PROVISIONING_PERFORMANCE_INVALID",
    }]);
  });

  it("reports a run that could not start as unavailable, never as a pass", async () => {
    const response = await createPlatformSmokeJobHandler({ secret: "synthetic-secret", run: async () => { throw new Error("SMOKE_OWNER_MISSING"); } })(authorizedRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "SMOKE_OWNER_MISSING" });
  });
});
