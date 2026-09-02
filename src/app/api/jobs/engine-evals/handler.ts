import { accessToken, safeEqual } from "@/lib/access";
import { phase8EngineEvalLive } from "@/lib/env-contract";
import { runStoredEngineEvalCases, type NightlyEngineEvalResult } from "@/lib/evals/nightly-engine-evals";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [left, right] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(left, right);
}

type Dependencies = {
  enabled(): boolean;
  secret: string | null;
  execute?: JobReceiptExecution;
  run(): Promise<NightlyEngineEvalResult>;
};

export function createEngineEvalJobHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
    if (!(await authorized(request, dependencies.secret))) return Response.json({ error: "Unauthorized." }, { status: 401, headers });
    try {
      const work = () => dependencies.run();
      const result = await (dependencies.execute ? dependencies.execute("engine-evals", work, {
        counters: (value) => value.state === "complete"
          ? { cases: value.cases }
          : {} as Record<string, number>,
        outcome: (value) => value.state === "complete" ? "succeeded" : "failed",
        errorDetail: (value) => value.state === "complete" ? null : value.code,
      }) : work());
      return Response.json(result, { status: result.state === "complete" ? 200 : 503, headers });
    } catch (error) {
      return Response.json({
        state: "unavailable", code: error instanceof Error && error.message === "PHASE3_ENGINE_CASES_MISSING" ? error.message : "ENGINE_EVAL_UNAVAILABLE",
      }, { status: 503, headers });
    }
  };
}

export const GET = createEngineEvalJobHandler({
  enabled: phase8EngineEvalLive,
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  run: runStoredEngineEvalCases,
});
