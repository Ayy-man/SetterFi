import { describe, expect, it, vi } from "vitest";
import { createBillingOperations } from "@/lib/billing/operations";
import type { BillingRepository } from "@/lib/repositories/billing";

function repository(overrides: Partial<BillingRepository> = {}): BillingRepository {
  return {
    updateTier: vi.fn(), setTenantOverride: vi.fn(), requestCorrection: vi.fn(), decideCorrection: vi.fn(),
    setTenantStatus: vi.fn(), recordAttendance: vi.fn(), listCorrections: vi.fn(), loadSubscription: vi.fn(),
    loadCheckoutTenant: vi.fn(), loadCheckoutTierPrices: vi.fn(), listAllowedPriceIds: vi.fn(), persistCheckout: vi.fn(),
    ...overrides,
  } as BillingRepository;
}

describe("billing operations", () => {
  it("returns the full approved correction evidence and no offset for rejection", async () => {
    const decideCorrection = vi.fn()
      .mockResolvedValueOnce({ decisionId: "d1", offsetEventId: "o1", requestAuditId: 1, decisionAuditId: 2 })
      .mockResolvedValueOnce({ decisionId: "d2", offsetEventId: null, requestAuditId: 3, decisionAuditId: 4 });
    const operations = createBillingOperations(repository({ decideCorrection }), { emit: vi.fn() });
    await expect(operations.decideCorrection({ actorId: "a", tenantId: "t", requestId: "r1", decision: "approved", reason: "ok" }))
      .resolves.toEqual({ state: "approved", requestId: "r1", decisionId: "d1", offsetEventId: "o1", requestAuditId: 1, decisionAuditId: 2 });
    await expect(operations.decideCorrection({ actorId: "a", tenantId: "t", requestId: "r2", decision: "rejected", reason: "no" }))
      .resolves.toEqual({ state: "rejected", requestId: "r2", decisionId: "d2", requestAuditId: 3, decisionAuditId: 4 });
  });

  it("does not complete suspension until its durable notice receipt exists", async () => {
    const setTenantStatus = vi.fn().mockResolvedValue({ tenantId: "t", previousStatus: "active", status: "suspended", auditId: 7 });
    const emit = vi.fn().mockResolvedValue({ notificationId: "notice-1" });
    await expect(createBillingOperations(repository({ setTenantStatus }), { emit }).setTenantStatus({
      actorId: "owner", tenantId: "t", status: "suspended", reason: "overdue", occurredAt: "now",
    })).resolves.toMatchObject({ auditId: 7, notificationId: "notice-1" });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ key: "billing.account_suspended", auditId: 7 }));
  });

  it("refuses a demo tenant before any Stripe driver can be selected", async () => {
    const repo = repository({
      listAllowedPriceIds: vi.fn().mockResolvedValue(new Set(["price-1"])),
      loadCheckoutTenant: vi.fn().mockResolvedValue({ id: "t", isDemo: true }),
      loadCheckoutTierPrices: vi.fn().mockResolvedValue([{ tierId: "tier", active: true, priceId: "price-1" }]),
    });
    await expect(createBillingOperations(repo, { emit: vi.fn() }).checkout({ actorId: "a", tenantId: "t", tierId: "tier", baseUrl: "https://app.test" }))
      .rejects.toThrow("BILLING_CHECKOUT_DEMO_TENANT");
    expect(repo.persistCheckout).not.toHaveBeenCalled();
  });

  it("persists the actor-bound Checkout receipt before returning Stripe's hosted URL", async () => {
    const persistCheckout = vi.fn().mockResolvedValue({
      checkoutSessionId: "checkout-row",
      tenantId: "tenant",
      tierId: "tier",
      priceId: "price",
      idempotencyKey: "checkout:tenant:tier:price",
      sessionId: "cs_live",
      customerId: "cus_live",
      subscriptionId: null,
      state: "open",
      expiresAt: "2026-08-30T00:30:00.000Z",
    });
    const provider = {
      create: vi.fn().mockResolvedValue({
        provider: {
          sessionId: "cs_live",
          customerId: "cus_live",
          subscriptionId: null,
          state: "open",
          expiresAt: "2026-08-30T00:30:00.000Z",
        },
        url: "https://checkout.stripe.com/c/pay_live",
      }),
    };
    const operations = createBillingOperations(repository({
      listAllowedPriceIds: vi.fn().mockResolvedValue(new Set(["price"])),
      loadCheckoutTenant: vi.fn().mockResolvedValue({ id: "tenant", isDemo: false }),
      loadCheckoutTierPrices: vi.fn().mockResolvedValue([{ tierId: "tier", active: true, priceId: "price" }]),
      persistCheckout,
    }), { emit: vi.fn() }, provider);

    await expect(operations.hostedCheckout({
      actorId: "coach", tenantId: "tenant", tierId: "tier", baseUrl: "https://app.test",
    })).resolves.toMatchObject({
      checkoutSessionId: "checkout-row",
      url: "https://checkout.stripe.com/c/pay_live",
    });
    expect(persistCheckout).toHaveBeenCalledWith(expect.objectContaining({ actorId: "coach" }));
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant",
      tierId: "tier",
      priceId: "price",
      successUrl: "https://app.test/coach/billing?checkout=returned",
      cancelUrl: "https://app.test/coach/billing?checkout=canceled",
    }));
  });
});
