import { LegacyCalendarOnboarding } from "@/components/onboarding/legacy-calendar";
import { OnboardingCalendarRehaul } from "@/components/workspace/rehaul/onboarding-calendar";
import { uiRehaulLive } from "@/lib/env-contract";

/**
 * Step 4 of setup, behind the rehaul flag. The pre-rehaul screen moved to `legacy-calendar.tsx`
 * unchanged; see `business-profile/page.tsx` for why the split is what a client page needs in
 * order to be flagged at all. Both arms call the same calendar reads and writes.
 */
export default function CalendarOnboardingPage() {
  return uiRehaulLive() ? <OnboardingCalendarRehaul /> : <LegacyCalendarOnboarding />;
}
