import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  AdminChannelHealth,
  type AgencyInstallSummary,
  type ChannelHealthClient,
} from "@/components/workspace/live/admin-channel-health";
import {
  MESSAGING_INSTALL_APPS,
  agencyGrantFacts,
  agencyInstallReadLabel,
  agencyInstallSummaryLine,
} from "@/components/onboarding/messaging-install-view-models";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { phase1Live, phase4Live, phase9GhlOAuthLive } from "@/lib/env-contract";
import { createGhlAgencyInstallCustody } from "@/lib/integrations/ghl-oauth-store";
import { impersonatedReadContext, type ImpersonationSession } from "@/lib/impersonation";
import { listChannelConnections } from "@/lib/repositories/channel-connections";
import { listMessageTemplates } from "@/lib/repositories/message-templates";
import { loadCoachA2pRegistration } from "@/lib/repositories/onboarding-evidence";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Channel health" };
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function unscopedSelection() {
  return { tenantId: null, impersonation: null };
}

async function liveAdminContext(requestedTenantId: string | null) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fadmin%2Fchannel-health");
  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "admin", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }

  const service = createSupabaseServiceClient();
  const clientsResult = await service
    .from("tenants")
    .select("id,name,is_demo")
    .order("name", { ascending: true });
  const clients: ChannelHealthClient[] = clientsResult.error
    ? []
    : (clientsResult.data ?? []).map((row) => ({
        id: String(row.id),
        isDemo: Boolean(row.is_demo),
        name: String(row.name),
      }));

  if (claims.impersonatingTenant) {
    const raw = data.claims as { app_metadata?: Record<string, unknown> };
    const sessionId = raw.app_metadata?.impersonation_session_id;
    if (typeof sessionId !== "string") redirect("/admin/platform-clients");
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
    return {
      clients,
      clientsUnavailable: Boolean(clientsResult.error),
      tenantId: context.tenantId,
      impersonation: { sessionId: context.sessionId, tenantId: context.tenantId },
    };
  }

  const claimTenantId = claims.tenantId;
  const selectedTenantId = claimTenantId
    ?? (requestedTenantId && clients.some((client) => client.id === requestedTenantId)
      ? requestedTenantId
      : null);
  const selection = selectedTenantId
    ? { tenantId: selectedTenantId, impersonation: null }
    : unscopedSelection();
  return {
    clients,
    clientsUnavailable: Boolean(clientsResult.error),
    ...selection,
  };
}

/**
 * The same read `/admin/provisioning` makes, for the card that points at it.
 *
 * Read here rather than passed down from anywhere: the agency grant is platform-wide, so it does
 * not belong to the tenant scope this page otherwise works in, and a card that reported a stale
 * copy of it would be worse than no card. A read that does not complete yields nothing at all --
 * "could not check" is a claim the panel itself is the place to make.
 */
async function agencyInstallSummaries(): Promise<AgencyInstallSummary[] | null> {
  if (!phase9GhlOAuthLive()) return null;
  const service = createSupabaseServiceClient();
  const summaries = await Promise.all(MESSAGING_INSTALL_APPS.map(async (entry) => {
    const row = await createGhlAgencyInstallCustody(null, service, entry.app).load();
    const state = agencyInstallReadLabel({ checked: true, row });
    if (!row) return { app: entry.app, title: entry.title, label: state.label, tone: state.tone };
    const receipt = await service
      .from("ghl_agency_installs")
      .select("created_at,updated_at,approve_all_locations,is_bulk_installation,install_to_future_locations")
      .eq("id", row.id)
      .maybeSingle();
    if (receipt.error || !receipt.data) throw new Error("agency install receipt read failed");
    const line = agencyInstallSummaryLine({
      state,
      facts: agencyGrantFacts({
        createdAt: String(receipt.data.created_at),
        updatedAt: String(receipt.data.updated_at),
        approveAllLocations: receipt.data.approve_all_locations ?? null,
        isBulkInstallation: receipt.data.is_bulk_installation ?? null,
        installToFutureLocations: receipt.data.install_to_future_locations ?? null,
      }),
    });
    return { app: entry.app, title: entry.title, label: line.label, tone: line.tone };
  })).catch(() => null);
  return summaries;
}

export default async function AdminChannelHealthPage({ searchParams }: PageProps) {
  if (!phase1Live() || !phase4Live()) {
    return (
      <AdminChannelHealth
        clients={[]}
        connections={[]}
        enabled={false}
        templates={[]}
      />
    );
  }

  const params = await searchParams;
  const context = await liveAdminContext(first(params.client)?.trim() || null);
  const agencyInstalls = await agencyInstallSummaries();
  if (context.clientsUnavailable || !context.tenantId) {
    return (
      <AdminChannelHealth
        agencyInstalls={agencyInstalls}
        clients={context.clients}
        clientsUnavailable={context.clientsUnavailable}
        connections={[]}
        scope="unscoped"
        templates={[]}
      />
    );
  }

  const [connections, templates, a2pSubmittedAt] = await Promise.all([
    listChannelConnections(context.tenantId),
    listMessageTemplates(context.tenantId),
    // The carrier day counter counts from the filed A2P submission, the same receipt the go-live
    // checklist reads. A failed read stays null so the page says the receipt is missing rather
    // than inventing a start date (CLAUDE.md: honest states).
    loadCoachA2pRegistration(context.tenantId)
      .then((registration) => registration?.submittedAt ?? null)
      .catch(() => null),
  ]);
  return (
    <AdminChannelHealth
      a2pSubmittedAt={a2pSubmittedAt}
      agencyInstalls={agencyInstalls}
      clients={context.clients}
      clientsUnavailable={context.clientsUnavailable}
      connections={connections}
      impersonation={context.impersonation}
      nowIso={new Date().toISOString()}
      selectedClientId={context.tenantId}
      templates={templates}
    />
  );
}
