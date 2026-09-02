import { describe, expect, it, vi } from "vitest";
import {
  createBillingCheckoutHandler,
  createBillingCheckoutStatusHandler,
  type BillingCheckoutBrowserState,
} from "@/app/api/billing/checkout/handler";
import { createHostedCheckoutProvider } from "@/lib/billing/checkout";

const request = (body: unknown) => new Request("https://app.test/api/billing/checkout", { method: "POST", body: JSON.stringify(body) });
const OFFERED: BillingCheckoutBrowserState = {
  state: "offered",
  offer: {
    tierId: "tier",
    label: "Growth",
    currency: "USD",
    amountCents: 49_700,
    interval: "month",
    effectiveTo: null,
  },
  attempt: null,
};
const browserState = vi.fn().mockResolvedValue(OFFERED);
describe("coach billing checkout route", () => {
  it("returns the hosted URL using only the session tenant", async () => {
    const checkout = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay_test" });
    const handler = createBillingCheckoutHandler({
      enabled: () => true,
      session: async () => ({ userId: "coach", tenantId: "tenant", role: "coach", impersonatingTenant: null, impersonationSessionId: null }), checkout,
      requestRetry: vi.fn(),
      browserState,
    });
    const response = await handler(request({ tierId: "tier" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://checkout.stripe.com/c/pay_test", attempt: null,
    });
    expect(checkout).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant", actorId: "coach" }));
  });

  it("refuses to hand an untrusted hosted URL to the browser", async () => {
    const checkout = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com.evil.test/c/pay_test" });
    const response = await createBillingCheckoutHandler({
      enabled: () => true,
      session: async () => ({ userId: "coach", tenantId: "tenant", role: "coach", impersonatingTenant: null, impersonationSessionId: null }),
      checkout,
      requestRetry: vi.fn(),
      browserState,
    })(request({ tierId: "tier" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Checkout was refused." });
  });

  it("refuses body tenant selectors and disabled feature state", async () => {
    const checkout = vi.fn();
    const requestRetry = vi.fn();
    const active = createBillingCheckoutHandler({ enabled: () => true, session: async () => ({ userId: "coach", tenantId: "tenant", role: "coach", impersonatingTenant: null, impersonationSessionId: null }), checkout, requestRetry, browserState });
    expect((await active(request({ tierId: "tier", tenantId: "other" }))).status).toBe(409);
    expect((await createBillingCheckoutHandler({ enabled: () => false, session: async () => null, checkout, requestRetry, browserState })(request({ tierId: "tier" }))).status).toBe(404);
    expect(checkout).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    const checkout = vi.fn();
    const response = await createBillingCheckoutHandler({
      enabled: () => true,
      session: async () => null,
      checkout,
      requestRetry: vi.fn(),
      browserState,
    })(request({ tierId: "tier" }));
    expect(response.status).toBe(403);
    expect(checkout).not.toHaveBeenCalled();
  });

  it("throws rather than selecting a mock Stripe arm in production", () => {
    expect(() => createHostedCheckoutProvider({
      environment: { NODE_ENV: "production", SETTERFI_STRIPE_DRIVER: "mock" },
    })).toThrow("Driver stripe is missing or has invalid configuration: SETTERFI_STRIPE_DRIVER");
  });

  it("retires only the caller's pending attempt when retrying after a cancellation return", async () => {
    const checkout = vi.fn().mockResolvedValue({
      url: "https://checkout.stripe.com/c/pay_retry",
      checkoutAttemptId: "attempt-new",
      checkoutAttemptOutcome: "pending",
    });
    const requestRetry = vi.fn().mockResolvedValue(undefined);
    const handler = createBillingCheckoutHandler({
      enabled: () => true,
      session: async () => ({ userId: "coach", tenantId: "tenant", role: "coach", impersonatingTenant: null, impersonationSessionId: null }),
      checkout,
      requestRetry,
      browserState,
    });

    const response = await handler(request({ tierId: "tier", retryAfterCancel: true }));

    expect(requestRetry).toHaveBeenCalledWith({ tenantId: "tenant", tierId: "tier" });
    expect(checkout).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant", tierId: "tier" }));
    await expect(response.json()).resolves.toEqual({
      url: "https://checkout.stripe.com/c/pay_retry",
      attempt: { id: "attempt-new", outcome: "pending" },
    });
  });

  it("refuses unlabelled retry controls so only an explicit cancellation return can retire an attempt", async () => {
    const checkout = vi.fn();
    const requestRetry = vi.fn();
    const handler = createBillingCheckoutHandler({
      enabled: () => true,
      session: async () => ({ userId: "coach", tenantId: "tenant", role: "coach", impersonatingTenant: null, impersonationSessionId: null }),
      checkout,
      requestRetry,
      browserState,
    });

    expect((await handler(request({ tierId: "tier", retryAfterCancel: false }))).status).toBe(409);
    expect((await handler(request({ tierId: "tier", retry: true }))).status).toBe(409);
    expect(requestRetry).not.toHaveBeenCalled();
    expect(checkout).not.toHaveBeenCalled();
  });

  it("returns only the actor-bound offer and provider-backed checkout state", async () => {
    const handler = createBillingCheckoutStatusHandler({
      enabled: () => true,
      session: async () => ({ userId: "coach", tenantId: "tenant", role: "coach", impersonatingTenant: null, impersonationSessionId: null }),
      browserState: vi.fn().mockResolvedValue({
        ...OFFERED,
        state: "pending",
        attempt: { outcome: "pending", expiresAt: "2026-09-01T00:30:00.000Z" },
      }),
    });
    const response = await handler();
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      checkout: {
        ...OFFERED,
        state: "pending",
        attempt: { outcome: "pending", expiresAt: "2026-09-01T00:30:00.000Z" },
      },
    });
  });

  it("refuses a tier that is not the tenant's current effective offer", async () => {
    const checkout = vi.fn();
    const requestRetry = vi.fn();
    const handler = createBillingCheckoutHandler({
      enabled: () => true,
      session: async () => ({ userId: "coach", tenantId: "tenant", role: "coach", impersonatingTenant: null, impersonationSessionId: null }),
      checkout,
      requestRetry,
      browserState: vi.fn().mockResolvedValue({ ...OFFERED, offer: { ...OFFERED.offer!, tierId: "selected-tier" } }),
    });
    expect((await handler(request({ tierId: "injected-tier" }))).status).toBe(409);
    expect(checkout).not.toHaveBeenCalled();
    expect(requestRetry).not.toHaveBeenCalled();
  });

  it("does not create another checkout after provider-backed completion or activation", async () => {
    const checkout = vi.fn();
    for (const state of ["confirming", "active"] as const) {
      const response = await createBillingCheckoutHandler({
        enabled: () => true,
        session: async () => ({ userId: "coach", tenantId: "tenant", role: "coach", impersonatingTenant: null, impersonationSessionId: null }),
        checkout,
        requestRetry: vi.fn(),
        browserState: vi.fn().mockResolvedValue({ ...OFFERED, state }),
      })(request({ tierId: "tier" }));
      expect(response.status).toBe(409);
    }
    expect(checkout).not.toHaveBeenCalled();
  });
});
