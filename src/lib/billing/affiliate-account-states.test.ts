import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AFFILIATE_ACCOUNT_STATES } from "@/lib/billing/contracts";

const ACCOUNT_STATES_MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20261005000001_affiliate_referral_account_states.sql",
);
const PHASE6_MONEY_MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20260822000001_phase6_money.sql",
);

/** The `then` arm of every branch in the projection's status `case`, in file order. */
function projectedStates(sql: string) {
  const create = sql.slice(sql.lastIndexOf("create function public.affiliate_referral_projection"));
  const expression = create.slice(create.indexOf("case"), create.indexOf("end,"));
  return [...expression.matchAll(/then\s+'([a-z_]+)'/gu)].map((match) => match[1]);
}

/**
 * The allowlist in the application and the values the deployed function can actually return.
 *
 * These are two copies of one decision and they broke apart in production. On 2026-09-01 the
 * allowlist moved from a two-state `active`/`inactive` to the four states below (`c1605878`,
 * 01:26 UTC), the migration that makes the function emit them landed twenty minutes later
 * (`3fac9f7d`), and the build carrying the new allowlist deployed at 13:07 UTC. A deploy does not
 * run migrations, so for as long as the hosted function was the old one every row it returned was
 * `active` or `inactive`, `parseProjection` refused the first of them, and `/affiliate` answered
 * 503 with a generic body on every load and every Retry. Two of those 503s are in the runtime log
 * at 13:08 UTC, which is one visit and one Retry.
 *
 * Nothing failed before production. The repository tests build their own rows, so they assert the
 * allowlist against fixtures written to satisfy it, and no test compared either copy to the SQL
 * that has to produce it. That is what this closes: the states are read out of the migration the
 * function is defined in, so a change to one copy without the other reddens here rather than in
 * front of an affiliate.
 */
describe("affiliate account states across the application and the database", () => {
  it("accepts exactly the states the deployed projection can emit", () => {
    const states = projectedStates(readFileSync(ACCOUNT_STATES_MIGRATION, "utf8"));

    expect(states.length).toBeGreaterThan(0);
    expect([...new Set(states)].sort()).toEqual([...AFFILIATE_ACCOUNT_STATES].sort());
  });

  /**
   * The `case` has no `else` arm on purpose: a seventh `tenant_status` maps to no branch, arrives
   * as null and fails the parser, so the portal says it could not load rather than reading an
   * unknown state as "Paying". Asserting the absence keeps a later hand from adding a default that
   * would turn a loud refusal into a quiet wrong claim about money.
   */
  it("maps every status by name with no default arm to absorb a new one", () => {
    const sql = readFileSync(ACCOUNT_STATES_MIGRATION, "utf8");
    const create = sql.slice(sql.lastIndexOf("create function public.affiliate_referral_projection"));
    const expression = create.slice(create.indexOf("case"), create.indexOf("end,"));

    expect(expression).not.toMatch(/\belse\b/u);
    expect([...expression.matchAll(/when\s+'([a-z_]+)'/gu)].map((match) => match[1]).sort())
      .toEqual(["active", "churned", "onboarding", "overdue", "paused", "suspended"]);
  });

  /**
   * The superseded definition, kept honest for the same reason: it is still in the tree, it is
   * still what an unmigrated project answers with, and every value it can return is one the
   * application now refuses. This is the state the hosted project was in at 13:07 UTC, asserted so
   * the failure mode is written down rather than remembered.
   */
  it("refuses every value the superseded projection returned", () => {
    const superseded = readFileSync(PHASE6_MONEY_MIGRATION, "utf8");
    const create = superseded.slice(
      superseded.indexOf("create or replace function public.affiliate_referral_projection"),
    );
    const expression = create.slice(create.indexOf("case"), create.indexOf("end,"));
    const legacy = [...expression.matchAll(/(?:then|else)\s+'([a-z_]+)'/gu)].map((m) => m[1]);

    expect([...new Set(legacy)].sort()).toEqual(["active", "inactive"]);
    for (const state of legacy) {
      expect(AFFILIATE_ACCOUNT_STATES as readonly string[]).not.toContain(state);
    }
  });
});
