/**
 * Deterministic affiliate money rules over the RPC-backed repository.
 *
 * The service derives cents and eligibility only from persisted invoice/window facts. It never
 * edits attribution, prior ledger rows, or payout state, and it has no payment-provider port.
 */

import type { CommissionPayoutResult } from "@/lib/billing/contracts";
import type {
  AffiliateRepository,
  CommissionAccrualReceipt,
  CommissionAdjustmentReceipt,
} from "@/lib/repositories/affiliates";

export type CommissionWindow = {
  startedAt: string;
  expiresAt: string;
};

export type CommissionBalance = {
  accrualCents: number;
  offsetCents: number;
  recoveryCents: number;
};

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function cents(value: number, code: string, allowZero = true) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(code);
  }
  return value;
}

function timestamp(value: string, code: string) {
  const normalized = required(value, code);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(code);
  return normalized;
}

export function deriveCommissionBaseCents(input: {
  amountPaidCents: number;
  totalExcludingTaxCents: number | null;
}) {
  const amountPaid = cents(input.amountPaidCents, "COMMISSION_AMOUNT_PAID_INVALID");
  if (amountPaid === 0) return null;
  if (input.totalExcludingTaxCents === null) throw new Error("COMMISSION_BASE_UNAVAILABLE");
  const base = cents(input.totalExcludingTaxCents, "COMMISSION_BASE_INVALID");
  if (base > amountPaid) throw new Error("COMMISSION_BASE_EXCEEDS_COLLECTION");
  return base;
}

export function deriveCommissionCents(baseCents: number) {
  return Math.round(cents(baseCents, "COMMISSION_BASE_INVALID") * 0.1);
}

export function isCommissionWindowEligible(input: {
  paidAt: string;
  window: CommissionWindow;
  canceledAt?: string | null;
}) {
  const paidAt = Date.parse(timestamp(input.paidAt, "COMMISSION_PAID_AT_INVALID"));
  const startedAt = Date.parse(timestamp(input.window.startedAt, "COMMISSION_WINDOW_INVALID"));
  const expiresAt = Date.parse(timestamp(input.window.expiresAt, "COMMISSION_WINDOW_INVALID"));
  if (expiresAt <= startedAt) throw new Error("COMMISSION_WINDOW_INVALID");
  if (input.canceledAt) {
    const canceledAt = Date.parse(timestamp(input.canceledAt, "COMMISSION_CANCELED_AT_INVALID"));
    if (paidAt >= canceledAt) return false;
  }
  return paidAt >= startedAt && paidAt < expiresAt;
}

export function deriveCommissionAdjustmentCents(input: {
  kind: "refund" | "dispute_loss" | "dispute_recovery";
  requestedCents: number;
  balance: CommissionBalance;
}) {
  const requested = cents(input.requestedCents, "COMMISSION_ADJUSTMENT_INVALID", false);
  const accrual = cents(input.balance.accrualCents, "COMMISSION_BALANCE_INVALID");
  const offsets = cents(input.balance.offsetCents, "COMMISSION_BALANCE_INVALID");
  const recoveries = cents(input.balance.recoveryCents, "COMMISSION_BALANCE_INVALID");
  const available = input.kind === "dispute_recovery"
    ? Math.max(offsets - recoveries, 0)
    : Math.max(accrual - offsets + recoveries, 0);
  return Math.min(requested, available);
}

export type AffiliateService = {
  listOwnReferrals: AffiliateRepository["listOwnReferrals"];
  accrueInvoice(input: {
    tenantId: string;
    invoiceId: string;
    paidAt: string;
    amountPaidCents: number;
    totalExcludingTaxCents: number | null;
  }): Promise<CommissionAccrualReceipt | null>;
  reverseInvoice(input: {
    tenantId: string;
    invoiceId: string;
    adjustmentId: string;
    adjustmentKind: "refund" | "dispute_loss" | "dispute_recovery";
    adjustmentCommissionCents: number;
    occurredAt: string;
  }): Promise<CommissionAdjustmentReceipt | null>;
  approvePayout(input: {
    actorId?: string;
    affiliateId: string;
    ledgerIds: readonly string[];
    reason: string;
  }): Promise<CommissionPayoutResult>;
  recordSent(input: {
    actorId?: string;
    payoutId: string;
    reference: string;
    paidOn: string;
  }): Promise<CommissionPayoutResult>;
};

export function createAffiliateService(repository: AffiliateRepository): AffiliateService {
  return {
    listOwnReferrals: () => repository.listOwnReferrals(),
    accrueInvoice: async (input) => {
      const tenantId = required(input.tenantId, "COMMISSION_TENANT_REQUIRED");
      const invoiceId = required(input.invoiceId, "COMMISSION_INVOICE_REQUIRED");
      const paidAt = timestamp(input.paidAt, "COMMISSION_PAID_AT_INVALID");
      const base = deriveCommissionBaseCents(input);
      if (base === null) return null;
      return repository.accrueInvoice({
        tenantId,
        invoiceId,
        paidAt,
        amountPaidCents: input.amountPaidCents,
        totalExcludingTaxCents: base,
      });
    },
    reverseInvoice: (input) => repository.reverseInvoice({
      tenantId: required(input.tenantId, "COMMISSION_TENANT_REQUIRED"),
      invoiceId: required(input.invoiceId, "COMMISSION_INVOICE_REQUIRED"),
      adjustmentId: required(input.adjustmentId, "COMMISSION_ADJUSTMENT_ID_REQUIRED"),
      adjustmentKind: input.adjustmentKind,
      adjustmentCommissionCents: cents(
        input.adjustmentCommissionCents,
        "COMMISSION_ADJUSTMENT_INVALID",
        false,
      ),
      occurredAt: timestamp(input.occurredAt, "COMMISSION_OCCURRED_AT_INVALID"),
    }),
    approvePayout: async (input) => {
      const ledgerIds = input.ledgerIds.map((id) => required(id, "PAYOUT_LEDGER_REQUIRED"));
      if (ledgerIds.length === 0 || new Set(ledgerIds).size !== ledgerIds.length) {
        throw new Error("PAYOUT_LEDGER_SELECTION_INVALID");
      }
      return repository.approvePayout({
        actorId: input.actorId,
        affiliateId: required(input.affiliateId, "PAYOUT_AFFILIATE_REQUIRED"),
        ledgerIds,
        reason: required(input.reason, "PAYOUT_APPROVAL_REASON_REQUIRED"),
      });
    },
    recordSent: async (input) => {
      const paidOn = required(input.paidOn, "PAYOUT_PAID_ON_REQUIRED");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`))) {
        throw new Error("PAYOUT_PAID_ON_INVALID");
      }
      return repository.recordPayoutSent({
        actorId: input.actorId,
        payoutId: required(input.payoutId, "PAYOUT_ID_REQUIRED"),
        reference: required(input.reference, "PAYOUT_REFERENCE_REQUIRED"),
        paidOn,
      });
    },
  };
}
