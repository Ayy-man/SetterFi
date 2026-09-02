/**
 * Stripe's offline arm supplies stable provider-shaped money events without touching Stripe.
 *
 * Its IDs carry an explicit mock prefix and its clock is injected so demo evidence cannot be
 * mistaken for live account evidence or drift between runs.
 */

import Stripe from "stripe";

import type {
  CancelSubscriptionInput,
  ChargeInvoice,
  CreateRenewalPriceScheduleInput,
  CreateSubscriptionCheckoutInput,
  InvoiceFinancials,
  RenewalPriceScheduleResult,
  StripeDriver,
  StripeEvent,
  SubscriptionCheckoutResult,
  SubscriptionSnapshot,
} from "./types";

const FIXED_NOW = "2026-08-17T12:00:00.000Z";

type Clock = () => Date;
type IdFactory = (kind: string, seed: string) => string;
type JsonObject = Record<string, unknown>;

export type MockStripeDependencies = {
  clock?: Clock;
  idFactory?: IdFactory;
  webhookSecret?: string;
};

export class MockStripeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MockStripeError";
  }
}

function stableId(kind: string, seed: string) {
  let hash = 2_166_136_261;
  for (const character of `${kind}:${seed}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `mock_${kind}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
  if (seconds === null) throw new MockStripeError(code);
  return new Date(seconds * 1_000).toISOString();
}

function providerSubscriptionStatus(value: unknown) {
  if (value === "active" || value === "trialing" || value === "past_due" ||
    value === "incomplete" || value === "incomplete_expired" || value === "unpaid" ||
    value === "paused" || value === "canceled") {
    return value;
  }
  return "unavailable" as const;
}

function paymentChargeId(invoice: JsonObject) {
  const payments = object(invoice.payments);
  const rows = Array.isArray(payments?.data) ? payments.data : [];
  for (const row of rows) {
    const payment = object(object(row)?.payment);
    if (payment?.type === "charge") return providerId(payment.charge);
    if (payment?.type === "payment_intent") {
      const latestCharge = providerId(object(payment.payment_intent)?.latest_charge);
      if (latestCharge) return latestCharge;
    }
  }
  return null;
}

function invoiceSubscriptionId(invoice: JsonObject) {
  const parent = object(invoice.parent);
  const details = object(parent?.subscription_details);
  return providerId(details?.subscription);
}

function normalizeInvoice(invoice: JsonObject): InvoiceFinancials {
  const invoiceId = text(invoice.id);
  const customerId = providerId(invoice.customer);
  const amountPaidCents = integer(invoice.amount_paid);
  const totalExcludingTax = invoice.total_excluding_tax;
  const currency = text(invoice.currency);
  if (!invoiceId || !customerId || amountPaidCents === null || !currency) {
    throw new MockStripeError("MOCK_STRIPE_INVOICE_ENVELOPE_INVALID");
  }
  if (totalExcludingTax !== null && integer(totalExcludingTax) === null) {
    throw new MockStripeError("MOCK_STRIPE_INVOICE_BASE_INVALID");
  }
  const transitions = object(invoice.status_transitions);
  return {
    invoiceId,
    subscriptionId: invoiceSubscriptionId(invoice),
    customerId,
    chargeId: paymentChargeId(invoice),
    amountPaidCents,
    totalExcludingTaxCents: totalExcludingTax === null ? null : integer(totalExcludingTax),
    currency,
    paidAt: transitions?.paid_at === null || transitions?.paid_at === undefined
      ? null
      : isoFromSeconds(transitions.paid_at, "MOCK_STRIPE_INVOICE_PAID_AT_INVALID"),
  };
}

function normalizeSubscription(subscription: JsonObject): SubscriptionSnapshot {
  const subscriptionId = text(subscription.id);
  const items = object(subscription.items);
  const rows = Array.isArray(items?.data) ? items.data : [];
  if (!subscriptionId || rows.length !== 1) {
    throw new MockStripeError("MOCK_STRIPE_SUBSCRIPTION_ENVELOPE_INVALID");
  }
  const item = object(rows[0]);
  const priceId = providerId(object(item?.price));
  if (!item || !priceId || typeof subscription.cancel_at_period_end !== "boolean") {
    throw new MockStripeError("MOCK_STRIPE_SUBSCRIPTION_ENVELOPE_INVALID");
  }
  return {
    subscriptionId,
    status: providerSubscriptionStatus(subscription.status),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodStart: isoFromSeconds(
      item.current_period_start,
      "MOCK_STRIPE_SUBSCRIPTION_PERIOD_INVALID",
    ),
    currentPeriodEnd: isoFromSeconds(
      item.current_period_end,
      "MOCK_STRIPE_SUBSCRIPTION_PERIOD_INVALID",
    ),
    priceId,
    providerUpdatedAt: isoFromSeconds(
      subscription.created,
      "MOCK_STRIPE_SUBSCRIPTION_UPDATED_AT_INVALID",
    ),
  };
}

function normalizeProviderEvent(event: unknown): StripeEvent {
  const envelope = object(event);
  const eventId = text(envelope?.id);
  const providerType = text(envelope?.type);
  const providerObject = object(object(envelope?.data)?.object);
  if (!eventId || !providerType || !providerObject) {
    throw new MockStripeError("MOCK_STRIPE_EVENT_ENVELOPE_INVALID");
  }
  const created = isoFromSeconds(envelope?.created, "MOCK_STRIPE_EVENT_CREATED_INVALID");

  if (providerType === "checkout.session.completed") {
    const metadata = object(providerObject.metadata);
    const sessionId = text(providerObject.id);
    const customerId = providerId(providerObject.customer);
    const tenantId = text(providerObject.client_reference_id) ?? text(metadata?.tenant_id);
    const tierId = text(metadata?.tier_id);
    const priceId = text(metadata?.price_id);
    const subscriptionId = providerId(providerObject.subscription);
    if (!sessionId || !customerId || !tenantId || !tierId || !priceId) {
      throw new MockStripeError("MOCK_STRIPE_CHECKOUT_ENVELOPE_INVALID");
    }
    return {
      id: eventId,
      type: providerType,
      created,
      data: {
        sessionId,
        customerId,
        subscriptionId,
        state: "completed",
        expiresAt: isoFromSeconds(
          providerObject.expires_at,
          "MOCK_STRIPE_CHECKOUT_EXPIRES_AT_INVALID",
        ),
        tenantId,
        tierId,
        priceId,
      },
    };
  }

  if (providerType === "invoice.paid" || providerType === "invoice.payment_failed") {
    return { id: eventId, type: providerType, created, data: normalizeInvoice(providerObject) };
  }

  if (
    providerType === "customer.subscription.updated"
    || providerType === "customer.subscription.deleted"
  ) {
    const customerId = providerId(providerObject.customer);
    if (!customerId) throw new MockStripeError("MOCK_STRIPE_SUBSCRIPTION_CUSTOMER_INVALID");
    return {
      id: eventId,
      type: providerType,
      created,
      data: { ...normalizeSubscription(providerObject), customerId },
    };
  }

  if (providerType === "charge.refunded") {
    const refunds = object(providerObject.refunds);
    const rows = Array.isArray(refunds?.data) ? refunds.data : [];
    const refund = object(rows.at(-1));
    const adjustmentId = text(refund?.id);
    const chargeId = text(providerObject.id);
    const amountCents = integer(refund?.amount);
    const currency = text(providerObject.currency);
    if (!adjustmentId || !chargeId || amountCents === null || !currency) {
      throw new MockStripeError("MOCK_STRIPE_REFUND_ENVELOPE_INVALID");
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
      throw new MockStripeError("MOCK_STRIPE_DISPUTE_ENVELOPE_INVALID");
    }
    const state = providerState === "won" ? "won" : providerState === "lost" ? "lost" : "open";
    return {
      id: eventId,
      type: providerType,
      created,
      data: { disputeId, chargeId, amountCents, currency, state },
    };
  }

  return {
    id: eventId,
    type: "unsupported",
    created,
    data: { providerType },
  };
}

function event<T extends StripeEvent["type"]>(
  type: T,
  id: string,
  created: string,
  data: Extract<StripeEvent, { type: T }>["data"],
) {
  return { id, type, created, data } as Extract<StripeEvent, { type: T }>;
}

export function createMockStripeEventFixtures(
  { clock = () => new Date(FIXED_NOW), idFactory = stableId }: MockStripeDependencies = {},
) {
  const created = clock().toISOString();
  const periodStart = new Date(clock().getTime() - 15 * 24 * 60 * 60_000).toISOString();
  const periodEnd = new Date(clock().getTime() + 15 * 24 * 60 * 60_000).toISOString();
  const subscription = {
    subscriptionId: idFactory("subscription", "fixture"),
    status: "active" as const,
    cancelAtPeriodEnd: false,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    priceId: idFactory("price", "starter"),
    providerUpdatedAt: created,
  };
  const invoice = {
    invoiceId: idFactory("invoice", "paid"),
    subscriptionId: subscription.subscriptionId,
    customerId: idFactory("customer", "tenant-fixture"),
    chargeId: idFactory("charge", "paid"),
    amountPaidCents: 9_900,
    totalExcludingTaxCents: 9_000,
    currency: "usd",
    paidAt: created,
  };
  const checkout = {
    sessionId: idFactory("checkout", "completed"),
    customerId: invoice.customerId,
    subscriptionId: subscription.subscriptionId,
    state: "completed" as const,
    expiresAt: new Date(clock().getTime() + 24 * 60 * 60_000).toISOString(),
    tenantId: "tenant_fixture",
    tierId: "tier_fixture",
    priceId: subscription.priceId,
  };
  return {
    checkoutCompleted: event(
      "checkout.session.completed",
      idFactory("event", "checkout-completed"),
      created,
      checkout,
    ),
    invoicePaid: event(
      "invoice.paid",
      idFactory("event", "invoice-paid"),
      created,
      invoice,
    ),
    invoicePaymentFailed: event(
      "invoice.payment_failed",
      idFactory("event", "invoice-failed"),
      created,
      { ...invoice, invoiceId: idFactory("invoice", "failed"), chargeId: null, paidAt: null },
    ),
    subscriptionUpdated: event(
      "customer.subscription.updated",
      idFactory("event", "subscription-updated"),
      created,
      { ...subscription, customerId: invoice.customerId },
    ),
    subscriptionDeleted: event(
      "customer.subscription.deleted",
      idFactory("event", "subscription-deleted"),
      created,
      { ...subscription, status: "unavailable", customerId: invoice.customerId },
    ),
    refundPartial: event(
      "charge.refunded",
      idFactory("event", "refund-partial"),
      created,
      {
        adjustmentId: idFactory("refund", "partial"),
        chargeId: invoice.chargeId,
        amountCents: 2_000,
        currency: "usd",
      },
    ),
    refundFull: event(
      "charge.refunded",
      idFactory("event", "refund-full"),
      created,
      {
        adjustmentId: idFactory("refund", "full"),
        chargeId: invoice.chargeId,
        amountCents: 9_900,
        currency: "usd",
      },
    ),
    disputeCreated: event(
      "charge.dispute.created",
      idFactory("event", "dispute-created"),
      created,
      {
        disputeId: idFactory("dispute", "fixture"),
        chargeId: invoice.chargeId,
        amountCents: 9_900,
        currency: "usd",
        state: "open",
      },
    ),
    disputeLost: event(
      "charge.dispute.closed",
      idFactory("event", "dispute-lost"),
      created,
      {
        disputeId: idFactory("dispute", "fixture"),
        chargeId: invoice.chargeId,
        amountCents: 9_900,
        currency: "usd",
        state: "lost",
      },
    ),
    disputeWon: event(
      "charge.dispute.closed",
      idFactory("event", "dispute-won"),
      created,
      {
        disputeId: idFactory("dispute", "fixture"),
        chargeId: invoice.chargeId,
        amountCents: 9_900,
        currency: "usd",
        state: "won",
      },
    ),
    unknown: event(
      "unsupported",
      idFactory("event", "unknown"),
      created,
      { providerType: "synthetic.provider.event" },
    ),
    invoiceMissingBase: event(
      "invoice.paid",
      idFactory("event", "invoice-missing-base"),
      created,
      {
        ...invoice,
        invoiceId: idFactory("invoice", "missing-base"),
        totalExcludingTaxCents: null,
      },
    ),
    chargeMissingInvoiceLink: {
      chargeId: idFactory("charge", "missing-invoice-link"),
      invoiceId: null,
      amountCents: 4_200,
      currency: "usd",
    },
  };
}

export function mockStripeWebhookBody(eventValue: StripeEvent) {
  const created = Math.floor(new Date(eventValue.created).getTime() / 1_000);
  let providerType: string = eventValue.type;
  let providerObject: JsonObject;
  if (eventValue.type === "checkout.session.completed") {
    providerObject = {
      id: eventValue.data.sessionId,
      object: "checkout.session",
      customer: eventValue.data.customerId,
      subscription: eventValue.data.subscriptionId,
      status: "complete",
      expires_at: Math.floor(new Date(eventValue.data.expiresAt).getTime() / 1_000),
      client_reference_id: eventValue.data.tenantId,
      metadata: {
        tenant_id: eventValue.data.tenantId,
        tier_id: eventValue.data.tierId,
        price_id: eventValue.data.priceId,
      },
    };
  } else if (eventValue.type === "invoice.paid" || eventValue.type === "invoice.payment_failed") {
    providerObject = {
      id: eventValue.data.invoiceId,
      object: "invoice",
      customer: eventValue.data.customerId,
      amount_paid: eventValue.data.amountPaidCents,
      total_excluding_tax: eventValue.data.totalExcludingTaxCents,
      currency: eventValue.data.currency,
      parent: eventValue.data.subscriptionId
        ? { subscription_details: { subscription: eventValue.data.subscriptionId } }
        : null,
      payments: {
        data: eventValue.data.chargeId
          ? [{ payment: { type: "charge", charge: eventValue.data.chargeId } }]
          : [],
      },
      status_transitions: {
        paid_at: eventValue.data.paidAt
          ? Math.floor(new Date(eventValue.data.paidAt).getTime() / 1_000)
          : null,
      },
    };
  } else if (
    eventValue.type === "customer.subscription.updated"
    || eventValue.type === "customer.subscription.deleted"
  ) {
    providerObject = {
      id: eventValue.data.subscriptionId,
      object: "subscription",
      customer: eventValue.data.customerId,
      status: eventValue.data.status === "unavailable" ? "canceled" : eventValue.data.status,
      cancel_at_period_end: eventValue.data.cancelAtPeriodEnd,
      created: Math.floor(new Date(eventValue.data.providerUpdatedAt).getTime() / 1_000),
      items: {
        data: [{
          current_period_start: Math.floor(
            new Date(eventValue.data.currentPeriodStart).getTime() / 1_000,
          ),
          current_period_end: Math.floor(
            new Date(eventValue.data.currentPeriodEnd).getTime() / 1_000,
          ),
          price: { id: eventValue.data.priceId },
        }],
      },
    };
  } else if (eventValue.type === "charge.refunded") {
    providerObject = {
      id: eventValue.data.chargeId,
      object: "charge",
      currency: eventValue.data.currency,
      refunds: {
        data: [{ id: eventValue.data.adjustmentId, amount: eventValue.data.amountCents }],
      },
    };
  } else if (
    eventValue.type === "charge.dispute.created"
    || eventValue.type === "charge.dispute.updated"
    || eventValue.type === "charge.dispute.closed"
  ) {
    providerObject = {
      id: eventValue.data.disputeId,
      object: "dispute",
      charge: eventValue.data.chargeId,
      amount: eventValue.data.amountCents,
      currency: eventValue.data.currency,
      status: eventValue.data.state === "open" ? "needs_response" : eventValue.data.state,
    };
  } else {
    providerType = eventValue.data.providerType;
    providerObject = { id: `mock_object_${eventValue.id}`, object: "synthetic" };
  }
  return new TextEncoder().encode(JSON.stringify({
    id: eventValue.id,
    object: "event",
    type: providerType,
    created,
    data: { object: providerObject },
  }));
}

export function createMockStripeDriver(
  { clock = () => new Date(FIXED_NOW), idFactory = stableId, webhookSecret }: MockStripeDependencies = {},
): StripeDriver {
  const customers = new Map<string, string>();
  const subscriptions = new Map<string, SubscriptionSnapshot>();
  const fixtures = createMockStripeEventFixtures({ clock, idFactory });
  const invoices = new Map<string, InvoiceFinancials>([
    [fixtures.invoicePaid.data.invoiceId, fixtures.invoicePaid.data],
    [fixtures.invoicePaymentFailed.data.invoiceId, fixtures.invoicePaymentFailed.data],
    [fixtures.invoiceMissingBase.data.invoiceId, fixtures.invoiceMissingBase.data],
  ]);
  const charges = new Map<string, ChargeInvoice>([
    [fixtures.invoicePaid.data.chargeId!, {
      chargeId: fixtures.invoicePaid.data.chargeId!,
      invoiceId: fixtures.invoicePaid.data.invoiceId,
      amountCents: fixtures.invoicePaid.data.amountPaidCents,
      currency: fixtures.invoicePaid.data.currency,
    }],
  ]);

  return {
    createSubscriptionCheckout: async (
      input: CreateSubscriptionCheckoutInput,
    ): Promise<SubscriptionCheckoutResult> => {
      const customerId = customers.get(input.tenantId)
        ?? idFactory("customer", input.tenantId);
      customers.set(input.tenantId, customerId);
      const subscriptionId = idFactory("subscription", input.idempotencyKey);
      const currentPeriodStart = clock().toISOString();
      const currentPeriodEnd = new Date(clock().getTime() + 30 * 24 * 60 * 60_000).toISOString();
      subscriptions.set(subscriptionId, {
        subscriptionId,
        status: "incomplete",
        cancelAtPeriodEnd: false,
        currentPeriodStart,
        currentPeriodEnd,
        priceId: input.priceId,
        providerUpdatedAt: currentPeriodStart,
      });
      return {
        sessionId: idFactory("checkout", input.idempotencyKey),
        customerId,
        subscriptionId,
        state: "open",
        expiresAt: new Date(clock().getTime() + 24 * 60 * 60_000).toISOString(),
      };
    },
    createRenewalPriceSchedule: async (
      input: CreateRenewalPriceScheduleInput,
    ): Promise<RenewalPriceScheduleResult> => ({
      scheduleId: idFactory("schedule", input.idempotencyKey),
      subscriptionId: input.subscriptionId,
      currentPeriodEnd: input.currentPeriodEnd,
      targetPriceId: input.targetPriceId,
      state: "scheduled",
    }),
    cancelSubscriptionAtPeriodEnd: async (input: CancelSubscriptionInput) => {
      const current = subscriptions.get(input.subscriptionId);
      if (!current) throw new MockStripeError("MOCK_STRIPE_SUBSCRIPTION_NOT_FOUND");
      const canceled = {
        ...current,
        cancelAtPeriodEnd: true,
        providerUpdatedAt: clock().toISOString(),
      };
      subscriptions.set(input.subscriptionId, canceled);
      return canceled;
    },
    retrieveInvoiceFinancials: async (invoiceId) => {
      const invoice = invoices.get(invoiceId);
      if (!invoice) throw new MockStripeError("MOCK_STRIPE_INVOICE_NOT_FOUND");
      return invoice;
    },
    resolveChargeInvoice: async (chargeId) => {
      if (chargeId === fixtures.chargeMissingInvoiceLink.chargeId) {
        throw new MockStripeError("STRIPE_CHARGE_INVOICE_LINK_MISSING");
      }
      const charge = charges.get(chargeId);
      if (!charge) throw new MockStripeError("MOCK_STRIPE_CHARGE_NOT_FOUND");
      return charge;
    },
    verifyWebhook: (rawBody, signature, toleranceSeconds = 300) => {
      if (!webhookSecret) throw new MockStripeError("MOCK_STRIPE_WEBHOOK_SECRET_REQUIRED");
      const providerEvent = Stripe.webhooks.constructEvent(
        Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength),
        signature,
        webhookSecret,
        toleranceSeconds,
        undefined,
        clock().getTime(),
      );
      return normalizeProviderEvent(providerEvent);
    },
  };
}
