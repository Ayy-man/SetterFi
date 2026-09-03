import { LegacySmsEligibility } from "@/components/onboarding/legacy-sms-eligibility";
import { OnboardingSmsRehaul } from "@/components/workspace/rehaul/onboarding-sms";
import { uiRehaulLive } from "@/lib/env-contract";

/**
 * Step 5 of setup, behind the rehaul flag. The pre-rehaul screen moved to
 * `legacy-sms-eligibility.tsx` unchanged; see `business-profile/page.tsx` for why. Both arms read
 * the same eligibility payload and reduce it through the same `carrierReviewFrom`.
 */
export default function SmsEligibilityPage() {
  return uiRehaulLive() ? <OnboardingSmsRehaul /> : <LegacySmsEligibility />;
}
