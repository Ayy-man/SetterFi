import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { phase7AnalyticsLive, uiRehaulLive } from "@/lib/env-contract";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Overview" }] as const;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function OverviewShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      activePath="/admin/overview"
      crumbs={CRUMBS}
      role="admin"
    >
      {children}
    </AppShell>
  );
}

export default async function AdminOverviewPage({ searchParams }: PageProps) {
  if (!phase7AnalyticsLive()) {
    return (
      <OverviewShell>
        <DataState
          body="Turn on platform analytics to read the operating figures and exception queue."
          kind="empty"
          title="Measurement is not enabled"
        />
      </OverviewShell>
    );
  }

  const { loadPlatformActor } = await import("@/lib/auth/actors");
  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Foverview");
  if (actor.role !== "owner" && actor.role !== "admin" && actor.role !== "success") forbidden();
  // The rehaul draw is the same data through a different body: one loader, one projection, and the
  // old surface left untouched behind the flag.
  const rehaul = uiRehaulLive();
  const [surface, measurementResult, params] = await Promise.all([
    rehaul
      ? import("@/components/workspace/rehaul/owner-overview")
      : import("@/components/workspace/live/admin-overview"),
    readPlatformMeasurementResult(actor.userId),
    searchParams,
  ]);
  if (!measurementResult.ok) {
    return (
      <OverviewShell>
        <DataState
          body={measurementResult.reason}
          kind="unavailable"
          title="Overview could not load"
        />
        <details className="mt-[var(--s-2)] max-w-[var(--measure-prose)] text-body text-[var(--muted)]">
          <summary className="w-fit cursor-pointer font-medium text-[var(--accent-text)]">
            Technical detail
          </summary>
          <code className="mt-[var(--s-1)] block break-all text-body text-[var(--faint)]">
            {measurementResult.code}
          </code>
        </details>
      </OverviewShell>
    );
  }
  if (rehaul && "OwnerOverview" in surface) {
    return (
      <OverviewShell>
        <surface.OwnerOverview
          historyWindow={firstParam(params.window)}
          measurement={measurementResult.value}
          role={actor.role}
        />
      </OverviewShell>
    );
  }
  if (!("AdminOverviewSurface" in surface)) return null;
  return (
    <OverviewShell>
      <surface.AdminOverviewSurface measurement={measurementResult.value} role={actor.role} />
    </OverviewShell>
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
