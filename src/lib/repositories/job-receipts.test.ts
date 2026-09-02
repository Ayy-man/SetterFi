import { describe, expect, it } from "vitest";

import type { LatestJobReceipt } from "@/lib/jobs/job-receipts";

import {
  createJobReceiptRepository,
  JobReceiptRepositoryError,
} from "./job-receipts";

function latest(overrides: Partial<LatestJobReceipt> = {}): LatestJobReceipt {
  return {
    id: "receipt-1",
    jobKey: "followups",
    startedAt: "2026-08-18T05:55:00.000Z",
    finishedAt: "2026-08-18T05:55:01.000Z",
    outcome: "succeeded",
    errorDetail: null,
    counters: { queued: 2 },
    freshness: "fresh",
    ageMs: 1_000,
    freshnessWindowMs: 20 * 60_000,
    ...overrides,
  };
}

describe("job receipt repository", () => {
  it("projects the persisted latest receipt and preserves its job-owned freshness evidence", async () => {
    const repository = createJobReceiptRepository({ readLatest: async () => [latest()] });

    await expect(repository.readLatest()).resolves.toEqual([{
      job: "followups",
      outcome: "succeeded",
      startedAt: "2026-08-18T05:55:00.000Z",
      finishedAt: "2026-08-18T05:55:01.000Z",
      receiptId: "receipt-1",
      freshness: "fresh",
      freshnessWindowMs: 20 * 60_000,
    }]);
  });

  it("fails closed when the receipt reader cannot supply an explicit freshness window", async () => {
    const repository = createJobReceiptRepository({
      readLatest: async () => [latest({ freshnessWindowMs: 0 })],
    });

    await expect(repository.readLatest()).rejects.toEqual(
      new JobReceiptRepositoryError("JOB_RECEIPT_FRESHNESS_WINDOW_INVALID"),
    );
  });
});
