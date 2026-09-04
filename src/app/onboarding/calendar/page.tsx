import type { Metadata } from "next";

import { CalendarStep } from "@/components/onboarding/calendar-step";

export const metadata: Metadata = {
  title: "Where your calls should land",
  description: "Connect the calendar your SetterFi agent books into.",
  robots: { index: false, follow: false },
};

/** Step 4 of setup. The screen makes the calendar reads and writes itself. */
export default function CalendarOnboardingPage() {
  return <CalendarStep />;
}
