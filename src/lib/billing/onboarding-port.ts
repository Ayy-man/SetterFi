import type {
  SubscriptionReadinessPort,
  SubscriptionReadinessResult,
  SubscriptionReadinessState,
} from "@/lib/onboarding/contracts";
import {
  createBillingRepository,
  type BillingRepository,
} from "@/lib/repositories/billing";

const MIRRORED_STATES = new Set<SubscriptionReadinessState>([
  "active",
  "trialing",
  "past_due",
  "incomplete",
]);

export function createPhase6SubscriptionReadinessPort(
  repository: Pick<BillingRepository, "loadSubscription"> = createBillingRepository(),
): SubscriptionReadinessPort {
  return async (tenantId): Promise<SubscriptionReadinessResult> => {
    try {
      const subscription = await repository.loadSubscription(tenantId);
      if (!subscription) return { state: "absent", evidenceAt: null, isDemo: false };
      return {
        state: MIRRORED_STATES.has(subscription.status as SubscriptionReadinessState)
          ? subscription.status as SubscriptionReadinessState
          : "incomplete",
        evidenceAt: subscription.evidenceAt,
        isDemo: subscription.isDemo,
      };
    } catch {
      return { state: "unavailable", evidenceAt: null, isDemo: false };
    }
  };
}
