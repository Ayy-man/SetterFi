import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AdminMoneyBilling } from "@/components/workspace/live/admin-money-billing";
import { moneyPageAccessStatus } from "@/components/workspace/live/view-models";
import { loadPlatformActor } from "@/lib/auth/actors";
import { phase6Live } from "@/lib/env-contract";
import { createBillingRepository, type MrrMovementRead } from "@/lib/repositories/billing";
import { logMoneyPageRefusal } from "@/lib/repositories/money-page-audit";

export const metadata: Metadata = { title: "Revenue and subscriptions" };
export const dynamic = "force-dynamic";

export default async function AdminBillingPage() {
  if (!phase6Live()) {
    return (
      <AdminMoneyBilling
        actorRole="admin"
        authorized
        enabled={false}
        surface="billing"
      />
    );
  }

  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Fbilling");

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
      <AdminMoneyBilling
        actorRole="success"
        authorized={false}
        enabled
        refusalRecord={refusalRecord}
        surface="billing"
      />
    );
  }

  const actorRole = actor.role === "owner" || actor.role === "admin" ? actor.role : "success";
  let movement: MrrMovementRead | null = null;
  try {
    movement = await createBillingRepository().loadMrrMovement(new Date().toISOString());
  } catch {
    movement = null;
  }

  return (
    <AdminMoneyBilling
      actorRole={actorRole}
      authorized={authorized}
      enabled
      movement={movement}
      surface="billing"
    />
  );
}
