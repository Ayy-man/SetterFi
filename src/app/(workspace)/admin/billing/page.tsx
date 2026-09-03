import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { GET as loadCorrections } from "@/app/api/platform/billing/route";
import {
  STRIPE_SETTINGS_HREF,
  loadClientPricing,
  loadPricingHistory,
  loadStripeReadinessReceipt,
  loadTierImpactById,
} from "@/app/(workspace)/admin/tiers/render-tiers-page";
import {
  moneyPageAccessStatus,
  type CorrectionEvidence,
} from "@/components/workspace/live/view-models";
import {
  OwnerMoney,
  type OwnerMoneyTiersData,
} from "@/components/workspace/rehaul/owner-money";
import type { PageSearchParams } from "@/lib/admin-route-fold";
// Server-side: the tab list has to come from the directive-free module, never from the
// "use client" screen. See src/lib/console-tabs.ts.
import { OWNER_MONEY_TABS, type OwnerMoneyTab } from "@/lib/console-tabs";
import { loadPlatformActor } from "@/lib/auth/actors";
import { phase6AffiliatesLive, phase6Live } from "@/lib/env-contract";
import {
  createBillingRepository,
  type MoneyBillingRead,
  type MoneySubscriptionRow,
  type MrrMovementRead,
} from "@/lib/repositories/billing";
import { logMoneyPageRefusal } from "@/lib/repositories/money-page-audit";
import type { MoneyTabId } from "@/components/workspace/live/admin-money-shell";

export const metadata: Metadata = { title: "Revenue and subscriptions" };
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<PageSearchParams> };

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function tabOf(value: string | undefined): OwnerMoneyTab {
  return OWNER_MONEY_TABS.find((candidate) => candidate === value) ?? "billing";
}

/**
 * Which access rule the folded tab is answerable to.
 *
 * The four Money routes did not become one rule when they became one page: Costs is still part of
 * the Billing surface, Tiers and Affiliates are still their own, and Corrections is still the one
 * a success reviewer carries. The tab decides which of them `moneyPageAccessStatus` is asked
 * about, so folding the routes changed the URL and nothing about who is refused.
 */
const TAB_SURFACE: Record<OwnerMoneyTab, MoneyTabId> = {
  affiliates: "affiliates",
  billing: "billing",
  corrections: "corrections",
  costs: "billing",
  tiers: "tiers",
};

type CorrectionsResult =
  | { ok: true; value: CorrectionEvidence[] }
  | { ok: false; code: "BILLING_CORRECTIONS_READ_FAILED"; reason: string }
  | { ok: false; unauthorized: true };

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

async function loadTiersData(): Promise<OwnerMoneyTiersData> {
  const [stripeReadinessReceipt, tierImpactById, clientPricingByTenantId, pricingHistory] =
    await Promise.all([
      loadStripeReadinessReceipt(),
      loadTierImpactById(),
      loadClientPricing(),
      loadPricingHistory(),
    ]);
  return {
    clientPricingByTenantId,
    pricingHistory,
    stripeActionHref: STRIPE_SETTINGS_HREF,
    stripeReadinessReceipt,
    tierImpactById,
  };
}

export default async function AdminBillingPage({ searchParams }: PageProps) {
  if (!phase6Live()) {
    return (
      <OwnerMoney
        actorRole="admin"
        authorized
        enabled={false}
        tab={tabOf(first((await searchParams).tab))}
      />
    );
  }

  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Fbilling");

  const tab = tabOf(first((await searchParams).tab));
  const surface = TAB_SURFACE[tab];
  const authorized = moneyPageAccessStatus(actor.role, surface) === 200;
  const actorRole = actor.role === "owner" || actor.role === "admin" ? actor.role : "success";

  if (!authorized) {
    const refusalRecord = await logMoneyPageRefusal(actor.userId, surface);
    // Corrections is the one Money tab a success reviewer carries, so nobody reading this console
    // is refused it: every actor who fails that check is a coach or an affiliate, and they get the
    // bare page the other four give them too.
    if (actor.role !== "success" || surface === "corrections") forbidden();
    return (
      <OwnerMoney
        actorRole="success"
        authorized={false}
        enabled
        refusalRecord={refusalRecord}
        tab={tab}
      />
    );
  }

  // The page loads the active tab's data and nothing else: four of the five reads are somebody
  // else's tab, and a tab nobody opened is a query nobody asked for.
  if (tab === "billing") {
    // Three reads, caught apart: the movement projection, the priced month-end series and the
    // subscription rows fail for different reasons, and a failure in one is no reason to blank the
    // card or the table the others draw.
    //
    // The rows are read here rather than fetched by the table after hydration. The table used to
    // call `/api/exports/platform-billing` from an effect, which put a whole client round trip --
    // an audit write, the row query, a second audit write, all serial -- between the page painting
    // and the Subscriptions table appearing, about a second of it. Reading them alongside the other
    // two costs nothing, because they run in parallel and this is not the slowest of the three.
    const repository = createBillingRepository();
    const asOf = new Date().toISOString();
    const [movementResult, billingResult, subscriptionResult] = await Promise.allSettled([
      repository.loadMrrMovement(asOf),
      repository.loadMoneyBilling(asOf),
      repository.loadSubscriptionRows(),
    ]);
    const movement: MrrMovementRead | null =
      movementResult.status === "fulfilled" ? movementResult.value : null;
    const billing: MoneyBillingRead | null =
      billingResult.status === "fulfilled" ? billingResult.value : null;
    // A failed row read hands the table no `initialRows` at all, which is the one case that still
    // wants the client fetch: the screen falls back to the path it used to take, and says so in
    // its own words if that fails too. An empty book is a real answer and is passed as one.
    const rows: readonly MoneySubscriptionRow[] | undefined =
      subscriptionResult.status === "fulfilled" ? subscriptionResult.value : undefined;
    return (
      <OwnerMoney
        actorRole={actorRole}
        authorized
        billing={billing}
        enabled
        initialRows={rows}
        movement={movement}
        tab={tab}
      />
    );
  }

  if (tab === "tiers") {
    return (
      <OwnerMoney actorRole={actorRole} authorized enabled tab={tab} tiers={await loadTiersData()} />
    );
  }

  if (tab === "affiliates") {
    return (
      <OwnerMoney
        actorRole={actorRole}
        affiliatesEnabled={phase6AffiliatesLive()}
        authorized
        enabled
        tab={tab}
      />
    );
  }

  if (tab === "corrections") {
    const result = await loadCorrectionsResult();
    if (!result.ok && "unauthorized" in result) redirect("/login?next=%2Fadmin%2Fbilling");
    return (
      <OwnerMoney
        actorRole={actor.role === "success" ? "success" : actorRole}
        authorized
        corrections={result.ok ? result.value : undefined}
        correctionsReadFailure={result.ok ? null : { code: result.code, reason: result.reason }}
        enabled
        openCorrections={result.ok ? result.value.filter((row) => row.decision === null).length : null}
        tab={tab}
      />
    );
  }

  return <OwnerMoney actorRole={actorRole} authorized enabled tab={tab} />;
}
