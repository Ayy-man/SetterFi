import { describe, expect, it } from "vitest";

import { realArmSkipReason } from "@/lib/env-contract";

import { STRIPE_CONFIGURATION_NAMES } from "./selector";
import type { StripeRealConfiguration } from "./selector";
import type { StripeDriver } from "./types";
import {
  StripeDriverError,
  createRealStripeDriver,
  type StripeClient,
} from "./real";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const configuration = {
  secretKey: "synthetic-stripe-api-secret",
  webhookSecret: "synthetic-stripe-webhook-secret",
};
const allowedPriceIds = ["price_synthetic_starter", "price_synthetic_scale"];

type Call = { operation: string; input: unknown };

function fakeStripeClient(eventOverride?: unknown) {
  const calls: Call[] = [];
  const client: StripeClient = {
    createCustomer: async (metadata, idempotencyKey) => {
      calls.push({ operation: "createCustomer", input: { metadata, idempotencyKey } });
      return { id: "cus_synthetic" };
    },
    createCheckout: async (input) => {
      calls.push({ operation: "createCheckout", input });
      return {
        id: "cs_synthetic",
        customer: "cus_synthetic",
        subscription: null,
        status: "open",
        expires_at: Math.floor(NOW.getTime() / 1_000) + 30 * 60,
      };
    },
    createScheduleFromSubscription: async (subscriptionId, metadata, idempotencyKey) => {
      calls.push({
        operation: "createScheduleFromSubscription",
        input: { subscriptionId, metadata, idempotencyKey },
      });
      return { id: "sub_sched_synthetic", subscription: subscriptionId };
    },
    updateSchedule: async (scheduleId, input) => {
      calls.push({ operation: "updateSchedule", input: { scheduleId, ...input } });
      return { id: scheduleId, subscription: "sub_synthetic" };
    },
    updateSubscription: async (subscriptionId, metadata, idempotencyKey) => {
      calls.push({
        operation: "updateSubscription",
        input: { subscriptionId, metadata, idempotencyKey },
      });
      return {
        id: subscriptionId,
        status: "active",
        cancel_at_period_end: true,
        items: {
          data: [{
            current_period_start: Math.floor(NOW.getTime() / 1_000),
            current_period_end: Math.floor(NOW.getTime() / 1_000) + 30 * 24 * 60 * 60,
            price: { id: "price_synthetic_starter" },
          }],
        },
      };
    },
    retrieveInvoice: async (invoiceId) => {
      calls.push({ operation: "retrieveInvoice", input: { invoiceId } });
      return {
        id: invoiceId,
        customer: "cus_synthetic",
        amount_paid: 9_900,
        total_excluding_tax: 9_000,
        currency: "usd",
        parent: { subscription_details: { subscription: "sub_synthetic" } },
        status_transitions: { paid_at: Math.floor(NOW.getTime() / 1_000) },
      };
    },
    listInvoicePayments: async (invoiceId) => {
      calls.push({ operation: "listInvoicePayments", input: { invoiceId } });
      return [{
        invoice: invoiceId,
        status: "paid",
        payment: { type: "payment_intent", payment_intent: "pi_synthetic" },
      }];
    },
    retrievePaymentIntent: async (paymentIntentId) => {
      calls.push({ operation: "retrievePaymentIntent", input: { paymentIntentId } });
      return { id: paymentIntentId, latest_charge: "ch_synthetic" };
    },
    retrieveCharge: async (chargeId) => {
      calls.push({ operation: "retrieveCharge", input: { chargeId } });
      return {
        id: chargeId,
        amount: 9_900,
        currency: "usd",
        payment_intent: "pi_synthetic",
      };
    },
    listInvoicePaymentsForPaymentIntent: async (paymentIntentId) => {
      calls.push({
        operation: "listInvoicePaymentsForPaymentIntent",
        input: { paymentIntentId },
      });
      return [{ invoice: "in_synthetic", status: "paid" }];
    },
    constructEvent: (rawBody, signature, webhookSecret, toleranceSeconds) => {
      calls.push({
        operation: "constructEvent",
        input: {
          isBuffer: Buffer.isBuffer(rawBody),
          rawBody: [...rawBody],
          signature,
          webhookSecret,
          toleranceSeconds,
        },
      });
      return eventOverride ?? {
        id: "evt_synthetic",
        object: "event",
        type: "checkout.session.completed",
        created: Math.floor(NOW.getTime() / 1_000),
        data: {
          object: {
            id: "cs_synthetic",
            customer: "cus_synthetic",
            subscription: "sub_synthetic",
            expires_at: Math.floor(NOW.getTime() / 1_000) + 30 * 60,
            client_reference_id: "tenant_synthetic",
            metadata: {
              tenant_id: "tenant_synthetic",
              tier_id: "tier_synthetic",
              price_id: "price_synthetic_starter",
            },
          },
        },
      };
    },
  };
  return { calls, client };
}

function driver(client: StripeClient) {
  return createRealStripeDriver(configuration, {
    client,
    allowedPriceIds,
    clock: () => new Date(NOW),
  });
}

describe("createRealStripeDriver", () => {
  it("retains the selector's one-argument real factory contract", () => {
    const selectorFactory: (value: StripeRealConfiguration) => StripeDriver = createRealStripeDriver;
    expect(selectorFactory).toBe(createRealStripeDriver);
  });

  it("creates an idempotent hosted subscription Checkout from server-derived linkage only", async () => {
    const fake = fakeStripeClient();
    const result = await driver(fake.client).createSubscriptionCheckout({
      tenantId: "tenant_synthetic",
      tierId: "tier_synthetic",
      priceId: "price_synthetic_starter",
      idempotencyKey: "checkout:tenant_synthetic:tier_synthetic:price_synthetic_starter",
      successUrl: "https://setterfi.test/billing/success",
      cancelUrl: "https://setterfi.test/billing/cancel",
    });

    expect(result).toEqual({
      sessionId: "cs_synthetic",
      customerId: "cus_synthetic",
      subscriptionId: null,
      state: "open",
      expiresAt: "2026-08-17T12:30:00.000Z",
    });
    expect(fake.calls).toEqual([
      {
        operation: "createCustomer",
        input: {
          metadata: { tenant_id: "tenant_synthetic" },
          idempotencyKey:
            "checkout:tenant_synthetic:tier_synthetic:price_synthetic_starter:customer",
        },
      },
      {
        operation: "createCheckout",
        input: {
          customerId: "cus_synthetic",
          priceId: "price_synthetic_starter",
          successUrl: "https://setterfi.test/billing/success",
          cancelUrl: "https://setterfi.test/billing/cancel",
          clientReferenceId: "tenant_synthetic",
          metadata: {
            tenant_id: "tenant_synthetic",
            tier_id: "tier_synthetic",
            price_id: "price_synthetic_starter",
          },
          expiresAt: 1_786_969_800,
          idempotencyKey:
            "checkout:tenant_synthetic:tier_synthetic:price_synthetic_starter:checkout",
        },
      },
    ]);
    expect(JSON.stringify(fake.calls)).not.toMatch(/amount|customerName|email|body/i);
  });

  it("rejects a non-allowlisted Price before constructing any provider request", async () => {
    const fake = fakeStripeClient();
    await expect(driver(fake.client).createSubscriptionCheckout({
      tenantId: "tenant_synthetic",
      tierId: "tier_synthetic",
      priceId: "price_caller_supplied",
      idempotencyKey: "checkout:rejected",
      successUrl: "https://setterfi.test/billing/success",
      cancelUrl: "https://setterfi.test/billing/cancel",
    })).rejects.toEqual(new StripeDriverError("STRIPE_PRICE_NOT_ALLOWLISTED"));
    expect(fake.calls).toEqual([]);
  });

  it("creates current and next schedule phases without an immediate price mutation", async () => {
    const fake = fakeStripeClient();
    const result = await driver(fake.client).createRenewalPriceSchedule({
      tenantId: "tenant_synthetic",
      subscriptionId: "sub_synthetic",
      currentPriceId: "price_synthetic_starter",
      targetPriceId: "price_synthetic_scale",
      currentPeriodEnd: "2026-09-16T12:00:00.000Z",
      idempotencyKey: "schedule:tenant_synthetic:price_synthetic_scale",
    });

    expect(result).toEqual({
      scheduleId: "sub_sched_synthetic",
      subscriptionId: "sub_synthetic",
      currentPeriodEnd: "2026-09-16T12:00:00.000Z",
      targetPriceId: "price_synthetic_scale",
      state: "scheduled",
    });
    expect(fake.calls).toEqual([
      {
        operation: "createScheduleFromSubscription",
        input: {
          subscriptionId: "sub_synthetic",
          metadata: {
            tenant_id: "tenant_synthetic",
            target_price_id: "price_synthetic_scale",
          },
          idempotencyKey: "schedule:tenant_synthetic:price_synthetic_scale:create",
        },
      },
      {
        operation: "updateSchedule",
        input: {
          scheduleId: "sub_sched_synthetic",
          currentPriceId: "price_synthetic_starter",
          targetPriceId: "price_synthetic_scale",
          currentPeriodEnd: 1_789_560_000,
          metadata: {
            tenant_id: "tenant_synthetic",
            target_price_id: "price_synthetic_scale",
          },
          idempotencyKey: "schedule:tenant_synthetic:price_synthetic_scale:update",
        },
      },
    ]);
  });

  it("normalizes period-end cancellation, invoice financials, and charge linkage", async () => {
    const fake = fakeStripeClient();
    const real = driver(fake.client);
    await expect(real.cancelSubscriptionAtPeriodEnd({
      tenantId: "tenant_synthetic",
      subscriptionId: "sub_synthetic",
      idempotencyKey: "cancel:tenant_synthetic",
    })).resolves.toEqual({
      subscriptionId: "sub_synthetic",
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodStart: "2026-08-17T12:00:00.000Z",
      currentPeriodEnd: "2026-09-16T12:00:00.000Z",
      priceId: "price_synthetic_starter",
      providerUpdatedAt: NOW.toISOString(),
    });
    await expect(real.retrieveInvoiceFinancials("in_synthetic")).resolves.toEqual({
      invoiceId: "in_synthetic",
      subscriptionId: "sub_synthetic",
      customerId: "cus_synthetic",
      chargeId: "ch_synthetic",
      amountPaidCents: 9_900,
      totalExcludingTaxCents: 9_000,
      currency: "usd",
      paidAt: NOW.toISOString(),
    });
    await expect(real.resolveChargeInvoice("ch_synthetic")).resolves.toEqual({
      chargeId: "ch_synthetic",
      invoiceId: "in_synthetic",
      amountCents: 9_900,
      currency: "usd",
    });
  });

  it("passes an unchanged Buffer and the default tolerance to SDK verification", () => {
    const fake = fakeStripeClient();
    const rawBody = new TextEncoder().encode("{\n  \"synthetic\": true\n}");
    const result = driver(fake.client).verifyWebhook(rawBody, "synthetic-signature");

    expect(result.type).toBe("checkout.session.completed");
    expect(fake.calls).toEqual([{
      operation: "constructEvent",
      input: {
        isBuffer: true,
        rawBody: [...rawBody],
        signature: "synthetic-signature",
        webhookSecret: configuration.webhookSecret,
        toleranceSeconds: 300,
      },
    }]);
  });

  it("preserves every Stripe subscription lifecycle status without coercion", () => {
    const statuses = [
      "trialing", "active", "past_due", "incomplete", "incomplete_expired", "unpaid", "paused", "canceled",
    ] as const;
    for (const status of statuses) {
      const event = {
        id: `evt_${status}`,
        object: "event",
        type: "customer.subscription.updated",
        created: Math.floor(NOW.getTime() / 1_000),
        data: {
          object: {
            id: "sub_synthetic",
            customer: "cus_synthetic",
            status,
            cancel_at_period_end: false,
            items: { data: [{
              current_period_start: Math.floor(NOW.getTime() / 1_000),
              current_period_end: Math.floor(NOW.getTime() / 1_000) + 30 * 24 * 60 * 60,
              price: { id: "price_synthetic_starter" },
            }] },
          },
        },
      };
      const normalized = driver(fakeStripeClient(event).client)
        .verifyWebhook(new TextEncoder().encode("{}"), "signature");
      expect(normalized).toMatchObject({ data: { status } });
    }
  });

  it("normalizes each partial refund by its explicit refund ID independent of delivery order", () => {
    function refund(id: string, amount: number, eventId: string) {
      return {
        id: eventId,
        object: "event",
        type: "refund.created",
        created: Math.floor(NOW.getTime() / 1_000),
        data: {
          object: {
            id,
            object: "refund",
            charge: "ch_synthetic",
            amount,
            currency: "usd",
          },
        },
      };
    }
    const deliveries = [
      refund("re_second", 2_500, "evt_refund_second"),
      refund("re_first", 1_000, "evt_refund_first"),
    ];
    const normalized = deliveries.map((event) => {
      const fake = fakeStripeClient(event);
      return driver(fake.client).verifyWebhook(new TextEncoder().encode("{}"), "signature");
    });

    expect(normalized).toEqual([
      {
        id: "evt_refund_second",
        type: "charge.refunded",
        created: NOW.toISOString(),
        data: {
          adjustmentId: "re_second",
          chargeId: "ch_synthetic",
          amountCents: 2_500,
          currency: "usd",
        },
      },
      {
        id: "evt_refund_first",
        type: "charge.refunded",
        created: NOW.toISOString(),
        data: {
          adjustmentId: "re_first",
          chargeId: "ch_synthetic",
          amountCents: 1_000,
          currency: "usd",
        },
      },
    ]);

    const replay = fakeStripeClient(deliveries[0]);
    expect(driver(replay.client).verifyWebhook(new TextEncoder().encode("{}"), "signature"))
      .toEqual(normalized[0]);
  });

  it("acknowledges a cumulative multi-refund charge event without guessing its adjustment", () => {
    const fake = fakeStripeClient({
      id: "evt_charge_refunded",
      object: "event",
      type: "charge.refunded",
      created: Math.floor(NOW.getTime() / 1_000),
      data: {
        object: {
          id: "ch_synthetic",
          currency: "usd",
          refunds: {
            data: [
              { id: "re_newest", amount: 2_500 },
              { id: "re_oldest", amount: 1_000 },
            ],
          },
        },
      },
    });

    expect(driver(fake.client).verifyWebhook(
      new TextEncoder().encode("{}"),
      "signature",
    )).toEqual({
      id: "evt_charge_refunded",
      type: "unsupported",
      created: NOW.toISOString(),
      data: { providerType: "charge.refunded" },
    });
  });
});

const baseSkipReason = realArmSkipReason(
  "stripe",
  "SETTERFI_STRIPE_DRIVER",
  STRIPE_CONFIGURATION_NAMES,
);
const realProbeSkipReason = baseSkipReason
  ? `${baseSkipReason}; required names: SETTERFI_STRIPE_DRIVER, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET`
  : null;

describe.skipIf(Boolean(realProbeSkipReason))(
  `Stripe configuration-gated arm — SKIPPED: ${realProbeSkipReason ?? "configured"}`,
  () => {
    it("constructs the configured arm against an injected client without contacting Stripe", () => {
      const fake = fakeStripeClient();
      expect(() => driver(fake.client)).not.toThrow();
      expect(fake.calls).toEqual([]);
    });
  },
);
