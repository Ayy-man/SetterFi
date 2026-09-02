import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { loadRouteActor } from "@/lib/auth/actors";
import { CoachBilling } from "@/components/workspace/live/coach-billing";
import { coachNavCounts } from "@/lib/coach-nav-counts";
import type { WorkspaceNavCounts } from "@/lib/workspace-navigation";
import { phase6Live } from "@/lib/env-contract";

export const metadata: Metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Coach" }, { label: "Billing" }] as const;

function CoachBillingShell({
  children,
  navCounts,
}: {
  children: ReactNode;
  navCounts?: WorkspaceNavCounts;
}) {
  return (
    <AppShell
      activePath="/coach/billing"
      crumbs={CRUMBS}
      navCounts={navCounts}
      role="coach"
    >
      {children}
    </AppShell>
  );
}

export default async function CoachBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!phase6Live()) {
    return <CoachBillingShell><CoachBilling enabled={false} /></CoachBillingShell>;
  }
  const actor = await loadRouteActor();
  if (!actor) redirect("/login?next=%2Fcoach%2Fbilling");
  if (actor.role !== "coach" && actor.role !== "coach_member") forbidden();
  const checkout = (await searchParams).checkout;
  const checkoutReturn = checkout === "returned" || checkout === "canceled" ? checkout : null;
  return (
    <CoachBillingShell navCounts={await coachNavCounts(actor.tenantId)}>
      <CoachBilling checkoutReturn={checkoutReturn} enabled />
    </CoachBillingShell>
  );
}
