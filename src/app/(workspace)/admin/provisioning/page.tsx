import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { GET as loadProvisioning } from "@/app/api/admin/provisioning/route";
import { loadPlatformActor } from "@/lib/auth/actors";
import { AdminProvisioning } from "@/components/onboarding/admin-provisioning";
import { InstallAttempts } from "@/components/onboarding/install-attempts";
import {
  INSTALL_EVENT_ACTIONS,
  installAttemptsAccess,
  type InstallAttemptsAccess,
  type InstallEventRow,
} from "@/components/onboarding/install-attempts-view-models";
import { MessagingInstallPanel } from "@/components/onboarding/messaging-install-panel";
import {
  AGENCY_INSTALL_UNCHECKED,
  agencyGrantFacts,
  agencyInstallReadLabel,
  agencyInstallStateLabel,
  messagingInstallOutcome,
  type AgencyGrantSummary,
  type MessagingInstallOutcome,
} from "@/components/onboarding/messaging-install-view-models";
import { phase5Live, phase9GhlOAuthLive } from "@/lib/env-contract";
import { createGhlAgencyInstallCustody } from "@/lib/integrations/ghl-oauth-store";
import type { ProvisioningTrackerRow } from "@/lib/onboarding/contracts";
import { loadCoachA2pRegistration } from "@/lib/repositories/onboarding-evidence";
import {
  listGhlInstallsByTenant,
  type GhlInstallTenantGroup,
} from "@/lib/repositories/ghl-installs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Provisioning" };
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Only these scalars may travel into a client component: `load()` hands back credential envelopes,
 * and a lookup failure remains visibly unchecked rather than becoming a false `Not connected`
 * claim.
 *
 * The consent flags and the two stamps join them because they are the facts about an install
 * nobody could read off the state alone. `installToFutureLocations` says whether sub-accounts
 * created later inherit the app; `createdAt` and `updatedAt` are what separate a grant stored
 * yesterday from one stored in August that nothing has touched since. All of it is admin-only,
 * like everything else on this page.
 */
type AgencyInstallRow = {
  installState: string;
  reauthorizationRequiredAt: string | null;
  installToFutureLocations: boolean | null;
  createdAt: string;
  updatedAt: string;
  approveAllLocations: boolean | null;
  isBulkInstallation: boolean | null;
};

/**
 * A failed custody read is never presented as an empty custody row -- and now a failed receipt
 * read is not presented as a grant with nothing to say about itself either.
 *
 * The receipt columns are read here rather than through custody because custody's select is the
 * credential path and stays that: it carries the envelopes, and widening it would put four more
 * columns on every refresh. The second read is keyed on the id the first one returned, so the two
 * describe the same row by construction rather than by both happening to match the same predicate.
 */
async function agencyInstallState(app: "agent" | "provisioning"): Promise<{ checked: boolean; row: AgencyInstallRow | null }> {
  if (!phase9GhlOAuthLive()) return { checked: false, row: null };
  try {
    const service = createSupabaseServiceClient();
    const row = await createGhlAgencyInstallCustody(null, service, app).load();
    if (!row) return { checked: true, row: null };
    const receipt = await service
      .from("ghl_agency_installs")
      .select("created_at,updated_at,approve_all_locations,is_bulk_installation")
      .eq("id", row.id)
      .maybeSingle();
    // PostgREST resolves rather than throws, so the error is checked rather than caught: a
    // half-read row would otherwise reach the panel as a grant with no install date, which reads
    // as an install that never happened.
    if (receipt.error || !receipt.data) throw new Error("agency install receipt read failed");
    return {
      checked: true,
      row: {
        installState: row.installState,
        reauthorizationRequiredAt: row.reauthorizationRequiredAt,
        installToFutureLocations: row.installToFutureLocations ?? null,
        createdAt: String(receipt.data.created_at),
        updatedAt: String(receipt.data.updated_at),
        approveAllLocations: receipt.data.approve_all_locations ?? null,
        isBulkInstallation: receipt.data.is_bulk_installation ?? null,
      },
    };
  } catch {
    return { checked: false, row: null };
  }
}

/** A read that did not complete has no grant to describe, which is not the same as no grant. */
function grantSummary(state: { checked: boolean; row: AgencyInstallRow | null }): AgencyGrantSummary | null {
  if (!state.checked) return null;
  return { stored: state.row !== null, facts: agencyGrantFacts(state.row) };
}

/**
 * A read that fails is reported as a failed read. An empty list would be the claim that no install
 * was ever attempted, which is a different fact from not being able to check.
 */
async function installEventRows(): Promise<{
  rows: InstallEventRow[];
  unavailable: boolean;
  hasDemoRows: boolean;
}> {
  if (!phase9GhlOAuthLive()) return { rows: [], unavailable: false, hasDemoRows: false };
  try {
    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("audit_log")
      .select("id,action,actor_id,tenant_id,reason,payload,created_at")
      .in("action", [...INSTALL_EVENT_ACTIONS])
      .order("created_at", { ascending: false })
      .limit(60);
    if (error || !data) return { rows: [], unavailable: true, hasDemoRows: false };
    const rows = data.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      actorId: row.actor_id ?? null,
      tenantId: row.tenant_id ?? null,
      reason: row.reason ?? null,
      payload: row.payload,
      createdAt: String(row.created_at),
    }));
    const tenantIds = [...new Set(rows.flatMap((row) => row.tenantId ? [row.tenantId] : []))];
    if (tenantIds.length === 0) {
      return { rows, unavailable: false, hasDemoRows: false };
    }
    const classifications = await service
      .from("tenants")
      .select("id,is_demo")
      .in("id", tenantIds);
    if (classifications.error || !classifications.data) {
      return { rows: [], unavailable: true, hasDemoRows: false };
    }
    const demoByTenant = new Map(classifications.data.map((row) => [String(row.id), Boolean(row.is_demo)]));
    if (tenantIds.some((tenantId) => !demoByTenant.has(tenantId))) {
      return { rows: [], unavailable: true, hasDemoRows: false };
    }
    return {
      unavailable: false,
      hasDemoRows: rows.some((row) => row.tenantId ? demoByTenant.get(row.tenantId) === true : false),
      rows,
    };
  } catch {
    return { rows: [], unavailable: true, hasDemoRows: false };
  }
}

async function a2pSubmissionTimes(rows: readonly ProvisioningTrackerRow[]) {
  const tenantIds = [...new Set(rows.flatMap((row) => (
    row.tenantId
    && row.blockingProvider === "carrier"
    && ["a2p_brand", "a2p_campaign", "sms_live"].includes(row.currentStep ?? "")
      ? [row.tenantId]
      : []
  )))];
  const entries = await Promise.all(tenantIds.map(async (tenantId) => {
    try {
      const registration = await loadCoachA2pRegistration(tenantId);
      return [tenantId, registration?.submittedAt ?? null] as const;
    } catch {
      return [tenantId, null] as const;
    }
  }));
  return Object.fromEntries(entries) as Readonly<Record<string, string | null>>;
}

/**
 * Same rule as `installEventRows`: a read that fails reports itself. Zero connected clients and a
 * read that could not run are different claims, and only one of them is ever true here.
 */
async function connectedClientGroups(): Promise<{ groups: GhlInstallTenantGroup[]; unavailable: boolean }> {
  if (!phase9GhlOAuthLive()) return { groups: [], unavailable: false };
  try {
    return { groups: await listGhlInstallsByTenant(), unavailable: false };
  } catch {
    return { groups: [], unavailable: true };
  }
}

type InstallSection = {
  access: InstallAttemptsAccess;
  rows: InstallEventRow[];
  unavailable: boolean;
  messagingAgencyState: ReturnType<typeof agencyInstallStateLabel>;
  messagingGrant: AgencyGrantSummary | null;
  provisioningAgencyState: ReturnType<typeof agencyInstallStateLabel>;
  provisioningGrant: AgencyGrantSummary | null;
  outcome: MessagingInstallOutcome | null;
  connectedClients: { real: number; demo: number };
  installsChecked: boolean;
  hasDemoAttempts: boolean;
};

/**
 * Both reads above run with the service role, so nothing underneath them will refuse a viewer this
 * page lets through. The guard is therefore the whole gate, and the reads live *inside* its branch
 * rather than after it: an edit that moves a line cannot quietly restore the read-then-authorize
 * order that made sixty audit rows from every tenant readable by anyone the proxy admitted.
 */
async function installSection(input: {
  installEnabled: boolean;
  trackerRefused: boolean;
  params: Record<string, string | string[] | undefined>;
}): Promise<InstallSection> {
  const actorRole = input.installEnabled ? (await loadPlatformActor())?.role ?? null : null;
  const access = installAttemptsAccess({
    installEnabled: input.installEnabled,
    actorRole,
    trackerRefused: input.trackerRefused,
  });

  if (access !== "allowed") {
    return {
      access,
      rows: [],
      unavailable: false,
      messagingAgencyState: AGENCY_INSTALL_UNCHECKED,
      messagingGrant: null,
      provisioningAgencyState: AGENCY_INSTALL_UNCHECKED,
      provisioningGrant: null,
      // The callback banner is deliberately weaker than the current state cards, which no
      // refused viewer may read.
      outcome: messagingInstallOutcome(input.params),
      connectedClients: { real: 0, demo: 0 },
      installsChecked: false,
      hasDemoAttempts: false,
    };
  }

  const [messagingAgency, provisioningAgency] = await Promise.all([
    agencyInstallState("agent"),
    agencyInstallState("provisioning"),
  ]);
  const messagingAgencyState = agencyInstallReadLabel(messagingAgency);
  const provisioningAgencyState = agencyInstallReadLabel(provisioningAgency);
  const attempts = await installEventRows();
  // Inside the gate for the same reason the other two reads are: the service role will not refuse
  // anyone this page admits, so the guard above is the whole gate and nothing may run before it.
  const installs = await connectedClientGroups();
  return {
    access,
    rows: attempts.rows,
    unavailable: attempts.unavailable,
    messagingAgencyState,
    messagingGrant: grantSummary(messagingAgency),
    provisioningAgencyState,
    provisioningGrant: grantSummary(provisioningAgency),
    connectedClients: {
      real: installs.groups.filter((group) => group.connected && !group.isDemo).length,
      demo: installs.groups.filter((group) => group.connected && group.isDemo).length,
    },
    installsChecked: !installs.unavailable,
    hasDemoAttempts: attempts.hasDemoRows,
    outcome: messagingInstallOutcome(input.params),
  };
}

export default async function AdminProvisioningPage({ searchParams }: PageProps) {
  const nowIso = new Date().toISOString();
  const params = await searchParams;
  // The marketplace install is switched independently of self-serve onboarding, so the panel is
  // gated on its own flag and renders its own disabled state rather than disappearing.
  const installEnabled = phase9GhlOAuthLive();

  if (!phase5Live()) {
    const section = await installSection({ installEnabled, trackerRefused: false, params });
    return (
      <AdminProvisioning
        enabled={false}
        hasDemoData={section.connectedClients.demo > 0 || section.hasDemoAttempts}
        installAttention={section.outcome !== null}
        nowIso={nowIso}
      >
        <MessagingInstallPanel
          messagingAgencyState={section.messagingAgencyState}
          messagingGrant={section.messagingGrant}
          provisioningAgencyState={section.provisioningAgencyState}
          provisioningGrant={section.provisioningGrant}
          connectedClients={section.connectedClients}
          enabled={installEnabled}
          installsChecked={section.installsChecked}
          outcome={section.outcome}
        />
        {section.access === "off" ? null : (
          <InstallAttempts
            refused={section.access === "refused"}
            rows={section.rows}
            unavailable={section.unavailable}
          />
        )}
      </AdminProvisioning>
    );
  }

  const response = await loadProvisioning();
  if (response.status === 401) redirect("/login?next=%2Fadmin%2Fprovisioning");
  const payload = await response.json() as { rows?: ProvisioningTrackerRow[]; error?: unknown };
  const authorized = response.status !== 403;
  const rows = response.ok && Array.isArray(payload.rows) ? payload.rows : [];
  const error = response.ok
    ? null
    : typeof payload.error === "string"
      ? payload.error
      : "Provisioning tracker is unavailable.";
  // A 403 from the tracker and the attempts section must never disagree about the same viewer.
  const section = await installSection({ installEnabled, trackerRefused: !authorized, params });
  const submittedAtByTenant = authorized ? await a2pSubmissionTimes(rows) : {};

  return (
    <AdminProvisioning
      a2pSubmittedAtByTenant={submittedAtByTenant}
      authorized={authorized}
      hasDemoData={section.connectedClients.demo > 0 || section.hasDemoAttempts || rows.some((row) => row.isDemo === true)}
      initialError={error}
      initialRows={rows}
      installAttention={section.outcome !== null}
      nowIso={nowIso}
    >
      <MessagingInstallPanel
        messagingAgencyState={section.messagingAgencyState}
        messagingGrant={section.messagingGrant}
        provisioningAgencyState={section.provisioningAgencyState}
        provisioningGrant={section.provisioningGrant}
        connectedClients={section.connectedClients}
        enabled={installEnabled}
        installsChecked={section.installsChecked}
        outcome={section.outcome}
      />
      {section.access === "off" ? null : (
        <InstallAttempts
          refused={section.access === "refused"}
          rows={section.rows}
          unavailable={section.unavailable}
        />
      )}
    </AdminProvisioning>
  );
}
