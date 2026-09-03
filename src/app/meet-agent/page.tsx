import type { Metadata } from "next";

import { AppShell } from "@/components/kit/app-shell";
import type { CoachAgentPreviewRules } from "@/components/workspace/live/coach-agent-preview";
import { MeetYourAgent } from "@/components/meet-your-agent";
import { loadPlatformActor, loadRouteActor } from "@/lib/auth/actors";
import { RehaulMeetAgent } from "@/components/workspace/rehaul/meet-agent";
import { phase7MeetAgentLive } from "@/lib/env-contract";
import { createOfferLayerRepository } from "@/lib/repositories/offer-layer";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Meet your agent",
  description: "Watch a configured SetterFi agent answer a sample lead.",
};

/**
 * The two rules the preview's third step cites, from the coach's own published offer.
 *
 * Nulls all the way down on any failure, and the component prints the rule without a number rather
 * than the artboard's 640 and $25,000 -- those belong to a coach who does not exist, and a screen
 * whose whole purpose is showing a coach their own setup is the worst place in the product to
 * print somebody else's numbers.
 */
async function publishedRules(tenantId: string): Promise<CoachAgentPreviewRules> {
  try {
    const offer = await createOfferLayerRepository().loadOffer({ status: "published", tenantId });
    return {
      creditFloor: offer?.creditMin ?? null,
      minimumRaiseCents: offer?.fundingGoalMinCents ?? null,
    };
  } catch {
    return { creditFloor: null, minimumRaiseCents: null };
  }
}

/** The first whitespace token of the signed-in person's name, or null. Display only. */
async function coachFirstName(userId: string) {
  try {
    const { data } = await createSupabaseServiceClient()
      .from("users")
      .select("full_name")
      .eq("id", userId)
      .maybeSingle();
    const fullName = typeof data?.full_name === "string" ? data.full_name.trim() : "";
    return fullName.split(/\s+/u)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Two different screens behind one route, and the split is deliberate.
 *
 * A coach gets `RehaulMeetAgent`: the phone-and-ledger body of `MeetAgent.body.html`, in the
 * coach chrome, with an explanation panel written in their words. A platform actor gets
 * `MeetYourAgent`, the live sandbox, unchanged -- it carries the composer, the adversarial
 * suggestion chips, the trace legend and the eval-promotion form the admin eval work depends on,
 * and the canvas that replaces it is still unsigned (`docs/REDESIGN-CANVAS.md:5`). Building the
 * artboard as a replacement would have deleted working capability to conform to a drawing; this
 * gives the coach the screen that was drawn for them and takes nothing away from anybody.
 */
export default async function MeetAgentPage() {
  if (!phase7MeetAgentLive()) return <p>Meet Your Agent is not enabled</p>;

  const actor = await loadPlatformActor();
  const canPromote = actor?.role === "owner" || actor?.role === "admin";
  if (actor) {
    return (
      <MeetYourAgent
        canPromote={canPromote}
        enabled
        initialContext={canPromote ? "admin" : "client"}
      />
    );
  }

  const routeActor = await loadRouteActor();
  if (!routeActor) {
    // No session to read a tenant from -- the open and password fixtures, and a claims read that
    // came back empty. The sandbox is what this route has always served in that case.
    return <MeetYourAgent canPromote={false} enabled initialContext="client" />;
  }

  const [rules, firstName] = await Promise.all([
    publishedRules(routeActor.tenantId),
    coachFirstName(routeActor.userId),
  ]);

  return (
    <AppShell
      // No pill takes the current state: this screen is not one of the five destinations, which is
      // what the artboard draws and what is true -- a coach arrives here from setup or from their
      // agent page, and highlighting a pill they are not on would be a lie about where they are.
      activePath="/meet-agent"
      crumbs={[{ label: "Coach" }, { label: "Meet your agent" }]}
      role="coach"
    >
      <RehaulMeetAgent coachName={firstName} rules={rules} />
    </AppShell>
  );
}
