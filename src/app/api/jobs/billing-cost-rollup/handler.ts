import { accessToken, safeEqual } from "@/lib/access";
import { phase6Live } from "@/lib/env-contract";
import { claimFairBillingTenantIds } from "@/lib/jobs/fair-scan";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const headers = { "Cache-Control": "no-store" };
export type CostRollupReceipt = { rollupId: string; tenantId: string; complete: boolean; missingSources: string[]; marginCents?: number };
type Dependencies = { enabled(): boolean; secret: string | null; execute?: JobReceiptExecution; run(): Promise<readonly CostRollupReceipt[]> };

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [left, right] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(left, right);
}

export function createBillingCostRollupJobHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
    if (!(await authorized(request, dependencies.secret))) return Response.json({ error: "Unauthorized." }, { status: 401, headers });
    try {
      const work = () => dependencies.run();
      const rollups = await (dependencies.execute ? dependencies.execute("billing-cost-rollup", work, {
        counters: (result) => ({ selected: result.length, complete: result.filter((row) => row.complete).length }),
      }) : work());
      return Response.json({ selected: rollups.length, rollups }, { headers });
    } catch (cause) {
      console.error(
        "/api/jobs/billing-cost-rollup failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Cost rollup unavailable." }, { status: 503, headers });
    }
  };
}

export async function runLiveCostRollup(): Promise<CostRollupReceipt[]> {
  const client = createSupabaseServiceClient();
  const tenantIds = await claimFairBillingTenantIds(client, "billing_cost_rollup", 25, null);
  if (tenantIds.length === 0) return [];
  const { data: subscriptions, error } = await client.from("billing_subscriptions")
    .select("tenant_id,stripe_price_id,current_period_start,current_period_end").in("tenant_id", tenantIds);
  if (error) throw new Error("COST_SUBSCRIPTIONS_READ_FAILED");
  const order = new Map(tenantIds.map((tenantId, index) => [tenantId, index]));
  const selected = [...(subscriptions ?? [])].sort((left, right) =>
    (order.get(left.tenant_id) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right.tenant_id) ?? Number.MAX_SAFE_INTEGER));
  const receipts: CostRollupReceipt[] = [];
  for (const subscription of selected) {
    const [{ data: tenant }, { data: tier }, traces] = await Promise.all([
      client.from("tenants").select("is_demo").eq("id", subscription.tenant_id).single(),
      client.from("tiers").select("price_cents").eq("stripe_price_id", subscription.stripe_price_id).single(),
      client.from("message_traces").select("cost").eq("tenant_id", subscription.tenant_id)
        .gte("created_at", subscription.current_period_start).lt("created_at", subscription.current_period_end),
    ]);
    if (!tenant || !tier || traces.error) throw new Error("COST_SOURCE_READ_FAILED");
    const modelCents = (traces.data ?? []).reduce((sum, trace) => sum + Math.round(Number(trace.cost) * 100), 0);
    const missingSources = tenant.is_demo ? [] : ["messaging", "embedding"];
    const messagingCents = tenant.is_demo ? 0 : null;
    const embeddingCents = tenant.is_demo ? 0 : null;
    const { data, error: rpcError } = await client.rpc("write_tenant_cost_rollup", {
      p_expected_tenant: subscription.tenant_id,
      p_window_start: subscription.current_period_start, p_window_end: subscription.current_period_end,
      p_recognized_subscription_cents: tier.price_cents, p_model_cents: modelCents,
      p_messaging_cents: messagingCents, p_embedding_cents: embeddingCents,
      p_missing_sources: missingSources,
      p_source_evidence: tenant.is_demo
        ? { lane: "SETTERFI_DEMO_PLACEHOLDER_COSTS", model: "message_traces.cost" }
        : { model: "message_traces.cost", messaging: "missing", embedding: "missing" },
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (rpcError || !row?.rollup_id || typeof row.complete !== "boolean") throw new Error("COST_ROLLUP_WRITE_FAILED");
    const persisted = await client.from("tenant_cost_rollups")
      .select("id,complete,missing_sources,total_cost_cents,recognized_subscription_cents")
      .eq("id", row.rollup_id).single();
    if (persisted.error || !persisted.data || persisted.data.complete !== row.complete) throw new Error("COST_ROLLUP_READBACK_MISMATCH");
    const receipt: CostRollupReceipt = {
      rollupId: row.rollup_id, tenantId: subscription.tenant_id,
      complete: row.complete, missingSources: persisted.data.missing_sources,
    };
    if (persisted.data.complete) {
      receipt.marginCents = persisted.data.recognized_subscription_cents - persisted.data.total_cost_cents;
    }
    receipts.push(receipt);
  }
  return receipts;
}

export const POST = createBillingCostRollupJobHandler({
  enabled: phase6Live,
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  run: runLiveCostRollup,
});

export const GET = POST;
