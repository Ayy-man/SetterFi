import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SetupOverview } from "@/components/onboarding/setup-overview";
import { onboardingSteps, type OnboardingSetupEvidence } from "@/components/onboarding/setup-status";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { phase5Live } from "@/lib/env-contract";
import { carrierReviewFrom } from "@/lib/onboarding/carrier-review";
import { listChannelConnections } from "@/lib/repositories/channel-connections";
import { createOfferLayerRepository } from "@/lib/repositories/offer-layer";
import { loadCoachA2pRegistration } from "@/lib/repositories/onboarding-evidence";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set up your agent",
  description: "The six steps between signing up and your SetterFi agent answering.",
  robots: { index: false, follow: false },
};

/**
 * The setup root: six steps, their real states, and one button that resumes.
 *
 * ## Which read each surface makes, and why they now agree
 *
 * Note 3 recorded `/onboarding` saying "3 of 7 confirmed" while `/coach/home` said "0 of 3 done"
 * for the same demo coach, and the audit called it three-way once Get started's "Six steps" was
 * counted. The cause was not a wrong constant. It was two surfaces reading two different things
 * and neither counting what it drew:
 *
 *   - `/onboarding` evaluated the seven **go-live readiness checks** (`evaluateReadiness`), which
 *     include the platform Brain and the subscription, and printed that count over a four-box
 *     strip. Two of the seven have no box at all, so the numerator and the drawing were never
 *     about the same set.
 *   - `/coach/home` builds two or three rungs from `channel_connections` and the A2P registration,
 *     plus a blocked-row count from `provisioning_steps`, and prints "done of rungs.length".
 *
 * Each rung now reads the same source its own step screen reads, which is the only rule that
 * actually closes this rather than moving it:
 *
 *   | rung              | read                                            | who else reads it |
 *   |-------------------|-------------------------------------------------|-------------------|
 *   | Business profile  | `business_profiles` row for the tenant           | the profile step  |
 *   | Connect           | `channel_connections` in state `live`            | the connect step, coach Home |
 *   | Texting           | the A2P registration through `carrierReviewFrom` | the texting step, the connect step, coach Home |
 *   | Calendar          | the primary `calendar_connections` row in `ready`| the calendar step |
 *   | Your offer        | the published offer row                          | the offer step    |
 *   | Go live           | `provisioning_steps.go_live`                     | nothing else states it |
 *
 * The first pass at this read all four non-channel rungs off `provisioning_steps`, and the demo
 * coach immediately showed why that is wrong: their `calendar_connections` row is `ready` and
 * there is no `calendar_connect` provisioning row at all, so the rail said "waiting on you" over a
 * step screen that said "availability verified". The provisioning table records what the worker
 * did; the connection tables record what is true. A rung has to agree with the screen it links to.
 *
 * Both counters count the array they render, so home's rail and this one still show different
 * denominators on purpose: home draws the two or three things it read, this draws the six steps of
 * setup. What can no longer happen is the two disagreeing about a fact they both state.
 *
 * The readiness evaluator is deliberately not read here. It answers "would the go-live endpoint
 * refuse", which is the go-live step's own question and is asked on that step's screen; asking it
 * here put a seven-check count on a six-step page, which is the defect Note 3 recorded.
 */

/**
 * The four rungs that are a row in a table rather than a connection list, read the same way the
 * step screens behind them read.
 *
 * Each answer is three-valued: `true` proved, `false` read and not proved, `null` not read. A
 * failed read is never `false` -- "you have not done this" and "we could not find out" are
 * different sentences and the rail draws them differently.
 */
type StoredEvidence = {
  calendarReady: boolean | null;
  live: boolean | null;
  offerPublished: boolean | null;
  profileSaved: boolean | null;
};

const UNREAD: StoredEvidence = {
  calendarReady: null,
  live: null,
  offerPublished: null,
  profileSaved: null,
};

async function loadStoredEvidence(tenantId: string): Promise<StoredEvidence> {
  const client = createSupabaseServiceClient();

  /** A saved business profile is what the profile step calls "saved": a row for this tenant. */
  const profileSaved = Promise.resolve(
    client.from("business_profiles").select("id").eq("tenant_id", tenantId).limit(1),
  )
    .then(({ data, error }) => (error || !Array.isArray(data) ? null : data.length > 0))
    .catch((): boolean | null => null);

  /*
   * `ready` on the primary row, which is exactly the `verified` the calendar step draws its own
   * state from. A stored authorization in any other state is a connection that exists and cannot
   * yet be booked into, and the step says so, so the rung must not call it done.
   */
  const calendarReady = Promise.resolve(
    client
      .from("calendar_connections")
      .select("state")
      .eq("tenant_id", tenantId)
      .eq("is_primary", true)
      .limit(1),
  )
    .then(({ data, error }) => {
      if (error || !Array.isArray(data)) return null;
      return data.length > 0 && (data[0] as { state?: unknown }).state === "ready";
    })
    .catch((): boolean | null => null);

  /** `go_live` is the one rung with no screen of its own to agree with, so it reads the worker. */
  const live = Promise.resolve(
    client
      .from("provisioning_steps")
      .select("state")
      .eq("tenant_id", tenantId)
      .eq("step_key", "go_live")
      .limit(1),
  )
    .then(({ data, error }) => {
      if (error || !Array.isArray(data)) return null;
      return data.length > 0 && (data[0] as { state?: unknown }).state === "done";
    })
    .catch((): boolean | null => null);

  /*
   * Published, not saved. The offer step reads the published row first and says out loud when it
   * is looking at a draft instead, because a draft is words the agent has never said to a lead.
   */
  const offerPublished = createOfferLayerRepository()
    .loadOffer({ status: "published", tenantId })
    .then((offer) => offer !== null)
    .catch((): boolean | null => null);

  const [calendar, isLive, offer, profile] = await Promise.all([
    calendarReady,
    live,
    offerPublished,
    profileSaved,
  ]);
  return {
    calendarReady: calendar,
    live: isLive,
    offerPublished: offer,
    profileSaved: profile,
  };
}

async function coachContext() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fonboarding");
  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "coach", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  if (!claims.tenantId) redirect("/login");
  return { tenantId: claims.tenantId };
}

export default async function OnboardingPage() {
  const { tenantId } = await coachContext();

  /*
   * With the go-live flow off, every one of these reads would describe a pipeline that is not
   * running. The rail still draws, and every step says the read did not happen, which is the
   * honest thing for a deployment where setup is switched off.
   */
  const live = phase5Live();

  const [connections, registration, stored] = await Promise.all([
    live ? listChannelConnections(tenantId).catch(() => null) : Promise.resolve(null),
    live
      ? loadCoachA2pRegistration(tenantId)
        .then((row) => ({ checked: true, row }))
        .catch(() => ({ checked: false, row: null }))
      : Promise.resolve({ checked: false, row: null }),
    live ? loadStoredEvidence(tenantId) : Promise.resolve(UNREAD),
  ]);

  const evidence: OnboardingSetupEvidence = {
    calendarReady: stored.calendarReady,
    carrier: carrierReviewFrom({
      checked: registration.checked,
      registrationState: registration.row?.registrationState ?? null,
      submittedAt: registration.row?.submittedAt ?? null,
      terminalRejection: registration.row?.terminalRejection ?? false,
    }),
    live: stored.live,
    /*
     * The same claim coach Home's `liveChannels` makes, off the same read. Only `live` counts:
     * `ready`, `pending_review` and `connecting` are all connections that exist and none of them
     * is a channel a lead can reach.
     */
    metaLive: connections === null
      ? null
      : connections.some(
        (row) => (row.channel === "instagram" || row.channel === "messenger")
          && row.state === "live",
      ),
    offerPublished: stored.offerPublished,
    profileSaved: stored.profileSaved,
  };

  return <SetupOverview steps={onboardingSteps(evidence)} />;
}
