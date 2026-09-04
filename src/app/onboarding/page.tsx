import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { coachSetupResumeHref, coachSetupRows } from "@/components/workspace/rehaul/coach-setup";
import { coachSetupContext, loadCoachSetup } from "@/components/workspace/rehaul/coach-setup-read";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your setup",
  robots: { index: false, follow: false },
};

/**
 * The setup root, which resumes setup where it stopped.
 *
 * Until 2026-09-04 this route drew its own six-rung list over its own reads, and it was the third
 * list a coach could be shown about one setup. `docs/plans/2026-09-04-coach-setup-and-thread-design.md`
 * rules that there is one list, `coachSetupRows` off `loadCoachSetup`, drawn on
 * `/coach/get-started`. This route reads those same rows and sends the coach to the open row's
 * screen: a coach who connected Google and left comes back to the offer, not to the business
 * profile they finished a week ago. When nothing is theirs to press it lands on the list, which
 * is where "nothing is waiting on you" is said. The step screens' "Back to your setup" links go
 * to the list directly, so leaving a step never bounces straight back into one.
 */
export default async function OnboardingPage() {
  const context = await coachSetupContext("/onboarding");
  const read = await loadCoachSetup(context.tenantId, { impersonating: context.impersonating });
  redirect(coachSetupResumeHref(coachSetupRows(read)) ?? "/coach/get-started");
}
