import type { AllowanceActionResult, BillingNotificationPort } from "@/lib/billing/contracts";
import { createMockStripeDriver } from "@/lib/integrations/stripe/mock";
import { createRealStripeDriver } from "@/lib/integrations/stripe/real";
import { resolveStripeDriver } from "@/lib/integrations/stripe/selector";
import type { StripeDriver } from "@/lib/integrations/stripe/types";
import { claimFairBillingTenantIds } from "@/lib/jobs/fair-scan";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type AllowanceCandidate = {
  tenantId: string;
  isDemo: boolean;
  periodStart: string;
  periodEnd: string;
  subscriptionId: string;
  currentTierId: string;
  currentPriceId: string;
  allowance: number;
  /**
   * True when the plan has no booked-call ceiling (`tiers.is_uncapped`). `allowance` still holds a
   * number on these rows -- the threshold the tier begins at, 75 for the client's "997 beyond that"
   * -- so every other reader of that column stays correct. This is the fact that nothing may happen
   * when the count passes it.
   */
  isUncapped: boolean;
  fairUseCap: number | null;
  nextTier: { id: string; priceId: string } | null;
  allowedPriceIds: readonly string[];
};

export type AllowanceRepository = {
  candidates(limit: number): Promise<readonly AllowanceCandidate[]>;
  countUsage(candidate: AllowanceCandidate): Promise<number>;
  findAction(candidate: AllowanceCandidate, kind: "warning" | "crossing" | "fair_use_review"): Promise<AllowanceActionResult | null>;
  record(input: {
    candidate: AllowanceCandidate;
    kind: "warning" | "crossing" | "fair_use_review";
    threshold: number;
    observedCount: number;
    pendingTierId: string | null;
    effectiveAt: string | null;
    noticeEventId: string;
    scheduleId: string | null;
    state: "pending" | "scheduled" | "review";
  }): Promise<AllowanceActionResult>;
};

export type AllowanceDependencies = {
  repository: AllowanceRepository;
  notifications: BillingNotificationPort;
  driver(candidate: AllowanceCandidate): Pick<StripeDriver, "createRenewalPriceSchedule">;
};

const ALLOWANCE_ACTION_RESULT_SELECT = [
  "id",
  "notice_event_id",
  "stripe_schedule_id",
  "pending_tier_id",
  "effective_at",
].join(",");

type AllowanceActionRow = {
  id: string;
  notice_event_id: string;
  stripe_schedule_id: string | null;
  pending_tier_id: string | null;
  effective_at: string | null;
};

function threshold(allowance: number) {
  if (!Number.isSafeInteger(allowance) || allowance <= 0) throw new Error("BILLING_ALLOWANCE_INVALID");
  return Math.ceil(allowance * 0.9);
}

export async function evaluateAllowance(
  candidate: AllowanceCandidate,
  dependencies: AllowanceDependencies,
): Promise<AllowanceActionResult | null> {
  /*
   * An uncapped plan is answered before anything is counted, because there is no number here that
   * would mean anything if it were. `allowance` on these rows is the threshold the tier *begins*
   * at, not a ceiling -- the client's top tier is "997 beyond that" (`docs/INTAKE.md:57`) and names
   * no upper bound at all -- so `threshold()` below would warn this tenant at 68 booked calls and
   * the comparison after it would schedule them a Stripe tier change at 75, against a contract that
   * agreed to neither. That is a wrong charge rather than a wrong screen, which is why it returns
   * here rather than being filtered further down: none of warning, crossing or fair-use review is a
   * correct outcome for a plan with no cap, and leaving the count to run would only give a later
   * edit something to get wrong.
   */
  if (candidate.isUncapped) return null;
  const observedCount = await dependencies.repository.countUsage(candidate);
  const warningAt = threshold(candidate.allowance);
  if (observedCount < warningAt) return null;
  const kind = observedCount >= candidate.allowance
    ? candidate.nextTier ? "crossing" : "fair_use_review"
    : "warning";
  const existing = await dependencies.repository.findAction(candidate, kind);
  if (existing) return existing;
  const operationKey = `allowance:${candidate.tenantId}:${candidate.periodEnd}:${kind}`;

  if (kind === "crossing" && candidate.nextTier) {
    const schedule = await dependencies.driver(candidate).createRenewalPriceSchedule({
      tenantId: candidate.tenantId,
      subscriptionId: candidate.subscriptionId,
      currentPriceId: candidate.currentPriceId,
      targetPriceId: candidate.nextTier.priceId,
      currentPeriodEnd: candidate.periodEnd,
      idempotencyKey: `schedule:${candidate.tenantId}:${candidate.periodEnd}:${candidate.nextTier.priceId}`,
    });
    if (schedule.state !== "scheduled" || !schedule.scheduleId.trim()) throw new Error("ALLOWANCE_SCHEDULE_RECEIPT_INVALID");
    const notice = await dependencies.notifications.emit({
      key: "billing.allowance_crossed", tenantId: candidate.tenantId,
      allowanceActionId: operationKey, observedCount, allowance: candidate.allowance,
      targetTierId: candidate.nextTier.id, targetPriceId: candidate.nextTier.priceId,
      effectiveAt: candidate.periodEnd, occurredAt: new Date().toISOString(), isTest: false,
    });
    return dependencies.repository.record({
      candidate, kind, threshold: candidate.allowance, observedCount,
      pendingTierId: candidate.nextTier.id, effectiveAt: candidate.periodEnd,
      noticeEventId: notice.notificationId, scheduleId: schedule.scheduleId, state: "scheduled",
    });
  }

  const notice = await dependencies.notifications.emit({
    key: kind === "warning" ? "billing.allowance_warning" : "billing.allowance_crossed",
    tenantId: candidate.tenantId, allowanceActionId: operationKey,
    observedCount, allowance: candidate.allowance,
    ...(kind === "warning" ? { periodEnd: candidate.periodEnd } : {
      targetTierId: candidate.currentTierId, targetPriceId: candidate.currentPriceId,
      effectiveAt: candidate.periodEnd,
    }),
    occurredAt: new Date().toISOString(), isTest: false,
  } as Parameters<BillingNotificationPort["emit"]>[0]);
  return dependencies.repository.record({
    candidate, kind, threshold: kind === "warning" ? warningAt : candidate.allowance,
    observedCount, pendingTierId: null, effectiveAt: null,
    noticeEventId: notice.notificationId, scheduleId: null,
    state: kind === "warning" ? "pending" : "review",
  });
}

export async function runAllowanceBatch(dependencies: AllowanceDependencies, limit = 25) {
  const candidates = await dependencies.repository.candidates(limit);
  const results: AllowanceActionResult[] = [];
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await evaluateAllowance(candidate, dependencies);
      if (result) results.push(result);
    } catch {
      failed += 1;
    }
  }
  return { selected: candidates.length, acted: results.length, failed, results };
}

export function createLiveAllowanceRepository(): AllowanceRepository {
  const client = createSupabaseServiceClient();
  return {
    candidates: async (limit) => {
      const tenantIds = await claimFairBillingTenantIds(
        client,
        "billing_allowances",
        limit,
        ["active", "trialing", "past_due"],
      );
      if (tenantIds.length === 0) return [];
      const { data: subscriptions, error } = await client.from("billing_subscriptions")
        .select("tenant_id,stripe_subscription_id,stripe_price_id,current_period_start,current_period_end,status")
        .in("tenant_id", tenantIds).in("status", ["active", "trialing", "past_due"]);
      if (error) throw new Error("ALLOWANCE_SUBSCRIPTIONS_READ_FAILED");
      const order = new Map(tenantIds.map((tenantId, index) => [tenantId, index]));
      const selected = [...(subscriptions ?? [])].sort((left, right) =>
        (order.get(left.tenant_id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.tenant_id) ?? Number.MAX_SAFE_INTEGER));
      const result: AllowanceCandidate[] = [];
      for (const subscription of selected) {
        const [tenantRead, tierRead, { data: tiers }] = await Promise.all([
          client.from("tenants").select("id,is_demo").eq("id", subscription.tenant_id).single(),
          client.from("tiers").select("id,price_cents,call_allowance,fair_use_cap,is_uncapped,stripe_price_id")
            .eq("stripe_price_id", subscription.stripe_price_id).eq("active", true).single(),
          client.from("tiers").select("id,price_cents,stripe_price_id").eq("active", true)
            .not("stripe_price_id", "is", null).order("price_cents"),
        ]);
        const { data: tenant } = tenantRead;
        const { data: tier } = tierRead;
        /*
         * A failed PostgREST read resolves with an error rather than throwing, and this loop's skip
         * below cannot tell that from a tenant that simply has no matching tier -- so a mistake that
         * disqualifies every row, such as selecting a column the database does not have yet, would
         * empty the candidate list and the job would report a quiet, successful nothing. Naming it
         * costs a line and is the only way the difference is visible: `is_uncapped` ships ahead of
         * its migration by design, and while that migration is unapplied this is exactly the shape
         * the failure takes.
         */
        if (tenantRead.error || tierRead.error) {
          console.error(
            "Allowance candidate read failed.",
            tenantRead.error?.code ?? tierRead.error?.code ?? "ALLOWANCE_CANDIDATE_READ_FAILED",
          );
        }
        if (!tenant || !tier || !subscription.stripe_subscription_id || !subscription.current_period_start || !subscription.current_period_end) continue;
        const next = (tiers ?? []).find((candidateTier) => candidateTier.price_cents > tier.price_cents);
        result.push({
          tenantId: tenant.id, isDemo: tenant.is_demo, periodStart: subscription.current_period_start,
          periodEnd: subscription.current_period_end, subscriptionId: subscription.stripe_subscription_id,
          currentTierId: tier.id, currentPriceId: tier.stripe_price_id,
          allowance: tier.call_allowance, isUncapped: tier.is_uncapped === true,
          fairUseCap: tier.fair_use_cap,
          nextTier: next ? { id: next.id, priceId: next.stripe_price_id } : null,
          allowedPriceIds: [...new Set([
            tier.stripe_price_id,
            ...(next ? [next.stripe_price_id] : []),
          ])],
        });
      }
      return result;
    },
    countUsage: async (candidate) => {
      const { count, error } = await client.from("billable_events").select("id", { count: "exact", head: true })
        .eq("tenant_id", candidate.tenantId).eq("is_test", false)
        .gte("created_at", candidate.periodStart).lt("created_at", candidate.periodEnd);
      if (error || count === null) throw new Error("ALLOWANCE_USAGE_READ_FAILED");
      return count;
    },
    findAction: async (candidate, kind) => {
      const { data, error } = await client.from("allowance_actions").select(ALLOWANCE_ACTION_RESULT_SELECT)
        .eq("tenant_id", candidate.tenantId).eq("billing_period_end", candidate.periodEnd)
        .eq("kind", kind).maybeSingle();
      if (error) throw new Error("ALLOWANCE_ACTION_READ_FAILED");
      if (!data) return null;
      const action = data as unknown as AllowanceActionRow;
      if (kind === "crossing") return { kind, actionId: action.id, noticeEventId: action.notice_event_id,
        scheduleId: action.stripe_schedule_id!, targetTierId: action.pending_tier_id!,
        effectiveAt: action.effective_at!, state: "scheduled" };
      return { kind, actionId: action.id, noticeEventId: action.notice_event_id, state: "recorded" };
    },
    record: async (input) => {
      const { data, error } = await client.rpc("record_allowance_action", {
        p_expected_tenant: input.candidate.tenantId,
        p_billing_period_start: input.candidate.periodStart, p_billing_period_end: input.candidate.periodEnd,
        p_kind: input.kind, p_threshold: input.threshold, p_observed_count: input.observedCount,
        p_pending_tier_id: input.pendingTierId, p_effective_at: input.effectiveAt,
        p_notice_event_id: input.noticeEventId, p_stripe_schedule_id: input.scheduleId, p_state: input.state,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.allowance_action_id) throw new Error("ALLOWANCE_ACTION_WRITE_FAILED");
      const persisted = await client.from("allowance_actions").select("notice_event_id").eq("id", row.allowance_action_id).single();
      if (persisted.error || !persisted.data || persisted.data.notice_event_id !== input.noticeEventId) {
        throw new Error("ALLOWANCE_ACTION_READBACK_MISMATCH");
      }
      if (input.kind === "crossing" && input.pendingTierId && input.effectiveAt && input.scheduleId) {
        return { kind: "crossing", actionId: row.allowance_action_id,
          noticeEventId: input.noticeEventId, scheduleId: input.scheduleId,
          targetTierId: input.pendingTierId, effectiveAt: input.effectiveAt, state: "scheduled" };
      }
      return { kind: input.kind, actionId: row.allowance_action_id,
        noticeEventId: input.noticeEventId, state: "recorded" } as AllowanceActionResult;
    },
  };
}

export function createLiveAllowanceDependencies(notifications: BillingNotificationPort): AllowanceDependencies {
  return {
    repository: createLiveAllowanceRepository(), notifications,
    driver: (candidate) => resolveStripeDriver({
      environment: candidate.isDemo ? { SETTERFI_STRIPE_DRIVER: "mock" } : process.env,
      factories: {
        mock: createMockStripeDriver,
        real: (configuration) => createRealStripeDriver(configuration, {
          allowedPriceIds: candidate.allowedPriceIds,
        }),
      },
    }),
  };
}
