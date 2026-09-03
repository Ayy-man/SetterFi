import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import type { CoachCadenceChannel } from "@/components/workspace/live/coach-agent";
import { CoachPageHead } from "@/components/workspace/live/coach-page-head";
import { CoachAgent } from "@/components/workspace/rehaul/coach-agent";
import {
  rehaulConnectionSurface,
  type RehaulCalendarSnapshot,
} from "@/components/workspace/rehaul/coach-agent-connection-view";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import type { MessagingChannel } from "@/lib/booking/types";
import { coachNavCounts } from "@/lib/coach-nav-counts";
import type { WorkspaceNavCounts } from "@/lib/workspace-navigation";
import {
  capiLive,
  phase1Live,
  phase2Live,
  phase3Live,
  phase4Live,
  phase7MeetAgentLive,
} from "@/lib/env-contract";
import { workspaceDateFormat } from "@/lib/format/datetime";
import {
  listChannelConnections,
  type ChannelConnectionView,
} from "@/lib/repositories/channel-connections";
import { listCapiDatasets } from "@/lib/repositories/capi-datasets";
import { readCoachQuestions } from "@/lib/repositories/coach-questions";
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

/**
 * A channel only joins the follow-up schedule once its own receipts say it can send. The state
 * column alone is a claim nobody signed for, which is why "live" still has to carry a signed
 * round trip and "ready" has to carry the four receipts that made it ready.
 */
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

/** The connected channels step 7 groups its schedule by, in the shape the schedule reads. */
function cadenceChannels(
  connections: readonly ChannelConnectionView[] | null,
): CoachCadenceChannel[] {
  return (connections ?? [])
    .filter(
      (connection) =>
        isCadenceChannel(connection.channel) && hasReceiptBackedReadiness(connection),
    )
    .map((connection) => ({
      channel: connection.channel as MessagingChannel,
      channelLabel: connection.channelLabel,
      capability: resolveChannelCapability(connection.channel, {
        [connection.channel]: connection.capabilities,
      }),
    }));
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
  const [draft, published, publicationReceipt] = await Promise.all([
    repository.loadOffer({ tenantId, status: "draft" }),
    repository.loadOffer({ tenantId, status: "published" }),
    loadPublishedOfferReceipt(tenantId),
  ]);

  /*
   * The offer layer, plus the connection surface the ladder's booking rung and the Connections tab
   * read. Every connection read is an existing repository call behind the same flags
   * `/coach/integrations` gates it with, and a read that refuses stays null so the screen says it
   * could not read rather than "not connected".
   */
  const params = await searchParams;
  const tabParam = params.tab;
  const tab = (Array.isArray(tabParam) ? tabParam[0] : tabParam) === "connections"
    ? ("connections" as const)
    : ("ladder" as const);
  const connectionsEnabled = phase1Live() && phase4Live();
  const cadenceEnabled = phase1Live() && phase3Live();
  const [channelRows, registration, calendar, datasets, questions] = await Promise.all([
    /*
     * One read for two consumers: the Connections tab and step 7's follow-up schedule sit behind
     * different flags, so the read runs when either is on and each consumer is handed null when
     * its own flag is down rather than borrowing the other's rows.
     */
    connectionsEnabled || cadenceEnabled
      ? listChannelConnections(tenantId).catch(() => null)
      : Promise.resolve(null),
    loadCoachA2pRegistration(tenantId).catch(() => null),
    rehaulCalendar(tenantId).catch(() => null),
    capiLive() ? listCapiDatasets(tenantId).catch(() => null) : Promise.resolve(null),
    /*
     * Step 3's rows. Read here rather than fetched by the component because the merged list is
     * tenant-scoped and the browser has no business naming a tenant for it. A refusal stays null
     * so the panel says it could not read, which is not the same claim as an empty library. The
     * writes go back through `/api/coach/questions`, which re-derives the actor from the session.
     */
    actorId
      ? readCoachQuestions({ tenantId, userId: actorId }).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <CoachAgentShell navCounts={await coachNavCounts(tenantId)}>
      <CoachAgent
        cadence={{
          enabled: cadenceEnabled,
          channels: cadenceEnabled ? cadenceChannels(channelRows) : [],
        }}
        connections={rehaulConnectionSurface({
          calendar,
          connections: connectionsEnabled ? channelRows : null,
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
        questions={questions}
        tab={tab}
        testEnabled={phase7MeetAgentLive()}
      />
    </CoachAgentShell>
  );
}
