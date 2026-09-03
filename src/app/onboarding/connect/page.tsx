import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DataState } from "@/components/kit/data-state";
import {
  connectCards,
  connectStepComplete,
} from "@/components/onboarding/connect-view-models";
import { OnboardingStage } from "@/components/onboarding/onboarding-stage";
import { SetupSteps } from "@/components/onboarding/setup-steps";
import { OnboardingConnectRehaul } from "@/components/workspace/rehaul/onboarding-connect";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { phase5Live } from "@/lib/env-contract";
import { listChannelConnections } from "@/lib/repositories/channel-connections";
import { loadCoachA2pRegistration } from "@/lib/repositories/onboarding-evidence";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Connect where your leads message you",
  description: "Connect the channels your SetterFi agent answers on.",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const TITLE = "Connect where your leads message you";
const LEAD =
  "Two of these turn on today. The third one takes about three weeks and there is nothing you can do to speed it up, so start it now and forget about it.";

/**
 * Step one of setup: where a coach's leads actually message them.
 *
 * It reads real connection rows and the real carrier registration rather than drawing three
 * identical "Connect" buttons, because the state is the whole point of the screen -- a coach who
 * connected Instagram yesterday should see that, and a coach whose details are with the carriers
 * should see a day count and no button at all. `connect-view-models.ts` holds every one of those
 * rules and is where they are tested; this file is the data load and nothing else.
 *
 * Not a public route. It sits under the same session gate as the rest of `/onboarding`, so it
 * needs no reachability flag of its own -- the only thing it adds is a screen an already
 * signed-in coach can get to.
 */
async function coachContext() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fonboarding%2Fconnect");
  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "coach", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  if (!claims.tenantId) redirect("/login");
  return { tenantId: claims.tenantId };
}

export default async function OnboardingConnectPage() {
  if (!phase5Live()) {
    return (
      <OnboardingStage lead={LEAD} title={TITLE} width="wide">
        <DataState
          body="Setup is not enabled on this deployment, so no channel can be connected from here yet."
          kind="empty"
          title="Connecting channels is not enabled"
        />
      </OnboardingStage>
    );
  }

  const { tenantId } = await coachContext();

  let connections: Awaited<ReturnType<typeof listChannelConnections>> = [];
  let registration = null;
  let failed = false;
  try {
    [connections, registration] = await Promise.all([
      listChannelConnections(tenantId),
      loadCoachA2pRegistration(tenantId),
    ]);
  } catch {
    // An unreadable channel list is an absence, not a licence to draw every card as
    // unconnected -- that would tell a coach with a live Instagram that they have none.
    failed = true;
  }

  if (failed) {
    return (
      <OnboardingStage
        lead={LEAD}
        steps={<SetupSteps current="connect" />}
        title={TITLE}
        width="wide"
      >
        <DataState
          body="Your channel connections could not be read just now, so this page cannot say which of them are working. Nothing has changed. Reload the page, or open your setup screen to connect a channel."
          kind="empty"
          title="Channel status is unavailable"
        />
      </OnboardingStage>
    );
  }

  const complete = connectStepComplete(connections);
  const cards = connectCards({ connections, registration });

  return <OnboardingConnectRehaul cards={cards} nextEnabled={complete} />;
}
