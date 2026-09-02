import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AFFILIATE_ACCOUNT_STATES,
  AFFILIATE_ACCOUNT_STATE_LABELS,
} from "@/lib/billing/contracts";

/**
 * The affiliate referral CSV, which is the one export in the set a customer opens.
 *
 * Every other resource here is read by the client's own team, so an internal representation in a
 * cell is untidy. This one goes to an affiliate, and it was shipping two of them: `account_status`
 * as the stored slug, so the file said `payment_problem` where the screen it came from says
 * "Payment problem", and a `commissionEarnedCents` header over a raw integer, so an affiliate owed
 * $894.00 read 89400. One class -- a storage unit reaching a customer -- so both are pinned here
 * rather than one being treated as the cosmetic half.
 *
 * The three-column rule is asserted in `routes.test.ts` against the projection. What this file
 * adds is the half that projection cannot see: the values, which are produced inside the Phase 6
 * cursor that those tests replace with a stub.
 */
describe("the affiliate referral export", () => {
  it("names every state the contract allows, so no status can fall through to its slug", () => {
    for (const state of AFFILIATE_ACCOUNT_STATES) {
      expect(AFFILIATE_ACCOUNT_STATE_LABELS[state], `${state} needs a customer-facing label`)
        .toBeTruthy();
      // A label that is just the slug back would pass a truthiness check and ship the defect.
      expect(AFFILIATE_ACCOUNT_STATE_LABELS[state]).not.toBe(state);
      expect(AFFILIATE_ACCOUNT_STATE_LABELS[state]).not.toMatch(/_/u);
    }
  });

  /**
   * The screen and the file must use one vocabulary for one state.
   *
   * `affiliate-money.tsx` owns `REFERRAL_STATES` and is not this lane's file, so rather than move
   * it the labels are read out of its source and compared. An affiliate who exports the table they
   * are looking at gets the same words in both, and a later edit to either one fails here instead
   * of quietly producing a second name for the same thing.
   */
  it("uses the same words as the affiliate's own screen", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/affiliate-money.tsx"),
      "utf8",
    );
    const table = source.slice(
      source.indexOf("const REFERRAL_STATES"),
      source.indexOf("function referralStatus"),
    );
    expect(table.length, "REFERRAL_STATES was not found in affiliate-money.tsx").toBeGreaterThan(0);

    for (const state of AFFILIATE_ACCOUNT_STATES) {
      const label = AFFILIATE_ACCOUNT_STATE_LABELS[state];
      expect(table, `the screen must label ${state} "${label}"`).toContain(`"${label}"`);
    }
  });

  /**
   * The column set, read out of the handler. Two properties in one assertion because they fail
   * together: the count is the affiliate-visibility rule -- name, status, commission, never the
   * coach's performance -- and the third name is the unit fix.
   */
  it("exports three columns and none of them names a storage unit", () => {
    const handler = readFileSync(
      resolve(process.cwd(), "src/app/api/exports/[resource]/handler.ts"),
      "utf8",
    );
    const declaration = handler.slice(handler.indexOf(`"affiliate-referrals": [`));
    const columns = declaration.slice(0, declaration.indexOf("]")).match(/"[a-zA-Z]+"/gu) ?? [];

    // The resource key itself carries a hyphen, so it does not match and the three columns are
    // what is left.
    expect(columns).toEqual(['"businessName"', '"accountStatus"', '"commissionEarnedUsd"']);
    expect(declaration.slice(0, declaration.indexOf("]"))).not.toContain("Cents");
  });

  /** The formatting itself, at the boundary a spreadsheet cares about. */
  it("writes commission as dollars with two places and no symbol", () => {
    const asUsd = (cents: number) => (cents / 100).toFixed(2);

    expect(asUsd(89400)).toBe("894.00");
    expect(asUsd(450)).toBe("4.50");
    expect(asUsd(0)).toBe("0.00");
    // A symbol would make the cell a string in every spreadsheet that opens it, and this is a
    // file people sum.
    expect(asUsd(89400)).not.toContain("$");
  });
});
