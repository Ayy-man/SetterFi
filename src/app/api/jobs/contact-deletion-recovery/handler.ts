import { accessToken, safeEqual } from "@/lib/access";
import { contactDeleteLive, phase1Live, phase3Live } from "@/lib/env-contract";
import { recoverContactDeletions } from "@/lib/deletion/recovery";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";

const noStoreHeaders = { "Cache-Control": "no-store" };

type Dependencies = {
  secret: string | null;
  execute?: JobReceiptExecution;
  recover(limit: number): Promise<{
    claimed: number;
    completed: number;
    retried: number;
    operatorRequired: number;
  }>;
};

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [candidateHash, secretHash] = await Promise.all([
    accessToken(candidate), accessToken(secret),
  ]);
  return safeEqual(candidateHash, secretHash);
}

export function createContactDeletionRecoveryHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    // The recovery job drives the same durable deletions the API exposes, so it answers to the
    // same gate the delete handlers use — otherwise the cron keeps finishing deletions after the
    // feature is switched off.
    if (!phase1Live() || !phase3Live() || !contactDeleteLive()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers: noStoreHeaders });
    }
    const work = () => dependencies.recover(10);
    return Response.json(
      await (dependencies.execute ? dependencies.execute("contact-deletion-recovery", work) : work()),
      { headers: noStoreHeaders },
    );
  };
}

export const GET = createContactDeletionRecoveryHandler({
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  recover: recoverContactDeletions,
});
