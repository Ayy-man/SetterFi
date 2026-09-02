/**
 * Hosted Stripe Checkout creation for an already-authorized real tenant.
 *
 * The integration driver intentionally exposes provider-neutral custody fields only. Checkout's
 * one browser-facing capability is its opaque hosted URL, so it stays in this server-only billing
 * boundary and is never persisted or synthesized from a session id.
 */

import Stripe from "stripe";

import {
  driverSelection,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";
import { STRIPE_CONFIGURATION_NAMES } from "@/lib/integrations/stripe/selector";
import type { SubscriptionCheckoutResult } from "@/lib/integrations/stripe/types";

export type HostedCheckoutProvider = {
  create(input: {
    tenantId: string;
    tierId: string;
    priceId: string;
    idempotencyKey: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ provider: SubscriptionCheckoutResult; url: string }>;
};

type StripeCheckoutClient = {
  createCustomer(metadata: Record<string, string>, idempotencyKey: string): Promise<unknown>;
  createCheckout(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    clientReferenceId: string;
    metadata: Record<string, string>;
    expiresAt: number;
    idempotencyKey: string;
  }): Promise<unknown>;
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerId(value: unknown) {
  return text(value) ?? text(object(value)?.id);
}

function isoFromSeconds(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(code);
  return new Date(value * 1_000).toISOString();
}

function createSdkClient(secretKey: string): StripeCheckoutClient {
  const stripe = new Stripe(secretKey, { apiVersion: "2026-07-29.dahlia" });
  return {
    createCustomer: (metadata, idempotencyKey) => stripe.customers.create(
      { metadata },
      { idempotencyKey },
    ),
    createCheckout: (input) => stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.clientReferenceId,
      metadata: input.metadata,
      subscription_data: { metadata: input.metadata },
      expires_at: input.expiresAt,
    }, { idempotencyKey: input.idempotencyKey }),
  };
}

export function createHostedCheckoutProvider({
  environment = process.env,
  clientFactory = createSdkClient,
  clock = () => new Date(),
}: {
  environment?: EnvironmentSource;
  clientFactory?: (secretKey: string) => StripeCheckoutClient;
  clock?: () => Date;
} = {}): HostedCheckoutProvider {
  // Keep this decision at the authoritative, fail-closed selector. A real-tenant checkout has no
  // mock success lane, even outside production, because a browser could mistake it for payment.
  if (driverSelection("stripe", "SETTERFI_STRIPE_DRIVER", environment) === "mock") {
    throw new Error("BILLING_CHECKOUT_MOCK_DRIVER_REFUSED");
  }
  const configuration = requireEnvironment("stripe", STRIPE_CONFIGURATION_NAMES, environment);
  const client = clientFactory(configuration.STRIPE_SECRET_KEY);

  return {
    create: async (input) => {
      const metadata = {
        tenant_id: input.tenantId,
        tier_id: input.tierId,
        price_id: input.priceId,
      };
      const customer = object(await client.createCustomer(
        { tenant_id: input.tenantId },
        `${input.idempotencyKey}:customer`,
      ));
      const customerId = text(customer?.id);
      if (!customerId || customer?.deleted === true) {
        throw new Error("STRIPE_CUSTOMER_ENVELOPE_INVALID");
      }
      const checkout = object(await client.createCheckout({
        customerId,
        priceId: input.priceId,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        clientReferenceId: input.tenantId,
        metadata,
        expiresAt: Math.floor(clock().getTime() / 1_000) + 30 * 60,
        idempotencyKey: `${input.idempotencyKey}:checkout`,
      }));
      const sessionId = text(checkout?.id);
      const url = text(checkout?.url);
      if (!sessionId || !url || checkout?.status !== "open") {
        throw new Error("STRIPE_CHECKOUT_ENVELOPE_INVALID");
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") throw new Error("invalid protocol");
      } catch {
        throw new Error("STRIPE_CHECKOUT_URL_INVALID");
      }
      return {
        provider: {
          sessionId,
          customerId,
          subscriptionId: providerId(checkout?.subscription),
          state: "open",
          expiresAt: isoFromSeconds(checkout?.expires_at, "STRIPE_CHECKOUT_EXPIRES_AT_INVALID"),
        },
        url,
      };
    },
  };
}
