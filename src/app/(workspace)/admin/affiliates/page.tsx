import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { AdminMoneyAffiliates } from "@/components/workspace/live/admin-money-affiliates";
import { moneyPageAccessStatus } from "@/components/workspace/live/view-models";
import { loadPlatformActor } from "@/lib/auth/actors";
import { foldedRouteRedirect, foldedRouteSearchParams, type PageSearchParams } from "@/lib/admin-route-fold";
import { navFoldLive, phase6AffiliatesLive, phase6Live } from "@/lib/env-contract";
import { logMoneyPageRefusal } from "@/lib/repositories/money-page-audit";

export const metadata: Metadata = { title: "Affiliates and payouts" };
export const dynamic = "force-dynamic";

const crumbs = [
  { label: "Money", href: "/admin/billing" },
  { label: "Affiliates and payouts" },
] as const;

function AffiliatesShell({ children }: { children: ReactNode }) {
  return (
    <AppShell
      activePath="/admin/affiliates"
      crumbs={crumbs}
      role="admin"
    >
      {children}
    </AppShell>
  );
}

type PageProps = { searchParams: Promise<PageSearchParams> };

export default async function AdminAffiliatesPage({ searchParams }: PageProps) {
  if (navFoldLive()) redirect(foldedRouteRedirect("/admin/affiliates", foldedRouteSearchParams(await searchParams))!);
  if (!phase6Live()) {
    return (
      <AffiliatesShell>
        <AdminMoneyAffiliates
          actorRole="admin"
          authorized
          enabled={false}
          surface="affiliates"
        />
      </AffiliatesShell>
    );
  }

  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Faffiliates");

  const authorized = moneyPageAccessStatus(actor.role, "affiliates") === 200;
  if (!authorized) {
    const refusalRecord = await logMoneyPageRefusal(actor.userId, "affiliates");
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
      <AffiliatesShell>
        <AdminMoneyAffiliates
          actorRole="success"
          affiliatesEnabled={phase6AffiliatesLive()}
          authorized={false}
          refusalRecord={refusalRecord}
          enabled
          surface="affiliates"
        />
      </AffiliatesShell>
    );
  }

  const actorRole = actor.role === "owner" || actor.role === "admin"
    ? actor.role
    : "success";

  return (
    <AffiliatesShell>
      <AdminMoneyAffiliates
        actorRole={actorRole}
        affiliatesEnabled={phase6AffiliatesLive()}
        authorized
        enabled
        surface="affiliates"
      />
    </AffiliatesShell>
  );
}
