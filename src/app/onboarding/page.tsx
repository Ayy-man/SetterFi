import type { Metadata } from "next";

import { CoachOnboarding } from "@/components/onboarding/coach-onboarding";
import { connectStepComplete } from "@/components/onboarding/connect-view-models";
import { OnboardingExperience } from "@/components/onboarding/onboarding-experience";
import { OnboardingStage } from "@/components/onboarding/onboarding-stage";
import {
  outstandingSetupSteps,
  SetupSteps,
  type SetupStepKey,
} from "@/components/onboarding/setup-steps";
import { parseAppClaims } from "@/lib/auth/claims";
import { phase5Live, phase7MeetAgentLive } from "@/lib/env-contract";
import { listChannelConnections } from "@/lib/repositories/channel-connections";
import { createOfferLayerRepository } from "@/lib/repositories/offer-layer";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Which of the earlier steps this page can prove, for the position strip above the title.
 *
 * Only the two it can read cheaply and directly: a Meta channel with a signed round trip, and a
 * published offer. "Meet your agent" maps to the `test_passed` readiness check, which the client
 * component below fetches and this server render does not have, so it is left as still-to-do
 * rather than assumed -- and the seven receipt-backed rows immediately underneath carry the real
 * per-check truth either way. Understating a step the list below reports honestly is a much
 * cheaper mistake than a strip that ticks a step on nothing.
 *
 * Any failure here is an empty list, never a guess. The strip is a position readout; it must not
 * be able to take the page down or invent a tick when a read fails.
 */
async function provenSteps(): Promise<SetupStepKey[]> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return [];
    const claims = parseAppClaims(data.claims);
    if (!claims.tenantId) return [];
    const [connections, published] = await Promise.all([
      listChannelConnections(claims.tenantId).catch(() => []),
      createOfferLayerRepository()
        .loadOffer({ status: "published", tenantId: claims.tenantId })
        .catch(() => null),
    ]);
    return [
      ...(connectStepComplete(connections) ? (["connect"] as const) : []),
      ...(published?.programName?.trim() ? (["offer"] as const) : []),
    ];
  } catch {
    return [];
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
 * Two titles, and which one is drawn is decided by the same evidence the strip above it is drawn
 * from.
 *
 * The artboard's sentence claims the coach is one press from being answered, and it shipped
 * unconditionally over a strip whose earlier boxes said "(still to do)" -- a headline and a rail
 * on one screen disagreeing about the same fact, which is exactly what the honest-states rule in
 * `CLAUDE.md` forbids. Rewording it would have been the same bug in quieter words: any fixed
 * sentence is right or wrong depending on evidence it cannot see. So the branch is on
 * `outstandingSetupSteps`, the strip's own function, and the readiness claim is unreachable by
 * construction while any box is still to do.
 *
 * They are two separate `title=` literals rather than one ternary because a reader -- human, or
 * the artboard conformance check next door -- sees each sentence next to the condition that earns
 * it, instead of two claims sharing one expression as though both could be on screen at once.
 *
 * **Today the readiness arm is unreachable, and that is honest rather than dead.** `provenSteps`
 * deliberately cannot prove `meet` (see its docblock: the `test_passed` check is fetched by the
 * client component, not by this render), so `meet` is always outstanding and the strip always
 * says so. The day that read moves server-side, both the strip and this headline start telling
 * the truth about it on the same commit, which is the whole point of deriving one from the other.
 */
export default async function OnboardingPage() {
  const completed = phase5Live() ? await provenSteps() : [];
  const outstanding = outstandingSetupSteps(completed, "go_live");
  const steps = <SetupSteps completed={completed} current="go_live" />;
  const body = phase5Live()
    ? <CoachOnboarding />
    : <OnboardingExperience meetAgentEnabled={phase7MeetAgentLive()} />;

  if (outstanding.length > 0) {
    return (
      <OnboardingStage
        steps={steps}
        lead={LEAD}
        title="Your agent is not answering yet"
        width="wide"
      >
        {body}
      </OnboardingStage>
    );
  }

  return (
    <OnboardingStage
      steps={steps}
      lead={LEAD}
      title="You are one button away from your agent answering"
      width="wide"
    >
      {body}
    </OnboardingStage>
  );
}
