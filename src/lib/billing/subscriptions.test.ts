import { describe, expect, it, vi } from "vitest";

import type { StripeDriver, SubscriptionCheckoutResult } from "@/lib/integrations/stripe/types";

import {
  createSubscriptionCheckout,
  type PersistedCheckoutSession,
  type SubscriptionCheckoutDependencies,
} from "./subscriptions";

const provider: SubscriptionCheckoutResult = {
  sessionId: "cs_synthetic",
  customerId: "cus_synthetic",
  subscriptionId: "sub_synthetic",
  state: "open",
  expiresAt: "2026-08-19T12:00:00.000Z",
};

function driver(create = vi.fn(async () => provider)): StripeDriver {
  return {
    createSubscriptionCheckout: create,
    createRenewalPriceSchedule: vi.fn(),
    cancelSubscriptionAtPeriodEnd: vi.fn(),
    retrieveInvoiceFinancials: vi.fn(),
    resolveChargeInvoice: vi.fn(),
    verifyWebhook: vi.fn(),
  };
}

function persisted(overrides: Partial<PersistedCheckoutSession> = {}): PersistedCheckoutSession {
  return {
    checkoutSessionId: "checkout-row-1",
    tenantId: "tenant-1",
    tierId: "tier-1",
    priceId: "price-approved",
    idempotencyKey: "checkout:tenant-1:tier-1:price-approved:attempt:attempt-1",
    ...provider,
    ...overrides,
  };
}

function dependencies(overrides: Partial<SubscriptionCheckoutDependencies> = {}) {
  const selectedDriver = driver();
  const checkoutAttempts = {
    claim: vi.fn(async () => ({
      id: "attempt-1",
      idempotencyKey: "checkout:tenant-1:tier-1:price-approved:attempt:attempt-1",
      outcome: "pending" as const,
    })),
    recordProviderSession: vi.fn(async () => undefined),
  };
  return {
    selectedDriver,
    checkoutAttempts,
    values: {
      loadTenant: vi.fn(async () => ({ id: "tenant-1", isDemo: false })),
      loadTierPrices: vi.fn(async () => [{ tierId: "tier-1", active: true, priceId: "price-approved" }]),
      allowedPriceIds: () => new Set(["price-approved"]),
      checkoutUrls: () => ({
        successUrl: "https://setterfi.test/coach/billing?checkout=return",
        cancelUrl: "https://setterfi.test/coach/billing?checkout=cancel",
      }),
      driver: () => selectedDriver,
      persistCheckout: vi.fn(async () => persisted()),
      checkoutAttemptsLive: () => true,
      checkoutAttempts,
      ...overrides,
    } satisfies SubscriptionCheckoutDependencies,
  };
}

describe("createSubscriptionCheckout", () => {
  it("claims a durable pending attempt and derives the Stripe key from that attempt", async () => {
    const deps = dependencies();
    const result = await createSubscriptionCheckout(
      { tenantId: "tenant-1", tierId: "tier-1" },
      deps.values,
    );

    expect(result).toEqual({
      ...persisted(), checkoutAttemptId: "attempt-1", checkoutAttemptOutcome: "pending",
    });
    expect(deps.checkoutAttempts.claim).toHaveBeenCalledWith({
      tenantId: "tenant-1", tierId: "tier-1", priceId: "price-approved",
    });
    expect(deps.selectedDriver.createSubscriptionCheckout).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      tierId: "tier-1",
      priceId: "price-approved",
      idempotencyKey: "checkout:tenant-1:tier-1:price-approved:attempt:attempt-1",
      successUrl: "https://setterfi.test/coach/billing?checkout=return",
      cancelUrl: "https://setterfi.test/coach/billing?checkout=cancel",
    });
    expect(deps.checkoutAttempts.recordProviderSession).toHaveBeenCalledWith({
      attemptId: "attempt-1", sessionId: provider.sessionId, expiresAt: provider.expiresAt,
    });
  });

  it("rejects inactive, unallowlisted, and ambiguous tier Prices before a driver call", async () => {
    for (const [rows, error] of [
      [[{ tierId: "tier-1", active: false, priceId: "price-approved" }], "BILLING_TIER_INACTIVE"],
      [[{ tierId: "tier-1", active: true, priceId: "price-other" }], "BILLING_PRICE_NOT_ALLOWLISTED"],
      [[
        { tierId: "tier-1", active: true, priceId: "price-approved" },
        { tierId: "tier-1", active: true, priceId: "price-approved" },
      ], "BILLING_TIER_PRICE_AMBIGUOUS"],
    ] as const) {
      const deps = dependencies({ loadTierPrices: vi.fn(async () => rows) });
      await expect(createSubscriptionCheckout(
        { tenantId: "tenant-1", tierId: "tier-1" },
        deps.values,
      )).rejects.toThrow(error);
      expect(deps.selectedDriver.createSubscriptionCheckout).not.toHaveBeenCalled();
    }
  });

  it("rejects demo tenants before selecting or calling a Stripe driver", async () => {
    const deps = dependencies({
      loadTenant: vi.fn(async () => ({ id: "tenant-1", isDemo: true })),
    });
    await expect(createSubscriptionCheckout(
      { tenantId: "tenant-1", tierId: "tier-1" },
      deps.values,
    )).rejects.toThrow("BILLING_CHECKOUT_DEMO_TENANT");
    expect(deps.selectedDriver.createSubscriptionCheckout).not.toHaveBeenCalled();
    expect(deps.values.persistCheckout).not.toHaveBeenCalled();
  });

  it("fails when a provider session is not durably persisted with the same custody fields", async () => {
    for (const readback of [
      null,
      persisted({ sessionId: "cs_other" }),
      persisted({ tenantId: "tenant-other" }),
      persisted({ idempotencyKey: "checkout:other" }),
    ]) {
      const deps = dependencies({ persistCheckout: vi.fn(async () => readback) });
      await expect(createSubscriptionCheckout(
        { tenantId: "tenant-1", tierId: "tier-1" },
        deps.values,
      )).rejects.toThrow("STRIPE_CHECKOUT_READBACK_MISMATCH");
    }
  });

  it("accepts a replay only when the existing checkout row matches the provider result", async () => {
    const deps = dependencies({ persistCheckout: vi.fn(async () => persisted()) });
    const first = await createSubscriptionCheckout(
      { tenantId: "tenant-1", tierId: "tier-1" },
      deps.values,
    );
    const replay = await createSubscriptionCheckout(
      { tenantId: "tenant-1", tierId: "tier-1" },
      deps.values,
    );
    expect(replay).toEqual(first);
    expect(deps.values.persistCheckout).toHaveBeenCalledTimes(2);
    expect(deps.checkoutAttempts.claim).toHaveBeenCalledTimes(2);
    expect(deps.selectedDriver.createSubscriptionCheckout).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "checkout:tenant-1:tier-1:price-approved:attempt:attempt-1",
    }));
  });

  it("uses a newly claimed key after an expired or cancellation-retired attempt", async () => {
    const deps = dependencies();
    vi.mocked(deps.checkoutAttempts.claim)
      .mockResolvedValueOnce({
        id: "attempt-old",
        idempotencyKey: "checkout:tenant-1:tier-1:price-approved:attempt:attempt-old",
        outcome: "pending",
      })
      .mockResolvedValueOnce({
        id: "attempt-new",
        idempotencyKey: "checkout:tenant-1:tier-1:price-approved:attempt:attempt-new",
        outcome: "pending",
      });
    vi.mocked(deps.values.persistCheckout)
      .mockResolvedValueOnce(persisted({ idempotencyKey: "checkout:tenant-1:tier-1:price-approved:attempt:attempt-old" }))
      .mockResolvedValueOnce(persisted({ idempotencyKey: "checkout:tenant-1:tier-1:price-approved:attempt:attempt-new" }));

    await createSubscriptionCheckout({ tenantId: "tenant-1", tierId: "tier-1" }, deps.values);
    const retry = await createSubscriptionCheckout({ tenantId: "tenant-1", tierId: "tier-1" }, deps.values);

    expect(retry).toMatchObject({ checkoutAttemptId: "attempt-new", checkoutAttemptOutcome: "pending" });
    expect(deps.selectedDriver.createSubscriptionCheckout).toHaveBeenLastCalledWith(expect.objectContaining({
      idempotencyKey: "checkout:tenant-1:tier-1:price-approved:attempt:attempt-new",
    }));
  });

  it("does not continue to receipt persistence when the provider session cannot be durably attached", async () => {
    const deps = dependencies();
    vi.mocked(deps.checkoutAttempts.recordProviderSession)
      .mockRejectedValueOnce(new Error("CHECKOUT_ATTEMPT_PROVIDER_SESSION_RECORD_FAILED"));

    await expect(createSubscriptionCheckout(
      { tenantId: "tenant-1", tierId: "tier-1" }, deps.values,
    )).rejects.toThrow("CHECKOUT_ATTEMPT_PROVIDER_SESSION_RECORD_FAILED");
    expect(deps.values.persistCheckout).not.toHaveBeenCalled();
  });

  it("refuses extra body fields so customer, Price, and amount cannot cross the service boundary", async () => {
    const deps = dependencies();
    await expect(createSubscriptionCheckout({
      tenantId: "tenant-1",
      tierId: "tier-1",
      priceId: "price-injected",
    } as never, deps.values)).rejects.toThrow("BILLING_CHECKOUT_INPUT_INVALID");
    expect(deps.selectedDriver.createSubscriptionCheckout).not.toHaveBeenCalled();
  });
});
