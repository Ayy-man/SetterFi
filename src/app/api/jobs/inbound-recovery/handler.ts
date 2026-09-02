import { accessToken, safeEqual } from "@/lib/access";
import { phase1Live } from "@/lib/env-contract";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import { recoverInboundWebhookReceipts } from "@/lib/webhooks/process-inbound";

const BATCH_LIMIT = 25;
const noStoreHeaders = { "Cache-Control": "no-store" };

type RecoveryDependencies = {
  secret: string | null;
  execute?: JobReceiptExecution;
  recover(limit: number): Promise<{ claimed: number; processed: number; failed: number }>;
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

export function createInboundRecoveryHandler(dependencies: RecoveryDependencies) {
  return async function GET(request: Request) {
    if (!phase1Live()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers: noStoreHeaders });
    }
    const work = () => dependencies.recover(BATCH_LIMIT);
    return Response.json(
      await (dependencies.execute ? dependencies.execute("inbound-recovery", work) : work()),
      { headers: noStoreHeaders },
    );
  };
}

export const GET = createInboundRecoveryHandler({
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  recover: recoverInboundWebhookReceipts,
});
