import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";

import {
  DRIVER_NOT_CONFIGURED_COUNTERS,
  createJobReceiptExecution,
  type JobReceiptStore,
} from "./job-receipts";

function store(): JobReceiptStore {
  return {
    start: vi.fn(async () => ({ id: "receipt-1", started_at: "2026-09-05T00:00:00.000Z" })),
    finish: vi.fn(async () => undefined),
  };
}

describe("job receipt execution", () => {
  it("starts before work and completes with the job's numeric counters", async () => {
    const receipts = store();
    const execute = createJobReceiptExecution(receipts, () => new Date("2026-09-05T00:00:00.000Z"));

    await expect(execute("followups", async () => ({ selected: 3, sent: 2, label: "ignored" })))
      .resolves.toEqual({ selected: 3, sent: 2, label: "ignored" });
    expect(receipts.start).toHaveBeenCalledBefore(receipts.finish as ReturnType<typeof vi.fn>);
    expect(receipts.finish).toHaveBeenCalledWith(expect.objectContaining({
      id: "receipt-1", outcome: "succeeded", errorDetail: null, counters: { selected: 3, sent: 2 },
    }));
  });

  it("finalizes a failed receipt before returning the original job error", async () => {
    const receipts = store();
    const execute = createJobReceiptExecution(receipts, () => new Date("2026-09-05T00:00:00.000Z"));

    await expect(execute("inbound-recovery", async () => {
      throw new Error("DATABASE_UNAVAILABLE");
    })).rejects.toThrow("DATABASE_UNAVAILABLE");
    expect(receipts.finish).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed", errorDetail: "DATABASE_UNAVAILABLE", counters: {},
    }));
  });

  it("records an intentionally unavailable driver as skipped and does not rethrow it to the scheduler", async () => {
    const receipts = store();
    const execute = createJobReceiptExecution(receipts, () => new Date("2026-09-05T00:00:00.000Z"));
    const resolveFakeDriver = vi.fn(() => {
      throw new DriverConfigurationError("ghl_provisioning", ["SETTERFI_GHL_PROVISIONING_DRIVER"]);
    });

    await expect(execute("a2p-probe", async () => resolveFakeDriver()))
      .resolves.toEqual(DRIVER_NOT_CONFIGURED_COUNTERS);
    expect(receipts.finish).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "skipped",
      errorDetail: "SETTERFI_GHL_PROVISIONING_DRIVER",
      counters: DRIVER_NOT_CONFIGURED_COUNTERS,
    }));
  });

  it("records an explicit unavailable result as failed without changing its response payload", async () => {
    const receipts = store();
    const execute = createJobReceiptExecution(receipts);
    const unavailable = { state: "unavailable", code: "ENGINE_EVAL_UNAVAILABLE" };

    await expect(execute("engine-evals", async () => unavailable, {
      outcome: () => "failed",
      errorDetail: (result) => result.code,
    })).resolves.toEqual(unavailable);
    expect(receipts.finish).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed", errorDetail: "ENGINE_EVAL_UNAVAILABLE",
    }));
  });

  it("records a zero-progress provisioning pass with the returned outcome counters", async () => {
    const receipts = store();
    const execute = createJobReceiptExecution(receipts);
    const waitingForProviders = {
      tenants: 2,
      succeeded: 2,
      failed: 0,
      steps: 4,
      committed: 0,
      stale: 4,
      missingExecutors: 0,
    };

    await expect(execute("provisioning-run", async () => waitingForProviders))
      .resolves.toEqual(waitingForProviders);
    expect(receipts.finish).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "succeeded",
      errorDetail: null,
      counters: waitingForProviders,
    }));
  });

  it("keeps the job failure visible when receipt finalization is unavailable", async () => {
    const receipts = store();
    vi.mocked(receipts.finish).mockRejectedValueOnce(new Error("JOB_RECEIPT_FINISH_FAILED"));
    const execute = createJobReceiptExecution(receipts);

    await expect(execute("stripe-webhooks", async () => {
      throw new Error("WEBHOOK_INBOX_UNAVAILABLE");
    })).rejects.toThrow("WEBHOOK_INBOX_UNAVAILABLE");
  });
});
