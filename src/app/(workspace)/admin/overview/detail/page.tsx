import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { phase7AnalyticsLive } from "@/lib/env-contract";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";

export const metadata: Metadata = { title: "Platform detail" };
export const dynamic = "force-dynamic";

// Overview sits outside every nav group, so its own page shows a single crumb and this sub-page
// hangs straight off it. A "Platform" group crumb here would name a group Overview is not in.
const CRUMBS = [
  { label: "Overview", href: "/admin/overview" },
  { label: "Platform detail" },
] as const;

function DetailShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell activePath="/admin/overview" crumbs={CRUMBS} role="admin">
      {children}
    </AppShell>
  );
}

export default async function AdminPlatformDetailPage() {
  if (!phase7AnalyticsLive()) {
    return (
      <DetailShell>
        <DataState
          body="Turn on platform analytics to read the operating figures and evidence tables."
          kind="empty"
          title="Measurement is not enabled"
        />
      </DetailShell>
    );
  }

  const { loadPlatformActor } = await import("@/lib/auth/actors");
  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Foverview%2Fdetail");
  if (actor.role !== "owner" && actor.role !== "admin" && actor.role !== "success") forbidden();

  const [{ AdminPlatformDetailSurface }, measurementResult] = await Promise.all([
    import("@/components/workspace/live/admin-overview"),
    readPlatformMeasurementResult(actor.userId),
  ]);

  if (!measurementResult.ok) {
    return (
      <DetailShell>
        <DataState
          body={measurementResult.reason}
          kind="unavailable"
          title="Platform detail could not load"
        />
      </DetailShell>
    );
  }

  const { loadClientNames } = await import("@/lib/repositories/client-names");
  const clientNames = await loadClientNames(
    measurementResult.value.subscriptions.map((row) => row.tenantId),
  );

  return (
    <DetailShell>
      <AdminPlatformDetailSurface
        clientNames={clientNames}
        measurement={measurementResult.value}
        role={actor.role}
      />
    </DetailShell>
  );
}

type PlatformMeasurementResult =
  | { ok: true; value: PlatformMeasurement }
  | { ok: false; code: "PLATFORM_PREVIEW_READ_FAILED"; reason: string };

async function readPlatformMeasurementResult(
  actorId: string,
): Promise<PlatformMeasurementResult> {
  try {
    const { loadPlatformMeasurement } = await import("@/lib/repositories/platform-analytics");
    return {
      ok: true,
      value: await loadPlatformMeasurement(actorId, new Date().toISOString()),
    };
  } catch {
    return {
      ok: false,
      code: "PLATFORM_PREVIEW_READ_FAILED",
      reason: "Platform measurement could not load.",
    };
  }
}
