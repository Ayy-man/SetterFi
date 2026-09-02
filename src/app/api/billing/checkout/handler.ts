import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { createLiveBillingOperations, type BillingOperations } from "@/lib/billing/operations";
import { requestCheckoutAttemptRetry } from "@/lib/billing/subscriptions";
import { createLiveBillingNotificationPort } from "@/lib/notifications/billing-events";
import {
  checkoutAttemptsLive,
  environmentValue,
  tierOfferTermsLive,
} from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const headers = { "Cache-Control": "no-store" };
type Dependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  checkout: BillingOperations["hostedCheckout"];
  requestRetry(input: { tenantId: string; tierId: string }): Promise<void>;
  browserState(tenantId: string): Promise<BillingCheckoutBrowserState>;
};

export type BillingCheckoutOffer = {
  tierId: string;
  label: string;
  currency: string;
  amountCents: number;
  interval: "day" | "week" | "month" | "year";
  effectiveTo: string | null;
};

export type BillingCheckoutBrowserState = {
  state: "unavailable" | "offered" | "pending" | "expired" | "confirming" | "active";
  offer: BillingCheckoutOffer | null;
  attempt: {
    outcome: "pending" | "succeeded" | "expired";
    expiresAt: string | null;
  } | null;
};

function checkoutBaseUrl(request: Request) {
  const configured = environmentValue("APP_BASE_URL");
  if (configured) return new URL(configured).origin;
  const requestUrl = new URL(request.url);
  if (process.env.NODE_ENV === "production" || requestUrl.protocol !== "https:") {
    throw new Error("BILLING_CHECKOUT_BASE_URL_REQUIRED");
  }
  return requestUrl.origin;
}

function stripeHostedUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.hostname !== "checkout.stripe.com"
    || url.username || url.password || url.port
  ) throw new Error("STRIPE_CHECKOUT_URL_INVALID");
  return url.toString();
}

export function createBillingCheckoutHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
    const actor = await dependencies.session();
    if (!actor || !["coach", "coach_member"].includes(actor.role ?? "")) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    try {
      const body = await request.json() as Record<string, unknown>;
      const allowedFields = Object.keys(body).every((key) => key === "tierId" || key === "retryAfterCancel");
      if (
        !allowedFields || typeof body.tierId !== "string" || !body.tierId.trim()
        || ("retryAfterCancel" in body && body.retryAfterCancel !== true)
      ) {
        throw new Error("INVALID_BODY");
      }
      const browserState = await dependencies.browserState(actor.tenantId);
      if (
        !browserState.offer
        || browserState.offer.tierId !== body.tierId
        || browserState.state === "unavailable"
        || browserState.state === "active"
        || browserState.state === "confirming"
      ) {
        throw new Error("BILLING_CHECKOUT_OFFER_REFUSED");
      }
      if (body.retryAfterCancel === true) {
        // This is local intent to replace the return/cancelled Checkout attempt. It deliberately
        // does not claim Stripe cancelled it; that attempt remains provider-outcome pending.
        await dependencies.requestRetry({ tenantId: actor.tenantId, tierId: body.tierId });
      }
      const checkout = await dependencies.checkout({
        actorId: actor.userId, tenantId: actor.tenantId, tierId: body.tierId,
        baseUrl: checkoutBaseUrl(request),
      });
      return Response.json({
        url: stripeHostedUrl(checkout.url),
        attempt: checkout.checkoutAttemptId
          ? { id: checkout.checkoutAttemptId, outcome: checkout.checkoutAttemptOutcome ?? "pending" }
          : null,
      }, { headers });
    } catch {
      return Response.json({ error: "Checkout was refused." }, { status: 409, headers });
    }
  };
}

export function createBillingCheckoutStatusHandler(dependencies: Pick<Dependencies, "enabled" | "session" | "browserState">) {
  return async function GET() {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
    const actor = await dependencies.session();
    if (!actor || !["coach", "coach_member"].includes(actor.role ?? "")) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    try {
      return Response.json({ checkout: await dependencies.browserState(actor.tenantId) }, { headers });
    } catch (cause) {
      console.error(
        "/api/billing/checkout failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Checkout status is unavailable." }, { status: 503, headers });
    }
  };
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validTimestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

async function loadLiveBillingCheckoutBrowserState(tenantId: string): Promise<BillingCheckoutBrowserState> {
  if (!tierOfferTermsLive()) return { state: "unavailable", offer: null, attempt: null };
  const client = createSupabaseServiceClient();
  const { data: tenant, error: tenantError } = await client.from("tenants")
    .select("id,is_demo,tier_id").eq("id", tenantId).maybeSingle();
  if (tenantError || !tenant || tenant.id !== tenantId || tenant.is_demo === true) {
    return { state: "unavailable", offer: null, attempt: null };
  }
  const tierId = string(tenant.tier_id);
  if (!tierId) return { state: "unavailable", offer: null, attempt: null };

  const asOf = new Date();
  const [{ data: tier, error: tierError }, { data: offerRows, error: offerError }, subscription, attempt] = await Promise.all([
    client.from("tiers").select("id,name,active,stripe_price_id").eq("id", tierId).maybeSingle(),
    client.rpc("resolve_tier_offer", { p_tier_id: tierId, p_as_of: asOf.toISOString() }),
    client.from("billing_subscriptions").select("status,provider_updated_at")
      .eq("tenant_id", tenantId).maybeSingle(),
    client.from("checkout_attempts")
      .select("outcome,provider_session_expires_at,created_at")
      .eq("tenant_id", tenantId).eq("tier_id", tierId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (tierError || offerError || subscription.error || attempt.error || !tier || tier.id !== tierId || tier.active !== true) {
    throw new Error("BILLING_CHECKOUT_BROWSER_STATE_READ_FAILED");
  }
  const offerRow = Array.isArray(offerRows) && offerRows.length === 1 ? offerRows[0] : null;
  const offerPriceId = offerRow && typeof offerRow === "object"
    ? string((offerRow as Record<string, unknown>).stripe_price_id)
    : null;
  const interval = offerRow && typeof offerRow === "object"
    ? (offerRow as Record<string, unknown>).billing_interval
    : null;
  const amountCents = offerRow && typeof offerRow === "object"
    ? (offerRow as Record<string, unknown>).amount_cents
    : null;
  const currency = offerRow && typeof offerRow === "object"
    ? string((offerRow as Record<string, unknown>).currency)
    : null;
  const rawEffectiveTo = offerRow && typeof offerRow === "object"
    ? (offerRow as Record<string, unknown>).effective_to
    : null;
  const effectiveTo = rawEffectiveTo === null ? null : validTimestamp(rawEffectiveTo);
  if (
    !offerRow || (offerRow as Record<string, unknown>).state !== "offered"
    || offerPriceId !== tier.stripe_price_id
    || !string(tier.name) || !currency || !/^[A-Z]{3}$/.test(currency)
    || !Number.isSafeInteger(amountCents) || typeof amountCents !== "number" || amountCents < 0
    || !["day", "week", "month", "year"].includes(String(interval))
    || (rawEffectiveTo !== null && effectiveTo === null)
  ) {
    return { state: "unavailable", offer: null, attempt: null };
  }
  const offer: BillingCheckoutOffer = {
    tierId,
    label: string(tier.name)!,
    currency,
    amountCents,
    interval: interval as BillingCheckoutOffer["interval"],
    effectiveTo,
  };
  const subscriptionStatus = subscription.data ? string(subscription.data.status) : null;
  if (subscriptionStatus === "active" || subscriptionStatus === "trialing") {
    return { state: "active", offer, attempt: null };
  }
  const outcome = attempt.data ? attempt.data.outcome : null;
  const rawExpiresAt = attempt.data?.provider_session_expires_at ?? null;
  const expiresAt = rawExpiresAt === null ? null : validTimestamp(rawExpiresAt);
  if (rawExpiresAt !== null && expiresAt === null) {
    throw new Error("BILLING_CHECKOUT_ATTEMPT_EXPIRY_INVALID");
  }
  const browserExpired = outcome === "pending"
    && expiresAt !== null
    && Date.parse(expiresAt) <= asOf.getTime();
  const browserAttempt = outcome === "pending" || outcome === "succeeded" || outcome === "expired"
    ? {
      outcome,
      expiresAt,
    }
    : null;
  return {
    state: outcome === "succeeded"
      ? "confirming"
      : outcome === "expired" || browserExpired
        ? "expired"
        : outcome === "pending"
          ? "pending"
          : "offered",
    offer,
    attempt: browserAttempt,
  };
}

const operations = createLiveBillingOperations(createLiveBillingNotificationPort());
const liveDependencies: Dependencies = {
  enabled: checkoutAttemptsLive,
  session: loadRouteActor,
  checkout: operations.hostedCheckout,
  requestRetry: requestCheckoutAttemptRetry,
  browserState: loadLiveBillingCheckoutBrowserState,
};
export const GET = createBillingCheckoutStatusHandler(liveDependencies);
export const POST = createBillingCheckoutHandler(liveDependencies);
