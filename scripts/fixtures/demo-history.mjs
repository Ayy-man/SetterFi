/**
 * The twelve-month shape of the demo platform.
 *
 * The owner Overview draws three series out of one RPC, and all three are windowed the same way:
 * twelve contiguous 30-day periods ending at the as-of instant
 * (`supabase/migrations/20260914000001_platform_history_series.sql`,
 * `20261009000005_platform_overview_history.sql`).
 *
 *   - `history` counts `public.tenants.created_at` per period, through `analytics_tenants`.
 *   - `activeSubscriptionsByPeriod` counts `public.billing_subscriptions` rows whose status is
 *     `active` and whose `current_period_start .. current_period_end` straddles the period end.
 *   - `revenueByPeriod` sums `public.tenant_cost_rollups.recognized_subscription_cents`, grouped
 *     by the rollup's `window_start`.
 *
 * Every demo tenant was seeded within the same few weeks, so all three series put everything in
 * the rightmost bar and left eleven empty ones behind it. This file is the one place that says
 * when each demo tenant signed up, when it subscribed and when it churned, so the seeders and the
 * backdating script cannot disagree about it.
 *
 * **Why the anchor is today's midnight and not a written-down date.** A literal date is
 * deterministic and also decays: `seed-phase7-demo.mjs` documents the production incident where
 * absolute June 2026 timestamps aged out of the coach Home window and the client read the result
 * as a broken product. An anchor of midnight UTC on the run day keeps a reseed byte-identical
 * within a day, keeps every row a fixed offset from one instant rather than from a moving
 * `Date.now()`, and never ages out. `DEMO_HISTORY_ANCHOR` overrides it when a caller needs to
 * reproduce an exact dataset.
 *
 * **Why the offsets avoid multiples of 30.** The RPC builds its periods from `now()`, a few hours
 * past this anchor, so a row placed exactly on a period boundary could land either side of it.
 * Every offset here sits at least three days clear of a boundary.
 *
 * **Known gap: the two newest revenue bars are not purely a function of this anchor.**
 * `seed-phase6-demo.mjs` writes its own cost rollups at literal windows of 2026-07-01, 2026-08-01
 * and 2026-09-01. Measured on 2026-09-04 they add 99,100 and 59,700 cents to the two newest
 * periods on top of the 1,024,300 this schedule produces, and as wall-clock time passes they slide
 * out of the trailing-twelve-month window and those two bars quietly drop to the schedule's own
 * number. Whoever demos this months from now sees different bars than this comment describes.
 *
 * They were not anchored, deliberately, and the reason is not effort:
 *
 *   1. `public.tenant_cost_rollups` is append-only, enforced by `app.reject_phase6_append_only`
 *      rejecting UPDATE and DELETE. The rows already in the hosted database cannot be moved or
 *      removed at all without disabling that guard, so anchoring the seeder would not fix the
 *      dataset anyone is looking at today, only future ones.
 *   2. A rollup is keyed by `(tenant_id, window_start, window_end)`, so a window derived from a
 *      moving anchor writes a brand new row every time the anchor moves. On an append-only table
 *      that accumulates a fresh pair of receipts per run and can never be cleaned up, which is
 *      worse than a stale window that at least stays one row.
 *   3. Those two windows are not free-standing. The August one is deliberately zero-revenue
 *      because `apply_stripe_invoice_failed` runs against that month, and the same seeder's
 *      invoice, commission-reversal, payout and allowance rows are all pinned to absolute August
 *      2026 dates around it. Anchoring the receipts alone would decouple them from the invoice
 *      story they exist to explain and make the money surfaces incoherent.
 *
 * Anchoring them properly means anchoring the whole phase 6 money story onto a grid that is stable
 * within a period rather than per run, which is a change to that seeder rather than to this file.
 */

import { COACH_NAMES, DEMO_BUSINESS_NAMES, DEMO_SUPPORT_TENANT_NAMES, DEMO_TAG, DEMO_TIER_LADDER, assertUniqueDisplayNames } from "./names.mjs";

/** The period count the Overview asks for; mirrors `PLATFORM_HISTORY_PERIODS`. */
export const DEMO_HISTORY_PERIODS = 12;
export const DEMO_HISTORY_PERIOD_DAYS = 30;

const DAY_MS = 86_400_000;

/** Midnight UTC of the run day, or the `DEMO_HISTORY_ANCHOR` override. */
export function demoHistoryAnchor(now = new Date(), override = process.env.DEMO_HISTORY_ANCHOR) {
  if (override) {
    const pinned = new Date(override);
    if (Number.isNaN(pinned.getTime())) throw new Error("DEMO_HISTORY_ANCHOR_INVALID");
    return pinned;
  }
  const anchor = new Date(now);
  anchor.setUTCHours(0, 0, 0, 0);
  return anchor;
}

/** `daysBefore` days before the anchor, as an ISO timestamp. */
export function demoHistoryInstant(anchor, daysBefore, minuteOffset = 0) {
  const at = new Date(anchor.getTime() - daysBefore * DAY_MS + minuteOffset * 60_000);
  return at.toISOString().replace(".000Z", "Z");
}

/**
 * Which of the twelve periods a `daysBefore` offset falls in, oldest first.
 *
 * Period `p` covers `[anchor - 30*(12-p), anchor - 30*(11-p))`, so an offset of 315 days is
 * period 1 and an offset of 9 days is period 11. Anything a year or more back is outside the
 * window the Overview draws and is refused rather than silently dropped off the left edge.
 */
export function demoHistoryPeriodOf(daysBefore) {
  const period = DEMO_HISTORY_PERIODS - 1 - Math.floor(daysBefore / DEMO_HISTORY_PERIOD_DAYS);
  if (!Number.isInteger(period) || period < 0 || period >= DEMO_HISTORY_PERIODS) {
    throw new Error("DEMO_HISTORY_OFFSET_OUTSIDE_WINDOW");
  }
  return period;
}

/** Signups per period for a set of schedule entries, oldest period first. */
export function demoSignupsByPeriod(entries) {
  const counts = Array.from({ length: DEMO_HISTORY_PERIODS }, () => 0);
  for (const entry of entries) counts[demoHistoryPeriodOf(entry.signupDaysBefore)] += 1;
  return counts;
}

/**
 * The growth story, as a curve rather than a spike.
 *
 * A slow start of one or two coaches a month, two stronger months at periods 5 and 6, a soft
 * period 8 where a single coach signs and Legacy Lane Financial churns, then a recovery. It is
 * the shape a year-old platform actually has, and it is written here as an assertion so a later
 * edit to the schedule that flattens it fails a test rather than a demo.
 */
export const DEMO_HISTORY_SIGNUP_CURVE = Object.freeze([0, 1, 1, 2, 2, 3, 4, 2, 1, 3, 3, 2]);

/**
 * The eight demo tenants that already exist, keyed by the slug each was seeded under.
 *
 * These are not created here. `scripts/seed-demo-history.mjs` moves their `created_at` onto the
 * grid; the seeders that own them keep owning everything else about them.
 */
export const DEMO_HISTORY_EXISTING = Object.freeze([
  Object.freeze({ slug: "setterfi-demo-placeholder-measurement", signupDaysBefore: 315 }),
  Object.freeze({ slug: "setterfi-phase1-demo", signupDaysBefore: 285 }),
  // Signs up in period 4 and churns in period 8, which is what makes the dip a story rather than
  // a missing bar.
  Object.freeze({ slug: "setterfi-demo-placeholder-referral-summit", signupDaysBefore: 232, churnDaysBefore: 98 }),
  Object.freeze({ slug: "setterfi-demo-placeholder-money", signupDaysBefore: 205 }),
  Object.freeze({ slug: "setterfi-demo-placeholder-referral-north", signupDaysBefore: 176 }),
  Object.freeze({ slug: "setterfi-demo-placeholder-referral-harbor", signupDaysBefore: 168 }),
  Object.freeze({ slug: "setterfi-demo-placeholder-affiliate", signupDaysBefore: 52 }),
  Object.freeze({ slug: "staging-demo", signupDaysBefore: 22 }),
]);

/** `8e000000-...` is unused by every other demo namespace in `scripts/`. */
export const DEMO_HISTORY_NAMESPACE = "8e000000-0000-4000-8000-";

export function demoHistoryTenantId(sequence) {
  return `${DEMO_HISTORY_NAMESPACE}${String(sequence).padStart(12, "0")}`;
}

/**
 * The cohort that fills the curve out.
 *
 * Eight tenants cannot draw eleven months of growth, so the schedule adds sixteen coach
 * workspaces on the same grid. Every one carries the `(demo)` marker for the same reason the
 * existing ones do: an unmarked demo tenant reads as a real client in the admin book
 * (GAPS F-11-REVIEW-TENANT-NAMES-UNLABELLED). Tier is the contracted ladder, cycled, so no row
 * quotes a price the client never agreed to sell.
 *
 * `subscribed: false` is the two newest, which are still onboarding. That is honest and it is
 * also what the console needs to show: a platform where every single coach is billing is a
 * platform nobody believes.
 *
 * **How to trim the cohort, and what it costs.** Delete whole lines from the array below, then
 * update `DEMO_HISTORY_SIGNUP_CURVE` to the counts that remain and rerun the seeder. Nothing else
 * has to change: ids and slugs are positional, and the import-time checks at the bottom of this
 * file recompute the curve and fail with the actual counts if the two disagree, so a mismatch is
 * a message rather than a wrong chart.
 *
 * What you lose is chart resolution, in this order. The last row a period holds is that period's
 * whole bar, so dropping it puts a zero in the middle of the signup series and the growth story
 * turns into a comb. The two rows at 106 and 86 days sit either side of the churn, and removing
 * either flattens the dip that makes the churn readable. Cutting the array in half roughly halves
 * every active-subscription and revenue value, which does not change the shape, but it does leave
 * a chart whose bars round to one or two coaches a month: honest, and too small to see the trend
 * that is the panel's whole reason to exist. Below about twelve rows the demo is back to the flat
 * line this schedule was written to fix. The floor is the eight already-seeded tenants, which is
 * the state before this file existed.
 */
const COHORT = [
  { name: "Copper Creek Credit Group", signupDaysBefore: 262, rung: 0 },
  { name: "Vantage Point Funding", signupDaysBefore: 248, rung: 1 },
  { name: "Ironwood Business Capital", signupDaysBefore: 218, rung: 0 },
  { name: "Bright Harbor Credit Co.", signupDaysBefore: 194, rung: 1 },
  { name: "Maple Row Advisory", signupDaysBefore: 184, rung: 0 },
  { name: "Grandview Funding Partners", signupDaysBefore: 160, rung: 2 },
  { name: "Silver Birch Credit Coaching", signupDaysBefore: 154, rung: 1 },
  { name: "Trailhead Business Funding", signupDaysBefore: 142, rung: 0 },
  { name: "Kingsley Capital Group", signupDaysBefore: 128, rung: 1 },
  { name: "Ember Lane Credit Partners", signupDaysBefore: 106, rung: 2 },
  { name: "Fairfield Funding Collective", signupDaysBefore: 86, rung: 0 },
  { name: "Watermark Business Advisory", signupDaysBefore: 74, rung: 1 },
  { name: "Ridgeline Credit Coaching", signupDaysBefore: 64, rung: 1 },
  { name: "Old Oak Funding Co.", signupDaysBefore: 44, rung: 2 },
  { name: "Beacon Hill Capital Coaching", signupDaysBefore: 34, rung: 0, subscribed: false },
  { name: "Willow Bend Credit Group", signupDaysBefore: 9, rung: 0, subscribed: false },
];

export const DEMO_HISTORY_COHORT = Object.freeze(COHORT.map((entry, index) => {
  const subscribed = entry.subscribed !== false;
  return Object.freeze({
    id: demoHistoryTenantId(index + 1),
    slug: `setterfi-demo-history-${String(index + 1).padStart(2, "0")}`,
    name: `${entry.name} ${DEMO_TAG}`,
    billingContactEmail: `demo-history-${String(index + 1).padStart(2, "0")}@example.invalid`,
    signupDaysBefore: entry.signupDaysBefore,
    tier: DEMO_TIER_LADDER[entry.rung],
    subscribed,
    status: subscribed ? "active" : "onboarding",
    stripeCustomerId: `SETTERFI_DEMO_PLACEHOLDER_HISTORY_CUSTOMER_${String(index + 1).padStart(2, "0")}`,
    stripeSubscriptionId: `SETTERFI_DEMO_PLACEHOLDER_HISTORY_SUBSCRIPTION_${String(index + 1).padStart(2, "0")}`,
  });
}));

/** Every tenant on the grid, existing and new, oldest signup first. */
export const DEMO_HISTORY_SCHEDULE = Object.freeze(
  [...DEMO_HISTORY_EXISTING, ...DEMO_HISTORY_COHORT]
    .slice()
    .sort((left, right) => right.signupDaysBefore - left.signupDaysBefore)
    .map((entry) => Object.freeze({ ...entry })),
);

/**
 * The 30-day cost window a rollup covers for period `p`.
 *
 * The window opens three days into the period rather than on its boundary, because the RPC groups
 * rollups by `window_start` against periods it measures from `now()` and this file measures from
 * midnight. Three days of clearance is more drift than a run can accumulate. The newest window is
 * truncated at the anchor rather than allowed to close in the future, so a partial period reads as
 * a partial period.
 */
export function demoRollupWindow(anchor, period) {
  const startDaysBefore = DEMO_HISTORY_PERIOD_DAYS * (DEMO_HISTORY_PERIODS - period) - 3;
  const start = new Date(anchor.getTime() - startDaysBefore * DAY_MS);
  const end = new Date(Math.min(start.getTime() + DEMO_HISTORY_PERIOD_DAYS * DAY_MS, anchor.getTime()));
  return { start: start.toISOString().replace(".000Z", "Z"), end: end.toISOString().replace(".000Z", "Z") };
}

/**
 * The cost breakdown to record beside a period's recognised revenue.
 *
 * Deterministic from the tenant sequence and the period so a rerun writes the same numbers, and
 * held well under the price so the margin projection stays positive. These are demo costs on demo
 * tenants; they never touch a real tenant's economics.
 */
export function demoRollupCosts(priceCents, sequence, period) {
  const spread = (sequence * 7 + period * 11) % 13;
  const model = Math.round(priceCents * (0.16 + spread * 0.004));
  const messaging = Math.round(priceCents * (0.07 + spread * 0.002));
  const embedding = Math.round(priceCents * 0.012);
  return { model, messaging, embedding, total: model + messaging + embedding };
}

// ---------------------------------------------------------------------------
// Fixture rules, checked at import so a bad edit fails the seeder and the test
// suite rather than the demo.
// ---------------------------------------------------------------------------

{
  const names = DEMO_HISTORY_COHORT.map((entry) => entry.name);
  assertUniqueDisplayNames(names, "DEMO_HISTORY_TENANT_NAMES_NOT_UNIQUE");
  if (names.some((name) => !name.endsWith(DEMO_TAG))) {
    throw new Error("DEMO_HISTORY_TENANT_NAME_MISSING_DEMO_TAG");
  }
  if (names.some((name) => /^(demo|test|synthetic|setterfi)\b/iu.test(name))) {
    throw new Error("DEMO_HISTORY_TENANT_NAME_LOOKS_LIKE_STATE");
  }
  const taken = new Set([
    ...COACH_NAMES,
    ...Object.values(DEMO_BUSINESS_NAMES),
    ...Object.values(DEMO_SUPPORT_TENANT_NAMES),
  ].map((name) => name.toLocaleLowerCase("en-US")));
  if (names.some((name) => taken.has(name.toLocaleLowerCase("en-US")))) {
    throw new Error("DEMO_HISTORY_TENANT_NAME_COLLIDES_WITH_FIXTURE");
  }
  if (new Set(DEMO_HISTORY_COHORT.map((entry) => entry.slug)).size !== DEMO_HISTORY_COHORT.length
    || new Set(DEMO_HISTORY_COHORT.map((entry) => entry.id)).size !== DEMO_HISTORY_COHORT.length) {
    throw new Error("DEMO_HISTORY_TENANT_KEYS_NOT_UNIQUE");
  }
}

{
  const curve = demoSignupsByPeriod(DEMO_HISTORY_SCHEDULE);
  if (curve.join(",") !== DEMO_HISTORY_SIGNUP_CURVE.join(",")) {
    throw new Error(`DEMO_HISTORY_CURVE_DIVERGED:${curve.join(",")}`);
  }
  // Period 0 has to stay empty. The signup series reports a period that closed before the first
  // tenant existed as `needs_more_history`, and losing that leaves the console with no example of
  // the honest-gap state on a dataset that is meant to demonstrate it.
  if (curve[0] !== 0) throw new Error("DEMO_HISTORY_OLDEST_PERIOD_NOT_EMPTY");
  // Three days of clearance from every period boundary, for the reason in `demoRollupWindow`.
  if (DEMO_HISTORY_SCHEDULE.some((entry) => {
    const into = entry.signupDaysBefore % DEMO_HISTORY_PERIOD_DAYS;
    return into < 3 || into > DEMO_HISTORY_PERIOD_DAYS - 3;
  })) {
    throw new Error("DEMO_HISTORY_SIGNUP_TOO_CLOSE_TO_BOUNDARY");
  }
  const churners = DEMO_HISTORY_SCHEDULE.filter((entry) => entry.churnDaysBefore !== undefined);
  if (churners.length !== 1) throw new Error("DEMO_HISTORY_EXPECTS_ONE_CHURN");
  if (churners.some((entry) => entry.churnDaysBefore >= entry.signupDaysBefore)) {
    throw new Error("DEMO_HISTORY_CHURN_BEFORE_SIGNUP");
  }
}
