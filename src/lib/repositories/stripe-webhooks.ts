/**
 * Durable Stripe inbox and guarded money-mirror repository.
 *
 * Only normalized provider events cross this boundary. The existing shared webhook table has no
 * processing status or lease columns, so claim ownership is encoded as a short-lived value-free
 * marker in its error field and every transition is a compare-and-set.
 */

import { randomUUID } from "node:crypto";

import type { StripeEvent, SubscriptionSnapshot } from "@/lib/integrations/stripe/types";
import { claimFairStripeReceiptIds } from "@/lib/jobs/fair-scan";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const CLAIM_PREFIX = "STRIPE_CLAIM:";
const CLAIM_LEASE_MS = 5 * 60_000;
export const STRIPE_WEBHOOK_BATCH_LIMIT = 25;

export type StripeProcessingResult =
  | {
      kind: "checkout_completed";
      tenantId: string;
      checkoutSessionId: string;
      subscriptionRowId: string;
    }
  | {
      kind: "invoice_paid";
      tenantId: string;
      subscriptionRowId: string;
      tenantStatus: string;
      commissionLedgerId: string | null;
    }
  | {
      kind: "invoice_failed";
      tenantId: string;
      subscriptionRowId: string;
      tenantStatus: string;
      notificationIds: readonly string[];
    }
  | {
      kind: "subscription_updated" | "subscription_deleted";
      tenantId: string;
      subscriptionRowId: string;
      status: string;
    }
  | {
      kind: "commission_adjustment";
      tenantId: string;
      ledgerId: string | null;
      entryKind: "offset" | "recovery" | "none";
      reversedCents: number;
    }
  | { kind: "skipped"; eventType: string };

export type StripeWebhookReceipt = {
  id: string;
  eventId: string;
  eventType: string;
  tenantId: string | null;
  event: StripeEvent;
  status: "received" | "processed" | "failed" | "skipped";
  attempts: number;
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
  result: StripeProcessingResult | null;
  inserted: boolean;
};

export type ClaimedStripeWebhookReceipt = StripeWebhookReceipt & {
  claimToken: string;
};

export type StripeTenantLink = {
  tenantId: string;
  isDemo: boolean;
  checkoutSessionId: string | null;
  tierId: string | null;
  idempotencyKey: string | null;
  sessionId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  expiresAt: string | null;
};

export type CheckoutCompletionReceipt = {
  tenantId: string;
  checkoutSessionId: string;
  subscriptionRowId: string;
};

export type SubscriptionMutationReceipt = {
  tenantId: string;
  subscriptionRowId: string;
  status: string;
};

export type InvoicePaidReceipt = {
  tenantId: string;
  subscriptionRowId: string;
  tenantStatus: string;
  commissionLedgerId: string | null;
};

export type InvoiceFailedReceipt = {
  tenantId: string;
  subscriptionRowId: string;
  tenantStatus: string;
};

type BillingMirrorSnapshot = Omit<SubscriptionSnapshot, "status"> & {
  status: "trialing" | "active" | "past_due" | "incomplete" | "incomplete_expired"
    | "unpaid" | "paused" | "canceled";
};

type ReceiptWrite = {
  provider: "stripe";
  provider_event_id: string;
  tenant_id: string | null;
  event_type: string;
  signature_verified: true;
  payload: { normalized: StripeEvent; result?: StripeProcessingResult };
  status: "received";
  attempts: number;
  error: null;
};

type ReceiptClaim = {
  id: string;
  expectedStatus: "received" | "failed";
  expectedAttempts: number;
  expectedError: string | null;
  attempts: number;
  marker: string;
};

type ReceiptFinish = {
  id: string;
  marker: string;
  tenantId: string | null;
  status: "processed" | "skipped";
  processedAt: string;
  payload: { normalized: StripeEvent; result: StripeProcessingResult };
};

export type StripeWebhookRepositoryDependencies = {
  insertReceipt(row: ReceiptWrite): Promise<unknown>;
  readReceiptByEventId(eventId: string): Promise<unknown>;
  readReceiptById(receiptId: string): Promise<unknown>;
  compareAndSetClaim(input: ReceiptClaim): Promise<unknown>;
  listRetryable(limit: number): Promise<unknown>;
  finishReceipt(input: ReceiptFinish): Promise<unknown>;
  failReceipt(input: { id: string; marker: string; error: string }): Promise<unknown>;
  resolveTenantLink(input: {
    expectedTenantId?: string;
    sessionId?: string;
    customerId?: string;
    subscriptionId?: string;
  }): Promise<StripeTenantLink | null>;
  callCompleteCheckout(input: {
    link: StripeTenantLink;
    event: Extract<StripeEvent, { type: "checkout.session.completed" }>;
  }): Promise<unknown>;
  readCompletedCheckout(input: {
    link: StripeTenantLink;
    event: Extract<StripeEvent, { type: "checkout.session.completed" }>;
  }): Promise<CheckoutCompletionReceipt | null>;
  callSubscriptionSnapshot(input: {
    tenantId: string;
    customerId: string;
    snapshot: BillingMirrorSnapshot;
  }): Promise<unknown>;
  readSubscription(input: {
    tenantId: string;
    customerId: string;
    subscriptionId: string;
  }): Promise<SubscriptionMutationReceipt | null>;
  callInvoicePaid(input: {
    tenantId: string;
    event: Extract<StripeEvent, { type: "invoice.paid" }>;
  }): Promise<unknown>;
  readInvoicePaid(input: {
    tenantId: string;
    event: Extract<StripeEvent, { type: "invoice.paid" }>;
    rpc: unknown;
  }): Promise<InvoicePaidReceipt | null>;
  callInvoiceFailed(input: {
    tenantId: string;
    event: Extract<StripeEvent, { type: "invoice.payment_failed" }>;
  }): Promise<unknown>;
  readInvoiceFailed(input: {
    tenantId: string;
    event: Extract<StripeEvent, { type: "invoice.payment_failed" }>;
    rpc: unknown;
  }): Promise<InvoiceFailedReceipt | null>;
  now(): Date;
  claimId(): string;
};

export type StripeWebhookRepository = {
  persistReceipt(event: StripeEvent): Promise<StripeWebhookReceipt>;
  getReceipt(receiptId: string): Promise<StripeWebhookReceipt>;
  claimReceipt(receiptId: string): Promise<ClaimedStripeWebhookReceipt | null>;
  claimBatch(limit?: number): Promise<readonly ClaimedStripeWebhookReceipt[]>;
  completeReceipt(
    receipt: ClaimedStripeWebhookReceipt,
    result: StripeProcessingResult,
  ): Promise<StripeWebhookReceipt>;
  failReceipt(receipt: ClaimedStripeWebhookReceipt, error: unknown): Promise<void>;
  resolveTenant(input: {
    expectedTenantId?: string;
    sessionId?: string;
    customerId?: string;
    subscriptionId?: string;
  }): Promise<StripeTenantLink>;
  completeCheckout(
    link: StripeTenantLink,
    event: Extract<StripeEvent, { type: "checkout.session.completed" }>,
  ): Promise<CheckoutCompletionReceipt>;
  applySubscription(
    link: StripeTenantLink,
    event: Extract<StripeEvent, {
      type: "customer.subscription.updated" | "customer.subscription.deleted";
    }>,
  ): Promise<SubscriptionMutationReceipt>;
  applyInvoicePaid(
    link: StripeTenantLink,
    event: Extract<StripeEvent, { type: "invoice.paid" }>,
  ): Promise<InvoicePaidReceipt>;
  applyInvoiceFailed(
    link: StripeTenantLink,
    event: Extract<StripeEvent, { type: "invoice.payment_failed" }>,
  ): Promise<InvoiceFailedReceipt>;
};

export class StripeWebhookRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StripeWebhookRepositoryError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rowFrom(value: unknown) {
  return object(Array.isArray(value) ? value[0] : value);
}

function safeInteger(value: unknown) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) ? parsed : null;
}

function parseResult(value: unknown): StripeProcessingResult | null {
  const row = object(value);
  if (!row || typeof row.kind !== "string") return null;
  return row as StripeProcessingResult;
}

function parseEvent(value: unknown): StripeEvent | null {
  const row = object(value);
  const data = object(row?.data);
  if (!row || typeof row.id !== "string" || typeof row.type !== "string" || !data) return null;
  return row as StripeEvent;
}

function parseReceipt(value: unknown, inserted: boolean): StripeWebhookReceipt {
  const row = rowFrom(value);
  const payload = object(row?.payload);
  const event = parseEvent(payload?.normalized);
  const attempts = safeInteger(row?.attempts);
  if (
    !row
    || typeof row.id !== "string"
    || row.provider !== "stripe"
    || typeof row.provider_event_id !== "string"
    || typeof row.event_type !== "string"
    || !["received", "processed", "failed", "skipped"].includes(String(row.status))
    || attempts === null
    || typeof row.received_at !== "string"
    || !event
  ) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_INVALID");
  return {
    id: row.id,
    eventId: row.provider_event_id,
    eventType: row.event_type,
    tenantId: typeof row.tenant_id === "string" ? row.tenant_id : null,
    event,
    status: row.status as StripeWebhookReceipt["status"],
    attempts,
    error: typeof row.error === "string" ? row.error : null,
    receivedAt: row.received_at,
    processedAt: typeof row.processed_at === "string" ? row.processed_at : null,
    result: parseResult(payload?.result),
    inserted,
  };
}

function claimMarker(now: Date, id: string) {
  return `${CLAIM_PREFIX}${now.toISOString()}:${id}`;
}

function claimStartedAt(error: string | null) {
  if (!error?.startsWith(CLAIM_PREFIX)) return null;
  const timestamp = error.slice(CLAIM_PREFIX.length).split(":").slice(0, 3).join(":");
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function safeStripeProcessingError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_.:-]{2,239}$/.test(message)
    ? message
    : "STRIPE_PROCESSING_FAILED";
}

function sameEvent(receipt: StripeWebhookReceipt, event: StripeEvent) {
  return receipt.eventId === event.id
    && receipt.eventType === event.type
    && JSON.stringify(receipt.event) === JSON.stringify(event);
}

function rpcRow(value: unknown, code: string) {
  const row = rowFrom(value);
  if (!row) throw new StripeWebhookRepositoryError(code);
  return row;
}

async function liveDependencies(): Promise<StripeWebhookRepositoryDependencies> {
  const client = createSupabaseServiceClient();
  const receiptColumns = "id,provider,provider_event_id,tenant_id,event_type,payload,status,attempts,error,received_at,processed_at";

  async function oneTenantBy(
    table: "stripe_checkout_sessions" | "billing_subscriptions" | "commission_ledger" | "tenants",
    column: string,
    value: string,
    select: string,
  ) {
    const { data, error } = await client.from(table).select(select).eq(column, value).maybeSingle();
    if (error) throw new StripeWebhookRepositoryError("STRIPE_TENANT_LINK_READ_FAILED");
    return data as Record<string, unknown> | null;
  }

  return {
    insertReceipt: async (row) => {
      const { data, error } = await client
        .from("webhook_events")
        .upsert(row, { onConflict: "provider,provider_event_id", ignoreDuplicates: true })
        .select(receiptColumns)
        .maybeSingle();
      if (error) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_WRITE_FAILED");
      return data;
    },
    readReceiptByEventId: async (eventId) => {
      const { data, error } = await client.from("webhook_events").select(receiptColumns)
        .eq("provider", "stripe").eq("provider_event_id", eventId).maybeSingle();
      if (error) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_READ_FAILED");
      return data;
    },
    readReceiptById: async (receiptId) => {
      const { data, error } = await client.from("webhook_events").select(receiptColumns)
        .eq("provider", "stripe").eq("id", receiptId).maybeSingle();
      if (error) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_READ_FAILED");
      return data;
    },
    compareAndSetClaim: async (input) => {
      let query = client.from("webhook_events").update({
        status: "received",
        attempts: input.attempts,
        error: input.marker,
        processed_at: null,
      }).eq("provider", "stripe").eq("id", input.id)
        .eq("status", input.expectedStatus).eq("attempts", input.expectedAttempts);
      query = input.expectedError === null
        ? query.is("error", null)
        : query.eq("error", input.expectedError);
      const { data, error } = await query.select(receiptColumns).maybeSingle();
      if (error) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_CLAIM_FAILED");
      return data;
    },
    listRetryable: async (limit) => {
      const receiptIds = await claimFairStripeReceiptIds(client, limit);
      if (receiptIds.length === 0) return [];
      const { data, error } = await client.from("webhook_events").select(receiptColumns)
        .eq("provider", "stripe").in("status", ["received", "failed"])
        .in("id", receiptIds);
      if (error) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_LIST_FAILED");
      const order = new Map(receiptIds.map((receiptId, index) => [receiptId, index]));
      return [...(data ?? [])].sort((left, right) =>
        (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
    },
    finishReceipt: async (input) => {
      const { data, error } = await client.from("webhook_events").update({
        tenant_id: input.tenantId,
        status: input.status,
        payload: input.payload,
        error: null,
        processed_at: input.processedAt,
      }).eq("provider", "stripe").eq("id", input.id).eq("status", "received")
        .eq("error", input.marker).select(receiptColumns).maybeSingle();
      if (error) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_FINISH_FAILED");
      return data;
    },
    failReceipt: async (input) => {
      const { data, error } = await client.from("webhook_events").update({
        status: "failed",
        error: input.error,
        processed_at: null,
      }).eq("provider", "stripe").eq("id", input.id).eq("status", "received")
        .eq("error", input.marker).select("id").maybeSingle();
      if (error || !data) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_FAIL_FAILED");
      return data;
    },
    resolveTenantLink: async (input) => {
      const candidates: Array<Record<string, unknown>> = [];
      if (input.sessionId) {
        const row = await oneTenantBy(
          "stripe_checkout_sessions",
          "stripe_session_id",
          input.sessionId,
          "id,tenant_id,tier_id,idempotency_key,stripe_session_id,stripe_customer_id,stripe_subscription_id,expires_at",
        );
        if (row) candidates.push(row);
      }
      for (const [column, value] of [
        ["stripe_subscription_id", input.subscriptionId],
        ["stripe_customer_id", input.customerId],
      ] as const) {
        if (!value) continue;
        const checkout = await oneTenantBy(
          "stripe_checkout_sessions",
          column,
          value,
          "id,tenant_id,tier_id,idempotency_key,stripe_session_id,stripe_customer_id,stripe_subscription_id,expires_at",
        );
        if (checkout) candidates.push(checkout);
        const subscription = await oneTenantBy(
          "billing_subscriptions",
          column,
          value,
          "tenant_id,stripe_customer_id,stripe_subscription_id",
        );
        if (subscription) candidates.push(subscription);
        const tenant = await oneTenantBy("tenants", column, value, "id,is_demo,stripe_customer_id,stripe_subscription_id");
        if (tenant) candidates.push({ ...tenant, tenant_id: tenant.id });
      }
      if (input.expectedTenantId) candidates.push({ tenant_id: input.expectedTenantId });
      const tenantIds = [...new Set(candidates.map((row) => row.tenant_id).filter((id): id is string => typeof id === "string"))];
      if (tenantIds.length !== 1) return null;
      const tenantId = tenantIds[0];
      const tenant = await oneTenantBy("tenants", "id", tenantId, "id,is_demo,stripe_customer_id,stripe_subscription_id");
      if (!tenant) return null;
      const checkout = candidates.find((row) => typeof row.id === "string" && typeof row.tier_id === "string");
      const customerIds = [...new Set(candidates.map((row) => row.stripe_customer_id).filter((id): id is string => typeof id === "string"))];
      const subscriptionIds = [...new Set(candidates.map((row) => row.stripe_subscription_id).filter((id): id is string => typeof id === "string"))];
      if (customerIds.length > 1 || subscriptionIds.length > 1) return null;
      return {
        tenantId,
        isDemo: tenant.is_demo === true,
        checkoutSessionId: typeof checkout?.id === "string" ? checkout.id : null,
        tierId: typeof checkout?.tier_id === "string" ? checkout.tier_id : null,
        idempotencyKey: typeof checkout?.idempotency_key === "string" ? checkout.idempotency_key : null,
        sessionId: typeof checkout?.stripe_session_id === "string" ? checkout.stripe_session_id : input.sessionId ?? null,
        customerId: customerIds[0] ?? input.customerId ?? null,
        subscriptionId: subscriptionIds[0] ?? input.subscriptionId ?? null,
        expiresAt: typeof checkout?.expires_at === "string" ? checkout.expires_at : null,
      };
    },
    callCompleteCheckout: async ({ link, event }) => {
      const { data, error } = await client.rpc("record_stripe_checkout_session", {
        p_expected_tenant: link.tenantId,
        p_actor_id: null,
        p_tier_id: link.tierId,
        p_idempotency_key: link.idempotencyKey,
        p_stripe_session_id: event.data.sessionId,
        p_stripe_customer_id: event.data.customerId,
        p_stripe_subscription_id: event.data.subscriptionId,
        p_state: "completed",
        p_expires_at: event.data.expiresAt,
        p_completed_at: event.created,
      });
      if (error) throw new StripeWebhookRepositoryError("STRIPE_CHECKOUT_COMPLETE_FAILED");
      return data;
    },
    readCompletedCheckout: async ({ event }) => {
      if (!event.data.subscriptionId) return null;
      const [checkout, subscription] = await Promise.all([
        oneTenantBy(
          "stripe_checkout_sessions",
          "stripe_session_id",
          event.data.sessionId,
          "id,tenant_id,tier_id,idempotency_key,stripe_customer_id,stripe_subscription_id,state",
        ),
        oneTenantBy(
          "billing_subscriptions",
          "stripe_subscription_id",
          event.data.subscriptionId,
          "id,tenant_id,stripe_customer_id,stripe_subscription_id",
        ),
      ]);
      if (!checkout || !subscription) return null;
      return {
        tenantId: String(checkout.tenant_id),
        checkoutSessionId: String(checkout.id),
        subscriptionRowId: String(subscription.id),
      };
    },
    callSubscriptionSnapshot: async ({ tenantId, customerId, snapshot }) => {
      const { data, error } = await client.rpc("apply_billing_subscription_snapshot", {
        p_expected_tenant: tenantId,
        p_stripe_customer_id: customerId,
        p_stripe_subscription_id: snapshot.subscriptionId,
        p_stripe_price_id: snapshot.priceId,
        p_status: snapshot.status,
        p_current_period_start: snapshot.currentPeriodStart,
        p_current_period_end: snapshot.currentPeriodEnd,
        p_cancel_at_period_end: snapshot.cancelAtPeriodEnd,
        p_provider_updated_at: snapshot.providerUpdatedAt,
      });
      if (error) throw new StripeWebhookRepositoryError("STRIPE_SUBSCRIPTION_APPLY_FAILED");
      return data;
    },
    readSubscription: async ({ tenantId, customerId, subscriptionId }) => {
      const row = await oneTenantBy(
        "billing_subscriptions",
        "stripe_subscription_id",
        subscriptionId,
        "id,tenant_id,stripe_customer_id,status",
      );
      if (!row || row.tenant_id !== tenantId || row.stripe_customer_id !== customerId) return null;
      return { tenantId, subscriptionRowId: String(row.id), status: String(row.status) };
    },
    callInvoicePaid: async ({ tenantId, event }) => {
      const { data, error } = await client.rpc("apply_stripe_invoice_paid", {
        p_expected_tenant: tenantId,
        p_stripe_subscription_id: event.data.subscriptionId,
        p_stripe_invoice_id: event.data.invoiceId,
        p_invoice_paid_at: event.data.paidAt,
        p_amount_paid_cents: event.data.amountPaidCents,
        p_total_excluding_tax_cents: event.data.totalExcludingTaxCents,
        p_provider_updated_at: event.created,
      });
      if (error) throw new StripeWebhookRepositoryError("STRIPE_INVOICE_PAID_APPLY_FAILED");
      return data;
    },
    readInvoicePaid: async ({ tenantId, event, rpc }) => {
      const result = rpcRow(rpc, "STRIPE_INVOICE_PAID_RECEIPT_INVALID");
      const subscriptionRowId = result.subscription_row_id;
      const tenantStatus = result.tenant_status;
      const ledgerId = typeof result.commission_ledger_id === "string" ? result.commission_ledger_id : null;
      if (typeof subscriptionRowId !== "string" || typeof tenantStatus !== "string") return null;
      const [subscription, tenant, ledger] = await Promise.all([
        oneTenantBy("billing_subscriptions", "id", subscriptionRowId, "id,tenant_id,stripe_subscription_id,status"),
        oneTenantBy("tenants", "id", tenantId, "id,status"),
        ledgerId ? oneTenantBy("commission_ledger", "id", ledgerId, "id,stripe_invoice_id,entry_kind") : null,
      ]);
      if (
        !subscription || subscription.tenant_id !== tenantId
        || subscription.stripe_subscription_id !== event.data.subscriptionId
        || tenant?.status !== tenantStatus
        || (ledgerId && (!ledger || ledger.stripe_invoice_id !== event.data.invoiceId || ledger.entry_kind !== "accrual"))
      ) return null;
      return { tenantId, subscriptionRowId, tenantStatus, commissionLedgerId: ledgerId };
    },
    callInvoiceFailed: async ({ tenantId, event }) => {
      const { data, error } = await client.rpc("apply_stripe_invoice_failed", {
        p_expected_tenant: tenantId,
        p_stripe_subscription_id: event.data.subscriptionId,
        p_stripe_invoice_id: event.data.invoiceId,
        p_provider_updated_at: event.created,
      });
      if (error) throw new StripeWebhookRepositoryError("STRIPE_INVOICE_FAILED_APPLY_FAILED");
      return data;
    },
    readInvoiceFailed: async ({ tenantId, event, rpc }) => {
      const result = rpcRow(rpc, "STRIPE_INVOICE_FAILED_RECEIPT_INVALID");
      if (typeof result.subscription_row_id !== "string" || typeof result.tenant_status !== "string") return null;
      const [subscription, tenant] = await Promise.all([
        oneTenantBy("billing_subscriptions", "id", result.subscription_row_id, "id,tenant_id,stripe_subscription_id,status"),
        oneTenantBy("tenants", "id", tenantId, "id,status"),
      ]);
      if (
        !subscription || subscription.tenant_id !== tenantId
        || subscription.stripe_subscription_id !== event.data.subscriptionId
        || subscription.status !== "past_due"
        || tenant?.status !== result.tenant_status
      ) return null;
      return {
        tenantId,
        subscriptionRowId: result.subscription_row_id,
        tenantStatus: result.tenant_status,
      };
    },
    now: () => new Date(),
    claimId: randomUUID,
  };
}

export function createStripeWebhookRepository(
  provided?: StripeWebhookRepositoryDependencies,
): StripeWebhookRepository {
  const dependencies = async () => provided ?? (await liveDependencies());
  return {
    persistReceipt: async (event) => {
      if (!event.id.trim()) throw new StripeWebhookRepositoryError("STRIPE_EVENT_ID_REQUIRED");
      const deps = await dependencies();
      const inserted = await deps.insertReceipt({
        provider: "stripe",
        provider_event_id: event.id,
        tenant_id: null,
        event_type: event.type,
        signature_verified: true,
        payload: { normalized: event },
        status: "received",
        attempts: 0,
        error: null,
      });
      const receipt = parseReceipt(
        inserted ?? await deps.readReceiptByEventId(event.id),
        Boolean(inserted),
      );
      if (!sameEvent(receipt, event)) {
        throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_REPLAY_MISMATCH");
      }
      return receipt;
    },
    getReceipt: async (receiptId) => parseReceipt(
      await (await dependencies()).readReceiptById(receiptId),
      false,
    ),
    claimReceipt: async (receiptId) => {
      const deps = await dependencies();
      const receipt = parseReceipt(await deps.readReceiptById(receiptId), false);
      if (receipt.status === "processed" || receipt.status === "skipped") return null;
      const now = deps.now();
      const startedAt = claimStartedAt(receipt.error);
      if (startedAt !== null && now.getTime() - startedAt < CLAIM_LEASE_MS) return null;
      const marker = claimMarker(now, deps.claimId());
      const claimed = await deps.compareAndSetClaim({
        id: receipt.id,
        expectedStatus: receipt.status,
        expectedAttempts: receipt.attempts,
        expectedError: receipt.error,
        attempts: receipt.attempts + 1,
        marker,
      });
      if (!claimed) return null;
      return { ...parseReceipt(claimed, false), claimToken: marker };
    },
    claimBatch: async (limit = STRIPE_WEBHOOK_BATCH_LIMIT) => {
      const deps = await dependencies();
      const bounded = Math.min(Math.max(Math.trunc(limit), 1), STRIPE_WEBHOOK_BATCH_LIMIT);
      const rows = await deps.listRetryable(bounded);
      if (!Array.isArray(rows)) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_LIST_INVALID");
      const claimed: ClaimedStripeWebhookReceipt[] = [];
      for (const row of rows.slice(0, bounded)) {
        const receipt = parseReceipt(row, false);
        const claim = await createStripeWebhookRepository(deps).claimReceipt(receipt.id);
        if (claim) claimed.push(claim);
      }
      return claimed;
    },
    completeReceipt: async (receipt, result) => {
      const deps = await dependencies();
      const status = result.kind === "skipped" ? "skipped" as const : "processed" as const;
      const completed = await deps.finishReceipt({
        id: receipt.id,
        marker: receipt.claimToken,
        tenantId: "tenantId" in result ? result.tenantId : null,
        status,
        processedAt: deps.now().toISOString(),
        payload: { normalized: receipt.event, result },
      });
      if (!completed) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_CLAIM_LOST");
      const persisted = parseReceipt(completed, false);
      if (persisted.status !== status || JSON.stringify(persisted.result) !== JSON.stringify(result)) {
        throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_FINISH_READBACK_MISMATCH");
      }
      return persisted;
    },
    failReceipt: async (receipt, error) => {
      const deps = await dependencies();
      const failed = await deps.failReceipt({
        id: receipt.id,
        marker: receipt.claimToken,
        error: safeStripeProcessingError(error),
      });
      if (!failed) throw new StripeWebhookRepositoryError("STRIPE_RECEIPT_CLAIM_LOST");
    },
    resolveTenant: async (input) => {
      const link = await (await dependencies()).resolveTenantLink(input);
      if (!link) throw new StripeWebhookRepositoryError("STRIPE_TENANT_LINK_UNRESOLVED");
      if (input.expectedTenantId && link.tenantId !== input.expectedTenantId) {
        throw new StripeWebhookRepositoryError("STRIPE_EVENT_TENANT_MISMATCH");
      }
      if (input.sessionId && link.sessionId && link.sessionId !== input.sessionId) {
        throw new StripeWebhookRepositoryError("STRIPE_EVENT_SESSION_MISMATCH");
      }
      if (input.customerId && link.customerId && link.customerId !== input.customerId) {
        throw new StripeWebhookRepositoryError("STRIPE_EVENT_CUSTOMER_MISMATCH");
      }
      if (input.subscriptionId && link.subscriptionId && link.subscriptionId !== input.subscriptionId) {
        throw new StripeWebhookRepositoryError("STRIPE_EVENT_SUBSCRIPTION_MISMATCH");
      }
      if (link.isDemo) throw new StripeWebhookRepositoryError("STRIPE_DEMO_TENANT_REJECTED");
      return link;
    },
    completeCheckout: async (link, event) => {
      if (
        !link.checkoutSessionId || !link.tierId || !link.idempotencyKey
        || !event.data.subscriptionId
        || event.data.tenantId !== link.tenantId
        || event.data.tierId !== link.tierId
        || event.data.sessionId !== link.sessionId
        || event.data.customerId !== link.customerId
        || event.data.subscriptionId !== link.subscriptionId
      ) throw new StripeWebhookRepositoryError("STRIPE_CHECKOUT_LINK_MISMATCH");
      const deps = await dependencies();
      await deps.callCompleteCheckout({ link, event });
      const persisted = await deps.readCompletedCheckout({ link, event });
      if (
        !persisted
        || persisted.tenantId !== link.tenantId
        || persisted.checkoutSessionId !== link.checkoutSessionId
        || !persisted.subscriptionRowId
      ) {
        // The frozen normalized Checkout event has no period snapshot. A subscription event must
        // establish the mirror before this receipt can complete; retry then converges in any order.
        throw new StripeWebhookRepositoryError("STRIPE_SUBSCRIPTION_SNAPSHOT_REQUIRED");
      }
      return persisted;
    },
    applySubscription: async (link, event) => {
      if (
        event.data.subscriptionId !== link.subscriptionId
        || event.data.customerId !== link.customerId
      ) throw new StripeWebhookRepositoryError("STRIPE_SUBSCRIPTION_LINK_MISMATCH");
      if (event.type !== "customer.subscription.deleted" && event.data.status === "unavailable") {
        throw new StripeWebhookRepositoryError("STRIPE_SUBSCRIPTION_STATUS_UNAVAILABLE");
      }
      const deps = await dependencies();
      const snapshot: BillingMirrorSnapshot = event.type === "customer.subscription.deleted"
        ? { ...event.data, status: "canceled", cancelAtPeriodEnd: true }
        : event.data.status === "unavailable"
          ? (() => { throw new StripeWebhookRepositoryError("STRIPE_SUBSCRIPTION_STATUS_UNAVAILABLE"); })()
          : { ...event.data, status: event.data.status };
      await deps.callSubscriptionSnapshot({
        tenantId: link.tenantId,
        customerId: event.data.customerId,
        snapshot,
      });
      const persisted = await deps.readSubscription({
        tenantId: link.tenantId,
        customerId: event.data.customerId,
        subscriptionId: event.data.subscriptionId,
      });
      if (!persisted) throw new StripeWebhookRepositoryError("STRIPE_SUBSCRIPTION_READBACK_MISMATCH");
      return persisted;
    },
    applyInvoicePaid: async (link, event) => {
      if (!event.data.subscriptionId || event.data.subscriptionId !== link.subscriptionId) {
        throw new StripeWebhookRepositoryError("STRIPE_INVOICE_SUBSCRIPTION_MISMATCH");
      }
      if (!event.data.paidAt || event.data.totalExcludingTaxCents === null) {
        throw new StripeWebhookRepositoryError("COMMISSION_BASE_UNAVAILABLE");
      }
      const deps = await dependencies();
      const rpc = await deps.callInvoicePaid({ tenantId: link.tenantId, event });
      const persisted = await deps.readInvoicePaid({ tenantId: link.tenantId, event, rpc });
      if (!persisted) throw new StripeWebhookRepositoryError("STRIPE_INVOICE_PAID_READBACK_MISMATCH");
      return persisted;
    },
    applyInvoiceFailed: async (link, event) => {
      if (!event.data.subscriptionId || event.data.subscriptionId !== link.subscriptionId) {
        throw new StripeWebhookRepositoryError("STRIPE_INVOICE_SUBSCRIPTION_MISMATCH");
      }
      const deps = await dependencies();
      const rpc = await deps.callInvoiceFailed({ tenantId: link.tenantId, event });
      const persisted = await deps.readInvoiceFailed({ tenantId: link.tenantId, event, rpc });
      if (!persisted) throw new StripeWebhookRepositoryError("STRIPE_INVOICE_FAILED_READBACK_MISMATCH");
      if (persisted.tenantStatus === "suspended") {
        throw new StripeWebhookRepositoryError("STRIPE_INVOICE_FAILED_SUSPENSION_FORBIDDEN");
      }
      return persisted;
    },
  };
}
