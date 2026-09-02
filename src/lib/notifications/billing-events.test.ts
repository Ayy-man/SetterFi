import { describe, expect, it, vi } from "vitest";
import { billingNotificationId, createBillingEventEmitter, resolveBillingDestinations, type BillingNotificationRepository } from "@/lib/notifications/billing-events";

function repository(overrides: Partial<BillingNotificationRepository> = {}): BillingNotificationRepository {
  return {
    resolveRule: vi.fn().mockResolvedValue({
      id: "rule", eventKey: "billing.allowance_warning", name: "Warning", defaultEnabled: true,
      suppressible: false, includeBillingContact: true, audienceRoles: ["coach"], defaultDestinations: ["bell", "email"],
    }),
    isDemoTenant: vi.fn().mockResolvedValue(true),
    resolveRecipients: vi.fn().mockResolvedValue([{ userId: "billing-user", destinations: ["bell", "email"] }]),
    insertNotification: vi.fn().mockResolvedValue({ notificationId: "notification-1" }),
    insertDeliveryIntent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("billing event emitter", () => {
  it("derives a stable receipt id so partial retries cannot duplicate notice rows", () => {
    expect(billingNotificationId("billing.allowance_crossed:tenant:period:user"))
      .toBe(billingNotificationId("billing.allowance_crossed:tenant:period:user"));
    expect(billingNotificationId("billing.allowance_crossed:tenant:period:user"))
      .not.toBe(billingNotificationId("billing.allowance_crossed:tenant:other:user"));
  });
  it("ignores a disabled billing-recipient preference only for a non-suppressible rule", () => {
    const disabled = [{ destination: "email" as const, enabled: false }];
    expect(resolveBillingDestinations({ suppressible: false, defaultDestinations: ["bell", "email"] }, disabled))
      .toEqual(["bell", "email"]);
    expect(resolveBillingDestinations({ suppressible: true, defaultDestinations: ["bell", "email"] }, disabled))
      .toEqual(["bell"]);
  });

  it("persists bell and email intents for a non-suppressible billing recipient", async () => {
    const repo = repository({ isDemoTenant: vi.fn().mockResolvedValue(false) });
    await expect(createBillingEventEmitter(repo).emit({
      key: "billing.allowance_warning", tenantId: "tenant", allowanceActionId: "action",
      observedCount: 9, allowance: 10, periodEnd: "2026-09-01T00:00:00Z", occurredAt: "now", isTest: false,
    })).resolves.toEqual({ notificationId: "notification-1" });
    expect(repo.insertNotification).toHaveBeenCalledWith(expect.objectContaining({
      body: "SETTERFI_DEMO_PLACEHOLDER_BILLING_ALLOWANCE_WARNING",
    }));
    expect(repo.insertDeliveryIntent).toHaveBeenNthCalledWith(1, {
      notificationId: "notification-1", destination: "bell",
    });
    expect(repo.insertDeliveryIntent).toHaveBeenNthCalledWith(2, {
      notificationId: "notification-1", destination: "email",
    });
  });

  it("persists unapproved copy for the provider selector to refuse instead of dropping the notice", async () => {
    const repo = repository({ isDemoTenant: vi.fn().mockResolvedValue(false) });
    await expect(createBillingEventEmitter(repo).emit({
      key: "billing.payment_failed", tenantId: "tenant", invoiceId: "invoice", occurredAt: "now", isTest: false,
    })).resolves.toEqual({ notificationId: "notification-1" });
    expect(repo.insertNotification).toHaveBeenCalledWith(expect.objectContaining({
      body: "SETTERFI_DEMO_PLACEHOLDER_BILLING_PAYMENT_FAILED",
      isTest: false,
    }));
  });

  it("names the paid invoice and links the notice back to that billing record", async () => {
    const repo = repository({ isDemoTenant: vi.fn().mockResolvedValue(false) });
    await createBillingEventEmitter(repo).emit({
      key: "billing.payment_completed", tenantId: "tenant", invoiceId: "invoice-paid",
      occurredAt: "now", isTest: false,
    });
    expect(repo.insertNotification).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "billing.payment_completed",
      body: "Invoice invoice-paid was paid.",
      link: "/coach/billing",
    }));
  });

  it("gives a provider-confirmed tier change its own durable event key", async () => {
    const repo = repository({ isDemoTenant: vi.fn().mockResolvedValue(false) });
    await createBillingEventEmitter(repo).emit({
      key: "billing.tier_upgraded", tenantId: "tenant", allowanceActionId: "action",
      targetTierId: "tier-2", targetPriceId: "price-2", effectiveAt: "2026-09-01T00:00:00.000Z",
      occurredAt: "now", isTest: false,
    });
    expect(repo.insertNotification).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "billing.tier_upgraded", body: "SETTERFI_DEMO_PLACEHOLDER_BILLING_TIER_UPGRADED",
    }));
  });

  it("contains no lead-messaging send primitive", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./billing-events.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/\.send(?:Template)?\s*\(/);
  });
});
