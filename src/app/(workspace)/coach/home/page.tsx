import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { coachNavCounts } from "@/lib/coach-nav-counts";
import type { WorkspaceNavCounts } from "@/lib/workspace-navigation";
import { phase7AnalyticsLive, uiRehaulLive } from "@/lib/env-contract";
import { impersonatedReadContext, type ImpersonationSession } from "@/lib/impersonation";
import { PROVISIONING_STEPS, type ProvisioningStep } from "@/lib/onboarding/contracts";
import {
  listChannelConnections,
  type ChannelConnectionView,
} from "@/lib/repositories/channel-connections";
import { loadCoachA2pRegistration } from "@/lib/repositories/onboarding-evidence";
import {
  carrierReviewFrom,
  type CoachChannelStatus,
} from "@/components/workspace/live/coach-channel-status";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Coach dashboard" };
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type CoachMeasurementWindow = "1d" | "1w" | "1m" | "3m" | "all" | "custom";
const WINDOWS = new Set<CoachMeasurementWindow>(["1d", "1w", "1m", "3m", "all", "custom"]);
const CRUMBS = [{ label: "Coach" }, { label: "Home" }] as const;

function CoachHomeShell({
  children,
  navCounts,
}: {
  children: ReactNode;
  navCounts?: WorkspaceNavCounts;
}) {
  return (
    <AppShell
      activePath="/coach/home"
      crumbs={CRUMBS}
      navCounts={navCounts}
      role="coach"
    >
      {children}
    </AppShell>
  );
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function dateOnly(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function measurementQuery(params: Record<string, string | string[] | undefined>) {
  const requested = first(params.window);
  const window = WINDOWS.has(requested as CoachMeasurementWindow)
    ? requested as CoachMeasurementWindow
    : "1m";
  const customFrom = dateOnly(first(params.from));
  const customTo = dateOnly(first(params.to));
  if (window === "custom" && (!customFrom || !customTo || customFrom > customTo)) {
    return { window: "1m" as const, customFrom: null, customTo: null };
  }
  return {
    window,
    customFrom: window === "custom" ? customFrom : null,
    customTo: window === "custom" ? customTo : null,
  };
}

async function liveCoachContext() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fcoach%2Fhome");
  const claims = parseAppClaims(data.claims);
  // The reader identity the measurement RPCs verify. It comes from getClaims(), which validates
  // the JWT server-side, and never from the URL. Under impersonation it stays the platform user's
  // own id while the tenant becomes the impersonated one -- exactly the pair
  // app.phase7_session_actor checks against public.impersonation_sessions.
  const actorId = claims.userId;
  if (!actorId) redirect("/login?next=%2Fcoach%2Fhome");
  if (!canAccessWorkspace(claims.role, "coach")) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  const tenantId = claims.impersonatingTenant ?? claims.tenantId;
  if (!tenantId) redirect("/admin/platform-clients");
  if (!claims.impersonatingTenant) return { actorId, tenantId, impersonation: null };
  if (!claims.impersonationSessionId) redirect("/admin/platform-clients");
  const service = createSupabaseServiceClient();
  const { data: row, error: sessionError } = await service.from("impersonation_sessions")
    .select("id, actor_id, tenant_id, reason, started_at, ended_at, expires_at")
    .eq("id", claims.impersonationSessionId)
    .single();
  if (sessionError || !row) redirect("/admin/platform-clients");
  const session: ImpersonationSession = { id: row.id, actorId: row.actor_id, tenantId: row.tenant_id, reason: row.reason, startedAt: row.started_at, endedAt: row.ended_at, expiresAt: row.expires_at };
  const context = impersonatedReadContext(data.claims, session);
  return { actorId, tenantId: context.tenantId, impersonation: { sessionId: context.sessionId, tenantId: context.tenantId } };
}

/**
 * The three queue depths the Dashboard leads with, and the one fact each of them needs to say why
 * it is waiting.
 *
 * Screen 2a draws a sentence under every count -- "Oldest has waited 22 min", "No-shows and
 * long-term follow-ups", "Carriers rejected your text registration". Each of those turned out to
 * be a column rather than a phrase, so each is read here rather than written into the surface:
 * `conversations.needs_human_at` for the oldest wait, the two `pipeline_stage` values the callback
 * count is already made of, and `provisioning_steps.step_key` for the blocked step's own name.
 * Nothing here is derived from a model or a rate, so a sentence can never claim more than a row.
 *
 * `blocked_reason` is deliberately not rendered. The column is operator-authored free text with no
 * contract about audience, and the coach Dashboard is not the place to find out what it says.
 */
function isProvisioningStep(value: unknown): value is ProvisioningStep {
  return typeof value === "string" && (PROVISIONING_STEPS as readonly string[]).includes(value);
}

async function loadCoachAttention(tenantId: string, includeTestData: boolean, asOf: string) {
  const service = createSupabaseServiceClient();
  const CLOSED_STATUSES = ["closed", "opted_out"] as const;

  function conversations() {
    const query = service.from("conversations").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);
    return includeTestData ? query : query.eq("is_test", false);
  }
  function callbacksInStage(stage: "long_term_followup" | "no_show") {
    const query = service.from("contacts").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("pipeline_stage", stage)
      .is("merged_into_contact_id", null);
    return includeTestData ? query : query.eq("is_test", false);
  }

  let oldestWaitQuery = service
    .from("conversations")
    .select("needs_human_at")
    .eq("tenant_id", tenantId)
    .eq("status", "needs_human")
    .not("needs_human_at", "is", null)
    .order("needs_human_at", { ascending: true })
    .limit(1);
  if (!includeTestData) oldestWaitQuery = oldestWaitQuery.eq("is_test", false);

  const [
    threadsResult,
    noShowResult,
    followUpResult,
    setupResult,
    blockedStepResult,
    openThreadsResult,
    oldestWaitResult,
  ] = await Promise.all([
    conversations().eq("status", "needs_human"),
    callbacksInStage("no_show"),
    callbacksInStage("long_term_followup"),
    service
      .from("provisioning_steps")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("state", "blocked"),
    service
      .from("provisioning_steps")
      .select("step_key")
      .eq("tenant_id", tenantId)
      .eq("state", "blocked")
      .order("updated_at", { ascending: true })
      .limit(1),
    conversations().not("status", "in", `(${CLOSED_STATUSES.join(",")})`),
    oldestWaitQuery,
  ]);
  if (
    threadsResult.error || noShowResult.error || followUpResult.error || setupResult.error
    || blockedStepResult.error || openThreadsResult.error || oldestWaitResult.error
  ) {
    throw new Error("COACH_ATTENTION_READ_FAILED");
  }

  const oldestWaitAt = oldestWaitResult.data?.[0]?.needs_human_at ?? null;
  const oldestWaitMs = oldestWaitAt ? Date.parse(oldestWaitAt) : Number.NaN;
  const nowMs = Date.parse(asOf);
  // Measured against the page's own clock, the same instant the metrics are read at, so the
  // sentence under the count and the figures beside it cannot disagree about when "now" is. A row
  // stamped a second into the future by clock skew is zero minutes old, never minus one.
  const oldestWaitMinutes = Number.isFinite(oldestWaitMs) && Number.isFinite(nowMs)
    ? Math.max(0, Math.floor((nowMs - oldestWaitMs) / 60_000))
    : null;
  const blockedStepKey = blockedStepResult.data?.[0]?.step_key ?? null;

  return {
    blockedSetupSteps: setupResult.count ?? 0,
    blockedStepKey: isProvisioningStep(blockedStepKey) ? blockedStepKey : null,
    leadsToCallBack: (noShowResult.count ?? 0) + (followUpResult.count ?? 0),
    longTermFollowUps: followUpResult.count ?? 0,
    noShows: noShowResult.count ?? 0,
    oldestThreadWaitMinutes: oldestWaitMinutes,
    openConversations: openThreadsResult.count ?? 0,
    threadsNeedingHuman: threadsResult.count ?? 0,
  };
}

/**
 * The channel states that mean a connection which used to work has stopped working.
 *
 * `disconnected` is deliberately not one of them: a channel nobody ever connected is a setup step,
 * which the Get started journey already owns, and putting it here would tell a coach mid-onboarding
 * that something broke.
 */
const BROKEN_CHANNEL_STATES = [
  "error",
  "expired",
  "restricted",
  "flagged",
  "blocked_permanent",
] as const;

/**
 * The one blocked channel that leads screen 5c, and the custody facts it is allowed to state.
 *
 * The artifact's sentence is "14 threads are being held, nothing is dropped, and they replay in
 * order the moment you reconnect." None of the three halves of that survives contact with the
 * code, so none of them is rendered:
 *
 * - **Nothing replays on reconnect.** `POST /api/channel-actions/[connectionId]/replay` takes one
 *   explicit `sourceReceiptId`, loads that single `webhook_events` row and refuses it unless the
 *   row is already `failed`. One receipt, named by the caller, by hand. No bulk path exists and
 *   nothing runs it when a connection comes back.
 * - **There is no ordering.** Nothing anywhere sequences a replay.
 * - **"Held" means something else here.** `process-inbound.ts` uses the word for a reply the
 *   safety screen withheld, which has nothing to do with a channel outage. The word is avoided on
 *   this surface for that reason.
 *
 * What is true, and what the surface says instead: the inbound event is recorded, because
 * `webhook_events` is unique on `(provider, provider_event_id)`, and one that failed to process is
 * still on file. So the honest claim is that the messages are recorded and are not being answered,
 * which is weaker than the artifact and is the whole point.
 *
 * `channel_connections.error` **is** read, and an earlier version of this comment was wrong about
 * why it should not be. There are exactly three writers of that column and the claim that all of
 * them write `null` was false:
 *
 * - `20260905000010_backend_security_sagas.sql:62` sets it to
 *   `LEGACY_CREDENTIAL_REAUTHORIZATION_REQUIRED` on every connection whose credential was
 *   quarantined as undecryptable pre-envelope ciphertext, together with `state = 'error'`. It runs
 *   once as a migration, but the rows it wrote persist, so a production connection can carry that
 *   value today.
 * - `20260917000001_provider_connection_commands.sql:110` clears it on disconnect.
 * - `20260905000009_provider_connection_atomicity.sql:195` clears it on WhatsApp reconnect.
 *
 * So a coach blocked by exactly that quarantine would have been shown no cause at all while the
 * database held the reason. The contract in `channel-connections.ts` was right the whole time; the
 * premise about its writers was the defect. What stays true is that no *ongoing* application path
 * records a provider's own words when a live call fails.
 *
 * The count is of **events, not threads**. `webhook_events` carries a provider and a status but no
 * conversation, so grouping into threads would mean parsing payloads, and Instagram and Messenger
 * share the `meta` provider so it could not even be narrowed to the channel that broke.
 */
async function loadBlockedChannel(
  tenantId: string,
  connections: readonly ChannelConnectionView[] | null,
) {
  if (!connections) return null;
  const broken = connections
    .filter((connection) => (BROKEN_CHANNEL_STATES as readonly string[]).includes(connection.state))
    // Oldest break first: the one that has been costing the coach replies for longest leads.
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
  const connection = broken[0];
  if (!connection) return null;

  const provider = ["instagram", "messenger"].includes(connection.channel) ? "meta" : "ghl";
  const service = createSupabaseServiceClient();
  const { count, error } = await service
    .from("webhook_events")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("provider", provider)
    .eq("status", "failed");

  return {
    channelLabel: connection.channelLabel,
    connectionId: connection.id,
    // Straight off the row. Null stays null: an unrecorded cause is a fact and the surface says
    // nothing rather than guessing one.
    providerReason: connection.error,
    // Null, not zero: a failed read has not established that nothing is waiting.
    unprocessedEvents: error ? null : count ?? 0,
    signedRoundTripAt: connection.receipts.signedRoundTripAt,
    state: connection.state,
    stoppedAt: connection.updatedAt,
  };
}


/**
 * The coach's own first name, for the greeting, and nothing else.
 *
 * `public.users.full_name` is the only place a person's name is stored -- the signup RPC writes it
 * and it has existed since the initial migration -- and the greeting takes the first whitespace
 * token of it. That is a display convention rather than a claim about name structure, and it is
 * the right trade here: a header that reads "Welcome back, Marcus" is the artboard's line, and one
 * that reads "Welcome back, Marcus Reed" is a database row wearing a greeting's clothes.
 *
 * A failed read, an unset name and a blank one all return null, and the header falls back to
 * "Dashboard" rather than to "Welcome back," with nothing after it. The read is allowed to fail
 * into null for the same reason the offer summary is: a greeting is the least important thing on
 * this page and must never be the reason it does not render.
 */
async function loadCoachGreeting(actorId: string) {
  try {
    const { data, error } = await createSupabaseServiceClient()
      .from("users")
      .select("full_name")
      .eq("id", actorId)
      .single();
    if (error || !data) return null;
    const fullName = typeof data.full_name === "string" ? data.full_name.trim() : "";
    return fullName.split(/\s+/u)[0] || null;
  } catch {
    return null;
  }
}

/**
 * What the agent is answering on, and where the text registration has got to.
 *
 * Both halves are reads of state somebody else owns, and both are shaped so that a failure is
 * distinguishable from an absence. `channelsChecked` is false when the connection list could not
 * be read, which is not the same as no channel being live; `carrierReviewFrom` maps a failed
 * registration read to `unchecked` rather than to `not-filed` for the same reason. A status line
 * built on the assumption that a missing answer means "no" would tell a coach mid-onboarding that
 * nothing is connected on the strength of a query that never ran.
 *
 * Only `live` counts as live. `ready`, `pending_review` and `connecting` are all connections that
 * exist and none of them is a channel a lead can reach, so the green line is drawn from the state
 * the row actually carries rather than from the row existing at all -- which is the difference
 * between an honest state and the fake "all set" `CLAUDE.md` forbids.
 */
async function loadChannelStatus(
  tenantId: string,
  connections: readonly ChannelConnectionView[] | null,
): Promise<CoachChannelStatus> {
  const registration = await loadCoachA2pRegistration(tenantId)
    .then((row) => ({ checked: true, row }))
    .catch(() => ({ checked: false, row: null }));

  return {
    channelsChecked: connections !== null,
    liveChannels: (connections ?? [])
      .filter((connection) => connection.state === "live")
      .map((connection) => connection.channel),
    carrier: carrierReviewFrom({
      checked: registration.checked,
      registrationState: registration.row?.registrationState ?? null,
      submittedAt: registration.row?.submittedAt ?? null,
      terminalRejection: registration.row?.terminalRejection ?? false,
    }),
  };
}

export default async function CoachHomePage({ searchParams }: PageProps) {
  if (!phase7AnalyticsLive()) {
    return (
      <CoachHomeShell>
        <DataState
          body="Turn on coach analytics to read the action queue and performance window."
          kind="empty"
          title="Measurement is not enabled"
        />
      </CoachHomeShell>
    );
  }

  const query = measurementQuery(await searchParams);
  const context = await liveCoachContext();
  const [
    { CoachMeasurementSurface },
    { loadCoachLeadComposition, loadCoachMeasurement },
    { createBillingRepository },
  ] = await Promise.all([
    import("@/components/workspace/live/coach-measurement"),
    import("@/lib/repositories/analytics"),
    import("@/lib/repositories/billing"),
  ]);
  // One clock reading for both reads, so the aggregate and the monthly bars cannot land on
  // opposite sides of a month boundary and disagree about which month is still filling.
  const asOf = new Date().toISOString();
  const [measurement, composition, billing] = await Promise.all([
    loadCoachMeasurement(context.actorId, context.tenantId, {
      window: query.window,
      customFrom: query.customFrom,
      customTo: query.customTo,
      asOf,
    }),
    loadCoachLeadComposition(context.actorId, context.tenantId, asOf),
    /*
     * The same read `/coach/billing` makes, at the same instant as the measurement beside it, so
     * the two pages cannot disagree about whether this coach has a billing period. It carries the
     * `isCurrentBillingPeriod` predicate with it, so a period that has ended without being
     * replaced is null here exactly as it is there.
     *
     * A failure is not allowed to take the dashboard down with it, and it is not allowed to pass
     * as an answer either: a read that failed is "unavailable", never the null that means a
     * successful read found no current period, so the footer can say the period could not be
     * loaded rather than telling a paying coach they have none.
     */
    createBillingRepository().loadOwnBilling(context.tenantId, new Date(asOf))
      .catch((): "unavailable" => "unavailable"),
  ]);
  // One read of the connection list, shared by the two things that reason about it. The blocked
  // channel is the negative -- one connection that used to work and stopped -- and the status line
  // is the positive; deriving them from two separate queries let them disagree about the same row.
  const connections = await listChannelConnections(context.tenantId).catch(() => null);
  const [attention, blockedChannel, channelStatus, greeting] = await Promise.all([
    loadCoachAttention(context.tenantId, measurement.isDemo, asOf),
    loadBlockedChannel(context.tenantId, connections),
    loadChannelStatus(context.tenantId, connections),
    // Suppressed under impersonation. The reader there is a platform user with a real name of
    // their own, and putting it at the top of somebody else's dashboard names the wrong person on
    // the right page -- the header already says the view is a read-only admin one.
    context.impersonation ? Promise.resolve(null) : loadCoachGreeting(context.actorId),
  ]);

  const navCounts = await coachNavCounts(context.tenantId);
  const billingPeriod = billing === "unavailable"
    ? "unavailable" as const
    : billing
      ? { periodStart: billing.periodStart, periodEnd: billing.periodEnd }
      : null;

  /*
   * The rehaul seam. When the flag is on the new body renders from exactly the reads above -- no
   * extra query, no different loader -- and when it is off the live surface is untouched.
   */
  if (uiRehaulLive()) {
    const { CoachDashboard } = await import("@/components/workspace/rehaul/coach-dashboard");
    return (
      <CoachHomeShell navCounts={navCounts}>
        <CoachDashboard
          {...query}
          attention={attention}
          billingPeriod={billingPeriod}
          channelStatus={channelStatus}
          composition={composition}
          greeting={greeting}
          measurement={measurement}
        />
      </CoachHomeShell>
    );
  }

  return (
    <CoachHomeShell navCounts={navCounts}>
      <CoachMeasurementSurface
        {...query}
        attention={attention}
        billingPeriod={billingPeriod}
        blockedChannel={blockedChannel}
        channelStatus={channelStatus}
        composition={composition}
        greeting={greeting}
        impersonation={context.impersonation}
        measurement={measurement}
      />
    </CoachHomeShell>
  );
}
