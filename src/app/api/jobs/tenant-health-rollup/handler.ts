import { accessToken, safeEqual } from "@/lib/access";
import { phase7AnalyticsLive } from "@/lib/env-contract";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const headers = { "Cache-Control": "no-store" };

/**
 * How far back each run reconstructs. The reconstruction only ever writes days a channel operation
 * receipt proves and never overwrites a nightly snapshot, so re-running it over the same window is
 * free and self-healing: a night the cron did not fire still gets its receipt counts back.
 */
export const TENANT_HEALTH_BACKFILL_DAYS = 30;

export type TenantHealthRollupResult = {
  day: string;
  tenantsWritten: number;
  signalsWritten: number;
  backfilledRows: number;
  backfillFrom: string;
  backfillTo: string;
};

type Dependencies = {
  enabled(): boolean;
  secret: string | null;
  execute?: JobReceiptExecution;
  run(): Promise<TenantHealthRollupResult>;
};

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [left, right] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(left, right);
}

export function createTenantHealthRollupJobHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers });
    }
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers });
    }
    try {
      const work = () => dependencies.run();
      const result = await (dependencies.execute
        ? dependencies.execute("tenant-health-rollup", work, {
          counters: (rollup) => ({
            tenantsWritten: rollup.tenantsWritten,
            signalsWritten: rollup.signalsWritten,
            backfilledRows: rollup.backfilledRows,
          }),
        })
        : work());
      return Response.json(result, { headers });
    } catch (cause) {
      console.error(
        "/api/jobs/tenant-health-rollup failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Tenant health rollup unavailable." }, { status: 503, headers });
    }
  };
}

function utcDay(at: Date, daysBack = 0) {
  const shifted = new Date(at.getTime() - daysBack * 24 * 60 * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Two writes, in the order that keeps the better evidence: today's snapshot of current channel,
 * provisioning, carrier and subscription state, then a reconstruction of the trailing window from
 * receipt timestamps for the days no snapshot exists. Neither invents a row: a tenant-day nothing
 * can prove stays absent (20260914000002).
 */
export async function runLiveTenantHealthRollup(
  now: Date = new Date(),
): Promise<TenantHealthRollupResult> {
  const client = createSupabaseServiceClient();
  const day = utcDay(now);
  const backfillFrom = utcDay(now, TENANT_HEALTH_BACKFILL_DAYS);
  const backfillTo = utcDay(now, 1);

  const snapshot = await client.rpc("write_tenant_health_snapshot", { p_day: day });
  const snapshotRow = Array.isArray(snapshot.data) ? snapshot.data[0] : snapshot.data;
  if (snapshot.error || typeof snapshotRow?.tenants_written !== "number"
    || typeof snapshotRow?.signals_written !== "number") {
    throw new Error("TENANT_HEALTH_SNAPSHOT_WRITE_FAILED");
  }

  const backfill = await client.rpc("backfill_tenant_health_rollup", {
    p_from: backfillFrom,
    p_to: backfillTo,
  });
  const backfillRow = Array.isArray(backfill.data) ? backfill.data[0] : backfill.data;
  if (backfill.error || typeof backfillRow?.rows_written !== "number") {
    throw new Error("TENANT_HEALTH_BACKFILL_FAILED");
  }

  return {
    day,
    tenantsWritten: snapshotRow.tenants_written,
    signalsWritten: snapshotRow.signals_written,
    backfilledRows: backfillRow.rows_written,
    backfillFrom,
    backfillTo,
  };
}

export const POST = createTenantHealthRollupJobHandler({
  enabled: phase7AnalyticsLive,
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  run: () => runLiveTenantHealthRollup(),
});

export const GET = POST;
