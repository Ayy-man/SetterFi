import { accessToken, safeEqual } from "@/lib/access";
import { phase1Live, phase3Live } from "@/lib/env-contract";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import {
  createLiveOutboundReconciliationDependencies,
  runOutboundReconciliationBatch,
} from "@/lib/sends/reconciliation";

const HEADERS = { "Cache-Control": "no-store" };

type Dependencies = {
  enabled(): boolean;
  secret: string | null;
  execute?: JobReceiptExecution;
  run(): Promise<{ claimed: number; persisted: number; alerted: number; retryable: number }>;
};

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [left, right] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(left, right);
}

export function createOutboundReconciliationJobHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: HEADERS });
    }
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers: HEADERS });
    }
    try {
      const work = () => dependencies.run();
      return Response.json(
        await (dependencies.execute ? dependencies.execute("outbound-reconciliation", work) : work()),
        { headers: HEADERS },
      );
    } catch (cause) {
      console.error(
        "/api/jobs/outbound-reconciliation failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json(
        { error: "Outbound reconciliation unavailable." },
        { status: 503, headers: HEADERS },
      );
    }
  };
}

export const GET = createOutboundReconciliationJobHandler({
  enabled: () => phase1Live() && phase3Live(),
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  run: () => runOutboundReconciliationBatch(createLiveOutboundReconciliationDependencies()),
});
