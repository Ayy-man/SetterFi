import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CURRENT_PERIOD_SUBSCRIPTION_STATES,
  isCurrentBillingPeriod,
} from "./current-period";

const MEASUREMENT_MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20260823000001_phase7_measurement.sql",
);

const subscription = (overrides: Partial<{
  status: string;
  periodStart: string;
  periodEnd: string;
}> = {}) => ({
  status: "active",
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("the billing period a coach is in right now", () => {
  it("admits a period that contains the instant and refuses one that has ended", () => {
    const inside = new Date("2026-08-17T12:00:00.000Z");
    /*
     * The exact instant /coach/home and /coach/billing were seen disagreeing: the seeded demo
     * period is the August calendar month in UTC, which a New York coach reads as Jul 31 to
     * Aug 31, and by this instant it is over. Home said there was no active period; billing was
     * still drawing the ended one with a 25-call allowance under it.
     */
    const after = new Date("2026-09-01T06:00:00.000Z");

    expect(isCurrentBillingPeriod(subscription(), inside)).toBe(true);
    expect(isCurrentBillingPeriod(subscription(), after)).toBe(false);
  });

  it("treats the closing instant as the next period, not this one", () => {
    const boundary = new Date("2026-09-01T00:00:00.000Z");

    expect(isCurrentBillingPeriod(subscription(), boundary)).toBe(false);
    expect(isCurrentBillingPeriod(subscription(), new Date(boundary.getTime() - 1))).toBe(true);
    expect(isCurrentBillingPeriod(
      subscription({
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
      }),
      boundary,
    )).toBe(true);
  });

  it("keeps a past-due coach inside their period and shuts a canceled one out", () => {
    const inside = new Date("2026-08-17T12:00:00.000Z");

    expect(isCurrentBillingPeriod(subscription({ status: "past_due" }), inside)).toBe(true);
    expect(isCurrentBillingPeriod(subscription({ status: "trialing" }), inside)).toBe(true);
    expect(isCurrentBillingPeriod(subscription({ status: "canceled" }), inside)).toBe(false);
    expect(isCurrentBillingPeriod(subscription({ status: "incomplete" }), inside)).toBe(false);
  });

  it("refuses a row whose boundaries are not instants rather than throwing at the caller", () => {
    const inside = new Date("2026-08-17T12:00:00.000Z");

    expect(isCurrentBillingPeriod(subscription({ periodEnd: "never" }), inside)).toBe(false);
    expect(isCurrentBillingPeriod(subscription(), new Date("nonsense"))).toBe(false);
  });

  /**
   * The allowance is computed inside `read_coach_measurement_for_actor` and cannot be filtered
   * after the fact, so that side keeps its own copy of the state list in SQL. Two copies is one
   * definition only while something fails when they drift, and reading the states back out of the
   * migration the runtime actually consults is that something — asserting the two lists against
   * each other by hand would just be a third copy agreeing with itself.
   */
  it("carries the same subscription states the measurement RPC bounds its lookup with", () => {
    const sql = readFileSync(MEASUREMENT_MIGRATION, "utf8");
    /*
     * Anchored on the allowance select rather than the first `subscription.status in (...)` in the
     * file, because there are four and they are not the same set: three platform rollups bound
     * themselves to `('active', 'trialing')`, and reading one of those would have had this guard
     * assert the wrong list against the right constant. The allowance query is the one identified
     * by what it selects into.
     */
    const allowanceQuery = sql.slice(0, sql.indexOf("into allowance_period_start"));
    const clause = allowanceQuery.slice(allowanceQuery.lastIndexOf("select subscription.current_period_start"))
      .concat(sql.slice(sql.indexOf("into allowance_period_start"), sql.indexOf("into allowance_period_start") + 800))
      .match(/subscription\.status in \(([^)]*)\)/u);

    expect(clause).not.toBeNull();
    const states = [...(clause?.[1] ?? "").matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]);
    expect(states.sort()).toEqual([...CURRENT_PERIOD_SUBSCRIPTION_STATES].sort());
  });
});

const COACH_HOME_PAGE = join(process.cwd(), "src/app/(workspace)/coach/home/page.tsx");
const BILLING_ROUTE = join(process.cwd(), "src/app/api/billing/corrections/handler.ts");

/**
 * The two surfaces that answer "what billing period am I in" for one coach, and the two ways they
 * used to answer it differently.
 *
 * The predicate above closed the first direction: `/coach/billing` no longer presents a period
 * that has ended. The second direction stayed open. The measurement RPC reports its allowance
 * available only when it finds a current period AND a tier call allowance behind that row, so
 * `unavailable` carries two unrelated meanings, and coach home printed the same sentence for both:
 * "There is no active billing period to count an allowance against". A tenant whose analytics
 * mirror is empty, or whose subscription maps to no tier, therefore had a period on one page and a
 * denial that any period exists on the other.
 */
describe("coach home and the billing page reading one period", () => {
  it("reads the period through the same repository function the billing route uses", () => {
    const home = readFileSync(COACH_HOME_PAGE, "utf8");
    const route = readFileSync(BILLING_ROUTE, "utf8");

    /*
     * Asserted as the shared call rather than as a rendered sentence, because two surfaces
     * agreeing today while reading two different tables is the defect, not the fix. Both of these
     * go through `loadOwnBilling`, which is where `isCurrentBillingPeriod` is applied, so neither
     * page can acquire a period the other cannot see.
     */
    expect(route).toContain("loadOwnBilling");
    expect(home).toContain("loadOwnBilling");
    expect(home).toContain("createBillingRepository");
    expect(home).toContain("billingPeriod=");
  });

  /**
   * Why coach home cannot get the period from the measurement RPC instead: the allowance is
   * withheld when the tier lookup misses, and a missing tier is not a missing period. Read out of
   * the migration rather than restated here, so the guard follows the query the runtime runs.
   */
  it("shows the RPC withholds the allowance for a missing tier, not only a missing period", () => {
    const sql = readFileSync(MEASUREMENT_MIGRATION, "utf8");
    const start = sql.indexOf("select subscription.current_period_start");
    const allowanceQuery = sql.slice(start, sql.indexOf("allowance_state := 'available';", start));

    expect(start).toBeGreaterThan(-1);
    expect(allowanceQuery).toContain("left join public.tiers tier on tier.id = subscription.tier_id");
    expect(allowanceQuery).toContain("from public.analytics_billing_subscriptions subscription");
    // Both halves are required, which is what makes `unavailable` ambiguous at the surface.
    expect(allowanceQuery).toContain("allowance_period_start is not null and allowance_limit is not null");
  });
});
