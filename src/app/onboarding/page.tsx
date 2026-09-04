import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your setup",
  robots: { index: false, follow: false },
};

/**
 * The setup root, which is Setup.
 *
 * Until 2026-09-04 this route drew its own six-rung list over its own reads, and it was the third
 * list a coach could be shown about one setup: Home drew three rows, `/coach/get-started` drew
 * four steps and four channels, and this drew six rungs, each honest about what it read and none
 * agreeing with the others. `docs/plans/2026-09-04-coach-setup-and-thread-design.md` rules that
 * there is one list, `coachSetupRows` off `loadCoachSetup`, and that Setup is where it lives. The
 * six task screens under this route stay: they are where a row's button goes. Their "back" and
 * "save and exit" links land here and arrive at the one list.
 */
export default function OnboardingPage() {
  redirect("/coach/get-started");
}
