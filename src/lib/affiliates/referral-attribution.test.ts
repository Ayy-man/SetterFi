import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REFERRAL_QUERY_PARAM, carriesReferralAttribution } from "@/lib/affiliates/referral-attribution";

/**
 * The referral attribution contract, held as one guard rather than two.
 *
 * Attribution has two halves in two lanes. The affiliate route writes `/signup?ref=<code>` and the
 * portal offers it to copy; the signup page reads that parameter and prefills the field the coach
 * submits. For a while only the first half existed, and the failure that produced is the reason
 * this file is one test and not two: **nothing broke.** The link was generated, returned over the
 * wire, and read by nothing, so a prospect landed on a signup page with an empty Referral code box
 * and the commission was dropped in silence. No error, no log, no failing test.
 *
 * A guard in each lane would not have caught it either. Each half is individually correct; it is
 * the *disagreement* that is the defect, and only something reading both sides can see it. So this
 * asserts the biconditional: either both halves are wired or neither is, and neither lane can move
 * alone. `docs/GAPS.md` carries the history.
 */

const ROOT = new URL("../../../", import.meta.url).pathname;
const SIGNUP_PAGE = "src/app/signup/page.tsx";
const AFFILIATE_ROUTE = "src/app/api/affiliate/referrals/route.ts";
const AFFILIATE_PORTAL = "src/components/workspace/live/affiliate-money.tsx";
const CONTRACT = "@/lib/affiliates/referral-attribution";

function source(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Imports anything from the contract module, whichever symbol it needs. */
function importsContract(path: string) {
  return new RegExp(`from "${CONTRACT}"`, "u").test(source(path));
}

describe("the referral attribution contract", () => {
  /**
   * The parameter is named once. Without this the biconditional below is worth nothing: a lane
   * could type the literal, be fully wired, and still read as unwired here, which would put the
   * two sides back out of step with a green suite over the top.
   */
  it("is never typed as a literal outside the module that owns it", () => {
    /*
     * Any quoted `"ref"`, not an accessor shape. The first version of this matched
     * `searchParams.get("ref")` and `searchParams["ref"]`, and missed the one form the codebase
     * actually uses: `(await searchParams)["ref"]`, where the character before the bracket is a
     * paren. It passed while the literal was right there, which is the failure mode this whole
     * file exists to prevent, one level up. Matching the quoted token needs no guess about how the
     * parameter is reached, and the character sequence has no other reason to appear in these
     * three files. A backticked mention in a comment stays legal, because naming the parameter is
     * how the reasoning stays readable.
     */
    const literal = new RegExp(`["']${REFERRAL_QUERY_PARAM}["']`, "u");
    const offenders = [SIGNUP_PAGE, AFFILIATE_ROUTE, AFFILIATE_PORTAL]
      .filter((path) => literal.test(source(path)));

    expect(offenders).toEqual([]);
  });

  /**
   * The whole point. Reading the parameter and offering the link are the two halves, and shipping
   * one without the other is either a link that earns nothing (write without read) or a read path
   * nobody can reach (read without write).
   */
  it("wires both halves or neither: the link is offered exactly when signup reads it", () => {
    const signupReadsParam = importsContract(SIGNUP_PAGE);
    const portalOffersLink = importsContract(AFFILIATE_PORTAL);

    expect(
      portalOffersLink,
      signupReadsParam
        ? `${SIGNUP_PAGE} reads the referral parameter, so ${AFFILIATE_PORTAL} must offer the link`
        : `${SIGNUP_PAGE} does not read the referral parameter, so ${AFFILIATE_PORTAL} must not offer a link that would attribute nothing`,
    ).toBe(signupReadsParam);
  });

  /**
   * T15-13, on the one layer that implements it.
   *
   * This assertion nearly went in backwards, and the way it nearly went in is worth keeping. The
   * page and the API disagree about who may reach the affiliate portal, and the obvious reading of
   * a disagreement is that the stricter side is right and the looser one is the bug. Here it is
   * the reverse: `docs/DECISIONS.md:278` records T15-13 as decided, "portal access is gated on
   * that row existing, not on `role = 'affiliate'`", and `git log` shows the page's strict check
   * was deliberately *replaced* by this one to deliver it. The API and
   * `affiliate_payout_history_projection` were not brought along until 2026-08-31, and are now.
   *
   * So the page is the correct half, and tightening it would have made the product consistently
   * violate a decided requirement while deleting the only evidence the requirement was unfinished.
   * This pins the decided behaviour so the next reader of a 403 does not "fix" the wrong end.
   */
  it("gates the affiliate portal on the affiliates row, per T15-13, not on the role value", () => {
    const page = source("src/app/(workspace)/affiliate/page.tsx");
    expect(page).toMatch(/canAccessWorkspace\(/u);
    expect(page).toContain("affiliateAccess: claims.affiliateAccess");
  });

  describe("carriesReferralAttribution", () => {
    it("accepts a link whose parameter matches the code", () => {
      expect(carriesReferralAttribution("https://setterfi.test/signup?ref=SF-ABC", "SF-ABC")).toBe(true);
    });

    /*
     * The database resolves `upper(referral_code) = upper(btrim(...))`
     * (`20260821000001_phase5_self_serve_onboarding.sql:494`), so a link differing only in case
     * pays out. An exact comparison here would hide that link from the affiliate as broken while
     * it worked, which is this module's own failure mode running backwards.
     */
    it("accepts a link the database would resolve, differing only in case or space", () => {
      expect(carriesReferralAttribution("https://setterfi.test/signup?ref=sf-abc", "SF-ABC")).toBe(true);
      expect(carriesReferralAttribution("https://setterfi.test/signup?ref=%20SF-ABC%20", "SF-ABC")).toBe(true);
    });

    it("refuses a link that lost the parameter, carries another code, or is not a URL", () => {
      expect(carriesReferralAttribution("https://setterfi.test/signup", "SF-ABC")).toBe(false);
      expect(carriesReferralAttribution("https://setterfi.test/signup?ref=SF-XYZ", "SF-ABC")).toBe(false);
      expect(carriesReferralAttribution("/signup?ref=SF-ABC", "SF-ABC")).toBe(false);
    });
  });
});
