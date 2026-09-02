import { accessToken, safeEqual } from "@/lib/access";
import { phase8AlertRuleEventsLive } from "@/lib/env-contract";
import { runTierChangeReconciliation, createLiveTierChangeDependencies, type TierChangeBatchResult } from "@/lib/billing/tier-changes";
import { runJobWithReceipt, type JobReceiptExecution, type JobReceiptKey } from "@/lib/jobs/job-receipts";
import { createLiveBillingNotificationPort } from "@/lib/notifications/billing-events";

const headers = { "Cache-Control": "no-store" };
const JOB_KEY = "tier-change-reconcile" as JobReceiptKey;

type Dependencies = {
  enabled(): boolean;
  secret: string | null;
  execute?: JobReceiptExecution;
  run(): Promise<TierChangeBatchResult>;
};

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [left, right] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(left, right);
}

export function createTierChangeReconcileJobHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
    if (!(await authorized(request, dependencies.secret))) return Response.json({ error: "Unauthorized." }, { status: 401, headers });
    try {
      const work = () => dependencies.run();
      const result = await (dependencies.execute
        ? dependencies.execute(JOB_KEY, work, { counters: (batch) => batch })
        : work());
      return Response.json(result, { headers });
    } catch (cause) {
      console.error(
        "/api/jobs/tier-change-reconcile failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Tier-change reconciliation unavailable." }, { status: 503, headers });
    }
  };
}

export const POST = createTierChangeReconcileJobHandler({
  enabled: phase8AlertRuleEventsLive,
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  run: () => runTierChangeReconciliation(createLiveTierChangeDependencies(createLiveBillingNotificationPort())),
});

export const GET = POST;
