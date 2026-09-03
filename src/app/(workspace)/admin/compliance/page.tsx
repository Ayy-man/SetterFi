import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import {
  AdminCompliance,
  type AdminDeletionActions,
  ComplianceHeader,
  type ComplianceContact,
  type LiveSuppressionRow,
  type SuppressionTombstoneRow,
} from "@/components/workspace/live/admin-compliance";
import { hasImpersonationMarker, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { previewLeadDeletion } from "@/lib/deletion/preview";
import { deleteLead } from "@/lib/deletion/service";
import { contactDeleteLive, phase1Live, phase3Live, uiRehaulLive } from "@/lib/env-contract";
import { impersonatedReadContext, type ImpersonationSession } from "@/lib/impersonation";
import {
  contactDeletedEvent,
  createComplianceEventEmitter,
  createNotificationRepository,
} from "@/lib/notifications/events";
import { OwnerCompliance } from "@/components/workspace/rehaul/owner-compliance";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Compliance" };
export const dynamic = "force-dynamic";

const ADMIN_COMPLIANCE_ROLES = new Set(["owner", "admin", "success"]);
const COMPLIANCE_CRUMBS = [
  { label: "Brain", href: "/admin/brain" },
  { label: "Compliance" },
] as const;

/* The rehaul rail's group for this route. The flag-off arm keeps the crumb it shipped with. */
const REHAUL_COMPLIANCE_CRUMBS = [{ label: "Platform" }, { label: "Compliance" }] as const;

/**
 * `failedConfirmations` is the rail's number, and it is deliberately narrower than "blocks on the
 * page": a confirmed block is finished work and a pending one is a provider taking its time, so
 * neither is somebody's queue. A failed confirmation is the only one of the three that means a
 * person here has to do something, and a page that could not be read counts nothing rather than
 * claiming an empty queue.
 */
function ComplianceShell({
  children,
  failedConfirmations = 0,
}: {
  children: ReactNode;
  failedConfirmations?: number;
}) {
  return (
    <AppShell
      activePath="/admin/compliance"
      crumbs={uiRehaulLive() ? REHAUL_COMPLIANCE_CRUMBS : COMPLIANCE_CRUMBS}
      navCounts={{ "/admin/compliance": failedConfirmations }}
      role="admin"
    >
      {children}
    </AppShell>
  );
}

async function authenticatedAdminClaims() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) throw new Error("AUTHENTICATION_REQUIRED");
  const claims = parseAppClaims(data.claims);
  if (!claims.role || !ADMIN_COMPLIANCE_ROLES.has(claims.role) || !claims.userId) {
    throw new Error("COMPLIANCE_ROLE_REQUIRED");
  }
  return { claims, rawClaims: data.claims };
}

async function liveAdminContext() {
  let authenticated;
  try {
    authenticated = await authenticatedAdminClaims();
  } catch {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getClaims();
    const claims = parseAppClaims(data?.claims ?? null);
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login?next=%2Fadmin%2Fcompliance");
  }
  const { claims, rawClaims } = authenticated;
  if (!claims.impersonatingTenant) return { tenantId: null, impersonation: null };
  if (!claims.impersonationSessionId) redirect("/admin/platform-clients");
  const service = createSupabaseServiceClient();
  const { data: row, error } = await service.from("impersonation_sessions")
    .select("id, actor_id, tenant_id, reason, started_at, ended_at, expires_at")
    .eq("id", claims.impersonationSessionId).single();
  if (error || !row) redirect("/admin/platform-clients");
  const session: ImpersonationSession = {
    id: row.id,
    actorId: row.actor_id,
    tenantId: row.tenant_id,
    reason: row.reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    expiresAt: row.expires_at,
  };
  const context = impersonatedReadContext(rawClaims, session);
  return {
    tenantId: context.tenantId,
    impersonation: { sessionId: context.sessionId, tenantId: context.tenantId },
  };
}

async function previewAdminDeletion(input: { tenantId: string; contactId: string }) {
  "use server";
  try {
    const { claims } = await authenticatedAdminClaims();
    if (hasImpersonationMarker(claims)) throw new Error("IMPERSONATION_READ_ONLY");
    if (!phase1Live() || !phase3Live() || !contactDeleteLive()) throw new Error("CONTACT_DELETE_DISABLED");
    const preview = await previewLeadDeletion({
      tenantId: input.tenantId,
      contactId: input.contactId,
      actorId: claims.userId!,
    });
    return { ok: true as const, value: preview };
  } catch {
    return { ok: false as const, error: "Deletion preview was refused." };
  }
}

async function executeAdminDeletion(input: Parameters<AdminDeletionActions["remove"]>[0]) {
  "use server";
  let started = false;
  try {
    const { claims } = await authenticatedAdminClaims();
    if (hasImpersonationMarker(claims)) throw new Error("IMPERSONATION_READ_ONLY");
    if (!phase1Live() || !phase3Live() || !contactDeleteLive()) throw new Error("CONTACT_DELETE_DISABLED");
    const service = createSupabaseServiceClient();
    const { data: contact, error } = await service.from("contacts").select("is_test")
      .eq("tenant_id", input.tenantId).eq("id", input.contactId).single();
    if (error || !contact) throw new Error("CONTACT_DELETE_SCOPE_FAILED");
    started = true;
    const result = await deleteLead({
      ...input,
      actorId: claims.userId!,
    });
    if (result.kind === "deleted" && !result.replayed) {
      const emitComplianceEvent = createComplianceEventEmitter(createNotificationRepository());
      await emitComplianceEvent(contactDeletedEvent({
        tenantId: input.tenantId,
        contactId: input.contactId,
        auditId: result.auditId,
        isTest: Boolean(contact.is_test),
        occurredAt: new Date().toISOString(),
      })).catch(() => undefined);
    }
    return { ok: true as const, value: result };
  } catch {
    if (started) {
      return {
        ok: false as const,
        error: "Contact deletion did not finish, so some of its steps may have run.",
        started: true as const,
      };
    }
    return { ok: false as const, error: "Contact deletion was refused." };
  }
}

function related(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return related(value[0]);
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

type ComplianceReadResult =
  | {
    ok: true;
    value: {
      contacts: ComplianceContact[];
      suppressions: LiveSuppressionRow[];
      tombstones: SuppressionTombstoneRow[];
    };
  }
  | { ok: false; code: "COMPLIANCE_READ_FAILED"; reason: string };

async function loadComplianceResult(
  context: Awaited<ReturnType<typeof liveAdminContext>>,
): Promise<ComplianceReadResult> {
  try {
    const service = createSupabaseServiceClient();
    let suppressionQuery = service.from("suppression_entries").select(`
      id,tenant_id,contact_id,channel,identifier_last4,source,reason,provider_sync_state,
      provider_synced_at,created_at,
      tenant:tenants(name,is_demo),contact:contacts(name,is_test)
    `).order("created_at", { ascending: false }).limit(200);
    let tombstoneQuery = service.from("suppression_tombstones").select(`
      id,tenant_id,channel,identifier_last4,deletion_audit_id,created_at,
      tenant:tenants!inner(name,is_demo)
    `).order("created_at", { ascending: false }).limit(200);
    let contactQuery = service.from("contacts").select(`
      id,tenant_id,name,pipeline_stage,last_seen_at,created_at,is_test,
      tenant:tenants!inner(name,is_demo)
    `).is("merged_into_contact_id", null).order("last_seen_at", { ascending: false, nullsFirst: false }).limit(200);
    if (context.tenantId) {
      suppressionQuery = suppressionQuery.eq("tenant_id", context.tenantId);
      tombstoneQuery = tombstoneQuery.eq("tenant_id", context.tenantId);
      contactQuery = contactQuery.eq("tenant_id", context.tenantId);
    }
    const [suppressionResult, tombstoneResult, contactResult] = await Promise.all([
      suppressionQuery,
      tombstoneQuery,
      contactQuery,
    ]);
    if (suppressionResult.error || tombstoneResult.error || contactResult.error) {
      return {
        ok: false,
        code: "COMPLIANCE_READ_FAILED",
        reason: "Compliance records could not load.",
      };
    }

    const suppressions: LiveSuppressionRow[] = (suppressionResult.data ?? []).map((row) => {
      const tenant = related(row.tenant);
      const contact = related(row.contact);
      return {
        id: String(row.id),
        tenantName: typeof tenant?.name === "string" ? tenant.name : "Platform",
        contactName: typeof contact?.name === "string" ? contact.name : null,
        channel: String(row.channel),
        identifierLast4: typeof row.identifier_last4 === "string" ? row.identifier_last4 : null,
        source: String(row.source),
        reason: typeof row.reason === "string" && row.reason.trim() ? row.reason : null,
        providerSyncState: String(row.provider_sync_state),
        providerSyncedAt: typeof row.provider_synced_at === "string" ? row.provider_synced_at : null,
        createdAt: String(row.created_at),
        isDemo: tenant?.is_demo === true,
        isTest: contact?.is_test === true,
      };
    });
    const tombstones: SuppressionTombstoneRow[] = (tombstoneResult.data ?? []).map((row) => {
      const tenant = related(row.tenant);
      return {
        id: String(row.id),
        tenantName: typeof tenant?.name === "string" ? tenant.name : "Unknown tenant",
        channel: String(row.channel),
        identifierLast4: typeof row.identifier_last4 === "string" ? row.identifier_last4 : null,
        deletionAuditId: Number(row.deletion_audit_id),
        createdAt: String(row.created_at),
        isDemo: tenant?.is_demo === true,
      };
    });
    const contacts: ComplianceContact[] = (contactResult.data ?? []).map((row) => {
      const tenant = related(row.tenant);
      return {
        id: String(row.id),
        tenantId: String(row.tenant_id),
        tenantName: typeof tenant?.name === "string" ? tenant.name : "Unknown tenant",
        name: typeof row.name === "string" && row.name.trim() ? row.name : "Unnamed contact",
        pipelineStage: String(row.pipeline_stage),
        lastSeenAt: String(row.last_seen_at ?? row.created_at),
        isDemo: tenant?.is_demo === true,
        isTest: row.is_test === true,
      };
    });

    return { ok: true, value: { contacts, suppressions, tombstones } };
  } catch {
    return {
      ok: false,
      code: "COMPLIANCE_READ_FAILED",
      reason: "Compliance records could not load.",
    };
  }
}

export default async function AdminCompliancePage() {
  if (!phase1Live() || !phase3Live()) {
    return (
      <ComplianceShell>
        <ComplianceHeader />
        <DataState
          body="Compliance records will appear here when this workspace enables the compliance registry."
          kind="empty"
          title="Compliance is not enabled"
        />
      </ComplianceShell>
    );
  }

  const context = await liveAdminContext();
  const complianceResult = await loadComplianceResult(context);
  if (!complianceResult.ok) {
    return (
      <ComplianceShell>
        <ComplianceHeader />
        <DataState
          body={complianceResult.reason}
          kind="unavailable"
          title="Compliance records could not load"
        />
        <details className="t-faint mt-[var(--s-2)] max-w-[var(--measure-prose)]">
          <summary className="w-fit cursor-pointer select-none">Technical detail</summary>
          <code className="t-id mt-[var(--s-1)] block break-all">{complianceResult.code}</code>
        </details>
      </ComplianceShell>
    );
  }
  const { contacts, suppressions, tombstones } = complianceResult.value;

  return (
    <ComplianceShell
      failedConfirmations={suppressions.filter((row) => row.providerSyncState === "failed").length}
    >
      {uiRehaulLive() ? (
        <OwnerCompliance
          actions={{ preview: previewAdminDeletion, remove: executeAdminDeletion }}
          impersonation={context.impersonation}
          initialContacts={contacts}
          suppressions={suppressions}
          tombstones={tombstones}
        />
      ) : (
        <AdminCompliance
          actions={{ preview: previewAdminDeletion, remove: executeAdminDeletion }}
          impersonation={context.impersonation}
          initialContacts={contacts}
          suppressions={suppressions}
          tombstones={tombstones}
        />
      )}
    </ComplianceShell>
  );
}
