import type { Metadata } from "next";

import { SmsStep } from "@/components/onboarding/sms-step";

export const metadata: Metadata = {
  title: "Can your business send texts",
  description: "Where your carrier registration stands, counted in real days.",
  robots: { index: false, follow: false },
};

/**
 * Step 3 of setup. The screen reads the eligibility payload and reduces it through
 * `carrierReviewFrom`, which is the reduction coach Home and the setup rail share.
 */
export default function SmsEligibilityPage() {
  return <SmsStep />;
}
