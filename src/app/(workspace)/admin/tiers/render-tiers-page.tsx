import { forbidden, redirect } from "next/navigation";
import type { ReactNode } from "react";
import Stripe from "stripe";

import { AppShell } from "@/components/kit/app-shell";
import {
  AdminMoneyTiers,
  type ClientPricingByTenantId,
  type StripeReadinessReceipt,
  type TierImpactById,
} from "@/components/workspace/live/admin-money-tiers";
import {
  derivePricingHistory,
  type PricingHistoryEntry,
} from "@/components/workspace/live/admin-money-pricing-history";
import { moneyPageAccessStatus } from "@/components/workspace/live/view-models";
import { loadPlatformActor } from "@/lib/auth/actors";
import {
  driverSelection,
  phase6Live,
  phase6StripeLive,
} from "@/lib/env-contract";
import {
  STRIPE_API_VERSION,
  STRIPE_SDK_VERSION,
} from "@/lib/integrations/stripe/real";
import {
  logMoneyPageRefusal,
  type MoneyRefusalRecord,
} from "@/lib/repositories/money-page-audit";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const STRIPE_SETTINGS_HREF = "https://dashboard.stripe.com/settings/account";

const CURRENT_SUBSCRIPTION_STATES = new Set([
  "active",
  "incomplete",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);

export async function loadStripeReadinessReceipt(): Promise<StripeReadinessReceipt | null> {
  try {
    if (
      !phase6StripeLive() ||
      driverSelection("stripe", "SETTERFI_STRIPE_DRIVER") !== "real"
    ) {
      return null;
    }

    const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
    if (!secretKey || Stripe.PACKAGE_VERSION !== STRIPE_SDK_VERSION) return null;

    const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
    const account = await stripe.accounts.retrieveCurrent();
    if (
      account.lastResponse.statusCode !== 200 ||
      !account.lastResponse.requestId.trim()
    ) {
      return null;
    }

    return {
      capabilityStatus: account.charges_enabled ? "available" : "missing",
      checkedAt: new Date().toISOString(),
      connectionStatus: account.details_submitted ? "connected" : "incomplete",
      receiptStatus: "received",
    };
  } catch {
    return null;
  }
}

export async function loadTierImpactById(): Promise<TierImpactById | null> {
  try {
    const client = await createSupabaseServerClient();
    const [tiers, subscriptions, tenants] = await Promise.all([
      client.from("tiers").select("id,stripe_price_id"),
      client.from("billing_subscriptions").select("tenant_id,stripe_price_id,status"),
      client.from("tenants").select("id,is_demo"),
    ]);

    if (tiers.error || subscriptions.error || tenants.error) return null;

    const realTenantIds = new Set(
      (tenants.data ?? [])
        .filter((tenant) => tenant.is_demo === false)
        .map((tenant) => tenant.id),
    );
    const workspacesByPrice = new Map<string, number>();

    for (const subscription of subscriptions.data ?? []) {
      if (
        !realTenantIds.has(subscription.tenant_id) ||
        !CURRENT_SUBSCRIPTION_STATES.has(subscription.status)
      ) {
        continue;
      }
      workspacesByPrice.set(
        subscription.stripe_price_id,
        (workspacesByPrice.get(subscription.stripe_price_id) ?? 0) + 1,
      );
    }

    const effectiveAt = new Date().toISOString();
    return Object.fromEntries(
      (tiers.data ?? []).map((tier) => [
        tier.id,
        {
          affectedWorkspaceCount: tier.stripe_price_id
            ? (workspacesByPrice.get(tier.stripe_price_id) ?? 0)
            : 0,
          effectiveAt,
        },
      ]),
    );
  } catch {
    return null;
  }
}

/**
 * Which plan each client is actually on, and whether a negotiated price is standing over it.
 *
 * The plan is read the way the money is: a subscription's `stripe_price_id` matched to the tier
 * that owns it, which is the same join `loadTierImpactById` counts with, so a client's row and the
 * card's customer count can never disagree. The override is the current row of
 * `tenant_price_overrides` -- started and not yet ended -- and its `reason` is required by that
 * table's own check, which is why the surface can promise a "why" on every override row.
 */
export async function loadClientPricing(): Promise<ClientPricingByTenantId | null> {
  try {
    const client = await createSupabaseServerClient();
    const now = new Date().toISOString();
    const [tiers, subscriptions, overrides] = await Promise.all([
      client.from("tiers").select("id,name,price_cents,stripe_price_id"),
      client.from("billing_subscriptions").select("tenant_id,stripe_price_id,status"),
      client.from("tenant_price_overrides")
        .select("tenant_id,price_cents,effective_at,ends_at,reason")
        .lte("effective_at", now)
        .order("effective_at", { ascending: false }),
    ]);
    if (tiers.error || subscriptions.error || overrides.error) return null;

    const tierByPrice = new Map(
      (tiers.data ?? [])
        .filter((tier) => typeof tier.stripe_price_id === "string" && tier.stripe_price_id)
        .map((tier) => [tier.stripe_price_id as string, tier]),
    );
    const pricing: Record<string, ClientPricingByTenantId[string]> = {};
    for (const subscription of subscriptions.data ?? []) {
      const tier = tierByPrice.get(subscription.stripe_price_id);
      pricing[subscription.tenant_id] = {
        tierId: tier?.id ?? null,
        tierName: tier?.name ?? null,
        tierPriceCents: typeof tier?.price_cents === "number" ? tier.price_cents : null,
        override: null,
      };
    }
    for (const row of overrides.data ?? []) {
      // Ordered newest-first, so the first row that is still running is the one in force; a later
      // row for the same client is history and must not overwrite it.
      if (row.ends_at !== null && row.ends_at <= now) continue;
      const existing = pricing[row.tenant_id] ?? {
        tierId: null, tierName: null, tierPriceCents: null, override: null,
      };
      if (existing.override) continue;
      pricing[row.tenant_id] = {
        ...existing,
        override: {
          priceCents: row.price_cents,
          effectiveAt: row.effective_at,
          endsAt: row.ends_at,
          reason: row.reason,
        },
      };
    }
    return pricing;
  } catch {
    return null;
  }
}

const PRICING_HISTORY_LIMIT = 100;

/**
 * Every recorded version of every plan's terms, newest first.
 *
 * `public.tier_price_versions` is append-only and carries When (`effective_at`), the values that
 * were set, Who (`actor_id`), why (`reason`, required by the table's own check) and the audit row
 * that authorised it. It does not carry the version it replaced, so "what changed" is derived by
 * `derivePricingHistory`, which is a separate pure module because that comparison has one silent
 * way to be wrong -- see its docstring.
 *
 * The actor name is read with the service client the way `/admin/audit` reads it, because the
 * caller is already through the owner-or-admin gate above and `users` is not readable under this
 * page's own RLS. A name that cannot be resolved stays null rather than becoming an id dressed up
 * as a person.
 */
export async function loadPricingHistory(): Promise<PricingHistoryEntry[] | null> {
  try {
    const client = await createSupabaseServerClient();
    const [versions, tiers] = await Promise.all([
      client.from("tier_price_versions")
        .select("id,tier_id,price_cents,call_allowance,fair_use_cap,effective_at,actor_id,reason,audit_id")
        .order("effective_at", { ascending: false })
        .limit(PRICING_HISTORY_LIMIT),
      client.from("tiers").select("id,name"),
    ]);
    if (versions.error || tiers.error) return null;

    const rows = (versions.data ?? []).map((row) => ({
      id: row.id as string,
      tierId: row.tier_id as string,
      priceCents: row.price_cents as number,
      callAllowance: row.call_allowance as number,
      fairUseCap: (row.fair_use_cap ?? null) as number | null,
      effectiveAt: row.effective_at as string,
      actorId: row.actor_id as string,
      reason: row.reason as string,
      auditId: Number(row.audit_id),
    }));

    const actorIds = [...new Set(rows.map((row) => row.actorId).filter(Boolean))];
    const actorNameById = new Map<string, string>();
    if (actorIds.length > 0) {
      const { data } = await createSupabaseServiceClient()
        .from("users").select("id,full_name,email").in("id", actorIds);
      for (const user of (data ?? []) as { id: string; full_name: string | null; email: string | null }[]) {
        const name = user.full_name?.trim() || user.email?.trim();
        if (name) actorNameById.set(user.id, name);
      }
    }

    return derivePricingHistory({
      versions: rows,
      tierNameById: new Map((tiers.data ?? []).map((tier) => [tier.id as string, tier.name as string])),
      actorNameById,
    });
  } catch {
    return null;
  }
}

function TierShell({ children }: { children: ReactNode }) {
  return (
    <AppShell
      activePath="/admin/tiers"
      // The two sections are tabs on one page now, so the trail stops at the page. A third crumb
      // would print the sub-page name a second time, 40px from the tab that already says it.
      crumbs={[
        { label: "Money", href: "/admin/billing" },
        { label: "Plans and pricing" },
      ]}
      role="admin"
    >
      {children}
    </AppShell>
  );
}

/**
 * Plans and pricing, loaded once.
 *
 * It took a `section` argument while there were two sub-pages to render; there is one page now and
 * `/admin/tiers/overrides` redirects into a band of it, so the argument selected nothing and the
 * only thing it still did was decide which URL an unauthenticated reader was sent back to.
 */
export async function renderTiersPage() {
  if (!phase6Live()) {
    return (
      <TierShell>
        <AdminMoneyTiers
          actorRole="admin"
          authorized
          enabled={false}
          stripeActionHref={STRIPE_SETTINGS_HREF}
          clientPricingByTenantId={null}
          stripeReadinessReceipt={null}
          surface="tiers"
          tierImpactById={null}
        />
      </TierShell>
    );
  }

  const actor = await loadPlatformActor();
  if (!actor) redirect(`/login?next=${encodeURIComponent("/admin/tiers")}`);

  const authorized = moneyPageAccessStatus(actor.role, "tiers") === 200;
  /*
   * Declared outside the branch because the surface below is rendered on both arms: an authorized
   * reader gets `undefined` here and never reaches the sentence the value governs.
   */
  let refusalRecord: MoneyRefusalRecord | undefined;
  if (!authorized) {
    refusalRecord = await logMoneyPageRefusal(actor.userId, "tiers");
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
  }
  const actorRole =
    actor.role === "owner" || actor.role === "admin" ? actor.role : "success";
  const [stripeReadinessReceipt, tierImpactById, clientPricingByTenantId, pricingHistory] =
    authorized
      ? await Promise.all([
        loadStripeReadinessReceipt(),
        loadTierImpactById(),
        loadClientPricing(),
        loadPricingHistory(),
      ])
      : [null, null, null, null];

  return (
    <TierShell>
      <AdminMoneyTiers
        actorRole={actorRole}
        authorized={authorized}
        clientPricingByTenantId={clientPricingByTenantId}
        enabled
        pricingHistory={pricingHistory}
        refusalRecord={refusalRecord}
        stripeActionHref={STRIPE_SETTINGS_HREF}
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />
    </TierShell>
  );
}
