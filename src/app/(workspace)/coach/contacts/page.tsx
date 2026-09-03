import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import type {
  AppointmentEvidenceByContact,
  NextSetterTouchByContact,
} from "@/components/workspace/live/leads-surface";
import { CoachLeads } from "@/components/workspace/rehaul/coach-leads";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { coachNavCounts } from "@/lib/coach-nav-counts";
import type { WorkspaceNavCounts } from "@/lib/workspace-navigation";
import { phase1Live } from "@/lib/env-contract";
import { impersonatedReadContext, type ImpersonationSession } from "@/lib/impersonation";
import { listContacts } from "@/lib/repositories/contacts";
import { listFollowups } from "@/lib/repositories/followups";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Workspace" }, { label: "Leads" }] as const;

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

/** Every lead, not the first page: views and local exports must cover the complete dataset. */
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
  // A failed read is not the same claim as zero receipts: null tells the surface to pause
  // evidence-dependent moves honestly instead of refusing them for the wrong reason.
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

/**
 * The setter's next automated touch per contact, for the call-back list.
 *
 * `followups` is keyed to a conversation and `listFollowups` already resolves the contact behind
 * it, so this is a fold rather than a query: the earliest `scheduled_at` per contact among the
 * rows still standing. A paused row is not a scheduled touch, and a sent or canceled one is
 * history.
 *
 * A truncated read returns `null`, not a partial map. Past the limit every missing contact would
 * render "No automated touch scheduled", which is a claim the read never established, and a false
 * absence on a list a coach works down is worse than saying nothing at all.
 */
async function loadNextSetterTouch(
  tenantId: string,
  contactIds: readonly string[],
): Promise<NextSetterTouchByContact | null> {
  if (!contactIds.length) return {};
  const limit = 500;
  try {
    const rows = await listFollowups(tenantId, { limit });
    if (rows.length >= limit) return null;
    const wanted = new Set(contactIds);
    const next: Record<string, string> = {};
    for (const row of rows) {
      if (row.status !== "scheduled" || row.pausedAt !== null) continue;
      if (!wanted.has(row.contactId)) continue;
      const current = next[row.contactId];
      if (!current || Date.parse(row.scheduledAt) < Date.parse(current)) {
        next[row.contactId] = row.scheduledAt;
      }
    }
    return next;
  } catch {
    return null;
  }
}

export default async function CoachContactsPage() {
  if (!phase1Live()) {
    return (
      <LeadsShell>
        <DataState
          body="Turn on lead management to view contacts and pipeline stages."
          kind="empty"
          title="Leads are not enabled"
        />
      </LeadsShell>
    );
  }

  const context = await liveCoachContext();
  const items = await listAllContacts(context.tenantId);
  const contactIds = items.map((contact) => contact.id);
  // One clock reading for the whole render, taken here so the server pass and the hydrated client
  // measure every silence figure on the call-back list against the same instant.
  const nowIso = new Date().toISOString();
  const [appointmentEvidence, nextSetterTouch] = await Promise.all([
    loadAppointmentEvidence(context.tenantId, contactIds),
    loadNextSetterTouch(context.tenantId, contactIds),
  ]);
  return (
    <LeadsShell navCounts={await coachNavCounts(context.tenantId)}>
      <CoachLeads
        appointmentEvidence={appointmentEvidence}
        defaultView="table"
        impersonation={context.impersonation}
        initialContacts={items}
        nextSetterTouch={nextSetterTouch}
        nowIso={nowIso}
      />
    </LeadsShell>
  );
}