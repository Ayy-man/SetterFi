import type { Metadata } from "next";

import { ProfileStep } from "@/components/onboarding/profile-step";

export const metadata: Metadata = {
  title: "Your business profile",
  description: "The legal details the phone carriers check before your business can send texts.",
  robots: { index: false, follow: false },
};

/**
 * Step 1 of setup. The screen reads and writes through `/api/onboarding/business-profile`.
 *
 * The title is the route's own rather than inherited from the layout, which is defect 14: three of
 * the five sub-routes carried no `<title>` beyond "SetterFi", so a coach with the flow open in two
 * tabs could not tell them apart.
 */
export default function BusinessProfilePage() {
  return <ProfileStep />;
}
