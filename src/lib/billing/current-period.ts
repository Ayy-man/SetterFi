/**
 * One definition of "the billing period a coach is in right now".
 *
 * Two surfaces answer that question about the same tenant and they used to answer it differently.
 * `/coach/home` reads the allowance out of `read_coach_measurement_for_actor`, whose subscription
 * lookup is bounded — `status in ('trialing', 'active', 'past_due')` and the period must contain
 * the as-of instant — and reports `state = 'unavailable'` when nothing matches
 * (`20260823000001_phase7_measurement.sql:1310-1327`). `/coach/billing` reads
 * `coach_billing_projection`, which plain-joins `billing_subscriptions` on `tenant_id` with no
 * status filter and no window at all (`20260822000003_phase7...:137`), so it renders whichever
 * row is there.
 *
 * While Stripe is rolling the period forward those agree. The moment a period ends without being
 * replaced — a lapsed subscription, or a demo tenant whose seed has not been re-run since the
 * calendar month turned over — they diverge, and the divergence is the dishonest direction:
 * `/coach/home` correctly says there is no active period while `/coach/billing` presents the dead
 * one as current, down to "Your month resets on <a date in the past>". `CLAUDE.md`'s honest-states
 * rule is what that breaks.
 *
 * This is the predicate, applied at the repository seam so the projection's own null path — which
 * `coach-billing.tsx:1022` already renders as an honest "unavailable" — carries the answer. The
 * SQL side keeps its copy because the allowance is computed inside the RPC and cannot be filtered
 * afterwards; `current-period.test.ts` reads the states back out of the migration text and fails
 * if the two copies drift, so there is one definition even though there are two implementations.
 */

/**
 * The subscription states that can carry a live allowance. `past_due` is in the set on purpose:
 * a coach whose card failed is still inside their period and still booking against the allowance
 * they are paying for, so the count has to keep running while collection is retried.
 */
export const CURRENT_PERIOD_SUBSCRIPTION_STATES = [
  "trialing",
  "active",
  "past_due",
] as const;

export type CurrentPeriodSubscriptionState = (typeof CURRENT_PERIOD_SUBSCRIPTION_STATES)[number];

/**
 * Half-open, matching the RPC and matching `assertHalfOpenWindow` everywhere else in the tree: the
 * instant a period ends belongs to the next period, not this one. An unparseable boundary is not a
 * period — it is a row this code should not be presenting as one — so it answers false rather than
 * throwing, and the caller's absent state takes over.
 */
export function isCurrentBillingPeriod(subscription: {
  status: string;
  periodStart: string;
  periodEnd: string;
}, asOf: Date): boolean {
  const states: readonly string[] = CURRENT_PERIOD_SUBSCRIPTION_STATES;
  if (!states.includes(subscription.status)) return false;
  const start = Date.parse(subscription.periodStart);
  const end = Date.parse(subscription.periodEnd);
  const at = asOf.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(at)) return false;
  return start <= at && end > at;
}
