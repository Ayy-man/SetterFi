/**
 * Provider-blind money contracts shared by billing, affiliate, and notification services.
 *
 * These shapes carry persisted identifiers and normalized business state only. Provider SDK
 * objects stay behind integration drivers, while cost evidence remains platform-only by type.
 */

export const BILLING_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
  "canceled",
  "unavailable",
] as const;

export type BillingSubscriptionStatus = (typeof BILLING_SUBSCRIPTION_STATUSES)[number];

export const BILLING_NOTIFICATION_EVENT_KEYS = [
  "billing.payment_completed",
  "billing.payment_failed",
  "billing.account_overdue",
  "billing.account_suspended",
  "billing.allowance_warning",
  "billing.allowance_crossed",
  "billing.tier_upgraded",
] as const;

export type BillingNotificationEventKey = (typeof BILLING_NOTIFICATION_EVENT_KEYS)[number];

type BillingNotificationBase = {
  tenantId: string;
  occurredAt: string;
  isTest: boolean;
};

export type BillingNotificationEvent =
  | (BillingNotificationBase & {
      key: "billing.payment_completed";
      invoiceId: string;
    })
  | (BillingNotificationBase & {
      key: "billing.payment_failed";
      invoiceId: string;
    })
  | (BillingNotificationBase & {
      key: "billing.account_overdue";
      invoiceId: string;
    })
  | (BillingNotificationBase & {
      key: "billing.account_suspended";
      reason: string;
      auditId: number;
    })
  | (BillingNotificationBase & {
      key: "billing.allowance_warning";
      allowanceActionId: string;
      observedCount: number;
      allowance: number;
      periodEnd: string;
    })
  | (BillingNotificationBase & {
      key: "billing.allowance_crossed";
      allowanceActionId: string;
      observedCount: number;
      allowance: number;
      targetTierId: string;
      targetPriceId: string;
      effectiveAt: string;
    })
  | (BillingNotificationBase & {
      key: "billing.tier_upgraded";
      allowanceActionId: string;
      targetTierId: string;
      targetPriceId: string;
      effectiveAt: string;
    });

export type BillingNotificationPort = {
  emit(event: BillingNotificationEvent): Promise<{ notificationId: string }>;
};

/**
 * The four states an affiliate may see a referred coach in, and the reason there are four rather
 * than the canvas's three.
 *
 * `tenant_status` is six values. `onboarding`, `active` and `churned` map cleanly onto "still
 * setting up", "paying" and "cancelled"; `paused`, `overdue` and `suspended` map onto none of them,
 * and the projection used to fold all three into `active` -- telling an affiliate that commission
 * was still coming from an account that had stopped paying for it. They collapse into one
 * `payment_problem` instead of three states, because *why* a coach's payments stalled is the
 * coach's business and not their referrer's; that a payment problem exists is the whole of what the
 * affiliate can act on.
 */
export const AFFILIATE_ACCOUNT_STATES = [
  "setting_up",
  "paying",
  "payment_problem",
  "cancelled",
] as const;

export type AffiliateAccountState = (typeof AFFILIATE_ACCOUNT_STATES)[number];

/**
 * What each state is called in front of an affiliate.
 *
 * These four strings are the ones `affiliate-money.tsx` already draws in its `REFERRAL_STATES`
 * table; they live here because the CSV needs them too, and the CSV was shipping the raw slug --
 * an affiliate opening their referral export read `payment_problem` where the screen they
 * exported it from says "Payment problem". A storage enum is not a word anybody chose to show a
 * customer, and a customer-facing file is exactly where one stops being an implementation detail.
 *
 * The labels only, without the tone or the detail line: a CSV cell has no colour to carry a tone,
 * and the detail sentences ("commission starts when their first invoice clears") are guidance for
 * someone reading a table, not a value belonging in a column beside it. Widening the export is
 * also not open to this module -- `AFFILIATE_REFERRAL_FIELDS` below is a three-field rule, not a
 * convenience.
 *
 * `affiliate-referral-export.test.ts` reads `REFERRAL_STATES` out of the component and asserts
 * every label here matches it, so the file and the screen cannot drift into two vocabularies for
 * one state.
 */
export const AFFILIATE_ACCOUNT_STATE_LABELS: Record<AffiliateAccountState, string> = {
  setting_up: "Still setting up",
  paying: "Paying",
  payment_problem: "Payment problem",
  cancelled: "Cancelled",
};

/**
 * Three fields, and the count is a rule rather than a coincidence.
 *
 * `CLAUDE.md`: an affiliate "sees only referred-coach name, status, and commission earned, never
 * their performance data." The canvas draws a fourth column, Joined, and it is not here: whether a
 * join date is performance data in spirit is Alec's call, not the build side's, and every layer
 * below refuses a fourth key today. Widening this type means widening the access model, so it goes
 * through `docs/DECISIONS.md` first.
 */
export type AffiliateProjectionRow = {
  business_name: string;
  account_status: AffiliateAccountState;
  commission_earned_cents: number;
};

export type BillingCorrectionResult =
  | {
      state: "requested";
      requestId: string;
      requestAuditId: number;
    }
  | {
      state: "approved";
      requestId: string;
      decisionId: string;
      offsetEventId: string;
      requestAuditId: number;
      decisionAuditId: number;
    }
  | {
      state: "rejected";
      requestId: string;
      decisionId: string;
      requestAuditId: number;
      decisionAuditId: number;
    };

export type AllowanceActionResult =
  | {
      kind: "warning";
      actionId: string;
      noticeEventId: string;
      state: "recorded";
    }
  | {
      kind: "crossing";
      actionId: string;
      noticeEventId: string;
      scheduleId: string;
      targetTierId: string;
      effectiveAt: string;
      state: "scheduled";
    }
  | {
      kind: "fair_use_review";
      actionId: string;
      noticeEventId: string;
      state: "recorded";
    };

export type CommissionPayoutResult =
  | {
      state: "approved_for_payout";
      payoutId: string;
      eventId: string;
      auditId: number;
    }
  | {
      state: "sent";
      payoutId: string;
      eventId: string;
      reference: string;
      paidOn: string;
      auditId: number;
    };

export type TenantBillingStateResult = {
  tenantId: string;
  previousStatus: "active" | "overdue" | "suspended";
  status: "active" | "overdue" | "suspended";
  auditId: number;
};

export const COST_SOURCES = ["model", "messaging", "embedding"] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export type PlatformCostRollupResult = {
  rollupId: string;
  tenantId: string;
  windowStart: string;
  windowEnd: string;
  modelCostCents: number | null;
  messagingCostCents: number | null;
  embeddingCostCents: number | null;
  revenueCents: number;
  complete: boolean;
  missingSources: readonly CostSource[];
  sourceEvidenceAt: string;
};

export type PlatformMarginProjectionRow = {
  tenantId: string;
  windowStart: string;
  windowEnd: string;
  revenueCents: number;
  totalCostCents: number;
  marginCents: number;
};
