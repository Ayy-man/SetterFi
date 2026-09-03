import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { GET as loadCorrections } from "@/app/api/platform/billing/route";
import { AdminMoneyCorrections } from "@/components/workspace/live/admin-money-corrections";
import {
  moneyPageAccessStatus,
  type CorrectionEvidence,
} from "@/components/workspace/live/view-models";
import { foldedRouteRedirect, foldedRouteSearchParams, type PageSearchParams } from "@/lib/admin-route-fold";
import { loadPlatformActor } from "@/lib/auth/actors";
import { navFoldLive, phase6Live } from "@/lib/env-contract";
import { logMoneyPageRefusal } from "@/lib/repositories/money-page-audit";

export const metadata: Metadata = { title: "Billing corrections" };
export const dynamic = "force-dynamic";

type CorrectionsResult =
  | { ok: true; value: CorrectionEvidence[] }
  | { ok: false; code: "BILLING_CORRECTIONS_READ_FAILED"; reason: string }
  | { ok: false; unauthorized: true };

type PageProps = { searchParams: Promise<PageSearchParams> };

async function loadCorrectionsResult(): Promise<CorrectionsResult> {
  try {
    const response = await loadCorrections();
    if (response.status === 401) return { ok: false, unauthorized: true };
    if (!response.ok) {
      return {
        ok: false,
        code: "BILLING_CORRECTIONS_READ_FAILED",
        reason: "Billing corrections could not load. Try again in a moment.",
      };
    }
    const payload = await response.json() as { corrections?: CorrectionEvidence[] };
    return {
      ok: true,
      value: Array.isArray(payload.corrections) ? payload.corrections : [],
    };
  } catch {
    return {
      ok: false,
      code: "BILLING_CORRECTIONS_READ_FAILED",
      reason: "Billing corrections could not load. Try again in a moment.",
    };
  }
}

export default async function AdminCorrectionsPage({ searchParams }: PageProps) {
  if (navFoldLive()) redirect(foldedRouteRedirect("/admin/corrections", foldedRouteSearchParams(await searchParams))!);
  if (!phase6Live()) {
    return <AdminMoneyCorrections actorRole="admin" enabled={false} />;
  }

  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Fcorrections");
  if (moneyPageAccessStatus(actor.role, "corrections") !== 200) {
    /*
     * The only route that discards the write outcome, and it is discarded because there is no
     * panel to tell. Every other Money route binds it and hands it to `MoneySurfaceGuard`, which
     * states whether the attempt actually reached the audit trail. Here the next line is
     * `forbidden()`, so nothing this reader sees makes a claim about the trail at all. The write
     * still reports its own failure to the server log. `money-page-audit.test.ts` names this file
     * as the exception, so dropping the binding on one of the other four is caught rather than
     * read as following this precedent.
     */
    await logMoneyPageRefusal(actor.userId, "corrections");
    /*
     * The one Money page a success reviewer does carry, so nobody who reads this console can be
     * refused it. Every actor who reaches this line is a coach or an affiliate with no business
     * anywhere under /admin, which is the case that keeps the bare `forbidden()` page on the other
     * three surfaces too -- `MoneySurfaceGuard`'s panel is written for a console reader.
     */
    forbidden();
  }

  const actorRole = actor.role === "owner" || actor.role === "admin" || actor.role === "success"
    ? actor.role
    : "success";
  const result = await loadCorrectionsResult();
  if (!result.ok && "unauthorized" in result) {
    redirect("/login?next=%2Fadmin%2Fcorrections");
  }
  if (!result.ok) {
    return (
      <AdminMoneyCorrections
        actorRole={actorRole}
        enabled
        readFailure={{ code: result.code, reason: result.reason }}
      />
    );
  }

  return (
    <AdminMoneyCorrections
      actorRole={actorRole}
      enabled
      initialCorrections={result.value}
    />
  );
}
