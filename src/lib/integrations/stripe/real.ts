/**
 * The real Stripe arm owns SDK objects, allowlisted Price use, and raw-body verification.
 *
 * Its injected client is deliberately narrower than Stripe's SDK so unit tests can prove every
 * provider request without a network call and no SDK type crosses the integration directory.
 */

import Stripe from "stripe";

import type { StripeRealConfiguration } from "./selector";
import type {
  ChargeInvoice,
  InvoiceFinancials,
  StripeDriver,
  StripeEvent,
  SubscriptionSnapshot,
} from "./types";

export const STRIPE_SDK_VERSION = "22.5.0";
export const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;

type JsonObject = Record<string, unknown>;
type Metadata = Record<string, string>;

type CheckoutCreate = {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId: string;
  metadata: Metadata;
  expiresAt: number;
  idempotencyKey: string;
};

type ScheduleUpdate = {
  currentPriceId: string;
  targetPriceId: string;
  currentPeriodEnd: number;
  metadata: Metadata;
  idempotencyKey: string;
};

export type StripeClient = {
  createCustomer(metadata: Metadata, idempotencyKey: string): Promise<unknown>;
  createCheckout(input: CheckoutCreate): Promise<unknown>;
  createScheduleFromSubscription(
    subscriptionId: string,
    metadata: Metadata,
    idempotencyKey: string,
  ): Promise<unknown>;
  updateSchedule(scheduleId: string, input: ScheduleUpdate): Promise<unknown>;
  updateSubscription(
    subscriptionId: string,
    metadata: Metadata,
    idempotencyKey: string,
  ): Promise<unknown>;
  retrieveInvoice(invoiceId: string): Promise<unknown>;
  listInvoicePayments(invoiceId: string): Promise<readonly unknown[]>;
  retrievePaymentIntent(paymentIntentId: string): Promise<unknown>;
  retrieveCharge(chargeId: string): Promise<unknown>;
  listInvoicePaymentsForPaymentIntent(paymentIntentId: string): Promise<readonly unknown[]>;
  constructEvent(
    rawBody: Buffer,
    signature: string,
    webhookSecret: string,
    toleranceSeconds: number,
  ): unknown;
};

export type StripeRealDependencies = {
  client?: StripeClient;
  allowedPriceIds?: readonly string[];
  clock?: () => Date;
};

export class StripeDriverError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StripeDriverError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function providerId(value: unknown) {
  return text(value) ?? text(object(value)?.id);
}

function isoFromSeconds(value: unknown, code: string) {
  const seconds = integer(value);
  if (seconds === null) throw new StripeDriverError(code);
  return new Date(seconds * 1_000).toISOString();
}

function secondsFromIso(value: string, code: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new StripeDriverError(code);
  return Math.floor(milliseconds / 1_000);
}

function requireProviderId(value: unknown, code: string) {
  const id = providerId(value);
  if (!id) throw new StripeDriverError(code);
  return id;
}

function subscriptionStatus(value: unknown) {
  if (value === "active" || value === "trialing" || value === "past_due" ||
    value === "incomplete" || value === "incomplete_expired" || value === "unpaid" ||
    value === "paused" || value === "canceled") {
    return value;
  }
  return "unavailable" as const;
}

function normalizeSubscription(value: unknown, providerUpdatedAt: string): SubscriptionSnapshot {
  const subscription = object(value);
  const subscriptionId = text(subscription?.id);
  const items = object(subscription?.items);
  const rows = Array.isArray(items?.data) ? items.data : [];
  if (!subscription || !subscriptionId || rows.length !== 1) {
    throw new StripeDriverError("STRIPE_SUBSCRIPTION_ENVELOPE_INVALID");
  }
  const item = object(rows[0]);
  const priceId = providerId(object(item?.price));
  if (!item || !priceId || typeof subscription.cancel_at_period_end !== "boolean") {
    throw new StripeDriverError("STRIPE_SUBSCRIPTION_ENVELOPE_INVALID");
  }
  return {
    subscriptionId,
    status: subscriptionStatus(subscription.status),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodStart: isoFromSeconds(
      item.current_period_start,
      "STRIPE_SUBSCRIPTION_PERIOD_INVALID",
    ),
    currentPeriodEnd: isoFromSeconds(
      item.current_period_end,
      "STRIPE_SUBSCRIPTION_PERIOD_INVALID",
    ),
    priceId,
    providerUpdatedAt,
  };
}

function invoiceSubscriptionId(invoice: JsonObject) {
  return providerId(object(object(invoice.parent)?.subscription_details)?.subscription);
}

function invoicePaymentChargeId(paymentValue: unknown) {
  const payment = object(object(paymentValue)?.payment);
  if (payment?.type === "charge") return providerId(payment.charge);
  if (payment?.type === "payment_intent") {
    return providerId(object(payment.payment_intent)?.latest_charge);
  }
  return null;
}

function normalizeInvoice(value: unknown, payments: readonly unknown[]): InvoiceFinancials {
  const invoice = object(value);
  const invoiceId = text(invoice?.id);
  const customerId = providerId(invoice?.customer);
  const amountPaidCents = integer(invoice?.amount_paid);
  const totalExcludingTax = invoice?.total_excluding_tax;
  const currency = text(invoice?.currency);
  if (!invoice || !invoiceId || !customerId || amountPaidCents === null || !currency) {
    throw new StripeDriverError("STRIPE_INVOICE_ENVELOPE_INVALID");
  }
  if (totalExcludingTax !== null && integer(totalExcludingTax) === null) {
    throw new StripeDriverError("STRIPE_INVOICE_BASE_INVALID");
  }
  const paidPayment = payments.find((payment) => object(payment)?.status === "paid");
  const transitions = object(invoice.status_transitions);
  return {
    invoiceId,
    subscriptionId: invoiceSubscriptionId(invoice),
    customerId,
    chargeId: paidPayment ? invoicePaymentChargeId(paidPayment) : null,
    amountPaidCents,
    totalExcludingTaxCents: totalExcludingTax === null ? null : integer(totalExcludingTax),
    currency,
    paidAt: transitions?.paid_at === null || transitions?.paid_at === undefined
      ? null
      : isoFromSeconds(transitions.paid_at, "STRIPE_INVOICE_PAID_AT_INVALID"),
  };
}

function normalizeEvent(eventValue: unknown): StripeEvent {
  const envelope = object(eventValue);
  const eventId = text(envelope?.id);
  const providerType = text(envelope?.type);
  const providerObject = object(object(envelope?.data)?.object);
  if (!eventId || !providerType || !providerObject) {
    throw new StripeDriverError("STRIPE_EVENT_ENVELOPE_INVALID");
  }
  const created = isoFromSeconds(envelope?.created, "STRIPE_EVENT_CREATED_INVALID");

  if (providerType === "checkout.session.completed") {
    const metadata = object(providerObject.metadata);
    const sessionId = text(providerObject.id);
    const customerId = providerId(providerObject.customer);
    const tenantId = text(providerObject.client_reference_id) ?? text(metadata?.tenant_id);
    const tierId = text(metadata?.tier_id);
    const priceId = text(metadata?.price_id);
    if (!sessionId || !customerId || !tenantId || !tierId || !priceId) {
      throw new StripeDriverError("STRIPE_CHECKOUT_ENVELOPE_INVALID");
    }
    return {
      id: eventId,
      type: providerType,
      created,
      data: {
        sessionId,
        customerId,
        subscriptionId: providerId(providerObject.subscription),
        state: "completed",
        expiresAt: isoFromSeconds(
          providerObject.expires_at,
          "STRIPE_CHECKOUT_EXPIRES_AT_INVALID",
        ),
        tenantId,
        tierId,
        priceId,
      },
    };
  }

  if (providerType === "invoice.paid" || providerType === "invoice.payment_failed") {
    const embeddedPayments = object(providerObject.payments);
    const rows = Array.isArray(embeddedPayments?.data) ? embeddedPayments.data : [];
    return {
      id: eventId,
      type: providerType,
      created,
      data: normalizeInvoice(providerObject, rows),
    };
  }

  if (
    providerType === "customer.subscription.updated"
    || providerType === "customer.subscription.deleted"
  ) {
    return {
      id: eventId,
      type: providerType,
      created,
      data: {
        ...normalizeSubscription(providerObject, created),
        customerId: requireProviderId(
          providerObject.customer,
          "STRIPE_SUBSCRIPTION_CUSTOMER_INVALID",
        ),
      },
    };
  }

  if (providerType === "refund.created") {
    const adjustmentId = text(providerObject.id);
    const chargeId = providerId(providerObject.charge);
    const amountCents = integer(providerObject.amount);
    const currency = text(providerObject.currency);
    if (!adjustmentId || !chargeId || amountCents === null || !currency) {
      throw new StripeDriverError("STRIPE_REFUND_ENVELOPE_INVALID");
    }
    // Keep the established provider-neutral event contract while taking identity from the refund
    // object itself. A charge's cumulative refunds list cannot identify which partial refund caused
    // this delivery once more than one refund exists.
    return {
      id: eventId,
      type: "charge.refunded",
      created,
      data: { adjustmentId, chargeId, amountCents, currency },
    };
  }

  if (providerType === "charge.refunded") {
    const refunds = object(providerObject.refunds);
    const rows = Array.isArray(refunds?.data) ? refunds.data : [];
    // Stripe's legacy charge event contains a cumulative list, so once it has multiple rows there
    // is no safe way to identify the refund represented by this delivery. The authoritative
    // `refund.created` events above carry each adjustment separately; acknowledge this companion
    // event as unsupported instead of leaving a permanently failing webhook receipt.
    if (rows.length > 1) {
      return {
        id: eventId,
        type: "unsupported",
        created,
        data: { providerType },
      };
    }
    const refund = rows.length === 1 ? object(rows[0]) : null;
    const adjustmentId = text(refund?.id);
    const chargeId = text(providerObject.id);
    const amountCents = integer(refund?.amount);
    const currency = text(providerObject.currency);
    if (!adjustmentId || !chargeId || amountCents === null || !currency) {
      throw new StripeDriverError("STRIPE_REFUND_ENVELOPE_INVALID");
    }
    return {
      id: eventId,
      type: providerType,
      created,
      data: { adjustmentId, chargeId, amountCents, currency },
    };
  }

  if (
    providerType === "charge.dispute.created"
    || providerType === "charge.dispute.updated"
    || providerType === "charge.dispute.closed"
  ) {
    const disputeId = text(providerObject.id);
    const chargeId = providerId(providerObject.charge);
    const amountCents = integer(providerObject.amount);
    const currency = text(providerObject.currency);
    const providerState = text(providerObject.status);
    if (!disputeId || !chargeId || amountCents === null || !currency || !providerState) {
      throw new StripeDriverError("STRIPE_DISPUTE_ENVELOPE_INVALID");
    }
    return {
      id: eventId,
      type: providerType,
      created,
      data: {
        disputeId,
        chargeId,
        amountCents,
        currency,
        state: providerState === "won" ? "won" : providerState === "lost" ? "lost" : "open",
      },
    };
  }

  return {
    id: eventId,
    type: "unsupported",
    created,
    data: { providerType },
  };
}

function createSdkClient(secretKey: string): StripeClient {
  if (Stripe.PACKAGE_VERSION !== STRIPE_SDK_VERSION) {
    throw new StripeDriverError("STRIPE_SDK_VERSION_MISMATCH");
  }
  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
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
    createScheduleFromSubscription: (subscriptionId, metadata, idempotencyKey) => (
      stripe.subscriptionSchedules.create(
        { from_subscription: subscriptionId, metadata },
        { idempotencyKey },
      )
    ),
    updateSchedule: (scheduleId, input) => stripe.subscriptionSchedules.update(scheduleId, {
      end_behavior: "release",
      metadata: input.metadata,
      proration_behavior: "none",
      phases: [
        {
          start_date: "now",
          end_date: input.currentPeriodEnd,
          items: [{ price: input.currentPriceId, quantity: 1 }],
          proration_behavior: "none",
        },
        {
          start_date: input.currentPeriodEnd,
          items: [{ price: input.targetPriceId, quantity: 1 }],
          proration_behavior: "none",
        },
      ],
    }, { idempotencyKey: input.idempotencyKey }),
    updateSubscription: (subscriptionId, metadata, idempotencyKey) => stripe.subscriptions.update(
      subscriptionId,
      { cancel_at_period_end: true, metadata },
      { idempotencyKey },
    ),
    retrieveInvoice: (invoiceId) => stripe.invoices.retrieve(invoiceId),
    listInvoicePayments: async (invoiceId) => {
      const response = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 10 });
      return response.data;
    },
    retrievePaymentIntent: (paymentIntentId) => stripe.paymentIntents.retrieve(paymentIntentId),
    retrieveCharge: (chargeId) => stripe.charges.retrieve(chargeId),
    listInvoicePaymentsForPaymentIntent: async (paymentIntentId) => {
      const response = await stripe.invoicePayments.list({
        payment: { type: "payment_intent", payment_intent: paymentIntentId },
        status: "paid",
        limit: 2,
      });
      return response.data;
    },
    constructEvent: (rawBody, signature, webhookSecret, toleranceSeconds) => (
      stripe.webhooks.constructEvent(rawBody, signature, webhookSecret, toleranceSeconds)
    ),
  };
}

export function createRealStripeDriver(
  configuration: StripeRealConfiguration,
  {
    client = createSdkClient(configuration.secretKey),
    allowedPriceIds = [],
    clock = () => new Date(),
  }: StripeRealDependencies = {},
): StripeDriver {
  const allowedPrices = new Set(allowedPriceIds);

  function assertAllowedPrice(priceId: string) {
    if (allowedPrices.size === 0) throw new StripeDriverError("STRIPE_PRICE_ALLOWLIST_REQUIRED");
    if (!allowedPrices.has(priceId)) throw new StripeDriverError("STRIPE_PRICE_NOT_ALLOWLISTED");
  }

  return {
    createSubscriptionCheckout: async (input) => {
      assertAllowedPrice(input.priceId);
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
        throw new StripeDriverError("STRIPE_CUSTOMER_ENVELOPE_INVALID");
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
      const state = checkout?.status === "complete"
        ? "completed"
        : checkout?.status === "expired"
          ? "expired"
          : checkout?.status === "open"
            ? "open"
            : null;
      if (!checkout || !sessionId || !state) {
        throw new StripeDriverError("STRIPE_CHECKOUT_ENVELOPE_INVALID");
      }
      return {
        sessionId,
        customerId,
        subscriptionId: providerId(checkout.subscription),
        state,
        expiresAt: isoFromSeconds(checkout.expires_at, "STRIPE_CHECKOUT_EXPIRES_AT_INVALID"),
      };
    },
    createRenewalPriceSchedule: async (input) => {
      assertAllowedPrice(input.currentPriceId);
      assertAllowedPrice(input.targetPriceId);
      const metadata = { tenant_id: input.tenantId, target_price_id: input.targetPriceId };
      const schedule = object(await client.createScheduleFromSubscription(
        input.subscriptionId,
        metadata,
        `${input.idempotencyKey}:create`,
      ));
      const scheduleId = text(schedule?.id);
      if (!scheduleId) throw new StripeDriverError("STRIPE_SCHEDULE_ENVELOPE_INVALID");
      const currentPeriodEnd = secondsFromIso(
        input.currentPeriodEnd,
        "STRIPE_SCHEDULE_PERIOD_INVALID",
      );
      const updated = object(await client.updateSchedule(scheduleId, {
        currentPriceId: input.currentPriceId,
        targetPriceId: input.targetPriceId,
        currentPeriodEnd,
        metadata,
        idempotencyKey: `${input.idempotencyKey}:update`,
      }));
      if (text(updated?.id) !== scheduleId) {
        throw new StripeDriverError("STRIPE_SCHEDULE_ENVELOPE_INVALID");
      }
      return {
        scheduleId,
        subscriptionId: input.subscriptionId,
        currentPeriodEnd: input.currentPeriodEnd,
        targetPriceId: input.targetPriceId,
        state: "scheduled",
      };
    },
    cancelSubscriptionAtPeriodEnd: async (input) => {
      const updatedAt = clock().toISOString();
      const subscription = await client.updateSubscription(
        input.subscriptionId,
        { tenant_id: input.tenantId },
        input.idempotencyKey,
      );
      return normalizeSubscription(subscription, updatedAt);
    },
    retrieveInvoiceFinancials: async (invoiceId) => {
      const [invoice, payments] = await Promise.all([
        client.retrieveInvoice(invoiceId),
        client.listInvoicePayments(invoiceId),
      ]);
      const financials = normalizeInvoice(invoice, payments);
      const paidPayment = payments.find((payment) => object(payment)?.status === "paid");
      const payment = object(object(paidPayment)?.payment);
      if (payment?.type === "payment_intent" && !financials.chargeId) {
        const paymentIntentId = providerId(payment.payment_intent);
        if (paymentIntentId) {
          const intent = object(await client.retrievePaymentIntent(paymentIntentId));
          financials.chargeId = providerId(intent?.latest_charge);
        }
      }
      return financials;
    },
    resolveChargeInvoice: async (chargeId): Promise<ChargeInvoice> => {
      const charge = object(await client.retrieveCharge(chargeId));
      const resolvedChargeId = text(charge?.id);
      const amountCents = integer(charge?.amount);
      const currency = text(charge?.currency);
      const paymentIntentId = providerId(charge?.payment_intent);
      if (!resolvedChargeId || amountCents === null || !currency) {
        throw new StripeDriverError("STRIPE_CHARGE_ENVELOPE_INVALID");
      }
      if (!paymentIntentId) throw new StripeDriverError("STRIPE_CHARGE_INVOICE_LINK_MISSING");
      const payments = await client.listInvoicePaymentsForPaymentIntent(paymentIntentId);
      const invoiceIds = [...new Set(payments.map((payment) => providerId(object(payment)?.invoice)))]
        .filter((value): value is string => Boolean(value));
      if (invoiceIds.length !== 1) {
        throw new StripeDriverError("STRIPE_CHARGE_INVOICE_LINK_MISSING");
      }
      return { chargeId: resolvedChargeId, invoiceId: invoiceIds[0], amountCents, currency };
    },
    verifyWebhook: (rawBody, signature, toleranceSeconds = 300) => {
      if (!signature.trim()) throw new StripeDriverError("STRIPE_SIGNATURE_REQUIRED");
      const exactBytes = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
      return normalizeEvent(client.constructEvent(
        exactBytes,
        signature,
        configuration.webhookSecret,
        toleranceSeconds,
      ));
    },
  };
}
