import { LegacyBusinessProfile } from "@/components/onboarding/legacy-business-profile";
import { OnboardingProfileRehaul } from "@/components/workspace/rehaul/onboarding-profile";
import { uiRehaulLive } from "@/lib/env-contract";

/**
 * Step 1 of setup, behind the rehaul flag.
 *
 * The route is a server component so the flag can be read where it is set. The pre-rehaul screen
 * moved to `legacy-business-profile.tsx` byte for byte -- it is a client component and always
 * was, and a `"use client"` module cannot read a server-only environment variable without
 * rendering one thing on the server and another in the browser. Both arms call the same
 * `/api/onboarding/business-profile` read and write.
 */
export default function BusinessProfilePage() {
  return uiRehaulLive() ? <OnboardingProfileRehaul /> : <LegacyBusinessProfile />;
}
