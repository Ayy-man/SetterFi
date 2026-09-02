/**
 * RPC-only custody for affiliate commission, projection, and payout records.
 *
 * Referral attribution has deliberately no write port here. Phase 5 owns attribution, while the
 * Phase 6 RPCs own commission windows and append-only money rows in one database transaction.
 */

import { AFFILIATE_ACCOUNT_STATES, type AffiliateProjectionRow } from "@/lib/billing/contracts";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

export type CommissionWindowReadback = {
  referralId: string;
  firstInvoiceId: string;
  startedAt: string;
  expiresAt: string;
};

export type CommissionAccrualReceipt = {
  ledgerId: string;
  referralId: string;
  windowStarted: boolean;
  commissionCents: number;
  window: CommissionWindowReadback;
};

export type CommissionAdjustmentReceipt = {
  ledgerId: string;
  reversedCents: number;
  entryKind: "offset" | "recovery";
};

export type PayoutApprovalReceipt = {
  payoutId: string;
  eventId: string;
  auditId: number;
  state: "approved_for_payout";
};

export type PayoutSentReceipt = {
  payoutId: string;
  eventId: string;
  auditId: number;
  reference: string;
  paidOn: string;
  state: "sent";
};

export type AffiliatePayoutProjectionRow = {
  amount_cents: number;
  state: "approved_for_payout" | "sent";
  reference: string | null;
  recorded_on: string | null;
};

export type AffiliateRepository = {
  listOwnReferrals(): Promise<readonly AffiliateProjectionRow[]>;
  listOwnPayouts(): Promise<readonly AffiliatePayoutProjectionRow[]>;
  accrueInvoice(input: {
    tenantId: string;
    invoiceId: string;
    paidAt: string;
    amountPaidCents: number;
    totalExcludingTaxCents: number;
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
  }): Promise<PayoutApprovalReceipt>;
  recordPayoutSent(input: {
    actorId?: string;
    payoutId: string;
    reference: string;
    paidOn: string;
  }): Promise<PayoutSentReceipt>;
};

type AccrualRpcRow = {
  ledger_id: string;
  referral_id: string;
  window_started: boolean;
  commission_cents: number;
};

type AdjustmentRpcRow = {
  ledger_id: string;
  reversed_cents: number;
  entry_kind: "offset" | "recovery";
};

type ApprovalRpcRow = { payout_id: string; event_id: string; audit_id: number };
type SentRpcRow = { event_id: string; audit_id: number };

export type AffiliateRepositoryDependencies = {
  projectReferrals(): Promise<unknown>;
  projectPayouts(): Promise<unknown>;
  callAccrual(args: Record<string, unknown>): Promise<unknown>;
  readAccrual(ledgerId: string, referralId: string): Promise<{
    ledgerId: string;
    referralId: string;
    commissionCents: number;
    entryKind: string;
    invoiceId: string;
    window: CommissionWindowReadback | null;
  } | null>;
  callAdjustment(args: Record<string, unknown>): Promise<unknown>;
  readAdjustment(ledgerId: string): Promise<{
    ledgerId: string;
    commissionCents: number;
    entryKind: string;
  } | null>;
  callApprovePayout(args: Record<string, unknown>): Promise<unknown>;
  readApprovedPayout(payoutId: string, eventId: string, auditId: number): Promise<{
    payoutId: string;
    eventId: string;
    eventKind: string;
    eventAuditId: number;
    auditAction: string;
  } | null>;
  callRecordSent(args: Record<string, unknown>): Promise<unknown>;
  readSentPayout(payoutId: string, eventId: string, auditId: number): Promise<{
    payoutId: string;
    eventId: string;
    eventKind: string;
    eventAuditId: number;
    reference: string | null;
    paidOn: string | null;
    auditAction: string;
  } | null>;
};

export class AffiliateRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AffiliateRepositoryError";
  }
}

function rowFrom(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" && !Array.isArray(row)
    ? row as Record<string, unknown>
    : null;
}

function safeInteger(value: unknown, code: string) {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new AffiliateRepositoryError(code);
  }
  return number;
}

function parseProjection(data: unknown): AffiliateProjectionRow[] {
  if (!Array.isArray(data)) throw new AffiliateRepositoryError("AFFILIATE_PROJECTION_RECEIPT_INVALID");
  return data.map((candidate) => {
    const row = rowFrom(candidate);
    /*
     * The state check is the enum guard, and it has to stay a whitelist rather than a cast.
     * `affiliate_referral_projection`'s `case` has no `else` arm, so a `tenant_status` value added
     * later maps to no state and arrives here as null; rejecting it turns that into "could not
     * load" on the portal instead of a silent wrong claim about whether money is still coming.
     *
     * The key list stays at three, and that is the access model rather than tidiness: `CLAUDE.md`
     * says an affiliate sees a referred coach's name, status and commission earned and nothing
     * else. This check is what caught a fourth field being added from the canvas.
     */
    if (
      !row
      || Object.keys(row).sort().join(",")
        !== "account_status,business_name,commission_earned_cents"
      || typeof row.business_name !== "string"
      || !(AFFILIATE_ACCOUNT_STATES as readonly string[]).includes(String(row.account_status))
    ) {
      throw new AffiliateRepositoryError("AFFILIATE_PROJECTION_RECEIPT_INVALID");
    }
    return {
      business_name: row.business_name,
      account_status: row.account_status as AffiliateProjectionRow["account_status"],
      commission_earned_cents: safeInteger(
        row.commission_earned_cents,
        "AFFILIATE_PROJECTION_RECEIPT_INVALID",
      ),
    };
  });
}

function parsePayoutProjection(data: unknown): AffiliatePayoutProjectionRow[] {
  if (!Array.isArray(data)) {
    throw new AffiliateRepositoryError("AFFILIATE_PAYOUT_PROJECTION_RECEIPT_INVALID");
  }
  return data.map((candidate) => {
    const row = rowFrom(candidate);
    if (
      !row
      || Object.keys(row).sort().join(",") !== "amount_cents,recorded_on,reference,state"
      || !["approved_for_payout", "sent"].includes(String(row.state))
      || (row.reference !== null && typeof row.reference !== "string")
      || (row.recorded_on !== null && typeof row.recorded_on !== "string")
      || (row.state === "approved_for_payout"
        && (row.reference !== null || row.recorded_on !== null))
      || (row.state === "sent"
        && (typeof row.reference !== "string" || !row.reference.trim()
          || typeof row.recorded_on !== "string" || !row.recorded_on.trim()))
    ) throw new AffiliateRepositoryError("AFFILIATE_PAYOUT_PROJECTION_RECEIPT_INVALID");
    return {
      amount_cents: safeInteger(
        row.amount_cents,
        "AFFILIATE_PAYOUT_PROJECTION_RECEIPT_INVALID",
      ),
      state: row.state as AffiliatePayoutProjectionRow["state"],
      reference: row.reference,
      recorded_on: row.recorded_on,
    };
  });
}

function parseAccrual(data: unknown): AccrualRpcRow | null {
  const row = rowFrom(data);
  if (!row) return null;
  if (
    typeof row.ledger_id !== "string"
    || typeof row.referral_id !== "string"
    || typeof row.window_started !== "boolean"
  ) throw new AffiliateRepositoryError("COMMISSION_ACCRUAL_RECEIPT_INVALID");
  return {
    ledger_id: row.ledger_id,
    referral_id: row.referral_id,
    window_started: row.window_started,
    commission_cents: safeInteger(row.commission_cents, "COMMISSION_ACCRUAL_RECEIPT_INVALID"),
  };
}

function parseAdjustment(data: unknown): AdjustmentRpcRow | null {
  const row = rowFrom(data);
  if (!row) return null;
  if (
    typeof row.ledger_id !== "string"
    || !["offset", "recovery"].includes(String(row.entry_kind))
  ) throw new AffiliateRepositoryError("COMMISSION_ADJUSTMENT_RECEIPT_INVALID");
  return {
    ledger_id: row.ledger_id,
    reversed_cents: safeInteger(row.reversed_cents, "COMMISSION_ADJUSTMENT_RECEIPT_INVALID"),
    entry_kind: row.entry_kind as AdjustmentRpcRow["entry_kind"],
  };
}

function parseApproval(data: unknown): ApprovalRpcRow {
  const row = rowFrom(data);
  if (typeof row?.payout_id !== "string" || typeof row.event_id !== "string") {
    throw new AffiliateRepositoryError("PAYOUT_APPROVAL_RECEIPT_INVALID");
  }
  return {
    payout_id: row.payout_id,
    event_id: row.event_id,
    audit_id: safeInteger(row.audit_id, "PAYOUT_APPROVAL_RECEIPT_INVALID"),
  };
}

function parseSent(data: unknown): SentRpcRow {
  const row = rowFrom(data);
  if (typeof row?.event_id !== "string") {
    throw new AffiliateRepositoryError("PAYOUT_SENT_RECEIPT_INVALID");
  }
  return {
    event_id: row.event_id,
    audit_id: safeInteger(row.audit_id, "PAYOUT_SENT_RECEIPT_INVALID"),
  };
}

async function liveDependencies(): Promise<AffiliateRepositoryDependencies> {
  const userClient = await createSupabaseServerClient();
  const serviceClient = createSupabaseServiceClient();
  return {
    projectReferrals: async () => {
      const { data, error } = await userClient.rpc("affiliate_referral_projection");
      if (error) throw new AffiliateRepositoryError("AFFILIATE_PROJECTION_FAILED");
      return data;
    },
    projectPayouts: async () => {
      const { data, error } = await userClient.rpc("affiliate_payout_history_projection");
      if (error) throw new AffiliateRepositoryError("AFFILIATE_PAYOUT_PROJECTION_FAILED");
      return data;
    },
    callAccrual: async (args) => {
      const { data, error } = await serviceClient.rpc("accrue_invoice_commission", args);
      if (error) throw new AffiliateRepositoryError("COMMISSION_ACCRUAL_FAILED");
      return data;
    },
    readAccrual: async (ledgerId, referralId) => {
      const [ledgerResult, windowResult] = await Promise.all([
        serviceClient
          .from("commission_ledger")
          .select("id,referral_id,commission_cents,entry_kind,stripe_invoice_id")
          .eq("id", ledgerId)
          .eq("referral_id", referralId)
          .maybeSingle(),
        serviceClient
          .from("referral_commission_windows")
          .select("referral_id,first_invoice_id,started_at,expires_at")
          .eq("referral_id", referralId)
          .maybeSingle(),
      ]);
      if (ledgerResult.error || windowResult.error || !ledgerResult.data) {
        throw new AffiliateRepositoryError("COMMISSION_ACCRUAL_READBACK_FAILED");
      }
      const ledger = ledgerResult.data;
      const window = windowResult.data;
      return {
        ledgerId: ledger.id,
        referralId: ledger.referral_id,
        commissionCents: Number(ledger.commission_cents),
        entryKind: ledger.entry_kind,
        invoiceId: ledger.stripe_invoice_id,
        window: window ? {
          referralId: window.referral_id,
          firstInvoiceId: window.first_invoice_id,
          startedAt: window.started_at,
          expiresAt: window.expires_at,
        } : null,
      };
    },
    callAdjustment: async (args) => {
      const { data, error } = await serviceClient.rpc("reverse_invoice_commission", args);
      if (error) throw new AffiliateRepositoryError("COMMISSION_ADJUSTMENT_FAILED");
      return data;
    },
    readAdjustment: async (ledgerId) => {
      const { data, error } = await serviceClient
        .from("commission_ledger")
        .select("id,commission_cents,entry_kind")
        .eq("id", ledgerId)
        .maybeSingle();
      if (error) throw new AffiliateRepositoryError("COMMISSION_ADJUSTMENT_READBACK_FAILED");
      return data ? {
        ledgerId: data.id,
        commissionCents: Number(data.commission_cents),
        entryKind: data.entry_kind,
      } : null;
    },
    callApprovePayout: async (args) => {
      const { data, error } = await serviceClient.rpc("approve_commission_payout", args);
      if (error) throw new AffiliateRepositoryError("PAYOUT_APPROVAL_FAILED");
      return data;
    },
    readApprovedPayout: async (payoutId, eventId, auditId) => {
      const [payoutResult, eventResult, auditResult] = await Promise.all([
        serviceClient.from("commission_payouts").select("id").eq("id", payoutId).maybeSingle(),
        serviceClient
          .from("commission_payout_events")
          .select("id,payout_id,kind,audit_id")
          .eq("id", eventId)
          .eq("payout_id", payoutId)
          .maybeSingle(),
        serviceClient.from("audit_log").select("id,action").eq("id", auditId).maybeSingle(),
      ]);
      if (payoutResult.error || eventResult.error || auditResult.error) {
        throw new AffiliateRepositoryError("PAYOUT_APPROVAL_READBACK_FAILED");
      }
      if (!payoutResult.data || !eventResult.data || !auditResult.data) return null;
      return {
        payoutId: payoutResult.data.id,
        eventId: eventResult.data.id,
        eventKind: eventResult.data.kind,
        eventAuditId: Number(eventResult.data.audit_id),
        auditAction: auditResult.data.action,
      };
    },
    callRecordSent: async (args) => {
      const { data, error } = await serviceClient.rpc("record_commission_payout_sent", args);
      if (error) throw new AffiliateRepositoryError("PAYOUT_SENT_FAILED");
      return data;
    },
    readSentPayout: async (payoutId, eventId, auditId) => {
      const [eventResult, auditResult] = await Promise.all([
        serviceClient
          .from("commission_payout_events")
          .select("id,payout_id,kind,audit_id,reference,paid_on")
          .eq("id", eventId)
          .eq("payout_id", payoutId)
          .maybeSingle(),
        serviceClient.from("audit_log").select("id,action").eq("id", auditId).maybeSingle(),
      ]);
      if (eventResult.error || auditResult.error) {
        throw new AffiliateRepositoryError("PAYOUT_SENT_READBACK_FAILED");
      }
      if (!eventResult.data || !auditResult.data) return null;
      return {
        payoutId: eventResult.data.payout_id,
        eventId: eventResult.data.id,
        eventKind: eventResult.data.kind,
        eventAuditId: Number(eventResult.data.audit_id),
        reference: eventResult.data.reference,
        paidOn: eventResult.data.paid_on,
        auditAction: auditResult.data.action,
      };
    },
  };
}

export function createAffiliateRepository(
  provided?: AffiliateRepositoryDependencies,
): AffiliateRepository {
  const dependencies = async () => provided ?? (await liveDependencies());
  return {
    listOwnReferrals: async () => parseProjection(await (await dependencies()).projectReferrals()),
    listOwnPayouts: async () => parsePayoutProjection(
      await (await dependencies()).projectPayouts(),
    ),
    accrueInvoice: async (input) => {
      const deps = await dependencies();
      const rpc = parseAccrual(await deps.callAccrual({
        p_expected_tenant: input.tenantId,
        p_stripe_invoice_id: input.invoiceId,
        p_invoice_paid_at: input.paidAt,
        p_amount_paid_cents: input.amountPaidCents,
        p_total_excluding_tax_cents: input.totalExcludingTaxCents,
      }));
      if (!rpc) return null;
      const readback = await deps.readAccrual(rpc.ledger_id, rpc.referral_id);
      if (
        !readback
        || readback.ledgerId !== rpc.ledger_id
        || readback.referralId !== rpc.referral_id
        || readback.commissionCents !== rpc.commission_cents
        || readback.entryKind !== "accrual"
        || readback.invoiceId !== input.invoiceId
        || !readback.window
        || readback.window.referralId !== rpc.referral_id
      ) throw new AffiliateRepositoryError("COMMISSION_ACCRUAL_READBACK_MISMATCH");
      return {
        ledgerId: rpc.ledger_id,
        referralId: rpc.referral_id,
        windowStarted: rpc.window_started,
        commissionCents: rpc.commission_cents,
        window: readback.window,
      };
    },
    reverseInvoice: async (input) => {
      const deps = await dependencies();
      const rpc = parseAdjustment(await deps.callAdjustment({
        p_expected_tenant: input.tenantId,
        p_stripe_invoice_id: input.invoiceId,
        p_stripe_adjustment_id: input.adjustmentId,
        p_adjustment_kind: input.adjustmentKind,
        p_adjustment_cents: input.adjustmentCommissionCents,
        p_occurred_at: input.occurredAt,
      }));
      if (!rpc) return null;
      const readback = await deps.readAdjustment(rpc.ledger_id);
      const expectedSigned = rpc.entry_kind === "offset" ? -rpc.reversed_cents : rpc.reversed_cents;
      if (
        !readback
        || readback.ledgerId !== rpc.ledger_id
        || readback.entryKind !== rpc.entry_kind
        || readback.commissionCents !== expectedSigned
      ) throw new AffiliateRepositoryError("COMMISSION_ADJUSTMENT_READBACK_MISMATCH");
      return {
        ledgerId: rpc.ledger_id,
        reversedCents: rpc.reversed_cents,
        entryKind: rpc.entry_kind,
      };
    },
    approvePayout: async (input) => {
      const deps = await dependencies();
      const rpc = parseApproval(await deps.callApprovePayout({
        ...(input.actorId ? { p_actor_id: input.actorId } : {}),
        p_affiliate_id: input.affiliateId,
        p_ledger_ids: [...input.ledgerIds],
        p_reason: input.reason,
      }));
      const readback = await deps.readApprovedPayout(rpc.payout_id, rpc.event_id, rpc.audit_id);
      if (
        !readback
        || readback.payoutId !== rpc.payout_id
        || readback.eventId !== rpc.event_id
        || readback.eventKind !== "approved"
        || readback.eventAuditId !== rpc.audit_id
        || readback.auditAction !== "affiliate.payout.approved"
      ) throw new AffiliateRepositoryError("PAYOUT_APPROVAL_READBACK_MISMATCH");
      return {
        payoutId: rpc.payout_id,
        eventId: rpc.event_id,
        auditId: rpc.audit_id,
        state: "approved_for_payout",
      };
    },
    recordPayoutSent: async (input) => {
      const deps = await dependencies();
      const rpc = parseSent(await deps.callRecordSent({
        ...(input.actorId ? { p_actor_id: input.actorId } : {}),
        p_payout_id: input.payoutId,
        p_reference: input.reference,
        p_paid_on: input.paidOn,
      }));
      const readback = await deps.readSentPayout(input.payoutId, rpc.event_id, rpc.audit_id);
      if (
        !readback
        || readback.payoutId !== input.payoutId
        || readback.eventId !== rpc.event_id
        || readback.eventKind !== "sent"
        || readback.eventAuditId !== rpc.audit_id
        || readback.reference !== input.reference
        || readback.paidOn !== input.paidOn
        || readback.auditAction !== "affiliate.payout.sent"
      ) throw new AffiliateRepositoryError("PAYOUT_SENT_READBACK_MISMATCH");
      return {
        payoutId: input.payoutId,
        eventId: rpc.event_id,
        auditId: rpc.audit_id,
        reference: input.reference,
        paidOn: input.paidOn,
        state: "sent",
      };
    },
  };
}
