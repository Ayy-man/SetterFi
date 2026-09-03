import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { AdminSystemHealth } from "@/components/workspace/live/admin-system-health";
import {
  OwnerSystem,
  type SystemPlatformSnapshot,
} from "@/components/workspace/rehaul/owner-system";
import { phase7AnalyticsLive, phase8Live } from "@/lib/env-contract";
import { loadSystemHealth } from "@/lib/operations/system-health";
import { loadSupportSession } from "@/lib/support/service";
import { withWorkspaceNavCounts, workspaceNavigationFor } from "@/lib/workspace-navigation";

export const metadata: Metadata = { title: "System" };
export const dynamic = "force-dynamic";

// System sits in the rail's Platform group, which is what the artboard's crumb reads. "Platform"
// is a group and not a page, so it names itself without linking anywhere.
const CRUMBS = [{ label: "Platform" }, { label: "System" }] as const;

/**
 * The delivery days and the per-client texting-registration state, or nothing.
 *
 * A measurement outage is not a System outage: the jobs, the queue and the integration modes are a
 * different read, and they are the reason an operator opens this page during one. So the snapshot
 * read is caught here and the screen draws without its two snapshot-fed pieces rather than
 * replacing the whole page with a measurement error.
 */
async function readPlatformSnapshot(actorId: string): Promise<SystemPlatformSnapshot | null> {
  if (!phase7AnalyticsLive()) return null;
  try {
    const { loadPlatformMeasurement } = await import("@/lib/repositories/platform-analytics");
    return await loadPlatformMeasurement(actorId, new Date().toISOString());
  } catch {
    return null;
  }
}

export default async function AdminSystemPage() {
  if (!phase8Live()) {
    return <AdminSystemHealth enabled={false} />;
  }
  const session = await loadSupportSession();
  if (!session) redirect("/login?next=%2Fadmin%2Fsystem");
  if (session.impersonatingTenant || !["owner", "admin", "success"].includes(session.role)) forbidden();
  const health = await loadSystemHealth();
  const platform = await readPlatformSnapshot(session.userId);
  /*
   * The body is the page, not the shell, so the route owns the shell the folded surface used to
   * own -- including the rail count, which stays the failed-attempt figure an operator would come
   * here to chase rather than the queue depth, most of which is healthy traffic.
   */
  return (
    <AppShell
      activePath="/admin/system"
      crumbs={CRUMBS}
      nav={withWorkspaceNavCounts(workspaceNavigationFor("admin"), {
        "/admin/system": health.queue.failedAttempts ?? 0,
      })}
      role="admin"
    >
      <OwnerSystem health={health} nowIso={new Date().toISOString()} platform={platform} />
    </AppShell>
  );
}
