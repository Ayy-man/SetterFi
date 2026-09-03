import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentSource } from "@/lib/env-contract";
import type { SystemJobReceipt } from "@/lib/repositories/job-receipts";

import { loadDeploymentReadiness } from "./deployment-readiness";

const BASE_ENVIRONMENT: EnvironmentSource = {
  NODE_ENV: "test",
  SETTERFI_AUTH_MODE: "supabase",
  NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-secret-never-rendered",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret-never-rendered",
};

function receipt(job: SystemJobReceipt["job"], overrides: Partial<SystemJobReceipt> = {}): SystemJobReceipt {
  return {
    job,
    outcome: "succeeded",
    startedAt: "2026-08-31T00:00:00.000Z",
    finishedAt: "2026-08-31T00:00:01.000Z",
    receiptId: `receipt-${job}`,
    errorDetail: null,
    freshness: "fresh",
    freshnessWindowMs: 60_000,
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("deployment readiness", () => {
  it("is ready when baseline configuration and the read-only database probe succeed", async () => {
    const readReceipts = vi.fn().mockResolvedValue([]);
    await expect(loadDeploymentReadiness({ environment: BASE_ENVIRONMENT, readReceipts })).resolves.toEqual({
      status: "ready",
      configuration: true,
      database: true,
      automation: true,
      requiredProviders: true,
    });
    expect(readReceipts).toHaveBeenCalledOnce();
  });

  it("fails configuration closed when auth or database configuration is incomplete", async () => {
    for (const missing of ["SETTERFI_AUTH_MODE", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const) {
      const environment = { ...BASE_ENVIRONMENT, [missing]: undefined };
      const result = await loadDeploymentReadiness({ environment, readReceipts: async () => [] });
      expect(result.configuration, missing).toBe(false);
      expect(result.status).toBe("unready");
    }
  });

  it("requires cron authentication, fresh successful receipts, and real providers only for enabled work", async () => {
    const environment: EnvironmentSource = {
      ...BASE_ENVIRONMENT,
      SETTERFI_PHASE1_LIVE: "true",
      CRON_SECRET: "cron-secret-never-rendered",
      SETTERFI_GHL_DRIVER: "real",
      GHL_CLIENT_ID: "client-id",
      GHL_CLIENT_SECRET: "client-secret",
      GHL_WEBHOOK_PUBLIC_KEY: "public-key",
      SETTERFI_OPENROUTER_DRIVER: "real",
      OPENROUTER_API_KEY: "model-secret",
      SETTERFI_META_DRIVER: "invalid",
      SETTERFI_STRIPE_DRIVER: "invalid",
    };
    const required = [
      receipt("appointment-reconcile"),
      receipt("contact-deletion-recovery"),
      receipt("ghl-install-reconcile"),
      receipt("inbound-recovery"),
    ];
    await expect(loadDeploymentReadiness({ environment, readReceipts: async () => required })).resolves.toEqual({
      status: "ready",
      configuration: true,
      database: true,
      automation: true,
      requiredProviders: true,
    });
    await expect(loadDeploymentReadiness({
      environment: { ...environment, CRON_SECRET: undefined },
      readReceipts: async () => required,
    })).resolves.toMatchObject({ status: "unready", configuration: false });
    await expect(loadDeploymentReadiness({
      environment: { ...environment, OPENROUTER_API_KEY: undefined },
      readReceipts: async () => required,
    })).resolves.toMatchObject({ status: "unready", requiredProviders: false });
  });

  it("reports stale, failed, and missing required job evidence as unavailable automation", async () => {
    const environment: EnvironmentSource = {
      ...BASE_ENVIRONMENT,
      SETTERFI_PHASE6_LIVE: "true",
      CRON_SECRET: "cron-secret",
    };
    for (const receipts of [
      [receipt("billing-allowances"), receipt("billing-cost-rollup", { freshness: "stale" })],
      [receipt("billing-allowances"), receipt("billing-cost-rollup", { outcome: "failed" })],
      [receipt("billing-allowances")],
    ]) {
      const result = await loadDeploymentReadiness({ environment, readReceipts: async () => receipts });
      expect(result).toMatchObject({ status: "unready", database: true, automation: false });
    }
  });

  it("bounds the database probe and converts timeout or read failure to booleans", async () => {
    vi.useFakeTimers();
    const pending = loadDeploymentReadiness({
      environment: BASE_ENVIRONMENT,
      readReceipts: () => new Promise(() => undefined),
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toMatchObject({ status: "unready", database: false, automation: false });

    vi.useRealTimers();
    await expect(loadDeploymentReadiness({
      environment: BASE_ENVIRONMENT,
      readReceipts: async () => { throw new Error("database URL and raw error must stay private"); },
    })).resolves.toMatchObject({ status: "unready", database: false, automation: false });
  });
});
