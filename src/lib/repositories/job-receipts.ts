/**
 * Platform-only projection of the latest persisted scheduled-job receipts.
 *
 * The job runner owns receipt writes and freshness calculation. This repository is the read
 * boundary for operator surfaces, so those surfaces never infer a completed run from a schedule.
 */

import {
  readLatestJobReceipts,
  type LatestJobReceipt,
} from "@/lib/jobs/job-receipts";

export type SystemJobReceipt = {
  job: LatestJobReceipt["jobKey"];
  outcome: LatestJobReceipt["outcome"];
  startedAt: string | null;
  finishedAt: string | null;
  receiptId: string | null;
  freshness: LatestJobReceipt["freshness"];
  freshnessWindowMs: number;
};

export type JobReceiptRepositoryDependencies = {
  readLatest(): Promise<readonly LatestJobReceipt[]>;
};

export class JobReceiptRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "JobReceiptRepositoryError";
  }
}

function receiptProjection(receipt: LatestJobReceipt): SystemJobReceipt {
  if (!Number.isFinite(receipt.freshnessWindowMs) || receipt.freshnessWindowMs <= 0) {
    throw new JobReceiptRepositoryError("JOB_RECEIPT_FRESHNESS_WINDOW_INVALID");
  }
  return {
    job: receipt.jobKey,
    outcome: receipt.outcome,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    receiptId: receipt.id,
    freshness: receipt.freshness,
    freshnessWindowMs: receipt.freshnessWindowMs,
  };
}

function liveDependencies(): JobReceiptRepositoryDependencies {
  return { readLatest: readLatestJobReceipts };
}

export function createJobReceiptRepository(
  dependencies: JobReceiptRepositoryDependencies = liveDependencies(),
) {
  return {
    async readLatest(): Promise<readonly SystemJobReceipt[]> {
      try {
        return (await dependencies.readLatest()).map(receiptProjection);
      } catch (cause) {
        if (cause instanceof JobReceiptRepositoryError) throw cause;
        throw new JobReceiptRepositoryError("JOB_RECEIPT_READ_FAILED");
      }
    },
  };
}

/** The production System Health source reads durable receipts, never cron configuration. */
export async function readJobReceipts(): Promise<readonly SystemJobReceipt[]> {
  return createJobReceiptRepository().readLatest();
}
