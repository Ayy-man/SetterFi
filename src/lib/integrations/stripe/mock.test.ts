import { describe, expect, it } from "vitest";

import {
  MockStripeError,
  createMockStripeDriver,
  createMockStripeEventFixtures,
} from "./mock";

const NOW = new Date("2026-08-17T12:00:00.000Z");

const checkoutInput = {
  tenantId: "tenant_synthetic",
  tierId: "tier_synthetic",
  priceId: "mock_price_starter",
  idempotencyKey: "checkout:tenant_synthetic:tier_synthetic:mock_price_starter",
  successUrl: "https://setterfi.test/billing/success",
  cancelUrl: "https://setterfi.test/billing/cancel",
};

describe("createMockStripeDriver", () => {
  it("reuses deterministic customer and Checkout IDs without reading a global clock", async () => {
    const clock = () => new Date(NOW);
    const first = createMockStripeDriver({ clock });
    const second = createMockStripeDriver({ clock });

    const firstResult = await first.createSubscriptionCheckout(checkoutInput);
    const replay = await first.createSubscriptionCheckout(checkoutInput);
    const otherRun = await second.createSubscriptionCheckout(checkoutInput);

    expect(replay).toEqual(firstResult);
    expect(otherRun).toEqual(firstResult);
    expect(firstResult).toEqual({
      sessionId: "mock_checkout_87b2fc79",
      customerId: "mock_customer_af192fa5",
      subscriptionId: "mock_subscription_52673f48",
      state: "open",
      expiresAt: "2026-08-18T12:00:00.000Z",
    });
  });

  it("preserves the current period end and schedules exactly one fixed target Price", async () => {
    const driver = createMockStripeDriver({ clock: () => new Date(NOW) });
    const result = await driver.createRenewalPriceSchedule({
      tenantId: "tenant_synthetic",
      subscriptionId: "mock_subscription_fixture",
      currentPriceId: "mock_price_starter",
      targetPriceId: "mock_price_scale",
      currentPeriodEnd: "2026-09-17T12:00:00.000Z",
      idempotencyKey: "schedule:tenant_synthetic:mock_price_scale",
    });

    expect(result).toEqual({
      scheduleId: "mock_schedule_e1fbea72",
      subscriptionId: "mock_subscription_fixture",
      currentPeriodEnd: "2026-09-17T12:00:00.000Z",
      targetPriceId: "mock_price_scale",
      state: "scheduled",
    });
  });

  it("marks a known mock subscription for period-end cancellation rather than inventing one", async () => {
    const driver = createMockStripeDriver({ clock: () => new Date(NOW) });
    const checkout = await driver.createSubscriptionCheckout(checkoutInput);
    const canceled = await driver.cancelSubscriptionAtPeriodEnd({
      tenantId: checkoutInput.tenantId,
      subscriptionId: checkout.subscriptionId!,
      idempotencyKey: "cancel:tenant_synthetic",
    });

    expect(canceled.cancelAtPeriodEnd).toBe(true);
    await expect(driver.cancelSubscriptionAtPeriodEnd({
      tenantId: checkoutInput.tenantId,
      subscriptionId: "mock_subscription_missing",
      idempotencyKey: "cancel:missing",
    })).rejects.toEqual(new MockStripeError("MOCK_STRIPE_SUBSCRIPTION_NOT_FOUND"));
  });

  it("covers every planned money event family and labels every ID as mock data", () => {
    const fixtures = createMockStripeEventFixtures({ clock: () => new Date(NOW) });
    expect(Object.keys(fixtures)).toEqual([
      "checkoutCompleted",
      "invoicePaid",
      "invoicePaymentFailed",
      "subscriptionUpdated",
      "subscriptionDeleted",
      "refundPartial",
      "refundFull",
      "disputeCreated",
      "disputeLost",
      "disputeWon",
      "unknown",
      "invoiceMissingBase",
      "chargeMissingInvoiceLink",
    ]);
    expect(fixtures.refundPartial.data.amountCents).toBeLessThan(
      fixtures.refundFull.data.amountCents,
    );
    expect(fixtures.disputeCreated.data.state).toBe("open");
    expect(fixtures.disputeLost.data.state).toBe("lost");
    expect(fixtures.disputeWon.data.state).toBe("won");
    expect(fixtures.unknown.data.providerType).toBe("synthetic.provider.event");
    expect(JSON.stringify(fixtures)).not.toMatch(/sk_(?:live|test)|whsec_|card/i);
    expect(JSON.stringify(fixtures).match(/mock_/g)?.length).toBeGreaterThan(20);
  });

  it("returns a missing invoice base as unknown and fails closed on an absent charge link", async () => {
    const fixtures = createMockStripeEventFixtures({ clock: () => new Date(NOW) });
    const driver = createMockStripeDriver({ clock: () => new Date(NOW) });

    await expect(driver.retrieveInvoiceFinancials(
      fixtures.invoiceMissingBase.data.invoiceId,
    )).resolves.toEqual(fixtures.invoiceMissingBase.data);
    await expect(driver.resolveChargeInvoice(
      fixtures.chargeMissingInvoiceLink.chargeId,
    )).rejects.toThrow("STRIPE_CHARGE_INVOICE_LINK_MISSING");
  });
});
