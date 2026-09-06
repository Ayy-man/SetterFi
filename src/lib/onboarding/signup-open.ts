import { loadCurrentAccountTerms, type AccountTermsState } from "@/lib/account/terms";
import { accountTermsLive, phase5Live } from "@/lib/env-contract";
import { listSignupTierCatalog } from "@/lib/repositories/onboarding-signup";

/**
 * Whether `/signup` has a named plan and can record acceptance of published account terms.
 *
 * The page is reachable whenever phase 5 is on, but with `tier_offer_terms` empty it renders "No
 * named plan is available" and asks for nothing (`docs/LAUNCH-CHECKLIST.md` B1). The affiliate
 * portal used to hand out `/signup?ref=<code>` regardless, which sent every referred coach to that
 * dead end with the affiliate's attribution attached to nothing. This is the one predicate both
 * halves read: the same catalogue the page renders from, with the same rule the page applies --
 * a seeded placeholder is not a plan a coach can sign up for. Terms acceptance must also be
 * enabled with a published version, matching the signup handler's pre-auth refusal.
 *
 * A catalogue that cannot be read counts as closed. Handing out a link to a page whose state is
 * unknown is the same overstatement as handing one out to a page known to be empty.
 */
export const SIGNUP_PLACEHOLDER_LABEL_MARK = "SETTERFI_DEMO_PLACEHOLDER_";

export async function signupOpen(
  dependencies: {
    enabled?: () => boolean;
    termsEnabled?: () => boolean;
    currentTerms?: () => Promise<AccountTermsState>;
    catalog?: () => Promise<readonly { label: string }[]>;
  } = {},
): Promise<boolean> {
  if (!(dependencies.enabled ?? phase5Live)()) return false;
  if (!(dependencies.termsEnabled ?? accountTermsLive)()) return false;
  try {
    if ((await (dependencies.currentTerms ?? loadCurrentAccountTerms)()).state !== "published") return false;
    const choices = await (dependencies.catalog ?? listSignupTierCatalog)();
    return choices.some((choice) =>
      choice.label.trim().length > 0 && !choice.label.includes(SIGNUP_PLACEHOLDER_LABEL_MARK));
  } catch {
    return false;
  }
}
