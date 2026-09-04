import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { CoachSupport } from "@/components/workspace/live/coach-support";
import { phase8SupportLive } from "@/lib/env-contract";
import { loadSupportSession } from "@/lib/support/service";

export const metadata: Metadata = { title: "Guides" };
export const dynamic = "force-dynamic";

/*
 * The route keeps its path and loses its name. `/coach/help` is what the support bubble's "Read
 * the guides" points at and what `workspace-navigation.test.ts` checks stays reachable, so moving
 * it would break both for a cosmetic gain; what the page holds is the guides and the record of
 * what the coach has asked, which is what the crumb says.
 */
const CRUMBS = [{ label: "Coach" }, { label: "Guides" }] as const;

function CoachHelpShell({ enabled }: { enabled: boolean }) {
  return (
    <AppShell
      activePath="/coach/help"
      crumbs={CRUMBS}
      role="coach"
    >
      <CoachSupport enabled={enabled} />
    </AppShell>
  );
}

export default async function CoachHelpPage() {
  if (!phase8SupportLive()) {
    return <CoachHelpShell enabled={false} />;
  }
  const session = await loadSupportSession();
  if (!session) redirect("/login?next=%2Fcoach%2Fhelp");
  if (session.impersonatingTenant || !session.tenantId
    || (session.role !== "coach" && session.role !== "coach_member")) forbidden();
  return <CoachHelpShell enabled />;
}
