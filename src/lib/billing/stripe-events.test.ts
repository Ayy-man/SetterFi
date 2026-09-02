import { describe, expect, it, vi } from "vitest";

import {
  createMockStripeDriver,
  createMockStripeEventFixtures,
} from "@/lib/integrations/stripe/mock";
import type { StripeEvent } from "@/lib/integrations/stripe/types";
import type {
  StripeProcessingResult,
  StripeWebhookReceipt,
  StripeWebhookRepository,
} from "@/lib/repositories/stripe-webhooks";

import {
  applyStripeEvent,
  processClaimedStripeWebhookReceipt,
  processStripeWebhookReceipt,
  type StripeEventProcessorDependencies,
} from "./stripe-events";

const fixtures = createMockStripeEventFixtures();
const link = {
  tenantId: "tenant_fixture",
  isDemo: false,
  checkoutSessionId: "checkout-row-1",
  tierId: "tier_fixture",
  idempotencyKey: "checkout:tenant_fixture:tier_fixture:price",
  sessionId: fixtures.checkoutCompleted.data.sessionId,
  customerId: fixtures.invoicePaid.data.customerId,
  subscriptionId: fixtures.invoicePaid.data.subscriptionId,
  expiresAt: fixtures.checkoutCompleted.data.expiresAt,
};

function receipt(
  event: StripeEvent,
  overrides: Partial<StripeWebhookReceipt> = {},
): StripeWebhookReceipt {
  return {
    id: `receipt-${event.id}`,
    eventId: event.id,
    eventType: event.type,
    tenantId: null,
    event,
    status: "received",
    attempts: 1,
    error: null,
    receivedAt: event.created,
    processedAt: null,
    result: null,
    inserted: true,
    ...overrides,
  };
}

function repository(): StripeWebhookRepository {
  return {
    persistReceipt: vi.fn(),
    getReceipt: vi.fn(),
    claimReceipt: vi.fn(),
    claimBatch: vi.fn(),
    completeReceipt: vi.fn(async (claimed, result) => receipt(claimed.event, {
      tenantId: "tenantId" in result ? result.tenantId : null,
      status: result.kind === "skipped" ? "skipped" : "processed",
      result,
      processedAt: claimed.event.created,
      inserted: false,
    })),
    failReceipt: vi.fn(),
    resolveTenant: vi.fn(async () => link),
    completeCheckout: vi.fn(async () => ({
      tenantId: link.tenantId,
      checkoutSessionId: link.checkoutSessionId!,
      subscriptionRowId: "subscription-row-1",
    })),
    applySubscription: vi.fn(async (_link, event) => ({
      tenantId: link.tenantId,
      subscriptionRowId: "subscription-row-1",
      status: event.type === "customer.subscription.deleted" ? "canceled" : event.data.status,
    })),
    applyInvoicePaid: vi.fn(async (_link, event) => ({
      tenantId: link.tenantId,
      subscriptionRowId: "subscription-row-1",
      tenantStatus: "active",
      commissionLedgerId: `ledger-${event.data.invoiceId}`,
    })),
    applyInvoiceFailed: vi.fn(async () => ({
      tenantId: link.tenantId,
      subscriptionRowId: "subscription-row-1",
      tenantStatus: "overdue",
    })),
  };
}

function dependencies(repositoryValue = repository()): StripeEventProcessorDependencies {
  const adjustmentReceipts = new Map<string, {
    ledgerId: string;
    reversedCents: number;
    entryKind: "offset" | "recovery";
  }>();
  return {
    repository: repositoryValue,
    driver: createMockStripeDriver(),
    affiliates: {
      accrueInvoice: vi.fn(async (input) => ({
        ledgerId: `ledger-${input.invoiceId}`,
        referralId: "referral-1",
        windowStarted: false,
        commissionCents: Math.round((input.totalExcludingTaxCents ?? 0) * 0.1),
        window: {
          referralId: "referral-1",
          firstInvoiceId: fixtures.invoicePaid.data.invoiceId,
          startedAt: fixtures.invoicePaid.created,
          expiresAt: "2027-08-17T12:00:00.000Z",
        },
      })),
      reverseInvoice: vi.fn(async (input) => {
        const existing = adjustmentReceipts.get(input.adjustmentId);
        if (existing) return existing;
        const created = {
          ledgerId: `ledger-${input.adjustmentId}`,
          reversedCents: input.adjustmentCommissionCents,
          entryKind: input.adjustmentKind === "dispute_recovery" ? "recovery" as const : "offset" as const,
        };
        adjustmentReceipts.set(input.adjustmentId, created);
        return created;
      }),
    },
    notifications: {
      emit: vi.fn(async (event) => ({ notificationId: `notice-${event.key}-${"invoiceId" in event ? event.invoiceId : "event"}` })),
    },
  };
}

describe("Stripe event processing", () => {
  it("keeps the live processor wired to the durable billing emitter", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./stripe-events.ts", import.meta.url), "utf8"));
    expect(source).toContain("notifications: BillingNotificationPort = createLiveBillingNotificationPort()");
    expect(source).not.toContain("notifications: BillingNotificationPort = unavailableBillingNotificationPort()");
  });

  it("covers every normalized event family and marks unknown types skipped", async () => {
    const deps = dependencies();
    const disputeUpdated = {
      ...fixtures.disputeCreated,
      id: "evt-dispute-updated",
      type: "charge.dispute.updated" as const,
    };
    const matrix: Array<[StripeEvent, StripeProcessingResult["kind"]]> = [
      [fixtures.checkoutCompleted, "checkout_completed"],
      [fixtures.invoicePaid, "invoice_paid"],
      [fixtures.invoicePaymentFailed, "invoice_failed"],
      [fixtures.subscriptionUpdated, "subscription_updated"],
      [fixtures.subscriptionDeleted, "subscription_deleted"],
      [fixtures.refundPartial, "commission_adjustment"],
      [fixtures.disputeCreated, "commission_adjustment"],
      [disputeUpdated, "commission_adjustment"],
      [fixtures.disputeWon, "commission_adjustment"],
      [fixtures.unknown, "skipped"],
    ];
    for (const [event, kind] of matrix) {
      expect((await applyStripeEvent(event, deps)).kind).toBe(kind);
    }
  });

  it("accrues replay-safe commission for two invoice ids in the same period", async () => {
    const deps = dependencies();
    const second = {
      ...fixtures.invoicePaid,
      id: "evt-second-invoice",
      data: { ...fixtures.invoicePaid.data, invoiceId: "in_second_same_month" },
    };
    const firstResult = await applyStripeEvent(fixtures.invoicePaid, deps);
    const replayResult = await applyStripeEvent(fixtures.invoicePaid, deps);
    const secondResult = await applyStripeEvent(second, deps);

    expect(firstResult).toEqual(replayResult);
    expect(firstResult).toMatchObject({ commissionLedgerId: `ledger-${fixtures.invoicePaid.data.invoiceId}` });
    expect(secondResult).toMatchObject({ commissionLedgerId: "ledger-in_second_same_month" });
    expect(deps.affiliates.accrueInvoice).toHaveBeenCalledTimes(3);
  });

  it("emits completed payment only behind the explicit alert-rule event arm", async () => {
    const previous = {
      phase8: process.env.SETTERFI_PHASE8_LIVE,
      alerts: process.env.SETTERFI_PHASE8_ALERTS_LIVE,
      events: process.env.SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE,
    };
    process.env.SETTERFI_PHASE8_LIVE = "true";
    process.env.SETTERFI_PHASE8_ALERTS_LIVE = "true";
    process.env.SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE = "true";
    try {
      const deps = dependencies();
      await applyStripeEvent(fixtures.invoicePaid, deps);
      expect(deps.notifications.emit).toHaveBeenCalledWith(expect.objectContaining({
        key: "billing.payment_completed",
        invoiceId: fixtures.invoicePaid.data.invoiceId,
      }));
    } finally {
      if (previous.phase8 === undefined) delete process.env.SETTERFI_PHASE8_LIVE;
      else process.env.SETTERFI_PHASE8_LIVE = previous.phase8;
      if (previous.alerts === undefined) delete process.env.SETTERFI_PHASE8_ALERTS_LIVE;
      else process.env.SETTERFI_PHASE8_ALERTS_LIVE = previous.alerts;
      if (previous.events === undefined) delete process.env.SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE;
      else process.env.SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE = previous.events;
    }
  });

  it("persists overdue and both consequence intents without ever requesting suspension", async () => {
    const deps = dependencies();
    const result = await applyStripeEvent(fixtures.invoicePaymentFailed, deps);
    expect(result).toMatchObject({ kind: "invoice_failed", tenantStatus: "overdue" });
    expect(deps.notifications.emit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      key: "billing.payment_failed",
      isTest: false,
    }));
    expect(deps.notifications.emit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      key: "billing.account_overdue",
      isTest: false,
    }));
    expect(JSON.stringify(result)).not.toContain("suspended");
  });

  it("keeps a failed notice replayable instead of processing the receipt without both intents", async () => {
    const repo = repository();
    const deps = dependencies(repo);
    deps.notifications.emit = vi.fn(async (event) => {
      if (event.key === "billing.account_overdue") throw new Error("BILLING_EMITTER_UNAVAILABLE");
      return { notificationId: "notice-first" };
    });
    const claimed = {
      ...receipt(fixtures.invoicePaymentFailed),
      claimToken: "STRIPE_CLAIM:synthetic",
    };
    await expect(processClaimedStripeWebhookReceipt(claimed, deps))
      .rejects.toThrow("BILLING_EMITTER_UNAVAILABLE");
    expect(repo.failReceipt).toHaveBeenCalledWith(claimed, expect.any(Error));
    expect(repo.completeReceipt).not.toHaveBeenCalled();
  });

  it("deduplicates open dispute updates and writes a distinct won-dispute recovery", async () => {
    const deps = dependencies();
    const updated = {
      ...fixtures.disputeCreated,
      id: "evt-dispute-update",
      type: "charge.dispute.updated" as const,
    };
    const opened = await applyStripeEvent(fixtures.disputeCreated, deps);
    const replayed = await applyStripeEvent(updated, deps);
    const won = await applyStripeEvent(fixtures.disputeWon, deps);

    expect(opened).toEqual(replayed);
    expect(opened).toMatchObject({ entryKind: "offset" });
    expect(won).toMatchObject({ entryKind: "recovery" });
    expect(deps.affiliates.reverseInvoice).toHaveBeenCalledWith(expect.objectContaining({
      adjustmentId: expect.stringMatching(/:loss$/),
      adjustmentKind: "dispute_loss",
    }));
    expect(deps.affiliates.reverseInvoice).toHaveBeenCalledWith(expect.objectContaining({
      adjustmentId: expect.stringMatching(/:recovery$/),
      adjustmentKind: "dispute_recovery",
    }));
  });

  it("uses append-only commission offsets for refunds and leaves payout state outside the port", async () => {
    const deps = dependencies();
    const partial = await applyStripeEvent(fixtures.refundPartial, deps);
    const full = await applyStripeEvent(fixtures.refundFull, deps);
    expect(partial).toMatchObject({ entryKind: "offset", reversedCents: 182 });
    expect(full).toMatchObject({ entryKind: "offset", reversedCents: 900 });
    expect(Object.keys(deps.affiliates).sort()).toEqual(["accrueInvoice", "reverseInvoice"]);
  });

  it("fails closed on missing invoice-base or charge linkage without a financial write", async () => {
    const deps = dependencies();
    await expect(applyStripeEvent(fixtures.invoiceMissingBase, deps))
      .rejects.toThrow("COMMISSION_BASE_UNAVAILABLE");
    await expect(applyStripeEvent({
      ...fixtures.refundPartial,
      data: { ...fixtures.refundPartial.data, chargeId: fixtures.chargeMissingInvoiceLink.chargeId },
    }, deps)).rejects.toThrow("STRIPE_CHARGE_INVOICE_LINK_MISSING");
    expect(deps.affiliates.reverseInvoice).not.toHaveBeenCalled();
  });

  it("returns an existing processed result on event-id replay without applying money twice", async () => {
    const repo = repository();
    const existing = receipt(fixtures.invoicePaid, {
      status: "processed",
      result: {
        kind: "invoice_paid",
        tenantId: link.tenantId,
        subscriptionRowId: "subscription-row-1",
        tenantStatus: "active",
        commissionLedgerId: "ledger-existing",
      },
    });
    repo.claimReceipt = vi.fn(async () => null);
    repo.getReceipt = vi.fn(async () => existing);
    const deps = dependencies(repo);
    expect(await processStripeWebhookReceipt(existing.id, deps)).toEqual(existing);
    expect(repo.applyInvoicePaid).not.toHaveBeenCalled();
    expect(deps.affiliates.accrueInvoice).not.toHaveBeenCalled();
  });

  it("converges when subscription evidence arrives before Checkout completion", async () => {
    const repo = repository();
    let mirrorReady = false;
    repo.applySubscription = vi.fn(async () => {
      mirrorReady = true;
      return { tenantId: link.tenantId, subscriptionRowId: "subscription-row-1", status: "active" };
    });
    repo.completeCheckout = vi.fn(async () => {
      if (!mirrorReady) throw new Error("STRIPE_SUBSCRIPTION_SNAPSHOT_REQUIRED");
      return { tenantId: link.tenantId, checkoutSessionId: "checkout-row-1", subscriptionRowId: "subscription-row-1" };
    });
    const deps = dependencies(repo);
    await expect(applyStripeEvent(fixtures.checkoutCompleted, deps))
      .rejects.toThrow("STRIPE_SUBSCRIPTION_SNAPSHOT_REQUIRED");
    await applyStripeEvent(fixtures.subscriptionUpdated, deps);
    await expect(applyStripeEvent(fixtures.checkoutCompleted, deps)).resolves.toMatchObject({
      kind: "checkout_completed",
      subscriptionRowId: "subscription-row-1",
    });
  });

  it("binds the subscription supplied by completed Checkout before the local mirror exists", async () => {
    const repo = repository();
    repo.resolveTenant = vi.fn(async () => ({ ...link, subscriptionId: null }));
    const deps = dependencies(repo);
    deps.checkoutSubscription = {
      retrieve: vi.fn(async () => ({
        subscriptionId: fixtures.checkoutCompleted.data.subscriptionId!,
        customerId: fixtures.checkoutCompleted.data.customerId,
        status: "active" as const,
        cancelAtPeriodEnd: false,
        currentPeriodStart: "2026-08-01T00:00:00.000Z",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        priceId: fixtures.checkoutCompleted.data.priceId,
        providerUpdatedAt: fixtures.checkoutCompleted.created,
      })),
    };
    await applyStripeEvent(fixtures.checkoutCompleted, deps);
    expect(repo.applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: fixtures.checkoutCompleted.data.subscriptionId }),
      expect.objectContaining({ type: "customer.subscription.updated" }),
    );
    expect(repo.completeCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: fixtures.checkoutCompleted.data.subscriptionId }),
      fixtures.checkoutCompleted,
    );
  });

  it("rejects demo tenancy before subscription, status, or commission work", async () => {
    const repo = repository();
    repo.resolveTenant = vi.fn(async () => { throw new Error("STRIPE_DEMO_TENANT_REJECTED"); });
    const deps = dependencies(repo);
    await expect(applyStripeEvent(fixtures.invoicePaid, deps))
      .rejects.toThrow("STRIPE_DEMO_TENANT_REJECTED");
    expect(repo.applyInvoicePaid).not.toHaveBeenCalled();
    expect(deps.affiliates.accrueInvoice).not.toHaveBeenCalled();
  });
});
