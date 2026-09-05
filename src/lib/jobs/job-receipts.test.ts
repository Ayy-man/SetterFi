import { beforeEach, describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";

import {
  DRIVER_NOT_CONFIGURED_COUNTERS,
  createJobReceiptExecution,
  parseMissingVariableNames,
  readLatestJobReceipts,
  type JobReceiptStore,
} from "./job-receipts";

const supabase = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        in: () => query,
        order: () => query,
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: supabase.rows, error: null }),
      };
      return query;
    },
  }),
}));

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
      // The scheduler's marker stays, and the names ride beside it as their own field.
      counters: { ...DRIVER_NOT_CONFIGURED_COUNTERS, missing_variables: ["SETTERFI_GHL_PROVISIONING_DRIVER"] },
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

describe("missing variable names on a skipped receipt", () => {
  it("reads the structured counter first and drops anything that is not a variable name", () => {
    expect(parseMissingVariableNames({
      counters: { skipped: "driver_not_configured", missing_variables: ["STRIPE_SECRET_KEY", "sk_live_value", 3, "STRIPE_SECRET_KEY"] },
      errorDetail: "something else entirely",
    })).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("falls back to the comma-joined error detail an older receipt carries", () => {
    expect(parseMissingVariableNames({
      counters: { skipped: "driver_not_configured" },
      errorDetail: "GHL_CLIENT_ID, GHL_CLIENT_SECRET",
    })).toEqual(["GHL_CLIENT_ID", "GHL_CLIENT_SECRET"]);
  });

  it("yields no names from a free-text detail rather than fragments of a sentence", () => {
    expect(parseMissingVariableNames({ counters: null, errorDetail: "fetch failed: ENOTFOUND db.example, retrying" }))
      .toEqual([]);
    expect(parseMissingVariableNames({ counters: undefined, errorDetail: null })).toEqual([]);
  });
});

describe("latest receipts with missing configuration", () => {
  const NOW = new Date("2026-09-06T06:00:00.000Z");

  function row(input: {
    id: string; job_key: string; at: string; outcome: "succeeded" | "failed" | "skipped";
    error_detail?: string | null; counters?: unknown;
  }) {
    return {
      id: input.id, job_key: input.job_key, started_at: input.at, finished_at: input.at,
      outcome: input.outcome, error_detail: input.error_detail ?? null, counters: input.counters ?? {},
    };
  }

  beforeEach(() => { supabase.rows = []; });

  it("dates the wait from the first receipt of the unbroken run of identical skips", async () => {
    const skip = (id: string, at: string, names = ["SETTERFI_GHL_PROVISIONING_DRIVER"]) => row({
      id, job_key: "a2p-probe", at, outcome: "skipped", error_detail: names.join(", "),
      counters: { skipped: "driver_not_configured", missing_variables: names },
    });
    supabase.rows = [
      skip("r5", "2026-09-06T03:45:00.000Z"),
      skip("r4", "2026-09-05T03:45:00.000Z"),
      skip("r3", "2026-09-04T03:45:00.000Z"),
      // A different missing set ends the run, even though it is also a skip.
      skip("r2", "2026-09-03T03:45:00.000Z", ["GHL_CLIENT_ID"]),
      row({ id: "r1", job_key: "a2p-probe", at: "2026-09-02T03:45:00.000Z", outcome: "succeeded" }),
    ];

    const receipts = await readLatestJobReceipts({ now: NOW });
    expect(receipts.find((receipt) => receipt.jobKey === "a2p-probe")).toMatchObject({
      id: "r5",
      outcome: "skipped",
      missingConfiguration: {
        variables: ["SETTERFI_GHL_PROVISIONING_DRIVER"],
        since: "2026-09-04T03:45:00.000Z",
      },
    });
  });

  it("stops the run at a success or failure in between, and reads older receipts from their detail", async () => {
    supabase.rows = [
      row({ id: "r3", job_key: "tier-change-reconcile", at: "2026-09-06T04:00:00.000Z", outcome: "skipped", error_detail: "STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET", counters: { skipped: "driver_not_configured" } }),
      row({ id: "r2", job_key: "tier-change-reconcile", at: "2026-09-05T04:00:00.000Z", outcome: "failed", error_detail: "STRIPE_UNAVAILABLE" }),
      row({ id: "r1", job_key: "tier-change-reconcile", at: "2026-09-04T04:00:00.000Z", outcome: "skipped", error_detail: "STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET" }),
    ];

    const receipts = await readLatestJobReceipts({ now: NOW });
    expect(receipts.find((receipt) => receipt.jobKey === "tier-change-reconcile")?.missingConfiguration).toEqual({
      variables: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      since: "2026-09-06T04:00:00.000Z",
    });
  });

  it("carries no missing configuration on a succeeded, failed or absent receipt", async () => {
    supabase.rows = [
      row({ id: "r2", job_key: "followups", at: "2026-09-06T05:55:00.000Z", outcome: "succeeded" }),
      row({ id: "r1", job_key: "followups", at: "2026-09-06T05:35:00.000Z", outcome: "skipped", error_detail: "OPENROUTER_API_KEY" }),
      row({ id: "f1", job_key: "engine-evals", at: "2026-09-06T05:00:00.000Z", outcome: "failed", error_detail: "ENGINE_EVAL_UNAVAILABLE" }),
    ];

    const receipts = await readLatestJobReceipts({ now: NOW });
    expect(receipts.every((receipt) => receipt.missingConfiguration === null)).toBe(true);
  });
});
