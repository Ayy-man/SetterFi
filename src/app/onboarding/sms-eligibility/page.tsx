import { CoachScale } from "@/components/coach-scale";
import { LegacySmsEligibility } from "@/components/onboarding/legacy-sms-eligibility";
import { OnboardingSmsRehaul } from "@/components/workspace/rehaul/onboarding-sms";
import { uiRehaulLive } from "@/lib/env-contract";

/**
 * Step 5 of setup, behind the rehaul flag. The pre-rehaul screen moved to
 * `legacy-sms-eligibility.tsx` unchanged; see `business-profile/page.tsx` for why. Both arms read
 * the same eligibility payload and reduce it through the same `carrierReviewFrom`.
 *
 * The route stamps coach density itself rather than leaving it to whichever arm the flag picks.
 * Both arms already stamp it inside -- the legacy screen through `OnboardingStage`, the rehaul one
 * through `OnboardingShell` -- so this changes nothing a reader sees, and the attribute is the same
 * value at both depths. What it buys is that the density is a property of the *route*, true on both
 * arms and readable from this file, which is how `coach-density.ts` decides which modules the
 * coach-only guards apply to. Before the split this page rendered `OnboardingStage` directly and
 * was in that set; delegating to two components took it out, and with it the guarantee that
 * neither arm can quietly pick up the console's 20px page head.
 */
export default function SmsEligibilityPage() {
  return (
    <CoachScale>
      {uiRehaulLive() ? <OnboardingSmsRehaul /> : <LegacySmsEligibility />}
    </CoachScale>
  );
}
