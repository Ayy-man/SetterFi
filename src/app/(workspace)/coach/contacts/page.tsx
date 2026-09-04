import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { CoachLeads } from "@/components/workspace/rehaul/coach-leads";
import type { AppointmentEvidenceByContact } from "@/components/workspace/rehaul/coach-leads-model";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { coachNavCounts } from "@/lib/coach-nav-counts";
import type { WorkspaceNavCounts } from "@/lib/workspace-navigation";
import { phase1Live, pipelineWriteLive } from "@/lib/env-contract";
import { impersonatedReadContext, type ImpersonationSession } from "@/lib/impersonation";
import { listContacts } from "@/lib/repositories/contacts";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Workspace" }, { label: "Leads" }] as const;

/**
 * One screen, two routes.
 *
 * `SIMPLIFICATION-SPEC` 2.3 merges Contacts and Pipeline into a single Leads screen with a
 * List / Board switch, and the two routes survive only as the two doors into it: this one opens
 * on the list, the switch writes `?view=` from there, and `workspace-navigation.ts` already
 * matches both paths to the one Leads pill. Nothing on the other route is mounted any more.
 */
function LeadsShell({
  children,
  navCounts,
}: {
  children: ReactNode;
  navCounts?: WorkspaceNavCounts;
}) {
  return (
    <AppShell
      activePath="/coach/contacts"
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
  if (error || !data?.claims) redirect("/login?next=%2Fcoach%2Fcontacts");
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
  return {
    tenantId: context.tenantId,
    impersonation: { sessionId: context.sessionId, tenantId: context.tenantId },
  };
}

/** Every lead, not the first page: the search, the board and the export all cover the whole set. */
async function listAllContacts(tenantId: string) {
  const items: Awaited<ReturnType<typeof listContacts>>["items"] = [];
  let cursor: Awaited<ReturnType<typeof listContacts>>["nextCursor"] = null;
  const seenCursors = new Set<string>();
  do {
    const page = await listContacts(tenantId, { cursor, limit: 100 });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor) {
      const key = `${cursor.lastActivityAt}:${cursor.id}`;
      if (seenCursors.has(key)) throw new Error("CONTACT_CURSOR_STALLED");
      seenCursors.add(key);
    }
  } while (cursor);
  return items;
}

async function loadAppointmentEvidence(
  tenantId: string,
  contactIds: readonly string[],
): Promise<AppointmentEvidenceByContact | null> {
  if (!contactIds.length) return {};
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("appointments")
    .select("id, contact_id, start_at, status")
    .eq("tenant_id", tenantId)
    .in("contact_id", [...contactIds])
    .order("start_at", { ascending: false });
  // A failed read is not the same claim as zero receipts: null tells the surface to pause the
  // moves that need a receipt honestly, instead of refusing them for the wrong reason.
  if (error) return null;

  const evidence: AppointmentEvidenceByContact = {};
  for (const row of data ?? []) {
    if (!evidence[row.contact_id]) {
      evidence[row.contact_id] = {
        appointmentId: row.id,
        startAt: row.start_at,
        status: row.status,
      };
    }
  }
  return evidence;
}

export default async function CoachContactsPage() {
  if (!phase1Live()) {
    return (
      <LeadsShell>
        <DataState
          body="Turn on lead management to view your leads and their stages."
          kind="empty"
          title="Leads are not enabled"
        />
      </LeadsShell>
    );
  }

  const context = await liveCoachContext();
  const items = await listAllContacts(context.tenantId);
  // One clock reading for the whole render, taken here so the server pass and the hydrated client
  // measure every relative age against the same instant.
  const nowIso = new Date().toISOString();
  const appointmentEvidence = await loadAppointmentEvidence(
    context.tenantId,
    items.map((contact) => contact.id),
  );
  return (
    <LeadsShell navCounts={await coachNavCounts(context.tenantId)}>
      <CoachLeads
        appointmentEvidence={appointmentEvidence}
        defaultView="list"
        impersonation={context.impersonation}
        initialContacts={items}
        nowIso={nowIso}
        writeEnabled={pipelineWriteLive()}
      />
    </LeadsShell>
  );
}
