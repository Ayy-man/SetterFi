import type { Metadata } from "next";

import { createReadinessEvidence } from "@/app/api/onboarding/readiness/handler";
import { CoachOnboarding } from "@/components/onboarding/coach-onboarding";
import { OnboardingExperience } from "@/components/onboarding/onboarding-experience";
import { OnboardingStage } from "@/components/onboarding/onboarding-stage";
import {
  currentSetupStep,
  setupHeadline,
  setupProgress,
  SetupSteps,
  type SetupProgress,
} from "@/components/onboarding/setup-steps";
import { parseAppClaims } from "@/lib/auth/claims";
import { phase5Live, phase7MeetAgentLive } from "@/lib/env-contract";
import { evaluateReadiness } from "@/lib/onboarding/readiness";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The coach's position, from the same seven readiness checks the go-live endpoint refuses on.
 *
 * An earlier version read only the two checks it could fetch cheaply, a live channel and a
 * published offer, and left the rest as still to do. That understated the strip, which is the cheap
 * mistake, but it also let the headline count "One step left" for a coach whose safe test and
 * subscription were both still outstanding, because neither had a box in the strip to be counted
 * from. So the page now evaluates the full result and derives the strip and the headline from it.
 *
 * Any failure here is `null`, never a guess: the strip then draws nothing as proved and the
 * headline makes no count, because a count over evidence the page does not have would be an
 * invention. The strip is a position readout; it must not be able to take the page down.
 */
async function readinessProgress(): Promise<SetupProgress | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;
    const claims = parseAppClaims(data.claims);
    if (!claims.tenantId) return null;
    const result = await evaluateReadiness(claims.tenantId, createReadinessEvidence());
    return setupProgress(result.checks);
  } catch {
    return null;
  }
}

export const metadata: Metadata = {
  title: "Assemble your agent",
  description: "Configure, test, and review your SetterFi appointment-setting agent.",
};

/**
 * The go-live screen. Everything the coach has set up, and what is still holding it.
 *
 * The title and the lead say the two things the artboard says, in the artboard's words: what
 * pressing the button will do, and what it will not touch. The title is
 * `OnboardingGoLive.dc.html:105` verbatim. It read "Finish setting up your agent" from round 2 to
 * round 5 -- the outcome replaced with the chore -- while this docblock three lines above claimed
 * it already matched, which is why four audits walked past it: a reader checking the title against
 * its own comment was told there was nothing to check. `artboard-conformance.test.ts` beside this
 * file now reads the drawing rather than trusting this paragraph.
 *
 * The seven rows below are the readiness checks the API actually returns -- the artboard draws six
 * statements and this draws seven,
 * because seven is what is stored, and inventing a sixth grouping to match a picture would be the
 * page claiming a shape the data does not have.
 */
const LEAD = "Your agent answers Instagram DMs and Facebook page messages in your voice, using the prices and rules you set. It will not touch anyone already in a conversation with you, and you can pause it from your Agent screen at any time.";

/**
 * One title and one strip, from one readiness result.
 *
 * The artboard's sentence claims the coach is one press from being answered, and it shipped
 * unconditionally over a strip whose earlier boxes said "(still to do)" -- a headline and a rail on
 * one screen disagreeing about the same fact, which is what the honest-states rule forbids.
 * Rewording it would have been the same bug in quieter words: any fixed sentence is right or wrong
 * depending on evidence it cannot see. So the sentence is counted by `setupHeadline` off the
 * outstanding checks, the ticks are derived by `setupProgress` off the same checks, and the rail's
 * "you are here" is the first step nobody has proved, so none of the three can disagree.
 */
export default async function OnboardingPage() {
  // Read only while the go-live flow itself is on: with it off the body below offers no button,
  // so a headline counting the coach down to one would be counting towards nothing.
  const progress = phase5Live() ? await readinessProgress() : null;
  const completed = progress?.completed ?? [];
  const body = phase5Live()
    ? <CoachOnboarding />
    : <OnboardingExperience meetAgentEnabled={phase7MeetAgentLive()} />;

  return (
    <OnboardingStage
      steps={<SetupSteps completed={completed} current={currentSetupStep(completed)} />}
      lead={LEAD}
      title={setupHeadline(progress?.outstanding ?? null)}
      width="wide"
    >
      {body}
    </OnboardingStage>
  );
}
