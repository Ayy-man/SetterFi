/**
 * The referral attribution contract: the one place the query parameter is named.
 *
 * Attribution has two halves in two lanes. The affiliate route writes `/signup?ref=<code>` and the
 * portal shows it; the signup page reads that parameter and prefills the field the coach submits.
 * For a while only the first half existed: the link was generated, returned over the wire, and
 * read by nothing, so an affiliate's link landed a prospect on a signup page with an empty
 * Referral code box and the commission was dropped in silence. Nothing failed, which is what made
 * it expensive.
 *
 * A literal `"ref"` typed independently in both lanes is that failure waiting to happen again, so
 * both sides import this and `referral-attribution.test.ts` asserts they move together: the
 * parameter is never hardcoded, and either both halves are wired or neither is.
 */

/** Compared the way `app.complete_onboarding_signup` resolves a submitted code. */
function normalise(code: string): string {
  return code.trim().toUpperCase();
}

/** The query parameter carrying an affiliate's referral code into signup. */
export const REFERRAL_QUERY_PARAM = "ref";

/**
 * Whether a referral link actually carries attribution.
 *
 * The portal checks this before offering a link to copy. It is not ceremony: a link that has lost
 * its parameter looks exactly like one that works, and the person it fails is the affiliate, who
 * finds out only by never being paid. Better to show nothing than a link that silently earns them
 * nothing.
 *
 * "Carries attribution" has exactly one authority, and it is not this function: it is
 * `app.complete_onboarding_signup`, which resolves the submitted code with
 * `upper(referral_code) = upper(btrim(p_referral_code))`
 * (`20260821000001_phase5_self_serve_onboarding.sql:494`). So the comparison matches on case and
 * surrounding space the way the database does. Codes are generated uppercase at line 523, which is
 * why an exact comparison passed every test we have and would still have been wrong: it would call
 * a link broken and hide it from the affiliate while that same link paid out perfectly well at
 * signup, which is the one failure this whole module exists to prevent, inverted.
 */
export function carriesReferralAttribution(link: string, code: string): boolean {
  try {
    const carried = new URL(link).searchParams.get(REFERRAL_QUERY_PARAM);
    return carried !== null && normalise(carried) === normalise(code);
  } catch {
    return false;
  }
}
