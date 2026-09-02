import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import {
  AdminAgentsSurface,
  AdminAgentsUnavailable,
} from "@/components/workspace/live/admin-agents";
import { loadAgentRoster, type AgentRoster } from "@/lib/operations/agent-roster";

export const metadata: Metadata = { title: "Agents" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Clients" }, { label: "Agents" }] as const;

function AgentsShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell activePath="/admin/agents" crumbs={CRUMBS} role="admin">
      {children}
    </AppShell>
  );
}

export default async function AdminAgentsPage() {
  const { loadAlertActor } = await import("@/lib/auth/actors");
  const actor = await loadAlertActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Fagents");
  /*
   * The roster is a cross-tenant read, so it stays on the platform side of the wall. A success
   * reviewer sees it because their whole job is chasing which client is unpublished; a coach never
   * reaches this route at all.
   */
  if (actor.role !== "owner" && actor.role !== "admin" && actor.role !== "success") forbidden();

  const result = await readRoster();
  if (!result.ok) {
    return (
      <AgentsShell>
        <AdminAgentsUnavailable reason={result.reason} />
      </AgentsShell>
    );
  }

  return (
    <AgentsShell>
      <AdminAgentsSurface roster={result.value} />
    </AgentsShell>
  );
}

type RosterResult =
  | { ok: true; value: AgentRoster }
  | { ok: false; reason: string };

async function readRoster(): Promise<RosterResult> {
  try {
    return { ok: true, value: await loadAgentRoster() };
  } catch {
    return {
      ok: false,
      reason:
        "The offer store did not answer, so which client is on which version could not be read."
        + " Nothing is being hidden and nothing has changed — the roster simply could not be built.",
    };
  }
}
