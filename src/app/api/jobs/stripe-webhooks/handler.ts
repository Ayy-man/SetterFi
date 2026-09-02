import { accessToken, safeEqual } from "@/lib/access";
import {
  createLiveStripeEventProcessor,
  processClaimedStripeWebhookReceipt,
  type StripeEventProcessorDependencies,
} from "@/lib/billing/stripe-events";
import { phase6StripeLive } from "@/lib/env-contract";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import {
  createStripeWebhookRepository,
  STRIPE_WEBHOOK_BATCH_LIMIT,
  type ClaimedStripeWebhookReceipt,
  type StripeWebhookReceipt,
} from "@/lib/repositories/stripe-webhooks";

export const runtime = "nodejs";

const noStoreHeaders = { "Cache-Control": "no-store" };

export type StripeWebhookJobDependencies = {
  enabled(): boolean;
  secret: string | null;
  execute?: JobReceiptExecution;
  claimBatch(limit: number): Promise<readonly ClaimedStripeWebhookReceipt[]>;
  processReceipt(receipt: ClaimedStripeWebhookReceipt): Promise<{
    status: StripeWebhookReceipt["status"];
  }>;
};

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: noStoreHeaders });
}

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

export function createStripeWebhookJobHandler(dependencies: StripeWebhookJobDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return json({ error: "Not found." }, 404);
    if (!(await authorized(request, dependencies.secret))) {
      return json({ error: "Unauthorized." }, 401);
    }

    try {
      const work = async () => {
        const receipts = await dependencies.claimBatch(STRIPE_WEBHOOK_BATCH_LIMIT);
        let processed = 0;
        let skipped = 0;
        let failed = 0;
        for (const receipt of receipts) {
          try {
            const result = await dependencies.processReceipt(receipt);
            if (result.status === "skipped") skipped += 1;
            else if (result.status === "processed") processed += 1;
            else failed += 1;
          } catch {
            failed += 1;
          }
        }
        return { selected: receipts.length, processed, skipped, failed };
      };
      const result = await (dependencies.execute ? dependencies.execute("stripe-webhooks", work) : work());
      return json(result, 200);
    } catch {
      return json({ error: "Webhook inbox unavailable." }, 503);
    }
  };
}

const repository = createStripeWebhookRepository();

function liveProcessor(): StripeEventProcessorDependencies {
  return createLiveStripeEventProcessor();
}

export const POST = createStripeWebhookJobHandler({
  enabled: phase6StripeLive,
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  claimBatch: (limit) => repository.claimBatch(limit),
  processReceipt: async (receipt) => processClaimedStripeWebhookReceipt(receipt, {
    ...liveProcessor(),
    repository,
  }),
});

// Vercel cron invocations are GET requests. Keep manual POST replay support, but route both
// methods through the same secret-bounded handler so the scheduled path cannot bypass auth.
export const GET = POST;
