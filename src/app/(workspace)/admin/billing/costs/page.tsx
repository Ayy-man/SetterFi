import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { AdminMoneyBillingCosts } from "@/components/workspace/live/admin-money-billing-costs";
import { moneyPageAccessStatus } from "@/components/workspace/live/view-models";
import { foldedRouteRedirect, foldedRouteSearchParams, type PageSearchParams } from "@/lib/admin-route-fold";
import { loadPlatformActor } from "@/lib/auth/actors";
import { navFoldLive, phase6Live } from "@/lib/env-contract";
import { logMoneyPageRefusal } from "@/lib/repositories/money-page-audit";

export const metadata: Metadata = { title: "Cost evidence" };
export const dynamic = "force-dynamic";

const crumbs = [
  { label: "Money", href: "/admin/billing" },
  { label: "Revenue and subscriptions", href: "/admin/billing" },
  { label: "Cost evidence" },
] as const;

type PageProps = { searchParams: Promise<PageSearchParams> };

function CostShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell activePath="/admin/billing" crumbs={crumbs} role="admin">
      {children}
    </AppShell>
  );
}

export default async function AdminBillingCostsPage({ searchParams }: PageProps) {
  if (navFoldLive()) redirect(foldedRouteRedirect("/admin/billing/costs", foldedRouteSearchParams(await searchParams))!);
  if (!phase6Live()) {
    return (
      <CostShell>
        <AdminMoneyBillingCosts actorRole="admin" authorized enabled={false} />
      </CostShell>
    );
  }

  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Fbilling%2Fcosts");

  const authorized = moneyPageAccessStatus(actor.role, "billing") === 200;
  if (!authorized) {
    const refusalRecord = await logMoneyPageRefusal(actor.userId, "billing");
  /*
   * One refusal for the Money group, drawn inside the console rather than four different ones.
   *
   * A success reviewer following a link from a client thread is a reader of this console who took
   * a wrong turn inside it; `forbidden()` answered them with a bare centred page -- no rail, no
   * eyebrow, no route onwards, and no mention of the one Money page they do carry. They get
   * `MoneySurfaceGuard`'s panel instead, which is the screen the canvas draws for this. A coach or
   * an affiliate has no business anywhere under /admin, so their refusal stays the bare page: the
   * panel's whole shape assumes a console reader.
   *
   * The audit row is written for both, because the boundary was hit either way.
   */
    if (actor.role !== "success") forbidden();
    return (
      <CostShell>
        <AdminMoneyBillingCosts
          actorRole="success"
          authorized={false}
          enabled
          refusalRecord={refusalRecord}
        />
      </CostShell>
    );
  }

  const actorRole = actor.role === "owner" || actor.role === "admin" ? actor.role : "success";

  return (
    <CostShell>
      <AdminMoneyBillingCosts actorRole={actorRole} authorized enabled />
    </CostShell>
  );
}
