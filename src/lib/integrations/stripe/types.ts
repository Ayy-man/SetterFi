/**
 * Stripe's provider-neutral boundary for fixed-price subscription and money events.
 *
 * SDK objects end during normalization. Callers receive only opaque provider identifiers,
 * integer cents, ISO timestamps, and closed event data needed by persisted billing services.
 */

import type { BillingSubscriptionStatus } from "@/lib/billing/contracts";

export type CreateSubscriptionCheckoutInput = {
  tenantId: string;
  tierId: string;
  priceId: string;
  idempotencyKey: string;
  successUrl: string;
  cancelUrl: string;
};

export type SubscriptionCheckoutResult = {
  sessionId: string;
  customerId: string;
  subscriptionId: string | null;
  state: "open" | "completed" | "expired";
  expiresAt: string;
};

export type CreateRenewalPriceScheduleInput = {
  tenantId: string;
  subscriptionId: string;
  currentPriceId: string;
  targetPriceId: string;
  currentPeriodEnd: string;
  idempotencyKey: string;
};

export type RenewalPriceScheduleResult = {
  scheduleId: string;
  subscriptionId: string;
  currentPeriodEnd: string;
  targetPriceId: string;
  state: "scheduled";
};

export type CancelSubscriptionInput = {
  tenantId: string;
  subscriptionId: string;
  idempotencyKey: string;
};

export type SubscriptionSnapshot = {
  subscriptionId: string;
  status: BillingSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  priceId: string;
  providerUpdatedAt: string;
};

export type InvoiceFinancials = {
  invoiceId: string;
  subscriptionId: string | null;
  customerId: string;
  chargeId: string | null;
  amountPaidCents: number;
  totalExcludingTaxCents: number | null;
  currency: string;
  paidAt: string | null;
};

export type ChargeInvoice = {
  chargeId: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
};

type StripeEventEnvelope<TType extends string, TData> = {
  id: string;
  type: TType;
  created: string;
  data: TData;
};

type CheckoutCompletedData = SubscriptionCheckoutResult & {
  tenantId: string;
  tierId: string;
  priceId: string;
  state: "completed";
};

type InvoiceEventData = InvoiceFinancials;

type SubscriptionEventData = SubscriptionSnapshot & {
  customerId: string;
};

type RefundEventData = {
  adjustmentId: string;
  chargeId: string;
  amountCents: number;
  currency: string;
};

type DisputeEventData = {
  disputeId: string;
  chargeId: string;
  amountCents: number;
  currency: string;
  state: "open" | "won" | "lost";
};

export type StripeEvent =
  | StripeEventEnvelope<"checkout.session.completed", CheckoutCompletedData>
  | StripeEventEnvelope<"invoice.paid", InvoiceEventData>
  | StripeEventEnvelope<"invoice.payment_failed", InvoiceEventData>
  | StripeEventEnvelope<"customer.subscription.updated", SubscriptionEventData>
  | StripeEventEnvelope<"customer.subscription.deleted", SubscriptionEventData>
  | StripeEventEnvelope<"charge.refunded", RefundEventData>
  | StripeEventEnvelope<"charge.dispute.created", DisputeEventData>
  | StripeEventEnvelope<"charge.dispute.updated", DisputeEventData>
  | StripeEventEnvelope<"charge.dispute.closed", DisputeEventData>
  | StripeEventEnvelope<"unsupported", { providerType: string }>;

export type StripeDriver = {
  createSubscriptionCheckout(
    input: CreateSubscriptionCheckoutInput,
  ): Promise<SubscriptionCheckoutResult>;
  createRenewalPriceSchedule(
    input: CreateRenewalPriceScheduleInput,
  ): Promise<RenewalPriceScheduleResult>;
  cancelSubscriptionAtPeriodEnd(input: CancelSubscriptionInput): Promise<SubscriptionSnapshot>;
  retrieveInvoiceFinancials(invoiceId: string): Promise<InvoiceFinancials>;
  resolveChargeInvoice(chargeId: string): Promise<ChargeInvoice>;
  /** The real arm defaults to Stripe's 300-second signature tolerance when omitted. */
  verifyWebhook(rawBody: Uint8Array, signature: string, toleranceSeconds?: number): StripeEvent;
};
