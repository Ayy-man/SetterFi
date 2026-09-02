import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { ListPage } from "@/components/kit/templates/list-page";
import { phase7AnalyticsLive } from "@/lib/env-contract";

export const metadata: Metadata = { title: "Agent performance" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Clients" }, { label: "Agent performance" }] as const;

function AgentPerformanceShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      activePath="/admin/agent-performance"
      crumbs={CRUMBS}
      role="admin"
    >
      {children}
    </AppShell>
  );
}

export default async function AdminAgentPerformancePage() {
  if (!phase7AnalyticsLive()) {
    return (
      <AgentPerformanceShell>
        {/*
          * The page keeps its own title and its own sentence even with the flag off, so a reader
          * who lands here knows which surface refused rather than reading an unattributed panel.
          */}
        <ListPage
          description="Client results are ordered from recorded cross-tenant measurement evidence."
          title="Agent performance"
        >
          <DataState
            body="Turn on platform analytics to compare client performance."
            kind="empty"
            title="Measurement is not enabled"
          />
        </ListPage>
      </AgentPerformanceShell>
    );
  }

  const { loadPlatformActor } = await import("@/lib/auth/actors");
  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Fagent-performance");
  if (actor.role !== "owner" && actor.role !== "admin" && actor.role !== "success") forbidden();
  const [
    { AdminAgentPerformanceSurface },
    { loadPlatformMeasurement },
    { adminMeasurementView },
    { loadClientNames },
  ] = await Promise.all([
    import("@/components/workspace/live/admin-agent-performance"),
    import("@/lib/repositories/platform-analytics"),
    import("@/components/workspace/live/admin-measurement-view-models"),
    import("@/lib/repositories/client-names"),
  ]);
  const measurement = await loadPlatformMeasurement(actor.userId, new Date().toISOString());
  // The snapshot carries tenant ids only, so the names are resolved here rather than invented in
  // the client component as "Client 1 / 2 / 3".
  const clientNames = await loadClientNames(
    measurement.tenantPerformance.map((row) => row.tenantId),
  );
  // Project before the boundary: the unprojected snapshot never reaches a browser.
  return (
    <AgentPerformanceShell>
      <AdminAgentPerformanceSurface
        clientNames={clientNames}
        origin={measurement.origin}
        view={adminMeasurementView(measurement, actor.role)}
      />
    </AgentPerformanceShell>
  );
}
