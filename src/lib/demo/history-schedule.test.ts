import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEMO_HISTORY_COHORT,
  DEMO_HISTORY_EXISTING,
  DEMO_HISTORY_PERIODS,
  DEMO_HISTORY_PERIOD_DAYS,
  DEMO_HISTORY_SCHEDULE,
  DEMO_HISTORY_SIGNUP_CURVE,
  demoHistoryAnchor,
  demoHistoryInstant,
  demoHistoryPeriodOf,
  demoRollupWindow,
  demoSignupsByPeriod,
} from "../../../scripts/fixtures/demo-history.mjs";
import { PLATFORM_HISTORY_PERIODS } from "@/lib/repositories/platform-analytics";
import { DEMO_TAG } from "../../../scripts/fixtures/names.mjs";

/**
 * The demo platform has to have a past.
 *
 * Every demo tenant was seeded inside the same few weeks, so the owner Overview drew one tall bar
 * at the right edge of "Signups by period" and eleven empty ones behind it, and both money trends
 * had nothing to slope across. These tests hold the schedule that fixes it to the two things that
 * can silently break it again: the period grid the RPC actually builds, and the growth curve the
 * dataset is supposed to tell.
 *
 * They read the fixture rather than a database, so they hold on a machine with no Postgres.
 */

type ScheduleEntry = {
  slug: string;
  name?: string;
  signupDaysBefore: number;
  churnDaysBefore?: number;
  subscribed?: boolean;
};

const schedule = DEMO_HISTORY_SCHEDULE as readonly ScheduleEntry[];
const cohort = DEMO_HISTORY_COHORT as readonly ScheduleEntry[];

describe("the demo history grid matches the RPC the Overview reads", () => {
  it("asks for the same number of periods the platform repository does", () => {
    expect(DEMO_HISTORY_PERIODS).toBe(PLATFORM_HISTORY_PERIODS);
    expect(DEMO_HISTORY_PERIOD_DAYS).toBe(30);
  });

  /**
   * The three series are built from `as_of - 30*(offset+1) .. as_of - 30*offset`
   * (20260914000001, 20261009000005). This is that arithmetic, independently, so a schedule entry
   * that would land in a different bar than the fixture claims fails here.
   */
  it("puts every signup in the period the RPC would count it in", () => {
    const asOf = Date.parse("2026-09-04T14:30:00Z");
    const anchor = demoHistoryAnchor(new Date(asOf), undefined) as Date;
    const dayMs = 86_400_000;

    for (const entry of schedule) {
      const claimed = demoHistoryPeriodOf(entry.signupDaysBefore) as number;
      const signupAt = Date.parse(demoHistoryInstant(anchor, entry.signupDaysBefore, 540) as string);
      const offset = DEMO_HISTORY_PERIODS - 1 - claimed;
      const windowStart = asOf - (offset + 1) * DEMO_HISTORY_PERIOD_DAYS * dayMs;
      const windowEnd = asOf - offset * DEMO_HISTORY_PERIOD_DAYS * dayMs;

      expect(signupAt).toBeGreaterThanOrEqual(windowStart);
      expect(signupAt).toBeLessThan(windowEnd);
    }
  });

  it("opens every rollup window inside the period that will sum it", () => {
    const asOf = Date.parse("2026-09-04T14:30:00Z");
    const anchor = demoHistoryAnchor(new Date(asOf), undefined) as Date;
    const dayMs = 86_400_000;

    for (let period = 0; period < DEMO_HISTORY_PERIODS; period += 1) {
      const window = demoRollupWindow(anchor, period) as { start: string; end: string };
      const offset = DEMO_HISTORY_PERIODS - 1 - period;
      const windowStart = asOf - (offset + 1) * DEMO_HISTORY_PERIOD_DAYS * dayMs;
      const windowEnd = asOf - offset * DEMO_HISTORY_PERIOD_DAYS * dayMs;

      expect(Date.parse(window.start)).toBeGreaterThanOrEqual(windowStart);
      expect(Date.parse(window.start)).toBeLessThan(windowEnd);
      // A cost window that closes in the future is a receipt for a period nobody has lived.
      expect(Date.parse(window.end)).toBeLessThanOrEqual(anchor.getTime());
      expect(Date.parse(window.end)).toBeGreaterThan(Date.parse(window.start));
    }
  });
});

describe("the schedule tells a growth story", () => {
  it("holds the curve rather than a flat line or a single spike", () => {
    expect(demoSignupsByPeriod(schedule)).toEqual([...DEMO_HISTORY_SIGNUP_CURVE]);
  });

  /**
   * The oldest period has to stay empty. `app.phase7_platform_signup_history` reports a period
   * that closed before the first tenant existed as `needs_more_history`, and that honest-gap state
   * is one of the things the demo is meant to show working.
   */
  it("leaves the oldest period before the first signup", () => {
    const curve = demoSignupsByPeriod(schedule) as number[];
    expect(curve[0]).toBe(0);
    expect(curve.slice(1).every((value) => value > 0)).toBe(true);
  });

  it("ends on a period with signups in it", () => {
    const curve = demoSignupsByPeriod(schedule) as number[];
    expect(curve[curve.length - 1]).toBeGreaterThan(0);
  });

  it("churns exactly one tenant, after it signed up", () => {
    const churners = schedule.filter((entry) => entry.churnDaysBefore !== undefined);
    expect(churners).toHaveLength(1);
    expect(churners[0].churnDaysBefore).toBeLessThan(churners[0].signupDaysBefore);
    expect(churners[0].slug).toBe("setterfi-demo-placeholder-referral-summit");
  });

  it("keeps every signup clear of a period boundary", () => {
    for (const entry of schedule) {
      const into = entry.signupDaysBefore % DEMO_HISTORY_PERIOD_DAYS;
      expect(into).toBeGreaterThanOrEqual(3);
      expect(into).toBeLessThanOrEqual(DEMO_HISTORY_PERIOD_DAYS - 3);
    }
  });
});

describe("every tenant the schedule adds says it is a demo", () => {
  it("marks each cohort name, because an unmarked one reads as a real client", () => {
    expect(cohort.length).toBeGreaterThan(0);
    for (const tenant of cohort) {
      expect(tenant.name).toMatch(new RegExp(`${DEMO_TAG.replace(/[()]/gu, "\\$&")}$`, "u"));
      expect(tenant.slug.startsWith("setterfi-demo-history-")).toBe(true);
    }
  });

  it("leaves the newest coaches unsubscribed, so the console is not all-billing", () => {
    expect(cohort.some((tenant) => tenant.subscribed === false)).toBe(true);
    expect(cohort.some((tenant) => tenant.subscribed === true)).toBe(true);
  });

  it("does not rename or re-own the eight tenants other seeders already write", () => {
    expect(DEMO_HISTORY_EXISTING).toHaveLength(8);
    const seed = readFileSync(join(process.cwd(), "scripts/seed-demo-history.mjs"), "utf8");
    // Only `created_at` moves on an already-seeded tenant.
    expect(seed).toContain("update public.tenants set created_at = $2::timestamptz");
    expect(seed).not.toMatch(/update public\.tenants set name/u);
  });

  it("refuses to write against a tenant that is not flagged as a demo", () => {
    const seed = readFileSync(join(process.cwd(), "scripts/seed-demo-history.mjs"), "utf8");
    expect(seed).toContain("DEMO_HISTORY_TENANT_NOT_DEMO");
    // Every write carries the predicate too, not just the up-front check.
    expect(seed).toContain("where id = $1 and is_demo");
    expect(seed).toContain("tenant.id = $1 and tenant.is_demo");
    expect(seed).toContain("where id = $1 and is_demo)");
  });
});
