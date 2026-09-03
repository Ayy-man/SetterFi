import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import type { CoachCadenceChannel } from "@/components/workspace/live/coach-agent";
import { CoachPageHead } from "@/components/workspace/live/coach-page-head";
import {
  CoachOffer,
  type CoachEscalationSummary,
  type CoachObjectionPushback,
} from "@/components/workspace/live/coach-offer";
import { CoachAgent } from "@/components/workspace/rehaul/coach-agent";
import {
  rehaulConnectionSurface,
  type RehaulCalendarSnapshot,
} from "@/components/workspace/rehaul/coach-agent-connection-view";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { coachNavCounts } from "@/lib/coach-nav-counts";
import type { WorkspaceNavCounts } from "@/lib/workspace-navigation";
import type { MessagingChannel } from "@/lib/booking/types";
import {
  brainObjectionsLive,
  capiLive,
  inboxVerbsLive,
  phase1Live,
  phase2Live,
  phase3Live,
  phase4Live,
  phase7MeetAgentLive,
  uiRehaulLive,
} from "@/lib/env-contract";
import { workspaceDateFormat } from "@/lib/format/datetime";
import { loadCoachTopObjections } from "@/lib/repositories/analytics";
import {
  listChannelConnections,
  type ChannelConnectionView,
} from "@/lib/repositories/channel-connections";
import { listCapiDatasets } from "@/lib/repositories/capi-datasets";
import { loadCoachA2pRegistration } from "@/lib/repositories/onboarding-evidence";
import { createOfferLayerRepository } from "@/lib/repositories/offer-layer";
import { resolveChannelCapability } from "@/lib/sends/channel-capabilities";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Your agent" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Configure" }, { label: "Your agent" }] as const;
const CADENCE_CHANNELS = new Set<MessagingChannel>([
  "sms",
  "instagram",
  "messenger",
  "whatsapp",
]);

function isCadenceChannel(channel: string): channel is MessagingChannel {
  return CADENCE_CHANNELS.has(channel as MessagingChannel);
}

function hasReceiptBackedReadiness(connection: ChannelConnectionView) {
  if (connection.state === "live") {
    return Boolean(connection.receipts.signedRoundTripAt);
  }
  if (connection.state !== "ready") return false;
  return Boolean(
    connection.externalAccountLabel &&
      connection.receipts.oauthCompletedAt &&
      connection.receipts.assetVerifiedAt &&
      connection.receipts.webhookSubscribedAt,
  );
}

async function loadPublishedOfferReceipt(tenantId: string) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("offer_layers")
    .select("id,published_at")
    .eq("tenant_id", tenantId)
    .eq("status", "published")
    .maybeSingle();
  if (error) throw new Error("OFFER_PUBLICATION_DATE_READ_FAILED");
  if (!data) return null;
  return {
    offerId: String(data.id),
    publishedAt:
      typeof data.published_at === "string" ? data.published_at : null,
  };
}

/**
 * How long the oldest escalated thread has waited. Derived from the real `needs_human_at` the
 * escalation path writes, and null whenever that column is unset, so the card omits the line
 * rather than estimating one.
 */
function waitingLabel(since: string | null, asOf: Date) {
  if (!since) return null;
  const started = new Date(since);
  if (Number.isNaN(started.valueOf())) return null;
  const minutes = Math.floor((asOf.getTime() - started.getTime()) / 60_000);
  if (minutes < 0) return null;
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The escalation source for the attention queue. Test rows are excluded so a seeded demo tenant
 * cannot inflate a real coach's count. Returns null on an empty queue rather than a zero, because
 * the card renders on presence, not on a number.
 */
async function loadCoachEscalations(
  tenantId: string,
  asOf: Date,
): Promise<CoachEscalationSummary | null> {
  const client = createSupabaseServiceClient();
  const [countResult, oldestResult] = await Promise.all([
    client
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "needs_human")
      .eq("is_test", false),
    client
      .from("conversations")
      .select("id,contact_id,needs_human_at")
      .eq("tenant_id", tenantId)
      .eq("status", "needs_human")
      .eq("is_test", false)
      .not("needs_human_at", "is", null)
      .order("needs_human_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  if (countResult.error || oldestResult.error) {
    throw new Error("COACH_ESCALATION_READ_FAILED");
  }
  const count = countResult.count ?? 0;
  if (count < 1) return null;

  let leadHandle: string | null = null;
  const contactId =
    typeof oldestResult.data?.contact_id === "string" ? oldestResult.data.contact_id : null;
  if (contactId) {
    const { data: contact, error: contactError } = await client
      .from("contacts")
      .select("name")
      .eq("tenant_id", tenantId)
      .eq("id", contactId)
      .maybeSingle();
    if (contactError) throw new Error("COACH_ESCALATION_READ_FAILED");
    const name = typeof contact?.name === "string" ? contact.name.trim() : "";
    leadHandle = name || null;
  }

  return {
    count,
    leadHandle,
    waitingLabel: waitingLabel(
      typeof oldestResult.data?.needs_human_at === "string"
        ? oldestResult.data.needs_human_at
        : null,
      asOf,
    ),
  };
}

function publicationDateLabel(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : workspaceDateFormat.format(date);
}


/**
 * The primary calendar row, read exactly as `/coach/integrations` reads it.
 *
 * A copy rather than an import: the loader there is a module-private function inside a page file,
 * and a page cannot export one for another page to call. The columns, the filter and the failure
 * arm are identical on purpose -- a `checked: false` read stays absent on the screen instead of
 * collapsing to "not connected", which would claim a fact the read did not establish.
 */
async function rehaulCalendar(tenantId: string): Promise<RehaulCalendarSnapshot | null> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("calendar_connections")
    .select("calendar_name, provider, state, last_slot_fetch_at, last_slot_fetch_ok")
    .eq("tenant_id", tenantId)
    .eq("is_primary", true)
    .maybeSingle();
  if (error || !data) return null;
  return {
    name: data.calendar_name,
    provider: data.provider,
    state: data.state,
    lastSlotFetchAt: data.last_slot_fetch_at,
    lastSlotFetchOk: data.last_slot_fetch_ok,
  };
}

type CoachAgentPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function CoachAgentShell({
  children,
  navCounts,
}: {
  children: ReactNode;
  navCounts?: WorkspaceNavCounts;
}) {
  return (
    <AppShell
      activePath="/coach/agent"
      crumbs={CRUMBS}
      navCounts={navCounts}
      role="coach"
    >
      {children}
    </AppShell>
  );
}

async function liveCoachContext() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fcoach%2Fagent");
  const claims = parseAppClaims(data.claims);
  if (
    !canAccessWorkspace(claims.role, "coach", {
      affiliateAccess: claims.affiliateAccess,
    })
  ) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  if (claims.role !== "coach" && claims.role !== "coach_member") {
    redirect("/admin/platform-clients");
  }
  if (!claims.tenantId) redirect("/login");
  return { actorId: claims.userId ?? null, tenantId: claims.tenantId };
}

export default async function CoachAgentPage({ searchParams }: CoachAgentPageProps) {
  if (!phase2Live()) {
    return (
      <CoachAgentShell>
        {/*
          The coach head on the off branch too, because this is still a coach page when the flag is
          down. `PageHeader` sets `.t-page-title`, which is 30px only under
          `[data-shell-role="admin"]` and 20px here, and the live path below already opens at the
          canvas's 46px -- so the flag was moving the title by 26px. Crumbs are dropped with it:
          `CoachAgentShell` passes the same list to `AppShell`.
        */}
        <CoachPageHead
          sub="Configure the offer facts and voice your agent may use with leads."
          surface="agent"
          title="Your agent"
        />
        <DataState
          body="Turn on the offer layer before configuring what the agent may say."
          kind="empty"
          title="Agent configuration is not enabled"
        />
      </CoachAgentShell>
    );
  }

  const { actorId, tenantId } = await liveCoachContext();
  const repository = createOfferLayerRepository();
  const cadenceEnabled = phase1Live() && phase3Live();
  const objectionsEnabled = brainObjectionsLive() && actorId !== null;
  // The same pair `POST /api/conversations/[id]/claim` is gated on. With either flag off the coach
  // cannot claim a thread, so a count would advertise a control that does nothing.
  const escalationsEnabled = phase3Live() && inboxVerbsLive();
  const asOf = new Date();
  const [draft, published, publicationReceipt, connections, objections, escalation] =
    await Promise.all([
      repository.loadOffer({ tenantId, status: "draft" }),
      repository.loadOffer({ tenantId, status: "published" }),
      loadPublishedOfferReceipt(tenantId),
      cadenceEnabled ? listChannelConnections(tenantId) : Promise.resolve([]),
      objectionsEnabled
        ? loadCoachTopObjections(actorId, tenantId, asOf.toISOString())
        : Promise.resolve(null),
      escalationsEnabled
        ? loadCoachEscalations(tenantId, asOf)
        : Promise.resolve(null),
    ]);

  if (uiRehaulLive()) {
    /*
     * The rehaul body. Same offer layer the old component gets, plus the connection surface the
     * ladder's booking rung and the Connections tab read. Every extra read is an existing
     * repository call behind the flag `/coach/integrations` already gates it with, and a read
     * that refuses stays null so the screen says it could not read rather than "not connected".
     */
    const params = await searchParams;
    const tabParam = params.tab;
    const tab = (Array.isArray(tabParam) ? tabParam[0] : tabParam) === "connections"
      ? ("connections" as const)
      : ("ladder" as const);
    const connectionsEnabled = phase1Live() && phase4Live();
    const [channelRows, registration, calendar, datasets] = await Promise.all([
      connectionsEnabled
        ? listChannelConnections(tenantId).catch(() => null)
        : Promise.resolve(null),
      loadCoachA2pRegistration(tenantId).catch(() => null),
      rehaulCalendar(tenantId).catch(() => null),
      capiLive() ? listCapiDatasets(tenantId).catch(() => null) : Promise.resolve(null),
    ]);

    return (
      <CoachAgentShell navCounts={await coachNavCounts(tenantId)}>
        <CoachAgent
          connections={rehaulConnectionSurface({
            calendar,
            connections: channelRows,
            datasets,
            registration,
          })}
          initialState={{ draft, published }}
          key={`${draft?.id ?? "no-draft"}:${published?.id ?? "no-published"}`}
          publishedDateLabel={
            published && publicationReceipt?.offerId === published.id
              ? publicationDateLabel(publicationReceipt.publishedAt)
              : null
          }
          tab={tab}
          testEnabled={phase7MeetAgentLive()}
        />
      </CoachAgentShell>
    );
  }

  const channels: CoachCadenceChannel[] = connections
    .filter(
      (connection) =>
        isCadenceChannel(connection.channel) &&
        hasReceiptBackedReadiness(connection),
    )
    .map((connection) => ({
      channel: connection.channel as MessagingChannel,
      channelLabel: connection.channelLabel,
      capability: resolveChannelCapability(connection.channel, {
        [connection.channel]: connection.capabilities,
      }),
    }));
  /*
   * `Agent.dc.html` draws a percentage and a 190px meter on every objection row. The rollup
   * returns a rate only while its own attribution state reads `available`, and today every row
   * reads `awaiting_definition`, so the rate arrives null and the row says why instead of drawing
   * a bar at zero. The two branches are written here rather than in the panel because the reason
   * an absent rate is absent is a property of the rollup, not of the drawing.
   */
  const pushback: readonly CoachObjectionPushback[] | null = objections
    ? objections.rows.map((row) => ({
        objectionId: row.objectionId,
        label: row.label,
        conversationCount: row.conversationCount,
        bookedRate: row.state === "available" ? row.bookedRate : null,
        absence:
          row.state === "available" && row.bookedRate !== null
            ? null
            : row.state === "held_safely"
              ? "Held safely, never counted as a booking"
              : "Booked rate awaiting definition",
        conversationHref: `/coach/conversations?objection=${encodeURIComponent(row.objectionId)}`,
      }))
    : null;

  return (
    <CoachAgentShell navCounts={await coachNavCounts(tenantId)}>
      <CoachOffer
        cadence={{ enabled: cadenceEnabled, channels }}
        initialState={{ draft, published }}
        key={`${draft?.id ?? "no-draft"}:${published?.id ?? "no-published"}:${publicationReceipt?.publishedAt ?? "no-publication-date"}`}
        publishedDateLabel={
          published && publicationReceipt?.offerId === published.id
            ? publicationDateLabel(publicationReceipt.publishedAt)
            : null
        }
        objections={pushback}
        testEnabled={phase7MeetAgentLive()}
      />
    </CoachAgentShell>
  );
}
