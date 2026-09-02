import { describe, expect, it, vi } from "vitest";

import { createMockStripeEventFixtures } from "@/lib/integrations/stripe/mock";

import {
  createStripeWebhookRepository,
  type StripeProcessingResult,
  type StripeWebhookRepositoryDependencies,
} from "./stripe-webhooks";

const fixtures = createMockStripeEventFixtures();
const NOW = new Date("2026-08-18T12:00:00.000Z");

function receipt(event = fixtures.invoicePaid) {
  return {
    id: `receipt-${event.id}`,
    provider: "stripe",
    provider_event_id: event.id,
    tenant_id: null,
    event_type: event.type,
    payload: { normalized: event },
    status: "received",
    attempts: 0,
    error: null,
    received_at: "2026-08-18T11:00:00.000Z",
    processed_at: null,
  };
}

function dependencies() {
  let stored = receipt();
  let inserted = false;
  const values: StripeWebhookRepositoryDependencies = {
    insertReceipt: vi.fn(async (row) => {
      if (inserted) return null;
      inserted = true;
      stored = { ...stored, ...row };
      return stored;
    }),
    readReceiptByEventId: vi.fn(async () => stored),
    readReceiptById: vi.fn(async () => stored),
    compareAndSetClaim: vi.fn(async (input) => {
      if (
        stored.id !== input.id
        || stored.status !== input.expectedStatus
        || stored.attempts !== input.expectedAttempts
        || stored.error !== input.expectedError
      ) return null;
      stored = {
        ...stored,
        status: "received",
        attempts: input.attempts,
        error: input.marker,
      };
      return stored;
    }),
    listRetryable: vi.fn(async () => [stored]),
    finishReceipt: vi.fn(async (input) => {
      if (stored.error !== input.marker) return null;
      stored = {
        ...stored,
        tenant_id: input.tenantId,
        status: input.status,
        payload: input.payload,
        error: null,
        processed_at: input.processedAt,
      };
      return stored;
    }),
    failReceipt: vi.fn(async (input) => {
      if (stored.error !== input.marker) return null;
      stored = { ...stored, status: "failed", error: input.error };
      return { id: stored.id };
    }),
    resolveTenantLink: vi.fn(async () => ({
      tenantId: "tenant_fixture",
      isDemo: false,
      checkoutSessionId: "checkout-row-1",
      tierId: "tier_fixture",
      idempotencyKey: "checkout:tenant_fixture:tier_fixture:price",
      sessionId: fixtures.checkoutCompleted.data.sessionId,
      customerId: fixtures.checkoutCompleted.data.customerId,
      subscriptionId: fixtures.checkoutCompleted.data.subscriptionId,
      expiresAt: fixtures.checkoutCompleted.data.expiresAt,
    })),
    callCompleteCheckout: vi.fn(async () => [{ checkout_session_id: "checkout-row-1", state: "completed" }]),
    readCompletedCheckout: vi.fn(async () => ({
      tenantId: "tenant_fixture",
      checkoutSessionId: "checkout-row-1",
      subscriptionRowId: "subscription-row-1",
    })),
    callSubscriptionSnapshot: vi.fn(async () => [{ subscription_row_id: "subscription-row-1", status: "active" }]),
    readSubscription: vi.fn(async () => ({ tenantId: "tenant_fixture", subscriptionRowId: "subscription-row-1", status: "active" })),
    callInvoicePaid: vi.fn(async () => [{ subscription_row_id: "subscription-row-1", tenant_status: "active", commission_ledger_id: "ledger-1" }]),
    readInvoicePaid: vi.fn(async () => ({ tenantId: "tenant_fixture", subscriptionRowId: "subscription-row-1", tenantStatus: "active", commissionLedgerId: "ledger-1" })),
    callInvoiceFailed: vi.fn(async () => [{ subscription_row_id: "subscription-row-1", tenant_status: "overdue" }]),
    readInvoiceFailed: vi.fn(async () => ({ tenantId: "tenant_fixture", subscriptionRowId: "subscription-row-1", tenantStatus: "overdue" })),
    now: () => NOW,
    claimId: () => "claim-1",
  };
  return {
    values,
    stored: () => stored,
    setStored: (value: typeof stored) => { stored = value; },
  };
}

describe("Stripe webhook repository", () => {
  it("persists one normalized receipt per Stripe event id and returns the existing result on replay", async () => {
    const deps = dependencies();
    const repository = createStripeWebhookRepository(deps.values);
    const first = await repository.persistReceipt(fixtures.invoicePaid);
    expect(first.inserted).toBe(true);

    const claimed = await repository.claimReceipt(first.id);
    const result: StripeProcessingResult = {
      kind: "invoice_paid",
      tenantId: "tenant_fixture",
      subscriptionRowId: "subscription-row-1",
      tenantStatus: "active",
      commissionLedgerId: "ledger-1",
    };
    await repository.completeReceipt(claimed!, result);
    const replay = await repository.persistReceipt(fixtures.invoicePaid);
    expect(replay).toMatchObject({ inserted: false, status: "processed", result });
    expect(await repository.claimReceipt(first.id)).toBeNull();
  });

  it("rejects an event-id collision whose normalized facts changed", async () => {
    const deps = dependencies();
    const repository = createStripeWebhookRepository(deps.values);
    await repository.persistReceipt(fixtures.invoicePaid);
    await expect(repository.persistReceipt({
      ...fixtures.invoicePaid,
      data: { ...fixtures.invoicePaid.data, amountPaidCents: 1 },
    })).rejects.toThrow("STRIPE_RECEIPT_REPLAY_MISMATCH");
  });

  it("uses a bounded compare-and-set claim and refuses a fresh competing lease", async () => {
    const deps = dependencies();
    const repository = createStripeWebhookRepository(deps.values);
    const persisted = await repository.persistReceipt(fixtures.invoicePaid);
    const first = await repository.claimReceipt(persisted.id);
    expect(first).toMatchObject({ attempts: 1, claimToken: expect.stringContaining("STRIPE_CLAIM:") });
    expect(await repository.claimReceipt(persisted.id)).toBeNull();

    const batch = await repository.claimBatch(999);
    expect(batch).toHaveLength(0);
    expect(deps.values.listRetryable).toHaveBeenCalledWith(25);
  });

  it("makes a failed receipt replayable without persisting an arbitrary exception string", async () => {
    const deps = dependencies();
    const repository = createStripeWebhookRepository(deps.values);
    const persisted = await repository.persistReceipt(fixtures.invoicePaid);
    const claimed = await repository.claimReceipt(persisted.id);
    await repository.failReceipt(claimed!, new Error("customer secret and provider payload"));
    expect(deps.stored()).toMatchObject({ status: "failed", error: "STRIPE_PROCESSING_FAILED" });
  });

  it("requires persisted redundant linkage and rejects demo tenants before money RPCs", async () => {
    const deps = dependencies();
    deps.values.resolveTenantLink = vi.fn(async () => ({
      tenantId: "tenant_fixture",
      isDemo: true,
      checkoutSessionId: null,
      tierId: null,
      idempotencyKey: null,
      sessionId: null,
      customerId: fixtures.invoicePaid.data.customerId,
      subscriptionId: fixtures.invoicePaid.data.subscriptionId,
      expiresAt: null,
    }));
    const repository = createStripeWebhookRepository(deps.values);
    await expect(repository.resolveTenant({
      customerId: fixtures.invoicePaid.data.customerId,
      subscriptionId: fixtures.invoicePaid.data.subscriptionId!,
    })).rejects.toThrow("STRIPE_DEMO_TENANT_REJECTED");
    expect(deps.values.callInvoicePaid).not.toHaveBeenCalled();
  });

  it("keeps Checkout replayable until a subscription snapshot has established the mirror", async () => {
    const deps = dependencies();
    deps.values.readCompletedCheckout = vi.fn(async () => null);
    const repository = createStripeWebhookRepository(deps.values);
    const link = await repository.resolveTenant({
      expectedTenantId: "tenant_fixture",
      sessionId: fixtures.checkoutCompleted.data.sessionId,
      customerId: fixtures.checkoutCompleted.data.customerId,
      subscriptionId: fixtures.checkoutCompleted.data.subscriptionId!,
    });
    await expect(repository.completeCheckout(link, fixtures.checkoutCompleted))
      .rejects.toThrow("STRIPE_SUBSCRIPTION_SNAPSHOT_REQUIRED");
    expect(deps.values.callCompleteCheckout).toHaveBeenCalledTimes(1);
  });

  it("passes every persisted Stripe subscription status to the mirror unchanged", async () => {
    const deps = dependencies();
    const repository = createStripeWebhookRepository(deps.values);
    const link = await repository.resolveTenant({
      customerId: fixtures.subscriptionUpdated.data.customerId,
      subscriptionId: fixtures.subscriptionUpdated.data.subscriptionId,
    });
    for (const status of ["incomplete_expired", "unpaid", "paused"] as const) {
      await repository.applySubscription(link, {
        ...fixtures.subscriptionUpdated,
        id: `${fixtures.subscriptionUpdated.id}-${status}`,
        data: { ...fixtures.subscriptionUpdated.data, status },
      });
    }
    expect(deps.values.callSubscriptionSnapshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ snapshot: expect.objectContaining({ status: "incomplete_expired" }) }),
    );
    expect(deps.values.callSubscriptionSnapshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ snapshot: expect.objectContaining({ status: "unpaid" }) }),
    );
    expect(deps.values.callSubscriptionSnapshot).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ snapshot: expect.objectContaining({ status: "paused" }) }),
    );
  });

  it("defers an unknown Stripe subscription status without mutating the mirror", async () => {
    const deps = dependencies();
    const repository = createStripeWebhookRepository(deps.values);
    const link = await repository.resolveTenant({
      customerId: fixtures.subscriptionUpdated.data.customerId,
      subscriptionId: fixtures.subscriptionUpdated.data.subscriptionId,
    });

    await expect(repository.applySubscription(link, {
      ...fixtures.subscriptionUpdated,
      id: `${fixtures.subscriptionUpdated.id}-future-status`,
      data: { ...fixtures.subscriptionUpdated.data, status: "unavailable" },
    })).rejects.toThrow("STRIPE_SUBSCRIPTION_STATUS_UNAVAILABLE");

    expect(deps.values.callSubscriptionSnapshot).not.toHaveBeenCalled();
    expect(deps.values.readSubscription).not.toHaveBeenCalled();
  });

  it("refuses a failed-invoice result that ever reports the tenant as suspended", async () => {
    const deps = dependencies();
    deps.values.readInvoiceFailed = vi.fn(async () => ({
      tenantId: "tenant_fixture",
      subscriptionRowId: "subscription-row-1",
      tenantStatus: "suspended",
    }));
    const repository = createStripeWebhookRepository(deps.values);
    const link = await repository.resolveTenant({
      customerId: fixtures.invoicePaymentFailed.data.customerId,
      subscriptionId: fixtures.invoicePaymentFailed.data.subscriptionId!,
    });
    await expect(repository.applyInvoiceFailed(link, fixtures.invoicePaymentFailed))
      .rejects.toThrow("STRIPE_INVOICE_FAILED_SUSPENSION_FORBIDDEN");
  });
});
