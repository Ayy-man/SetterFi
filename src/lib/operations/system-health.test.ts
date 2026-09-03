import { describe, expect, it } from "vitest";

import type { SystemJobReceipt } from "@/lib/repositories/job-receipts";

import {
  deriveSystemReportingState,
  loadSystemHealth,
  type SystemHealthSource,
} from "./system-health";

const NOW = new Date("2026-08-18T06:00:00.000Z");
const SCHEDULED_JOB_KEYS: SystemJobReceipt["job"][] = [
  "appointment-reconcile", "compliance-reconcile", "a2p-probe", "stripe-webhooks",
  "billing-allowances", "billing-cost-rollup", "notification-deliveries", "engine-evals",
  "followups", "ghl-install-reconcile", "inbound-recovery", "outbound-reconciliation",
  "contact-deletion-recovery", "tenant-health-rollup", "provisioning-run",
  "agent-inactivity-sweep",
  "tier-change-reconcile",
  "capi-events",
];

function receipt(input: Partial<SystemJobReceipt> & Pick<SystemJobReceipt, "job">): SystemJobReceipt {
  return {
    outcome: "succeeded",
    startedAt: "2026-08-18T05:40:00.000Z",
    finishedAt: "2026-08-18T05:40:00.000Z",
    receiptId: `receipt-${input.job}`,
    errorDetail: null,
    freshness: "fresh",
    freshnessWindowMs: 26 * 60 * 60_000,
    ...input,
  };
}

function source(overrides: Partial<SystemHealthSource> = {}): SystemHealthSource {
  return {
    readQueueEvidence: async () => ({ depth: 2, rows: [] }),
    readAttemptEvidence: async () => ({ failed: 3, terminal: 1 }),
    readJobReceipts: async () => [],
    ...overrides,
  };
}

describe("read-only system health", () => {
  it("shows all 18 configured jobs as never-ran when no receipts exist", async () => {
    const result = await loadSystemHealth({ source: source(), environment: {}, now: NOW });

    expect(result.queue).toMatchObject({ state: "available", depth: 2, failedAttempts: 3, terminalAttempts: 1 });
    expect(result.jobs).toHaveLength(18);
    expect(result.jobs.find((job) => job.id === "capi-events")).toMatchObject({
      label: "CAPI Events", schedule: "*/2 * * * *", state: "never-ran",
    });
    expect(result.jobs.every((job) => (
      job.state === "never-ran" && job.lastRunAt === null && !job.reportedSinceYesterday
    ))).toBe(true);
    expect(result.reporting).toEqual({
      state: "never-ran",
      reason: "At least one scheduled job has no recorded run.",
    });
    expect(result.providers.map((provider) => provider.label)).toEqual([
      "Text messages (SMS)", "Calendar", "Model routing", "Instagram and Messenger",
      "Credential storage", "Payments", "Email", "Alerts",
    ]);
  });

  it("keeps stale receipts distinct from a fresh failed receipt", async () => {
    const result = await loadSystemHealth({
      source: source({ readJobReceipts: async () => [
        receipt({ job: "notification-deliveries", finishedAt: "2026-08-18T05:10:00.000Z" }),
        receipt({ job: "engine-evals", outcome: "failed" }),
        receipt({ job: "appointment-reconcile", finishedAt: "2026-08-15T03:15:00.000Z", freshness: "stale" }),
      ] }),
      environment: {}, now: NOW,
    });

    expect(result.jobs.find((job) => job.id === "notification-deliveries")?.state).toBe("healthy");
    expect(result.jobs.find((job) => job.id === "engine-evals")?.state).toBe("failed");
    expect(result.jobs.find((job) => job.id === "appointment-reconcile")?.state).toBe("stale");
    expect(result.reporting?.state).toBe("failed");
  });

  it("passes a failed receipt's error detail to the job row and keeps it off every other state", async () => {
    const result = await loadSystemHealth({
      source: source({ readJobReceipts: async () => [
        receipt({ job: "provisioning-run", outcome: "failed", errorDetail: "PROVISIONING_TENANT_READ_FAILED" }),
        receipt({ job: "engine-evals", outcome: "succeeded", errorDetail: "STALE_DETAIL_FROM_AN_EARLIER_ROW" }),
        receipt({ job: "appointment-reconcile", outcome: "failed", errorDetail: "OLD_FAILURE", finishedAt: "2026-08-15T03:15:00.000Z", freshness: "stale" }),
      ] }),
      environment: {}, now: NOW,
    });

    const failed = result.jobs.find((job) => job.id === "provisioning-run");
    expect(failed).toMatchObject({ state: "failed", errorDetail: "PROVISIONING_TENANT_READ_FAILED" });
    // A succeeded receipt carrying a detail is a receipt-writer bug, not a failure to report.
    expect(result.jobs.find((job) => job.id === "engine-evals")).toMatchObject({ state: "healthy", errorDetail: null });
    // A stale row is reported as stale; its old reason would read as a current fault.
    expect(result.jobs.find((job) => job.id === "appointment-reconcile")).toMatchObject({ state: "stale", errorDetail: null });
    expect(result.jobs.filter((job) => job.state === "never-ran").every((job) => job.errorDetail === null)).toBe(true);
  });

  it("uses the receipt reader's explicit per-job freshness rather than inventing one", async () => {
    const result = await loadSystemHealth({
      source: source({ readJobReceipts: async () => [
        receipt({
          job: "stripe-webhooks", finishedAt: "2026-08-18T05:00:00.000Z", freshness: "stale",
          freshnessWindowMs: 45 * 60_000,
        }),
        receipt({ job: "appointment-reconcile", finishedAt: "2026-08-17T05:30:00.000Z" }),
      ] }),
      environment: {}, now: NOW,
    });

    expect(result.jobs.find((job) => job.id === "stripe-webhooks")).toMatchObject({ state: "stale", reportedSinceYesterday: true });
    expect(result.jobs.find((job) => job.id === "appointment-reconcile")).toMatchObject({ state: "healthy", reportedSinceYesterday: false });
  });

  it("reports healthy only when queue evidence and every scheduled job have fresh success receipts", async () => {
    const result = await loadSystemHealth({
      source: source({ readJobReceipts: async () => SCHEDULED_JOB_KEYS.map((job) => receipt({ job })) }),
      environment: {}, now: NOW,
    });

    expect(result.jobs).toHaveLength(18);
    expect(result.jobs.every((job) => job.state === "healthy")).toBe(true);
    expect(result.reporting).toEqual({ state: "healthy", reason: null });
  });

  it("derives the page-level reporting state from every owned queue and job signal", () => {
    const jobs = [{
      id: "followups", label: "Followups", schedule: "*/5 * * * *", state: "healthy" as const,
      lastRunAt: "2026-08-18T05:55:00.000Z", reportedSinceYesterday: true,
      receiptId: "receipt-followups", reason: null, errorDetail: null,
    }];

    expect(deriveSystemReportingState({ queueState: "available", jobs })).toEqual({ state: "healthy", reason: null });
    expect(deriveSystemReportingState({ queueState: "available", jobs: [{ ...jobs[0], state: "stale" }] }))
      .toEqual({ state: "stale", reason: "At least one scheduled job report is stale." });
    expect(deriveSystemReportingState({ queueState: "available", jobs: [{ ...jobs[0], state: "never-ran" }] }))
      .toEqual({ state: "never-ran", reason: "At least one scheduled job has no recorded run." });
    expect(deriveSystemReportingState({ queueState: "unavailable", jobs }))
      .toEqual({ state: "unavailable", reason: "Delivery activity could not be read." });
  });

  it("renders unknown queue evidence unavailable rather than zero or healthy", async () => {
    const result = await loadSystemHealth({
      source: source({ readQueueEvidence: async () => { throw new Error("offline"); } }), environment: {},
    });
    expect(result.queue).toEqual({ state: "unavailable", depth: null, failedAttempts: null, terminalAttempts: null, rows: [], reason: "Delivery activity could not be read." });
    expect(result.reporting?.state).toBe("unavailable");
  });

  it("fails an explicitly real integration closed without publishing missing names", async () => {
    const result = await loadSystemHealth({ source: source(), environment: { SETTERFI_EMAIL_DRIVER: "real", RESEND_API_KEY: "synthetic-secret-never-rendered" } });
    expect(result.providers.find((provider) => provider.id === "email")).toEqual({
      id: "email", label: "Email", state: "unavailable", reason: "Required setup is incomplete.",
    });
    expect(JSON.stringify(result.providers)).not.toContain("SETTERFI_EMAIL_FROM");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-never-rendered");
  });

  it("reports real only when every requirement is present and never returns names or values", async () => {
    const environment = { SETTERFI_SLACK_DRIVER: "real", SLACK_WEBHOOK_URL: "https://synthetic.invalid/secret-path" };
    const result = await loadSystemHealth({ source: source(), environment });
    expect(result.providers.find((provider) => provider.id === "alerts")).toEqual({ id: "alerts", label: "Alerts", state: "real", reason: null });
    expect(JSON.stringify(result.providers)).not.toContain("SLACK_WEBHOOK_URL");
    expect(JSON.stringify(result)).not.toContain(environment.SLACK_WEBHOOK_URL);
  });

  it("keeps a grouped integration in mock state until every underlying service is real", async () => {
    const result = await loadSystemHealth({
      source: source(), environment: { SETTERFI_OPENROUTER_DRIVER: "real", OPENROUTER_API_KEY: "synthetic-routing-secret" },
    });
    expect(result.providers.find((provider) => provider.id === "model-routing")).toEqual({
      id: "model-routing", label: "Model routing", state: "mock", reason: "Part of this integration is using mock data.",
    });
  });

  it("never exposes any deployment configuration name in the public provider projection", async () => {
    const result = await loadSystemHealth({
      source: source(), environment: { SETTERFI_META_DRIVER: "real", META_APP_ID: "app", META_APP_SECRET: "secret" },
    });
    const projection = JSON.stringify(result.providers);
    expect(projection).not.toMatch(/[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)+/);
    expect(projection).not.toContain("secret");
  });
});
