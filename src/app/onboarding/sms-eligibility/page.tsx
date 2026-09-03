import { CoachScale } from "@/components/coach-scale";
import { OnboardingSmsRehaul } from "@/components/workspace/rehaul/onboarding-sms";

/**
 * Step 5 of setup. The screen reads the eligibility payload and reduces it through
 * `carrierReviewFrom`.
 *
 * The route stamps coach density itself rather than leaving it to the screen. `OnboardingShell`
 * already stamps it inside, so this changes nothing a reader sees, and the attribute is the same
 * value at both depths. What it buys is that the density is a property of the *route*, readable
 * from this file, which is how `coach-density.ts` decides which modules the coach-only guards
 * apply to.
 */
export default function SmsEligibilityPage() {
  return (
    <CoachScale>
      <OnboardingSmsRehaul />
    </CoachScale>
  );
}
