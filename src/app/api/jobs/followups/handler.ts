import { accessToken, safeEqual } from "@/lib/access";
import { phase1Live, phase3Live } from "@/lib/env-contract";
import { runFollowupBatch } from "@/lib/followups/scheduler";
import { claimFairTenantIds } from "@/lib/jobs/fair-scan";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import { createLiveSendToLeadGateway } from "@/lib/repositories/conversations";
import { createLiveFollowupSchedulerRepository } from "@/lib/repositories/followups";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const TENANT_LIMIT = 25;
const FOLLOWUP_LIMIT = 50;
const noStoreHeaders = { "Cache-Control": "no-store" };

type Dependencies = {
  secret: string | null;
  execute?: JobReceiptExecution;
  listTenants(limit: number): Promise<readonly string[]>;
  run(input: { tenantId: string; workerKey: string; now: string; limit: number }): Promise<readonly { outcome: string }[]>;
};

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [candidateHash, secretHash] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(candidateHash, secretHash);
}

export function createFollowupJobHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    if (!phase1Live() || !phase3Live()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers: noStoreHeaders });
    }
    const work = async () => {
      const now = new Date().toISOString();
      const workerKey = `followups:${now.slice(0, 16)}`;
      const tenants = await dependencies.listTenants(TENANT_LIMIT);
      let claimed = 0;
      let sent = 0;
      let deferred = 0;
      let canceled = 0;
      for (const tenantId of tenants) {
        const results = await dependencies.run({ tenantId, workerKey, now, limit: FOLLOWUP_LIMIT });
        claimed += results.length;
        sent += results.filter((result) => result.outcome === "sent").length;
        deferred += results.filter((result) => result.outcome === "deferred").length;
        canceled += results.filter((result) => result.outcome === "canceled").length;
      }
      return { tenants: tenants.length, claimed, sent, deferred, canceled };
    };
    return Response.json(
      await (dependencies.execute ? dependencies.execute("followups", work) : work()),
      { headers: noStoreHeaders },
    );
  };
}

async function listTenants(limit: number) {
  const client = createSupabaseServiceClient();
  return claimFairTenantIds(client, "followups", limit);
}

export const GET = createFollowupJobHandler({
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  listTenants,
  run: async (input) => runFollowupBatch(input, {
    repository: createLiveFollowupSchedulerRepository(),
    sendToLead: createLiveSendToLeadGateway(),
  }),
});
