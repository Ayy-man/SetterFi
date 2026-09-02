import { describe, expect, it, vi } from "vitest";

import type { AffiliateRepository } from "@/lib/repositories/affiliates";

import {
  createAffiliateService,
  deriveCommissionAdjustmentCents,
  deriveCommissionBaseCents,
  deriveCommissionCents,
  isCommissionWindowEligible,
} from "./service";

function repository(overrides: Partial<AffiliateRepository> = {}): AffiliateRepository {
  return {
    listOwnReferrals: async () => [],
    listOwnPayouts: async () => [],
    accrueInvoice: async () => null,
    reverseInvoice: async () => null,
    approvePayout: async () => ({
      payoutId: "payout-1",
      eventId: "event-approved",
      auditId: 41,
      state: "approved_for_payout",
    }),
    recordPayoutSent: async (input) => ({
      payoutId: input.payoutId,
      eventId: "event-sent",
      auditId: 42,
      reference: input.reference,
      paidOn: input.paidOn,
      state: "sent",
    }),
    ...overrides,
  };
}

describe("affiliate commission rules", () => {
  it("uses the collected after-discount excluding-tax amount rather than list price or tax", () => {
    const base = deriveCommissionBaseCents({
      amountPaidCents: 10_700,
      totalExcludingTaxCents: 10_000,
    });

    expect(base).toBe(10_000);
    expect(deriveCommissionCents(base!)).toBe(1_000);
  });

  it("creates no commission base for a zero-collected invoice", () => {
    expect(deriveCommissionBaseCents({
      amountPaidCents: 0,
      totalExcludingTaxCents: 0,
    })).toBeNull();
  });

  it("requires an excluding-tax base and refuses a base larger than collection", () => {
    expect(() => deriveCommissionBaseCents({
      amountPaidCents: 1_000,
      totalExcludingTaxCents: null,
    })).toThrow("COMMISSION_BASE_UNAVAILABLE");
    expect(() => deriveCommissionBaseCents({
      amountPaidCents: 1_000,
      totalExcludingTaxCents: 1_001,
    })).toThrow("COMMISSION_BASE_EXCEEDS_COLLECTION");
  });

  it("treats month twelve as exclusive and cancellation as a stop on future accrual", () => {
    const window = {
      startedAt: "2026-01-15T00:00:00.000Z",
      expiresAt: "2027-01-15T00:00:00.000Z",
    };
    expect(isCommissionWindowEligible({
      paidAt: "2027-01-14T23:59:59.999Z",
      window,
    })).toBe(true);
    expect(isCommissionWindowEligible({
      paidAt: "2027-01-15T00:00:00.000Z",
      window,
    })).toBe(false);
    expect(isCommissionWindowEligible({
      paidAt: "2026-08-15T00:00:00.000Z",
      window,
      canceledAt: "2026-08-01T00:00:00.000Z",
    })).toBe(false);
  });

  it("caps partial refund and dispute-loss offsets at unreversed commission", () => {
    expect(deriveCommissionAdjustmentCents({
      kind: "refund",
      requestedCents: 900,
      balance: { accrualCents: 1_000, offsetCents: 400, recoveryCents: 100 },
    })).toBe(700);
    expect(deriveCommissionAdjustmentCents({
      kind: "dispute_loss",
      requestedCents: 200,
      balance: { accrualCents: 1_000, offsetCents: 400, recoveryCents: 100 },
    })).toBe(200);
  });

  it("caps won-dispute recovery at the amount still offset", () => {
    expect(deriveCommissionAdjustmentCents({
      kind: "dispute_recovery",
      requestedCents: 900,
      balance: { accrualCents: 1_000, offsetCents: 600, recoveryCents: 250 },
    })).toBe(350);
  });
});

describe("affiliate service", () => {
  it("does not call the repository or start a window for a zero-paid invoice", async () => {
    const accrueInvoice = vi.fn(repository().accrueInvoice);
    const service = createAffiliateService(repository({ accrueInvoice }));

    await expect(service.accrueInvoice({
      tenantId: "tenant-1",
      invoiceId: "invoice-zero",
      paidAt: "2026-08-17T00:00:00.000Z",
      amountPaidCents: 0,
      totalExcludingTaxCents: 0,
    })).resolves.toBeNull();
    expect(accrueInvoice).not.toHaveBeenCalled();
  });

  it("passes the derived excluding-tax base into the atomic accrual RPC boundary", async () => {
    const accrueInvoice = vi.fn(async () => null);
    const service = createAffiliateService(repository({ accrueInvoice }));

    await service.accrueInvoice({
      tenantId: "tenant-1",
      invoiceId: "invoice-discounted",
      paidAt: "2026-08-17T00:00:00.000Z",
      amountPaidCents: 11_200,
      totalExcludingTaxCents: 10_000,
    });

    expect(accrueInvoice).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      invoiceId: "invoice-discounted",
      paidAt: "2026-08-17T00:00:00.000Z",
      amountPaidCents: 11_200,
      totalExcludingTaxCents: 10_000,
    });
  });

  it("rejects duplicate ledger ids before payout approval", async () => {
    const approvePayout = vi.fn(repository().approvePayout);
    const service = createAffiliateService(repository({ approvePayout }));

    await expect(service.approvePayout({
      affiliateId: "affiliate-1",
      ledgerIds: ["ledger-1", "ledger-1"],
      reason: "Monthly review",
    })).rejects.toThrow("PAYOUT_LEDGER_SELECTION_INVALID");
    expect(approvePayout).not.toHaveBeenCalled();
  });

  it("keeps approved-for-payout separate from a sent record with reference and date", async () => {
    const service = createAffiliateService(repository());

    await expect(service.approvePayout({
      affiliateId: "affiliate-1",
      ledgerIds: ["ledger-1"],
      reason: "Monthly review",
    })).resolves.toMatchObject({ state: "approved_for_payout", auditId: 41 });
    await expect(service.recordSent({
      payoutId: "payout-1",
      reference: "bank-reference-7",
      paidOn: "2026-08-17",
    })).resolves.toMatchObject({
      state: "sent",
      reference: "bank-reference-7",
      paidOn: "2026-08-17",
      auditId: 42,
    });
  });

  it("has no attribution mutation or payment-transfer port", () => {
    expect(Object.keys(createAffiliateService(repository())).sort()).toEqual([
      "accrueInvoice",
      "approvePayout",
      "listOwnReferrals",
      "recordSent",
      "reverseInvoice",
    ]);
  });
});
