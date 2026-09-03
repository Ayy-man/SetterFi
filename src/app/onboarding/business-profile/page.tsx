import { OnboardingProfileRehaul } from "@/components/workspace/rehaul/onboarding-profile";

/**
 * Step 1 of setup. The screen reads and writes through
 * `/api/onboarding/business-profile`.
 */
export default function BusinessProfilePage() {
  return <OnboardingProfileRehaul />;
}
