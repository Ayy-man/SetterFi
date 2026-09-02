import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { phase7AnalyticsLive } from "@/lib/env-contract";
import { impersonatedReadContext, type ImpersonationSession } from "@/lib/impersonation";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Coach dashboard" };
export const dynamic = "force-dynamic";

const COACH_CRUMBS = [
  { label: "Coach", href: "/coach/home" },
  { label: "Dashboard" },
] as const;

async function assertCoachContext() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fcoach");
  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "coach")) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  const tenantId = claims.impersonatingTenant ?? claims.tenantId;
  if (!tenantId) redirect("/admin/platform-clients");
  if (!claims.impersonatingTenant) return;
  if (!claims.impersonationSessionId) redirect("/admin/platform-clients");
  const service = createSupabaseServiceClient();
  const { data: row, error: sessionError } = await service.from("impersonation_sessions")
    .select("id, actor_id, tenant_id, reason, started_at, ended_at, expires_at")
    .eq("id", claims.impersonationSessionId)
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
  impersonatedReadContext(data.claims, session);
}

export default async function CoachPage() {
  if (!phase7AnalyticsLive()) {
    return (
      <AppShell activePath="/coach/home" crumbs={COACH_CRUMBS} role="coach">
        <DataState
          body="Measurement is not enabled for this workspace."
          kind="unavailable"
          title="Measurement is not enabled"
        />
      </AppShell>
    );
  }
  await assertCoachContext();
  redirect("/coach/home");
}
