import { accessToken, safeEqual } from "@/lib/access";
import { dispatchCapiEvents } from "@/lib/capi/worker";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";

const BATCH_LIMIT = 25;
const noStoreHeaders = { "Cache-Control": "no-store" };

type CapiJobDependencies = {
  secret: string | null;
  execute?: JobReceiptExecution;
  dispatch(limit: number): Promise<{
    claimed: number;
    sent: number;
    mockSent: number;
    excluded: number;
    retried: number;
    terminalFailed: number;
  }>;
};

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [candidateHash, secretHash] = await Promise.all([
    accessToken(candidate),
    accessToken(secret),
  ]);
  return safeEqual(candidateHash, secretHash);
}

export function createCapiEventsHandler(dependencies: CapiJobDependencies) {
  return async function GET(request: Request) {
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers: noStoreHeaders });
    }
    const work = () => dependencies.dispatch(BATCH_LIMIT);
    return Response.json(
      await (dependencies.execute ? dependencies.execute("capi-events", work) : work()),
      { headers: noStoreHeaders },
    );
  };
}

export const GET = createCapiEventsHandler({
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  dispatch: dispatchCapiEvents,
});
