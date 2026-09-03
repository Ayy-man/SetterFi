import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import {
  CoachIntegrations,
  type A2pRegistrationRead,
  type CalendarConnectionRead,
  type ConversionTrackingRead,
  type ConnectionActivity,
  type ConnectionErrorRead,
} from "@/components/workspace/live/coach-integrations";
import {
  coachMessagingConnectionState,
  type CoachMessagingConnectionState,
} from "@/components/workspace/live/coach-messaging-connection-view-models";
import { PHASE4_CHANNELS, type Phase4Channel } from "@/components/workspace/live/view-models";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { calendarAvailabilityErrorCopy, humanError } from "@/lib/copy/errors";
import { capiLive, phase1Live, phase4Live, phase9GhlOAuthLive } from "@/lib/env-contract";
import { impersonatedReadContext, type ImpersonationSession } from "@/lib/impersonation";
import {
  listChannelConnections,
  type ChannelConnectionView,
} from "@/lib/repositories/channel-connections";
import { listGhlInstallLocationsForTenant } from "@/lib/repositories/ghl-installs";
import { listCapiDatasets } from "@/lib/repositories/capi-datasets";
import { listMessageTemplates } from "@/lib/repositories/message-templates";
import { loadCoachA2pRegistration } from "@/lib/repositories/onboarding-evidence";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Connections" };
export const dynamic = "force-dynamic";

const CRUMBS = [
  { label: "Setup", href: "/coach/get-started" },
  { label: "Connections" },
] as const;

function ConnectionsShell({ children }: { children: ReactNode }) {
  return (
    <AppShell
      activePath="/coach/integrations"
      crumbs={CRUMBS}
      role="coach"
    >
      {children}
    </AppShell>
  );
}

async function liveCoachContext() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fcoach%2Fintegrations");
  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "coach", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  const tenantId = claims.impersonatingTenant ?? claims.tenantId;
  if (!tenantId) redirect("/admin/platform-clients");
  if (!claims.impersonatingTenant) return { tenantId, impersonation: null };

  const raw = data.claims as { app_metadata?: Record<string, unknown> };
  const sessionId = raw.app_metadata?.impersonation_session_id;
  if (typeof sessionId !== "string") redirect("/admin/platform-clients");
  const service = createSupabaseServiceClient();
  const { data: row, error: sessionError } = await service
    .from("impersonation_sessions")
    .select("id, actor_id, tenant_id, reason, started_at, ended_at, expires_at")
    .eq("id", sessionId)
    .single();
  if (sessionError || !row) redirect("/admin/platform-clients");
  const session: ImpersonationSession = {
    id: row.id,
    actorId: row.actor_id,
    tenantId: row.tenant_id,
    reason: row.reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    expiresAt: row.expires_at,
  };
  const context = impersonatedReadContext(data.claims, session);
  return { tenantId: context.tenantId, impersonation: true };
}

/**
 * A failed install read stays unchecked. It never collapses to an empty array because an empty
 * array would claim that no setup record exists.
 */
async function messagingConnection(tenantId: string): Promise<CoachMessagingConnectionState | null> {
  if (!phase9GhlOAuthLive()) return null;
  try {
    return coachMessagingConnectionState({
      checked: true,
      locations: await listGhlInstallLocationsForTenant(tenantId),
    });
  } catch {
    return coachMessagingConnectionState({ checked: false, locations: [] });
  }
}

async function a2pRegistration(tenantId: string): Promise<A2pRegistrationRead> {
  try {
    return { checked: true, registration: await loadCoachA2pRegistration(tenantId) };
  } catch {
    return { checked: false, registration: null };
  }
}

function latestActivityAt(values: readonly string[]) {
  return values.reduce<string | null>((latest, value) => {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return latest;
    if (!latest || timestamp > Date.parse(latest)) return value;
    return latest;
  }, null);
}

async function channelActivity(
  tenantId: string,
  connections: readonly ChannelConnectionView[] | null,
): Promise<Record<Phase4Channel, ConnectionActivity>> {
  const service = createSupabaseServiceClient();
  const entries = await Promise.all(PHASE4_CHANNELS.map(async (channel) => {
    if (connections === null) {
      return [channel, { checked: false, at: null }] as const;
    }
    const connection = connections.find((candidate) => candidate.channel === channel);
    if (!connection) {
      return [channel, { checked: true, at: null }] as const;
    }

    // Activity must move with normal message persistence, not freeze at verification: read the
    // newest conversation activity for this channel since this connection existed (a replaced
    // account's older traffic stays excluded), with the signed verification receipts as the floor.
    const { data: newestConversation, error: activityError } = await service
      .from("conversations")
      .select("last_message_at")
      .eq("tenant_id", tenantId)
      .eq("channel", channel)
      .gte("last_message_at", connection.createdAt)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activityError) {
      return [channel, { checked: false, at: null }] as const;
    }

    const activityTimes: string[] = [];
    if (newestConversation?.last_message_at) activityTimes.push(newestConversation.last_message_at);
    for (const receipt of [connection.receipts.signedRoundTripAt, connection.receipts.webhookSubscribedAt]) {
      if (receipt) activityTimes.push(receipt);
    }
    return [channel, { checked: true, at: latestActivityAt(activityTimes) }] as const;
  }));
  return Object.fromEntries(entries) as Record<Phase4Channel, ConnectionActivity>;
}

async function calendarConnection(tenantId: string): Promise<CalendarConnectionRead> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("calendar_connections")
    .select("id, calendar_name, provider, state, timezone, last_slot_fetch_at, last_slot_fetch_ok, last_error, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .eq("is_primary", true)
    .maybeSingle();
  if (error) return { checked: false, connection: null };
  if (!data) return { checked: true, connection: null };
  return {
    checked: true,
    connection: {
      id: data.id,
      name: data.calendar_name,
      provider: data.provider,
      state: data.state,
      timezone: data.timezone,
      lastSlotFetchAt: data.last_slot_fetch_at,
      lastSlotFetchOk: data.last_slot_fetch_ok,
      lastError: {
        checked: true,
        // The availability codes are answered by the calendar's own sentence first. `humanError`
        // has no entry for them and its fallback says nothing changed, which is false here: the
        // connection is stored and only the read did not verify.
        message: data.last_error
          ? calendarAvailabilityErrorCopy(data.last_error) ?? humanError(data.last_error).body
          : null,
      },
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    },
  };
}

async function storedConnectionErrors(
  tenantId: string,
  connections: readonly ChannelConnectionView[] | null,
): Promise<Record<string, ConnectionErrorRead> | null> {
  if (connections === null) return null;
  if (connections.length === 0) return {};
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("channel_connections")
    .select("id, error")
    .eq("tenant_id", tenantId)
    .in("id", connections.map((connection) => connection.id));
  if (error) return null;
  const byId = new Map((data ?? []).map((row) => [row.id, row]));
  return Object.fromEntries(connections.map((connection) => {
    const row = byId.get(connection.id);
    return [
      connection.id,
      row
        ? {
            checked: true,
            message: row.error ? humanError(row.error).body : null,
          }
        : { checked: false, message: null },
    ];
  }));
}

async function conversionTracking(tenantId: string): Promise<ConversionTrackingRead> {
  if (!capiLive()) return { enabled: false, checked: true, datasets: [] };
  try {
    return { enabled: true, checked: true, datasets: await listCapiDatasets(tenantId) };
  } catch {
    return { enabled: true, checked: false, datasets: [] };
  }
}

export default async function CoachIntegrationsPage() {
  if (!phase1Live() || !phase4Live()) {
    return (
      <ConnectionsShell>
        <CoachIntegrations connections={[]} enabled={false} templates={[]} />
      </ConnectionsShell>
    );
  }

  const context = await liveCoachContext();
  const nowIso = new Date().toISOString();
  const [connections, templates, registration, messaging, calendar, capi] = await Promise.all([
    listChannelConnections(context.tenantId).catch(() => null),
    listMessageTemplates(context.tenantId).catch(() => null),
    a2pRegistration(context.tenantId),
    messagingConnection(context.tenantId),
    calendarConnection(context.tenantId),
    conversionTracking(context.tenantId),
  ]);
  const [activity, storedErrors] = await Promise.all([
    channelActivity(context.tenantId, connections),
    storedConnectionErrors(context.tenantId, connections),
  ]);

  return (
    <ConnectionsShell>
      <CoachIntegrations
        a2pRegistration={registration}
        activityByChannel={activity}
        calendar={calendar}
        connections={connections}
        conversionTracking={capi}
        impersonating={context.impersonation !== null}
        messaging={messaging}
        nowIso={nowIso}
        storedErrorsByConnection={storedErrors}
        templates={templates}
      />
    </ConnectionsShell>
  );
}
