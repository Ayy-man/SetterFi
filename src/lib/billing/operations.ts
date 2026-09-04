/**
 * Actor-bound billing operations above the RPC repository.
 *
 * Routes authenticate callers, this service preserves the actor through SQL, and successful
 * responses require persisted receipts. Provider selection happens only after demo and Price
 * allowlist checks have passed inside the shared Checkout service.
 */

import type { BillingNotificationPort, BillingCorrectionResult } from "@/lib/billing/contracts";
import { createHostedCheckoutProvider, type HostedCheckoutProvider } from "@/lib/billing/checkout";
import {
  createSubscriptionCheckout,
  type PersistedCheckoutSession,
} from "@/lib/billing/subscriptions";
import {
  createBillingRepository,
  type BillingRepository,
} from "@/lib/repositories/billing";

export type BillingOperations = ReturnType<typeof createBillingOperations>;

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function checkoutUrls(baseUrl: string) {
  const url = new URL(baseUrl);
  return {
    successUrl: new URL("/coach/billing?checkout=returned", url).toString(),
    cancelUrl: new URL("/coach/billing?checkout=canceled", url).toString(),
  };
}

export function createBillingOperations(
  repository: BillingRepository,
  notifications: BillingNotificationPort,
  hostedCheckoutProvider?: HostedCheckoutProvider,
) {
  const hostedCheckout = async (input: {
    actorId: string;
    tenantId: string;
    tierId: string;
    baseUrl: string;
  }): Promise<PersistedCheckoutSession & { url: string }> => {
    let hostedUrl: string | null = null;
    let provider = hostedCheckoutProvider;
    const allowedPriceIds = await repository.listAllowedPriceIds();
    const checkout = await createSubscriptionCheckout({
      tenantId: input.tenantId,
      tierId: input.tierId,
    }, {
      loadTenant: (tenantId) => repository.loadCheckoutTenant(tenantId),
      loadTierPrices: (tierId) => repository.loadCheckoutTierPrices(tierId),
      allowedPriceIds: () => allowedPriceIds,
      checkoutUrls: () => checkoutUrls(input.baseUrl),
        driver: () => ({
          createSubscriptionCheckout: async (providerInput) => {
            provider ??= createHostedCheckoutProvider();
            const hosted = await provider.create(providerInput);
          hostedUrl = hosted.url;
          return hosted.provider;
        },
      }),
      persistCheckout: (checkoutInput) => repository.persistCheckout({
        actorId: input.actorId,
        ...checkoutInput,
      }),
    });
    if (!hostedUrl) throw new Error("STRIPE_CHECKOUT_URL_MISSING");
    return { ...checkout, url: hostedUrl };
  };

  return {
    updateTier: (input: Parameters<BillingRepository["updateTier"]>[0]) =>
      repository.updateTier(input),
    setTenantOverride: (input: Parameters<BillingRepository["setTenantOverride"]>[0]) =>
      repository.setTenantOverride(input),
    requestCorrection: async (
      input: Parameters<BillingRepository["requestCorrection"]>[0],
    ): Promise<BillingCorrectionResult> => {
      const receipt = await repository.requestCorrection(input);
      return {
        state: "requested",
        requestId: receipt.requestId,
        requestAuditId: receipt.auditId,
      };
    },
    requestPeriodCorrection: async (
      input: Parameters<BillingRepository["requestPeriodCorrection"]>[0],
    ): Promise<BillingCorrectionResult> => {
      const receipt = await repository.requestPeriodCorrection(input);
      return {
        state: "requested",
        requestId: receipt.requestId,
        requestAuditId: receipt.auditId,
      };
    },
    decideCorrection: async (
      input: Parameters<BillingRepository["decideCorrection"]>[0],
    ): Promise<BillingCorrectionResult> => {
      const receipt = await repository.decideCorrection(input);
      if (input.decision === "approved") {
        if (!receipt.offsetEventId) throw new Error("BILLING_CORRECTION_OFFSET_RECEIPT_REQUIRED");
        return {
          state: "approved",
          requestId: input.requestId,
          decisionId: receipt.decisionId,
          offsetEventId: receipt.offsetEventId,
          requestAuditId: receipt.requestAuditId,
          decisionAuditId: receipt.decisionAuditId,
        };
      }
      if (receipt.offsetEventId !== null) throw new Error("BILLING_CORRECTION_REJECTION_HAS_OFFSET");
      return {
        state: "rejected",
        requestId: input.requestId,
        decisionId: receipt.decisionId,
        requestAuditId: receipt.requestAuditId,
        decisionAuditId: receipt.decisionAuditId,
      };
    },
    listCorrections: () => repository.listCorrections(),
    setTenantStatus: async (
      input: Parameters<BillingRepository["setTenantStatus"]>[0] & { occurredAt: string },
    ) => {
      const persisted = await repository.setTenantStatus(input);
      if (persisted.status !== "suspended") return { ...persisted, notificationId: null };
      const notice = await notifications.emit({
        key: "billing.account_suspended",
        tenantId: input.tenantId,
        reason: required(input.reason, "TENANT_BILLING_STATUS_REASON_REQUIRED"),
        auditId: persisted.auditId,
        occurredAt: input.occurredAt,
        isTest: false,
      });
      if (!notice.notificationId.trim()) throw new Error("BILLING_NOTICE_RECEIPT_INVALID");
      return { ...persisted, notificationId: notice.notificationId };
    },
    recordAttendance: (
      input: Parameters<BillingRepository["recordAttendance"]>[0],
    ) => repository.recordAttendance(input),
    checkout: hostedCheckout,
    hostedCheckout,
  };
}

export function createLiveBillingOperations(notifications: BillingNotificationPort) {
  return createBillingOperations(createBillingRepository(), notifications);
}
