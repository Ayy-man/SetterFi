import { accessToken, safeEqual } from "@/lib/access";
import { createLiveAllowanceDependencies, runAllowanceBatch } from "@/lib/billing/allowances";
import { phase6Live } from "@/lib/env-contract";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import { createLiveBillingNotificationPort } from "@/lib/notifications/billing-events";

const headers = { "Cache-Control": "no-store" };
type Dependencies = { enabled(): boolean; secret: string | null; execute?: JobReceiptExecution; run(): Promise<{ selected: number; acted: number; failed: number }> };

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [left, right] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(left, right);
}

export function createBillingAllowanceJobHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
    if (!(await authorized(request, dependencies.secret))) return Response.json({ error: "Unauthorized." }, { status: 401, headers });
    try {
      const work = () => dependencies.run();
      return Response.json(await (dependencies.execute ? dependencies.execute("billing-allowances", work) : work()), { headers });
    } catch (cause) {
      console.error(
        "/api/jobs/billing-allowances failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Allowance run unavailable." }, { status: 503, headers });
    }
  };
}

export const POST = createBillingAllowanceJobHandler({
  enabled: phase6Live,
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  run: () => runAllowanceBatch(createLiveAllowanceDependencies(createLiveBillingNotificationPort())),
});

export const GET = POST;
