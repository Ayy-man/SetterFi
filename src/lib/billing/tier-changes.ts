import Stripe from "stripe";

import type { BillingNotificationPort } from "@/lib/billing/contracts";
import { driverSelection, requireEnvironment, type EnvironmentSource } from "@/lib/env-contract";
import { STRIPE_API_VERSION, STRIPE_SDK_VERSION } from "@/lib/integrations/stripe/real";
import { STRIPE_CONFIGURATION_NAMES } from "@/lib/integrations/stripe/selector";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type TierChangeCandidate = {
  actionId: string;
  tenantId: string;
  isDemo: boolean;
  scheduleId: string;
  subscriptionId: string;
  targetTierId: string;
  targetPriceId: string;
  effectiveAt: string;
  state: "scheduled" | "completed";
  completionNoticeEventId: string | null;
};

type ReleasedSubscription = {
  subscriptionId: string;
  priceId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  providerUpdatedAt: string;
};

export type TierChangeProviderResult =
  | { state: "pending" }
  | { state: "failed"; reason: string }
  | { state: "released"; subscription: ReleasedSubscription };

export type TierChangeRepository = {
  due(now: string, limit: number): Promise<readonly TierChangeCandidate[]>;
  complete(input: { candidate: TierChangeCandidate; subscription: ReleasedSubscription; confirmedAt: string }): Promise<TierChangeCandidate>;
  fail(input: { candidate: TierChangeCandidate; reason: string; confirmedAt: string }): Promise<void>;
  recordNotification(input: { actionId: string; notificationId: string }): Promise<void>;
};

export type TierChangeDependencies = {
  repository: TierChangeRepository;
  provider(candidate: TierChangeCandidate): Promise<TierChangeProviderResult>;
  notifications: BillingNotificationPort;
  now(): Date;
};

export type TierChangeBatchResult = {
  selected: number;
  pending: number;
  completed: number;
  terminalFailed: number;
  notified: number;
  errors: number;
};

function object(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerId(candidate: unknown) {
  return text(candidate) ?? text(object(candidate)?.id);
}

function secondsIso(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(code);
  return new Date(value * 1_000).toISOString();
}

function subscriptionSnapshot(subscriptionValue: unknown, expectedSubscriptionId: string): ReleasedSubscription {
  const subscription = object(subscriptionValue);
  const items = object(subscription?.items);
  const item = Array.isArray(items?.data) ? object(items.data[0]) : null;
  const priceId = providerId(item?.price);
  const subscriptionId = text(subscription?.id);
  const status = text(subscription?.status);
  if (!subscription || subscriptionId !== expectedSubscriptionId || !item || !priceId || !status
    || typeof subscription.cancel_at_period_end !== "boolean") {
    throw new Error("TIER_CHANGE_SUBSCRIPTION_ENVELOPE_INVALID");
  }
  return {
    subscriptionId,
    priceId,
    status,
    currentPeriodStart: secondsIso(item.current_period_start, "TIER_CHANGE_SUBSCRIPTION_PERIOD_INVALID"),
    currentPeriodEnd: secondsIso(item.current_period_end, "TIER_CHANGE_SUBSCRIPTION_PERIOD_INVALID"),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    // Stripe subscriptions do not expose a universally stable updated timestamp. The read instant
    // is the source timestamp for this confirmed snapshot and must win over an older webhook.
    providerUpdatedAt: new Date().toISOString(),
  };
}

export function createStripeTierChangeProvider(environment: EnvironmentSource = process.env) {
  if (driverSelection("stripe", "SETTERFI_STRIPE_DRIVER", environment) === "mock") {
    return async (): Promise<TierChangeProviderResult> => ({ state: "pending" });
  }
  const configuration = requireEnvironment("stripe", STRIPE_CONFIGURATION_NAMES, environment);
  if (Stripe.PACKAGE_VERSION !== STRIPE_SDK_VERSION) throw new Error("STRIPE_SDK_VERSION_MISMATCH");
  const stripe = new Stripe(configuration.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
  return async (candidate: TierChangeCandidate): Promise<TierChangeProviderResult> => {
    const schedule = object(await stripe.subscriptionSchedules.retrieve(candidate.scheduleId));
    if (!schedule || text(schedule.id) !== candidate.scheduleId) throw new Error("TIER_CHANGE_SCHEDULE_ENVELOPE_INVALID");
    if (schedule.status === "canceled") return { state: "failed", reason: "provider_cancelled" };
    if (schedule.status === "completed") return { state: "failed", reason: "provider_completed_without_release" };
    if (schedule.status !== "released") return { state: "pending" };
    const releasedSubscriptionId = providerId(schedule.released_subscription);
    if (releasedSubscriptionId !== candidate.subscriptionId) {
      throw new Error("TIER_CHANGE_RELEASED_SUBSCRIPTION_MISMATCH");
    }
    const subscription = subscriptionSnapshot(
      await stripe.subscriptions.retrieve(candidate.subscriptionId),
      candidate.subscriptionId,
    );
    if (subscription.priceId !== candidate.targetPriceId) throw new Error("TIER_CHANGE_RELEASED_PRICE_MISMATCH");
    return { state: "released", subscription };
  };
}

function candidate(row: Record<string, unknown>): TierChangeCandidate {
  const state = row.state === "scheduled" || row.state === "completed" ? row.state : null;
  const required = [
    ["allowance_action_id", row.allowance_action_id], ["tenant_id", row.tenant_id],
    ["stripe_schedule_id", row.stripe_schedule_id], ["stripe_subscription_id", row.stripe_subscription_id],
    ["target_tier_id", row.target_tier_id], ["target_price_id", row.target_price_id],
    ["effective_at", row.effective_at],
  ] as const;
  if (!state || typeof row.is_demo !== "boolean" || required.some(([, item]) => !text(item))) {
    throw new Error("TIER_CHANGE_CANDIDATE_INVALID");
  }
  return {
    actionId: text(row.allowance_action_id)!, tenantId: text(row.tenant_id)!, isDemo: row.is_demo,
    scheduleId: text(row.stripe_schedule_id)!, subscriptionId: text(row.stripe_subscription_id)!,
    targetTierId: text(row.target_tier_id)!, targetPriceId: text(row.target_price_id)!,
    effectiveAt: text(row.effective_at)!, state,
    completionNoticeEventId: row.completion_notice_event_id === null ? null : text(row.completion_notice_event_id),
  };
}

export function createLiveTierChangeRepository(): TierChangeRepository {
  const client = createSupabaseServiceClient();
  return {
    due: async (now, limit) => {
      const { data, error } = await client.rpc("list_due_tier_changes", { p_due_before: now, p_limit: limit });
      if (error) throw new Error("TIER_CHANGE_CANDIDATE_READ_FAILED");
      return (data ?? []).map((row: unknown) => candidate(row as Record<string, unknown>));
    },
    complete: async ({ candidate: pending, subscription, confirmedAt }) => {
      const { data, error } = await client.rpc("complete_scheduled_tier_change", {
        p_allowance_action_id: pending.actionId, p_stripe_subscription_id: subscription.subscriptionId,
        p_stripe_price_id: subscription.priceId, p_status: subscription.status,
        p_current_period_start: subscription.currentPeriodStart, p_current_period_end: subscription.currentPeriodEnd,
        p_cancel_at_period_end: subscription.cancelAtPeriodEnd, p_provider_updated_at: subscription.providerUpdatedAt,
        p_provider_confirmed_at: confirmedAt,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row || row.state !== "completed") throw new Error("TIER_CHANGE_COMPLETE_FAILED");
      return { ...pending, state: "completed", completionNoticeEventId: pending.completionNoticeEventId };
    },
    fail: async ({ candidate: pending, reason, confirmedAt }) => {
      const { data, error } = await client.rpc("fail_scheduled_tier_change", {
        p_allowance_action_id: pending.actionId, p_reason: reason, p_provider_confirmed_at: confirmedAt,
      });
      if (error || data !== "failed") throw new Error("TIER_CHANGE_FAIL_RECORD_FAILED");
    },
    recordNotification: async ({ actionId, notificationId }) => {
      const { data, error } = await client.rpc("record_tier_change_completion_notice", {
        p_allowance_action_id: actionId, p_notification_id: notificationId,
      });
      if (error || typeof data !== "string" || !data.trim()) throw new Error("TIER_CHANGE_NOTIFICATION_RECORD_FAILED");
    },
  };
}

async function notify(candidate: TierChangeCandidate, dependencies: TierChangeDependencies) {
  if (candidate.completionNoticeEventId) return false;
  const receipt = await dependencies.notifications.emit({
    key: "billing.tier_upgraded", tenantId: candidate.tenantId, allowanceActionId: candidate.actionId,
    targetTierId: candidate.targetTierId, targetPriceId: candidate.targetPriceId,
    effectiveAt: candidate.effectiveAt, occurredAt: dependencies.now().toISOString(), isTest: candidate.isDemo,
  });
  await dependencies.repository.recordNotification({ actionId: candidate.actionId, notificationId: receipt.notificationId });
  return true;
}

export async function runTierChangeReconciliation(dependencies: TierChangeDependencies, limit = 25): Promise<TierChangeBatchResult> {
  const candidates = await dependencies.repository.due(dependencies.now().toISOString(), limit);
  const result: TierChangeBatchResult = { selected: candidates.length, pending: 0, completed: 0, terminalFailed: 0, notified: 0, errors: 0 };
  for (const due of candidates) {
    try {
      let completed = due;
      if (due.state === "scheduled") {
        const provider = await dependencies.provider(due);
        if (provider.state === "pending") { result.pending += 1; continue; }
        if (provider.state === "failed") {
          await dependencies.repository.fail({ candidate: due, reason: provider.reason, confirmedAt: dependencies.now().toISOString() });
          result.terminalFailed += 1;
          continue;
        }
        completed = await dependencies.repository.complete({ candidate: due, subscription: provider.subscription, confirmedAt: dependencies.now().toISOString() });
        result.completed += 1;
      }
      if (await notify(completed, dependencies)) result.notified += 1;
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

export function createLiveTierChangeDependencies(notifications: BillingNotificationPort): TierChangeDependencies {
  return {
    repository: createLiveTierChangeRepository(), provider: createStripeTierChangeProvider(), notifications,
    now: () => new Date(),
  };
}
