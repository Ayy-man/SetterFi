import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { GET as loadProvisioning } from "@/app/api/admin/provisioning/route";
import { adminMeasurementView } from "@/components/workspace/live/admin-measurement-view-models";
import {
  OwnerClients,
  type OwnerClientsFold,
  type OwnerClientsHealth,
  type OwnerClientsPerformance,
  type OwnerClientsTab,
} from "@/components/workspace/rehaul/owner-clients";
import { phase5Live, phase7AnalyticsLive, phase8SupportLive } from "@/lib/env-contract";
import type { ProvisioningTrackerRow } from "@/lib/onboarding/contracts";
import { loadAgentRoster, type AgentRoster } from "@/lib/operations/agent-roster";
import { loadCoachA2pRegistration } from "@/lib/repositories/onboarding-evidence";
import type { SuccessClientBookRead, SupportBook } from "@/lib/repositories/support";
import { createSupportRepository } from "@/lib/repositories/support";
import { createSupportService, loadSupportSession, type SupportSession } from "@/lib/support/service";

import { ClientsSetupSection } from "./install-section";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TABS = ["status", "agent", "performance", "health", "team", "setup"] as const;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function tabOf(value: string | undefined): OwnerClientsTab {
  return TABS.includes(value as OwnerClientsTab) ? (value as OwnerClientsTab) : "status";
}

/**
 * The agent roster behind the Agent tab.
 *
 * `/admin/agents` gates this on owner, admin or success, which is the same set the client book
 * already admitted above, so the page's own guard is the whole gate here too. A read that does not
 * complete says so rather than folding into an empty roster: no rows and no answer are different
 * claims, and only one of them means "chase this client".
 */
async function agentFold(): Promise<OwnerClientsFold<AgentRoster>> {
  try {
    return { kind: "ready", value: await loadAgentRoster() };
  } catch {
    return {
      kind: "refused",
      reason:
        "The offer store did not answer, so which client is on which version could not be read.",
    };
  }
}

/**
 * The measurement snapshot behind the Performance tab.
 *
 * It carries its own flag and its own actor, both of which are narrower than the client book's, so
 * the refusal is kept rather than folded away. A success reviewer is admitted and the projection
 * drops the economics columns for them, exactly as `/admin/agent-performance` does.
 */
async function performanceFold(): Promise<OwnerClientsFold<OwnerClientsPerformance>> {
  if (!phase7AnalyticsLive()) {
    return { kind: "refused", reason: "Platform analytics is not turned on in this environment." };
  }
  const { loadPlatformActor } = await import("@/lib/auth/actors");
  const actor = await loadPlatformActor();
  if (!actor || !["owner", "admin", "success"].includes(actor.role)) {
    return { kind: "refused", reason: "Measurement is read under a platform role this session does not carry." };
  }
  try {
    const { loadPlatformMeasurement } = await import("@/lib/repositories/platform-analytics");
    const measurement = await loadPlatformMeasurement(actor.userId, new Date().toISOString());
    const view = adminMeasurementView(measurement, actor.role);
    return {
      kind: "ready",
      value: {
        origin: measurement.origin,
        role: view.role,
        tenantPerformance: view.tenantPerformance,
        history: view.history,
      },
    };
  } catch {
    return { kind: "refused", reason: "The measurement snapshot did not answer." };
  }
}

/**
 * The provisioning tracker behind the Health tab and the drawer's stepper.
 *
 * `/admin/provisioning` answers 403 to a reader the tracker will not serve, and that refusal is
 * carried through rather than turned into an empty stage list -- a client with no tracker row and a
 * client nobody is allowed to read are not the same client.
 */
async function healthFold(): Promise<OwnerClientsFold<OwnerClientsHealth>> {
  if (!phase5Live()) {
    return { kind: "refused", reason: "Provisioning is not turned on in this environment." };
  }
  const response = await loadProvisioning();
  if (response.status === 401) redirect("/login?next=%2Fadmin%2Fplatform-clients");
  if (response.status === 403) {
    return { kind: "refused", reason: "The provisioning tracker is refused to this session." };
  }
  const payload = (await response.json()) as { rows?: ProvisioningTrackerRow[] };
  if (!response.ok || !Array.isArray(payload.rows)) {
    return { kind: "refused", reason: "The provisioning tracker did not answer." };
  }
  const rows = payload.rows;
  // The same receipt `/admin/provisioning` counts the carrier wait from, read only for the tenants
  // actually waiting on a carrier. A failed read stays null so the row says the receipt is missing
  // rather than inventing a start date.
  const waiting = [...new Set(rows.flatMap((row) => (
    row.tenantId && row.blockingProvider === "carrier" ? [row.tenantId] : []
  )))];
  const entries = await Promise.all(waiting.map(async (tenantId) => {
    try {
      const registration = await loadCoachA2pRegistration(tenantId);
      return [tenantId, registration?.submittedAt ?? null] as const;
    } catch {
      return [tenantId, null] as const;
    }
  }));
  return {
    kind: "ready",
    value: { rows, a2pSubmittedAtByTenant: Object.fromEntries(entries) },
  };
}

async function clientBook(session: SupportSession, book: SupportBook) {
  const service = createSupportService(createSupportRepository());
  try {
    return { rows: await service.listClientBook(session, book), error: null };
  } catch {
    return { rows: [] as SuccessClientBookRead[], error: "The client book could not be read." };
  }
}

export default async function PlatformClientsPage({ searchParams }: PageProps) {
  if (!phase8SupportLive()) {
    return (
      <OwnerClients
        actorRole="admin"
        agents={{ kind: "refused", reason: "Client-book reads are not enabled in this environment." }}
        book="all"
        enabled={false}
        health={{ kind: "refused", reason: "Client-book reads are not enabled in this environment." }}
        nowIso={new Date().toISOString()}
        performance={{ kind: "refused", reason: "Client-book reads are not enabled in this environment." }}
        rows={[]}
        rowsError={null}
        selectedClientId={null}
        selectedOwnerId={null}
        tab="status"
      />
    );
  }

  const session = await loadSupportSession();
  if (!session) redirect("/login?next=%2Fadmin%2Fplatform-clients");
  if (session.impersonatingTenant
    || (session.role !== "owner" && session.role !== "admin" && session.role !== "success")) forbidden();

  const params = await searchParams;
  const tab = tabOf(first(params.tab));
  const book: SupportBook = first(params.book) === "mine" ? "mine" : "all";
  const [{ rows, error }, agents, performance, health] = await Promise.all([
    clientBook(session, book),
    agentFold(),
    performanceFold(),
    healthFold(),
  ]);

  return (
    <OwnerClients
      actorId={session.userId}
      actorRole={session.role}
      agents={agents}
      book={book}
      enabled
      health={health}
      nowIso={new Date().toISOString()}
      performance={performance}
      rows={rows}
      rowsError={error}
      selectedClientId={first(params.client)?.trim() || null}
      selectedOwnerId={first(params.owner)?.trim() || null}
      setup={tab === "setup" ? <ClientsSetupSection searchParams={params} /> : null}
      tab={tab}
    />
  );
}
