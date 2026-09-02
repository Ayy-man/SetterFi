import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { CoachSupport } from "@/components/workspace/live/coach-support";
import { phase8SupportLive } from "@/lib/env-contract";
import { loadSupportSession } from "@/lib/support/service";

export const metadata: Metadata = { title: "Help and support" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Coach" }, { label: "Help" }] as const;

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
