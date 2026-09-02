/**
 * Server-owned Stripe Checkout orchestration.
 *
 * HTTP callers supply only tenant and tier identifiers. Price, URLs, provider selection, and the
 * idempotency key are derived behind this boundary so a request body cannot choose money or reuse
 * another tenant's Stripe customer.
 */

import { checkoutAttemptsLive } from "@/lib/env-contract";
import type {
  StripeDriver,
  SubscriptionCheckoutResult,
} from "@/lib/integrations/stripe/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type SubscriptionCheckoutInput = {
  tenantId: string;
  tierId: string;
};

export type CheckoutTenant = {
  id: string;
  isDemo: boolean;
};

export type CheckoutTierPrice = {
  tierId: string;
  active: boolean;
  priceId: string | null;
};

export type PersistedCheckoutSession = SubscriptionCheckoutResult & {
  checkoutSessionId: string;
  tenantId: string;
  tierId: string;
  priceId: string;
  idempotencyKey: string;
  checkoutAttemptId?: string;
  checkoutAttemptOutcome?: "pending";
};

export type CheckoutAttempt = {
  id: string;
  idempotencyKey: string;
  outcome: "pending";
};

export type CheckoutAttemptStore = {
  claim(input: {
    tenantId: string;
    tierId: string;
    priceId: string;
  }): Promise<CheckoutAttempt>;
  recordProviderSession(input: {
    attemptId: string;
    sessionId: string;
    expiresAt: string;
  }): Promise<void>;
};

export type SubscriptionCheckoutDependencies = {
  loadTenant(tenantId: string): Promise<CheckoutTenant | null>;
  loadTierPrices(tierId: string): Promise<readonly CheckoutTierPrice[]>;
  allowedPriceIds(): ReadonlySet<string>;
  checkoutUrls(input: SubscriptionCheckoutInput): { successUrl: string; cancelUrl: string };
  driver(): Pick<StripeDriver, "createSubscriptionCheckout">;
  persistCheckout(input: {
    tenantId: string;
    tierId: string;
    priceId: string;
    idempotencyKey: string;
    provider: SubscriptionCheckoutResult;
  }): Promise<PersistedCheckoutSession | null>;
  /**
   * Attempt lifecycle is separately rollout-gated because it writes new durable state before the
   * provider request. It defaults off until the matching migration and deployment flag are live.
   */
  checkoutAttemptsLive?(): boolean;
  checkoutAttempts?: CheckoutAttemptStore;
};

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function exactInput(input: SubscriptionCheckoutInput) {
  if (Object.keys(input).sort().join(",") !== "tenantId,tierId") {
    throw new Error("BILLING_CHECKOUT_INPUT_INVALID");
  }
  return {
    tenantId: required(input.tenantId, "BILLING_CHECKOUT_TENANT_REQUIRED"),
    tierId: required(input.tierId, "BILLING_CHECKOUT_TIER_REQUIRED"),
  };
}

function resolvedPrice(
  tierId: string,
  rows: readonly CheckoutTierPrice[],
  allowed: ReadonlySet<string>,
) {
  if (rows.length === 0 || rows.every((row) => !row.active)) {
    throw new Error("BILLING_TIER_INACTIVE");
  }
  const active = rows.filter((row) => row.active && row.tierId === tierId);
  if (active.length !== 1) throw new Error("BILLING_TIER_PRICE_AMBIGUOUS");
  const priceId = active[0].priceId?.trim();
  if (!priceId || !allowed.has(priceId)) throw new Error("BILLING_PRICE_NOT_ALLOWLISTED");
  return priceId;
}

function text(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}


function liveCheckoutAttemptStore(): CheckoutAttemptStore {
  return {
    async claim(input) {
      const client = createSupabaseServiceClient();
      const { data, error } = await client.rpc("claim_stripe_checkout_attempt", {
        p_expected_tenant: input.tenantId,
        p_tier_id: input.tierId,
        p_price_id: input.priceId,
      });
      const receipt = Array.isArray(data) ? data[0] : null;
      if (error || !receipt || typeof receipt !== "object") {
        throw new Error("CHECKOUT_ATTEMPT_CLAIM_FAILED");
      }
      const row = receipt as Record<string, unknown>;
      if (row.outcome !== "pending") throw new Error("CHECKOUT_ATTEMPT_OUTCOME_INVALID");
      return {
        id: text(row.attempt_id, "CHECKOUT_ATTEMPT_RECEIPT_INVALID"),
        idempotencyKey: text(row.idempotency_key, "CHECKOUT_ATTEMPT_RECEIPT_INVALID"),
        outcome: "pending",
      };
    },
    async recordProviderSession(input) {
      const client = createSupabaseServiceClient();
      const { data, error } = await client.rpc("record_stripe_checkout_attempt_session", {
        p_attempt_id: input.attemptId,
        p_stripe_session_id: input.sessionId,
        p_expires_at: input.expiresAt,
      });
      const receipt = Array.isArray(data) ? data[0] : null;
      if (
        error || !receipt || typeof receipt !== "object"
        || (receipt as Record<string, unknown>).attempt_id !== input.attemptId
        || (receipt as Record<string, unknown>).outcome !== "pending"
      ) {
        throw new Error("CHECKOUT_ATTEMPT_PROVIDER_SESSION_RECORD_FAILED");
      }
    },
  };
}

export async function requestCheckoutAttemptRetry(input: {
  tenantId: string;
  tierId: string;
}): Promise<void> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("request_stripe_checkout_attempt_retry", {
    p_expected_tenant: input.tenantId,
    p_tier_id: input.tierId,
  });
  const receipt = Array.isArray(data) ? data[0] : null;
  if (
    error || !receipt || typeof receipt !== "object"
    || typeof (receipt as Record<string, unknown>).retired_attempt_count !== "number"
  ) {
    throw new Error("CHECKOUT_ATTEMPT_RETRY_REQUEST_FAILED");
  }
}

function assertPersistedCheckout(
  persisted: PersistedCheckoutSession | null,
  expected: {
    tenantId: string;
    tierId: string;
    priceId: string;
    idempotencyKey: string;
    provider: SubscriptionCheckoutResult;
  },
) {
  if (
    !persisted
    || !persisted.checkoutSessionId
    || persisted.tenantId !== expected.tenantId
    || persisted.tierId !== expected.tierId
    || persisted.priceId !== expected.priceId
    || persisted.idempotencyKey !== expected.idempotencyKey
    || persisted.sessionId !== expected.provider.sessionId
    || persisted.customerId !== expected.provider.customerId
    || persisted.subscriptionId !== expected.provider.subscriptionId
    || persisted.state !== expected.provider.state
    || persisted.expiresAt !== expected.provider.expiresAt
  ) {
    throw new Error("STRIPE_CHECKOUT_READBACK_MISMATCH");
  }
  return persisted;
}

export async function createSubscriptionCheckout(
  untrustedInput: SubscriptionCheckoutInput,
  dependencies: SubscriptionCheckoutDependencies,
): Promise<PersistedCheckoutSession> {
  const input = exactInput(untrustedInput);
  const tenant = await dependencies.loadTenant(input.tenantId);
  if (!tenant || tenant.id !== input.tenantId) throw new Error("BILLING_TENANT_NOT_FOUND");

  // Demo billing stays visibly local and cannot create even a mock provider object through the
  // production Checkout service; the seeded demo lane owns its own labelled evidence.
  if (tenant.isDemo) throw new Error("BILLING_CHECKOUT_DEMO_TENANT");

  const priceId = resolvedPrice(
    input.tierId,
    await dependencies.loadTierPrices(input.tierId),
    dependencies.allowedPriceIds(),
  );
  const attemptsEnabled = dependencies.checkoutAttemptsLive?.() ?? checkoutAttemptsLive();
  const attempt = attemptsEnabled
    ? await (dependencies.checkoutAttempts ?? liveCheckoutAttemptStore()).claim({
      tenantId: input.tenantId,
      tierId: input.tierId,
      priceId,
    })
    : null;
  const idempotencyKey = attempt?.idempotencyKey
    ?? `checkout:${input.tenantId}:${input.tierId}:${priceId}`;
  const urls = dependencies.checkoutUrls(input);
  const provider = await dependencies.driver().createSubscriptionCheckout({
    tenantId: input.tenantId,
    tierId: input.tierId,
    priceId,
    idempotencyKey,
    successUrl: required(urls.successUrl, "BILLING_CHECKOUT_SUCCESS_URL_REQUIRED"),
    cancelUrl: required(urls.cancelUrl, "BILLING_CHECKOUT_CANCEL_URL_REQUIRED"),
  });
  if (attempt) {
    await (dependencies.checkoutAttempts ?? liveCheckoutAttemptStore()).recordProviderSession({
      attemptId: attempt.id,
      sessionId: provider.sessionId,
      expiresAt: provider.expiresAt,
    });
  }
  const expected = { ...input, priceId, idempotencyKey, provider };
  return {
    ...assertPersistedCheckout(await dependencies.persistCheckout(expected), expected),
    ...(attempt ? { checkoutAttemptId: attempt.id, checkoutAttemptOutcome: attempt.outcome } : {}),
  };
}
