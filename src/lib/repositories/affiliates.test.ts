import { describe, expect, it, vi } from "vitest";

import {
  AffiliateRepositoryError,
  createAffiliateRepository,
  type AffiliateRepositoryDependencies,
} from "./affiliates";

function dependencies(
  overrides: Partial<AffiliateRepositoryDependencies> = {},
): AffiliateRepositoryDependencies {
  return {
    projectReferrals: async () => [{
      business_name: "Northstar Funding",
      account_status: "paying",
      commission_earned_cents: 1_250,
    }],
    projectPayouts: async () => [{
      amount_cents: 2_500,
      state: "sent",
      reference: "synthetic-reference",
      recorded_on: "2026-08-17",
    }],
    callAccrual: async () => [{
      ledger_id: "ledger-1",
      referral_id: "referral-1",
      window_started: true,
      commission_cents: 1_250,
    }],
    readAccrual: async () => ({
      ledgerId: "ledger-1",
      referralId: "referral-1",
      commissionCents: 1_250,
      entryKind: "accrual",
      invoiceId: "invoice-1",
      window: {
        referralId: "referral-1",
        firstInvoiceId: "invoice-1",
        startedAt: "2026-01-15T00:00:00.000Z",
        expiresAt: "2027-01-15T00:00:00.000Z",
      },
    }),
    callAdjustment: async () => [{
      ledger_id: "offset-1",
      reversed_cents: 400,
      entry_kind: "offset",
    }],
    readAdjustment: async () => ({
      ledgerId: "offset-1",
      commissionCents: -400,
      entryKind: "offset",
    }),
    callApprovePayout: async () => [{
      payout_id: "payout-1",
      event_id: "event-approved",
      audit_id: 41,
    }],
    readApprovedPayout: async () => ({
      payoutId: "payout-1",
      eventId: "event-approved",
      eventKind: "approved",
      eventAuditId: 41,
      auditAction: "affiliate.payout.approved",
    }),
    callRecordSent: async () => [{ event_id: "event-sent", audit_id: 42 }],
    readSentPayout: async () => ({
      payoutId: "payout-1",
      eventId: "event-sent",
      eventKind: "sent",
      eventAuditId: 42,
      reference: "bank-reference-7",
      paidOn: "2026-08-17",
      auditAction: "affiliate.payout.sent",
    }),
    ...overrides,
  };
}

const invoice = {
  tenantId: "tenant-1",
  invoiceId: "invoice-1",
  paidAt: "2026-01-15T00:00:00.000Z",
  amountPaidCents: 13_500,
  totalExcludingTaxCents: 12_500,
};

describe("affiliate repository", () => {
  /**
   * Three columns, and the count is the access model rather than tidiness. The contractual rule
   * is that an affiliate sees only referred-coach name, status, and commission earned, never their
   * performance data. This allowlist is what caught a fourth field, Joined, being added from the
   * canvas; the canvas is a drawing and this rule is not, so the field set stays at three and
   * whether a join date counts as performance data is the owner's call, still unanswered.
   *
   * The *values* of `account_status` did change, from a two-state active/inactive to four states,
   * and that is inside the rule rather than a widening of it: it narrows what one field may say so
   * a stalled account stops reading as paying.
   */
  it("accepts only the exact three-column own-referral projection", async () => {
    const repository = createAffiliateRepository(dependencies());

    await expect(repository.listOwnReferrals()).resolves.toEqual([{
      business_name: "Northstar Funding",
      account_status: "paying",
      commission_earned_cents: 1_250,
    }]);

    const widened = createAffiliateRepository(dependencies({
      projectReferrals: async () => [{
        business_name: "Northstar Funding",
        account_status: "paying",
        commission_earned_cents: 1_250,
        tenant_id: "must-not-escape",
      }],
    }));
    await expect(widened.listOwnReferrals()).rejects.toThrow("AFFILIATE_PROJECTION_RECEIPT_INVALID");
  });

  it("accepts only exact own-payout states without affiliate or coach fields", async () => {
    const repository = createAffiliateRepository(dependencies());
    await expect(repository.listOwnPayouts()).resolves.toEqual([{
      amount_cents: 2_500,
      state: "sent",
      reference: "synthetic-reference",
      recorded_on: "2026-08-17",
    }]);

    const widened = createAffiliateRepository(dependencies({
      projectPayouts: async () => [{
        amount_cents: 2_500,
        state: "sent",
        reference: "synthetic-reference",
        recorded_on: "2026-08-17",
        affiliate_id: "must-not-escape",
        tenant_revenue_cents: 99_999,
      }],
    }));
    await expect(widened.listOwnPayouts()).rejects.toThrow(
      "AFFILIATE_PAYOUT_PROJECTION_RECEIPT_INVALID",
    );
  });

  it("calls the accrual RPC with invoice custody fields and requires its window readback", async () => {
    const callAccrual = vi.fn(dependencies().callAccrual);
    const readAccrual = vi.fn(dependencies().readAccrual);
    const repository = createAffiliateRepository(dependencies({ callAccrual, readAccrual }));

    await expect(repository.accrueInvoice(invoice)).resolves.toMatchObject({
      ledgerId: "ledger-1",
      referralId: "referral-1",
      windowStarted: true,
      commissionCents: 1_250,
      window: { firstInvoiceId: "invoice-1" },
    });
    expect(callAccrual).toHaveBeenCalledWith({
      p_expected_tenant: "tenant-1",
      p_stripe_invoice_id: "invoice-1",
      p_invoice_paid_at: "2026-01-15T00:00:00.000Z",
      p_amount_paid_cents: 13_500,
      p_total_excluding_tax_cents: 12_500,
    });
    expect(readAccrual).toHaveBeenCalledWith("ledger-1", "referral-1");
  });

  it("keeps two same-month invoice ids independent and returns the persisted row on replay", async () => {
    const receipts = new Map<string, { ledgerId: string; commissionCents: number }>();
    const callAccrual = vi.fn(async (args: Record<string, unknown>) => {
      const invoiceId = String(args.p_stripe_invoice_id);
      const prior = receipts.get(invoiceId);
      if (prior) return [{
        ledger_id: prior.ledgerId,
        referral_id: "referral-1",
        window_started: false,
        commission_cents: prior.commissionCents,
      }];
      const receipt = { ledgerId: `ledger-${receipts.size + 1}`, commissionCents: 1_000 };
      receipts.set(invoiceId, receipt);
      return [{
        ledger_id: receipt.ledgerId,
        referral_id: "referral-1",
        window_started: receipts.size === 1,
        commission_cents: receipt.commissionCents,
      }];
    });
    const readAccrual = vi.fn(async (ledgerId: string) => {
      const invoiceId = [...receipts].find(([, receipt]) => receipt.ledgerId === ledgerId)?.[0];
      return invoiceId ? {
        ledgerId,
        referralId: "referral-1",
        commissionCents: 1_000,
        entryKind: "accrual",
        invoiceId,
        window: {
          referralId: "referral-1",
          firstInvoiceId: "invoice-a",
          startedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2027-08-01T00:00:00.000Z",
        },
      } : null;
    });
    const repository = createAffiliateRepository(dependencies({ callAccrual, readAccrual }));

    const first = await repository.accrueInvoice({ ...invoice, invoiceId: "invoice-a" });
    const second = await repository.accrueInvoice({ ...invoice, invoiceId: "invoice-b" });
    const replay = await repository.accrueInvoice({ ...invoice, invoiceId: "invoice-a" });

    expect([first?.ledgerId, second?.ledgerId, replay?.ledgerId]).toEqual([
      "ledger-1",
      "ledger-2",
      "ledger-1",
    ]);
    expect(receipts.size).toBe(2);
  });

  it("fails closed when an accrual receipt has no Phase 6 window readback", async () => {
    const repository = createAffiliateRepository(dependencies({
      readAccrual: async () => ({
        ledgerId: "ledger-1",
        referralId: "referral-1",
        commissionCents: 1_250,
        entryKind: "accrual",
        invoiceId: "invoice-1",
        window: null,
      }),
    }));

    await expect(repository.accrueInvoice(invoice)).rejects.toThrow(
      "COMMISSION_ACCRUAL_READBACK_MISMATCH",
    );
  });

  it("read-backs signed offsets and won-dispute recoveries instead of editing an accrual", async () => {
    const recovery = createAffiliateRepository(dependencies({
      callAdjustment: async () => [{
        ledger_id: "recovery-1",
        reversed_cents: 250,
        entry_kind: "recovery",
      }],
      readAdjustment: async () => ({
        ledgerId: "recovery-1",
        commissionCents: 250,
        entryKind: "recovery",
      }),
    }));

    await expect(recovery.reverseInvoice({
      tenantId: "tenant-1",
      invoiceId: "invoice-1",
      adjustmentId: "dispute-won-1",
      adjustmentKind: "dispute_recovery",
      adjustmentCommissionCents: 250,
      occurredAt: "2026-08-17T12:00:00.000Z",
    })).resolves.toEqual({
      ledgerId: "recovery-1",
      reversedCents: 250,
      entryKind: "recovery",
    });
  });

  it("requires persisted payout and audit receipts for both honest payout states", async () => {
    const repository = createAffiliateRepository(dependencies());

    await expect(repository.approvePayout({
      affiliateId: "affiliate-1",
      ledgerIds: ["ledger-1"],
      reason: "Monthly payout review",
    })).resolves.toEqual({
      payoutId: "payout-1",
      eventId: "event-approved",
      auditId: 41,
      state: "approved_for_payout",
    });
    await expect(repository.recordPayoutSent({
      payoutId: "payout-1",
      reference: "bank-reference-7",
      paidOn: "2026-08-17",
    })).resolves.toEqual({
      payoutId: "payout-1",
      eventId: "event-sent",
      auditId: 42,
      reference: "bank-reference-7",
      paidOn: "2026-08-17",
      state: "sent",
    });
  });

  it("rejects a mismatched audit action rather than claiming a payout was recorded", async () => {
    const repository = createAffiliateRepository(dependencies({
      readApprovedPayout: async () => ({
        payoutId: "payout-1",
        eventId: "event-approved",
        eventKind: "approved",
        eventAuditId: 41,
        auditAction: "billing.tier.updated",
      }),
    }));

    await expect(repository.approvePayout({
      affiliateId: "affiliate-1",
      ledgerIds: ["ledger-1"],
      reason: "Monthly payout review",
    })).rejects.toBeInstanceOf(AffiliateRepositoryError);
  });
});

/**
 * The shape of the production 503 of 2026-09-01, kept as a fixture.
 *
 * The allowlist moved to four account states while the hosted `affiliate_referral_projection` was
 * still the two-state version, and a deploy does not run migrations, so every row the function
 * returned was `active` or `inactive` and the parser refused the first one. This asserts the
 * refusal itself, because the refusal is correct: the alternative to failing here is reading an
 * unknown status as something it is not, in front of the person whose income depends on it.
 * `affiliate-account-states.test.ts` is what stops the two copies drifting in the first place.
 */
describe("the superseded two-state projection", () => {
  it("refuses a stalled-account status the deployed allowlist no longer knows", async () => {
    for (const account_status of ["active", "inactive"]) {
      const stale = createAffiliateRepository(dependencies({
        projectReferrals: async () => [{
          business_name: "Northstar Funding",
          account_status,
          commission_earned_cents: 1_250,
        }],
      }));

      await expect(stale.listOwnReferrals())
        .rejects.toThrow("AFFILIATE_PROJECTION_RECEIPT_INVALID");
    }
  });

  /**
   * A `tenant_status` the migration's `case` does not name arrives as null, which is the same
   * refusal by design: the `case` has no `else` arm precisely so an unmapped status cannot be read
   * as "Paying".
   */
  it("refuses an unmapped status rather than reading it as paying", async () => {
    const unmapped = createAffiliateRepository(dependencies({
      projectReferrals: async () => [{
        business_name: "Northstar Funding",
        account_status: null,
        commission_earned_cents: 1_250,
      }],
    }));

    await expect(unmapped.listOwnReferrals())
      .rejects.toThrow("AFFILIATE_PROJECTION_RECEIPT_INVALID");
  });
});
