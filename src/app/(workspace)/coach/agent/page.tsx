import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import type { CoachCadenceChannel } from "@/components/workspace/live/coach-agent";
import { CoachPageHead } from "@/components/workspace/live/coach-page-head";
import {
  CoachAgent,
  type CoachAgentObjections,
} from "@/components/workspace/rehaul/coach-agent";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import type { MessagingChannel } from "@/lib/booking/types";
import { coachNavCounts } from "@/lib/coach-nav-counts";
import type { WorkspaceNavCounts } from "@/lib/workspace-navigation";
import {
  phase1Live,
  phase2Live,
  phase3Live,
  phase7MeetAgentLive,
  phase8SupportLive,
} from "@/lib/env-contract";
import { loadCoachTopObjections } from "@/lib/repositories/analytics";
import {
  listChannelConnections,
  type ChannelConnectionView,
} from "@/lib/repositories/channel-connections";
import { readCoachQuestions } from "@/lib/repositories/coach-questions";
import { createOfferLayerRepository } from "@/lib/repositories/offer-layer";
import { resolveChannelCapability } from "@/lib/sends/channel-capabilities";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Your agent" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Configure" }, { label: "Your agent" }] as const;
const CADENCE_CHANNELS = new Set<MessagingChannel>([
  "sms",
  "instagram",
  "messenger",
  "whatsapp",
]);
const DAY_MS = 24 * 60 * 60 * 1_000;

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

/** The connected channels the follow-up card groups its schedule by. */
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

/**
 * The objections rollup, reduced to what the rail draws.
 *
 * A hard-gated row never reaches here (`HARD_GATED_ROWS_COACH_VISIBLE` is false in the
 * repository), and a row whose booked share has no approved definition arrives with a null rate,
 * which the panel renders as words rather than as a bar. The window length is carried through as
 * whole days rather than described as "the last month", because the panel should name the window
 * the read actually returned.
 */
async function coachObjections(
  actorId: string | null,
  tenantId: string,
): Promise<CoachAgentObjections | null> {
  if (!actorId) return null;
  try {
    const rollup = await loadCoachTopObjections(actorId, tenantId, new Date().toISOString());
    const windowDays = Math.max(
      1,
      Math.round(
        (Date.parse(rollup.windowEnd) - Date.parse(rollup.windowStart)) / DAY_MS,
      ),
    );
    return {
      windowDays,
      rows: rollup.rows.map((row) => ({
        objectionId: row.objectionId,
        label: row.label,
        bookedRate: row.bookedRate,
        conversationCount: row.conversationCount,
      })),
    };
  } catch {
    return null;
  }
}

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

export default async function CoachAgentPage() {
  if (!phase2Live()) {
    return (
      <CoachAgentShell>
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

  const [draft, published, channelRows, questions, objections] = await Promise.all([
    repository.loadOffer({ tenantId, status: "draft" }),
    repository.loadOffer({ tenantId, status: "published" }),
    /*
     * The follow-up card groups its touches by connected channel class. A refused read stays null,
     * so the card falls back to the platform's own schedule rather than claiming no channel is
     * connected.
     */
    cadenceEnabled ? listChannelConnections(tenantId).catch(() => null) : Promise.resolve(null),
    /*
     * The merged question list, read here rather than fetched by the component because it is
     * tenant-scoped and the browser has no business naming a tenant for it. A refusal stays null so
     * the panel says it could not read, which is not the same claim as an empty library.
     */
    actorId
      ? readCoachQuestions({ tenantId, userId: actorId }).catch(() => null)
      : Promise.resolve(null),
    coachObjections(actorId, tenantId),
  ]);

  return (
    <CoachAgentShell navCounts={await coachNavCounts(tenantId)}>
      <CoachAgent
        cadence={{
          enabled: cadenceEnabled,
          channels: cadenceEnabled ? cadenceChannels(channelRows) : [],
        }}
        initialState={{ draft, published }}
        key={`${draft?.id ?? "no-draft"}:${published?.id ?? "no-published"}`}
        objections={objections}
        questions={questions}
        supportEnabled={phase8SupportLive()}
        testEnabled={phase7MeetAgentLive()}
      />
    </CoachAgentShell>
  );
}
