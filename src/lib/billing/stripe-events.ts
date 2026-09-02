/**
 * Idempotent Stripe event processing over the durable inbox.
 *
 * Signature verification and receipt insertion happen before this module. It resolves tenancy only
 * from persisted provider linkage, then requires every money transition and notice to return a
 * durable receipt before the inbox row can become processed.
 */

import type {
  AffiliateService,
} from "@/lib/affiliates/service";
import { createAffiliateService } from "@/lib/affiliates/service";
import type { BillingNotificationPort } from "@/lib/billing/contracts";
import { createLiveBillingNotificationPort } from "@/lib/notifications/billing-events";
import Stripe from "stripe";
import { driverSelection, phase8AlertRuleEventsLive, requireEnvironment } from "@/lib/env-contract";
import { createMockStripeDriver } from "@/lib/integrations/stripe/mock";
import { createRealStripeDriver } from "@/lib/integrations/stripe/real";
import {
  resolveStripeDriver,
  STRIPE_CONFIGURATION_NAMES,
} from "@/lib/integrations/stripe/selector";
import type {
  InvoiceFinancials,
  StripeDriver,
  StripeEvent,
  SubscriptionSnapshot,
} from "@/lib/integrations/stripe/types";
import { createAffiliateRepository } from "@/lib/repositories/affiliates";
import {
  createStripeWebhookRepository,
  type ClaimedStripeWebhookReceipt,
  type StripeProcessingResult,
  type StripeTenantLink,
  type StripeWebhookRepository,
} from "@/lib/repositories/stripe-webhooks";

const MOCK_WEBHOOK_SECRET = "setterfi-synthetic-stripe-webhook-secret";

type CheckoutSubscriptionSnapshot = SubscriptionSnapshot & { customerId: string };

export type CheckoutSubscriptionReader = {
  retrieve(input: { subscriptionId: string; occurredAt: string }): Promise<CheckoutSubscriptionSnapshot>;
};

export type StripeEventProcessorDependencies = {
  repository: StripeWebhookRepository;
  driver: Pick<StripeDriver, "retrieveInvoiceFinancials" | "resolveChargeInvoice">;
  affiliates: Pick<AffiliateService, "accrueInvoice" | "reverseInvoice">;
  notifications: BillingNotificationPort;
  checkoutSubscription?: CheckoutSubscriptionReader;
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

function subscriptionStatus(value: unknown) {
  if (value === "active" || value === "trialing" || value === "past_due" ||
    value === "incomplete" || value === "incomplete_expired" || value === "unpaid" ||
    value === "paused" || value === "canceled") return value;
  return "unavailable" as const;
}

/**
 * A Checkout completion creates its subscription before a separate subscription event is
 * necessarily delivered. Read the provider snapshot here, then the durable webhook repository
 * mirrors it before completing the Checkout receipt. This makes the return journey converge even
 * when Stripe's `customer.subscription.created` event arrives without a later update event.
 */
export function createLiveCheckoutSubscriptionReader(): CheckoutSubscriptionReader | undefined {
  if (driverSelection("stripe", "SETTERFI_STRIPE_DRIVER") === "mock") return undefined;
  const configuration = requireEnvironment("stripe", STRIPE_CONFIGURATION_NAMES);
  const stripe = new Stripe(configuration.STRIPE_SECRET_KEY, {
    apiVersion: "2026-07-29.dahlia",
  });
  return {
    retrieve: async ({ subscriptionId, occurredAt }) => {
      const subscription = object(await stripe.subscriptions.retrieve(subscriptionId));
      const items = object(subscription?.items);
      const rows = Array.isArray(items?.data) ? items.data : [];
      const item = object(rows[0]);
      const customerId = providerId(subscription?.customer);
      const priceId = providerId(object(item?.price));
      if (
        text(subscription?.id) !== subscriptionId || !customerId || !priceId || rows.length !== 1
        || typeof subscription?.cancel_at_period_end !== "boolean"
      ) throw new Error("STRIPE_CHECKOUT_SUBSCRIPTION_ENVELOPE_INVALID");
      return {
        subscriptionId,
        customerId,
        status: subscriptionStatus(subscription?.status),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        currentPeriodStart: isoFromSeconds(
          item?.current_period_start,
          "STRIPE_CHECKOUT_SUBSCRIPTION_PERIOD_INVALID",
        ),
        currentPeriodEnd: isoFromSeconds(
          item?.current_period_end,
          "STRIPE_CHECKOUT_SUBSCRIPTION_PERIOD_INVALID",
        ),
        priceId,
        providerUpdatedAt: occurredAt,
      };
    },
  };
}

function commissionAdjustmentCents(invoice: InvoiceFinancials, adjustmentCents: number) {
  if (
    !Number.isSafeInteger(adjustmentCents)
    || adjustmentCents <= 0
    || !Number.isSafeInteger(invoice.amountPaidCents)
    || invoice.amountPaidCents <= 0
    || invoice.totalExcludingTaxCents === null
    || !Number.isSafeInteger(invoice.totalExcludingTaxCents)
    || invoice.totalExcludingTaxCents < 0
    || invoice.totalExcludingTaxCents > invoice.amountPaidCents
  ) throw new Error("COMMISSION_ADJUSTMENT_BASE_UNAVAILABLE");
  const bounded = Math.min(adjustmentCents, invoice.amountPaidCents);
  const excludingTaxAdjustment = Math.round(
    invoice.totalExcludingTaxCents * bounded / invoice.amountPaidCents,
  );
  return Math.round(excludingTaxAdjustment * 0.1);
}

async function tenantForInvoice(
  repository: StripeWebhookRepository,
  event: Extract<StripeEvent, { type: "invoice.paid" | "invoice.payment_failed" }>,
) {
  if (!event.data.subscriptionId) throw new Error("STRIPE_INVOICE_LINK_MISSING");
  return repository.resolveTenant({
    subscriptionId: event.data.subscriptionId,
    customerId: event.data.customerId,
  });
}

async function tenantForCharge(
  repository: StripeWebhookRepository,
  driver: StripeEventProcessorDependencies["driver"],
  chargeId: string,
) {
  const charge = await driver.resolveChargeInvoice(chargeId);
  const invoice = await driver.retrieveInvoiceFinancials(charge.invoiceId);
  if (
    invoice.invoiceId !== charge.invoiceId
    || invoice.chargeId !== charge.chargeId
    || invoice.currency !== charge.currency
    || !invoice.subscriptionId
  ) throw new Error("STRIPE_CHARGE_INVOICE_LINK_MISMATCH");
  const tenant = await repository.resolveTenant({
    subscriptionId: invoice.subscriptionId,
    customerId: invoice.customerId,
  });
  return { charge, invoice, tenant };
}

async function processCheckout(
  event: Extract<StripeEvent, { type: "checkout.session.completed" }>,
  dependencies: StripeEventProcessorDependencies,
): Promise<StripeProcessingResult> {
  const link = await dependencies.repository.resolveTenant({
    expectedTenantId: event.data.tenantId,
    sessionId: event.data.sessionId,
    customerId: event.data.customerId,
    subscriptionId: event.data.subscriptionId ?? undefined,
  });
  // Stripe creates a subscription only when Checkout completes, so the session record legitimately
  // has no subscription id when this event first arrives. Its signed event is the authoritative
  // binding; preserve all previously resolved custody fields and use that binding for the durable
  // completion write. The following subscription event can then resolve the same local link.
  const checkoutLink = {
    ...link,
    subscriptionId: event.data.subscriptionId,
  };
  if (event.data.subscriptionId && dependencies.checkoutSubscription) {
    const snapshot = await dependencies.checkoutSubscription.retrieve({
      subscriptionId: event.data.subscriptionId,
      occurredAt: event.created,
    });
    if (
      snapshot.subscriptionId !== event.data.subscriptionId
      || snapshot.customerId !== event.data.customerId
    ) throw new Error("STRIPE_CHECKOUT_SUBSCRIPTION_LINK_MISMATCH");
    await dependencies.repository.applySubscription(checkoutLink, {
      id: `checkout:${event.id}`,
      type: "customer.subscription.updated",
      created: event.created,
      data: snapshot,
    });
  }
  const completed = await dependencies.repository.completeCheckout(checkoutLink, event);
  return { kind: "checkout_completed", ...completed };
}

async function processInvoicePaid(
  event: Extract<StripeEvent, { type: "invoice.paid" }>,
  dependencies: StripeEventProcessorDependencies,
): Promise<StripeProcessingResult> {
  if (!event.data.paidAt || event.data.totalExcludingTaxCents === null) {
    throw new Error("COMMISSION_BASE_UNAVAILABLE");
  }
  const link = await tenantForInvoice(dependencies.repository, event);
  const persisted = await dependencies.repository.applyInvoicePaid(link, event);
  const accrual = await dependencies.affiliates.accrueInvoice({
    tenantId: link.tenantId,
    invoiceId: event.data.invoiceId,
    paidAt: event.data.paidAt ?? "",
    amountPaidCents: event.data.amountPaidCents,
    totalExcludingTaxCents: event.data.totalExcludingTaxCents,
  });
  if (accrual && persisted.commissionLedgerId !== accrual.ledgerId) {
    throw new Error("COMMISSION_ACCRUAL_READBACK_MISMATCH");
  }
  if (phase8AlertRuleEventsLive()) {
    const notification = await dependencies.notifications.emit({
      key: "billing.payment_completed",
      tenantId: link.tenantId,
      invoiceId: event.data.invoiceId,
      occurredAt: event.data.paidAt,
      isTest: false,
    });
    if (!notification.notificationId.trim()) throw new Error("BILLING_NOTICE_RECEIPT_INVALID");
  }
  return { kind: "invoice_paid", ...persisted };
}

async function processInvoiceFailed(
  event: Extract<StripeEvent, { type: "invoice.payment_failed" }>,
  dependencies: StripeEventProcessorDependencies,
): Promise<StripeProcessingResult> {
  const link = await tenantForInvoice(dependencies.repository, event);
  const persisted = await dependencies.repository.applyInvoiceFailed(link, event);
  const notificationIds: string[] = [];
  for (const key of ["billing.payment_failed", "billing.account_overdue"] as const) {
    const notification = await dependencies.notifications.emit({
      key,
      tenantId: link.tenantId,
      invoiceId: event.data.invoiceId,
      occurredAt: event.created,
      isTest: false,
    });
    if (!notification.notificationId.trim()) throw new Error("BILLING_NOTICE_RECEIPT_INVALID");
    notificationIds.push(notification.notificationId);
  }
  return { kind: "invoice_failed", ...persisted, notificationIds };
}

async function processSubscription(
  event: Extract<StripeEvent, {
    type: "customer.subscription.updated" | "customer.subscription.deleted";
  }>,
  dependencies: StripeEventProcessorDependencies,
): Promise<StripeProcessingResult> {
  const link = await dependencies.repository.resolveTenant({
    subscriptionId: event.data.subscriptionId,
    customerId: event.data.customerId,
  });
  const persisted = await dependencies.repository.applySubscription(link, event);
  return {
    kind: event.type === "customer.subscription.deleted"
      ? "subscription_deleted"
      : "subscription_updated",
    ...persisted,
  };
}

async function reverseCommission(
  link: StripeTenantLink,
  invoice: InvoiceFinancials,
  input: {
    adjustmentId: string;
    adjustmentKind: "refund" | "dispute_loss" | "dispute_recovery";
    adjustmentCents: number;
    occurredAt: string;
  },
  dependencies: StripeEventProcessorDependencies,
): Promise<StripeProcessingResult> {
  const adjustmentCommissionCents = commissionAdjustmentCents(invoice, input.adjustmentCents);
  if (adjustmentCommissionCents === 0) {
    return {
      kind: "commission_adjustment",
      tenantId: link.tenantId,
      ledgerId: null,
      entryKind: "none",
      reversedCents: 0,
    };
  }
  const receipt = await dependencies.affiliates.reverseInvoice({
    tenantId: link.tenantId,
    invoiceId: invoice.invoiceId,
    adjustmentId: input.adjustmentId,
    adjustmentKind: input.adjustmentKind,
    adjustmentCommissionCents,
    occurredAt: input.occurredAt,
  });
  return {
    kind: "commission_adjustment",
    tenantId: link.tenantId,
    ledgerId: receipt?.ledgerId ?? null,
    entryKind: receipt?.entryKind ?? "none",
    reversedCents: receipt?.reversedCents ?? 0,
  };
}

async function processRefund(
  event: Extract<StripeEvent, { type: "charge.refunded" }>,
  dependencies: StripeEventProcessorDependencies,
) {
  const { invoice, tenant } = await tenantForCharge(
    dependencies.repository,
    dependencies.driver,
    event.data.chargeId,
  );
  return reverseCommission(tenant, invoice, {
    adjustmentId: event.data.adjustmentId,
    adjustmentKind: "refund",
    adjustmentCents: event.data.amountCents,
    occurredAt: event.created,
  }, dependencies);
}

async function processDispute(
  event: Extract<StripeEvent, {
    type: "charge.dispute.created" | "charge.dispute.updated" | "charge.dispute.closed";
  }>,
  dependencies: StripeEventProcessorDependencies,
) {
  const { invoice, tenant } = await tenantForCharge(
    dependencies.repository,
    dependencies.driver,
    event.data.chargeId,
  );
  if (event.type !== "charge.dispute.closed" && event.data.state === "won") {
    return {
      kind: "commission_adjustment",
      tenantId: tenant.tenantId,
      ledgerId: null,
      entryKind: "none",
      reversedCents: 0,
    } satisfies StripeProcessingResult;
  }
  const recovered = event.type === "charge.dispute.closed" && event.data.state === "won";
  return reverseCommission(tenant, invoice, {
    adjustmentId: `dispute:${event.data.disputeId}:${recovered ? "recovery" : "loss"}`,
    adjustmentKind: recovered ? "dispute_recovery" : "dispute_loss",
    adjustmentCents: event.data.amountCents,
    occurredAt: event.created,
  }, dependencies);
}

export async function applyStripeEvent(
  event: StripeEvent,
  dependencies: StripeEventProcessorDependencies,
): Promise<StripeProcessingResult> {
  switch (event.type) {
    case "checkout.session.completed":
      return processCheckout(event, dependencies);
    case "invoice.paid":
      return processInvoicePaid(event, dependencies);
    case "invoice.payment_failed":
      return processInvoiceFailed(event, dependencies);
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return processSubscription(event, dependencies);
    case "charge.refunded":
      return processRefund(event, dependencies);
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      return processDispute(event, dependencies);
    case "unsupported":
      return { kind: "skipped", eventType: event.data.providerType };
  }
}

export async function processClaimedStripeWebhookReceipt(
  receipt: ClaimedStripeWebhookReceipt,
  dependencies: StripeEventProcessorDependencies,
) {
  try {
    const result = await applyStripeEvent(receipt.event, dependencies);
    return await dependencies.repository.completeReceipt(receipt, result);
  } catch (error) {
    await dependencies.repository.failReceipt(receipt, error);
    throw error;
  }
}

export async function processStripeWebhookReceipt(
  receiptId: string,
  dependencies: StripeEventProcessorDependencies,
) {
  const claimed = await dependencies.repository.claimReceipt(receiptId);
  if (claimed) return processClaimedStripeWebhookReceipt(claimed, dependencies);
  const existing = await dependencies.repository.getReceipt(receiptId);
  if (existing.result && (existing.status === "processed" || existing.status === "skipped")) {
    return existing;
  }
  return null;
}

export function unavailableBillingNotificationPort(): BillingNotificationPort {
  return {
    emit: async () => {
      throw new Error("BILLING_EMITTER_UNAVAILABLE");
    },
  };
}

export function createLiveStripeDriver() {
  return resolveStripeDriver({
    factories: {
      mock: () => createMockStripeDriver({ webhookSecret: MOCK_WEBHOOK_SECRET }),
      real: createRealStripeDriver,
    },
  });
}

export function createLiveStripeEventProcessor(
  notifications: BillingNotificationPort = createLiveBillingNotificationPort(),
): StripeEventProcessorDependencies {
  return {
    repository: createStripeWebhookRepository(),
    driver: createLiveStripeDriver(),
    affiliates: createAffiliateService(createAffiliateRepository()),
    notifications,
    checkoutSubscription: createLiveCheckoutSubscriptionReader(),
  };
}

/** Plan 06 appends a durable billing emitter through createLiveStripeEventProcessor. */
export async function processLiveStripeWebhookReceipt(receiptId: string) {
  return processStripeWebhookReceipt(receiptId, createLiveStripeEventProcessor());
}
