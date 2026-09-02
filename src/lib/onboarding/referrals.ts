/**
 * Coach-safe referral result mapping at the immutable signup seam.
 *
 * Unknown and revoked codes intentionally collapse to the same empty client result. Their reason
 * remains in the audit log, while self-referral alone earns explicit coach-facing correction.
 */

import type { CompleteSignupReceipt } from "@/lib/repositories/onboarding-signup";

export const SELF_REFERRAL_CLIENT_CODE = "SELF_REFERRAL_NOT_APPLIED" as const;
export const SELF_REFERRAL_MESSAGE =
  "This referral code belongs to your own account, so it can't be applied" as const;

export type ReferralClientResult =
  | {
      status: "attributed" | "none";
      coachCode: null;
      message: null;
      affiliateEnrollment: "requested" | "not_requested";
      attributionLocked: true;
    }
  | {
      status: "self_referral";
      coachCode: typeof SELF_REFERRAL_CLIENT_CODE;
      message: typeof SELF_REFERRAL_MESSAGE;
      affiliateEnrollment: "requested" | "not_requested";
      attributionLocked: true;
    };

export function mapReferralOutcome(
  receipt: CompleteSignupReceipt,
  options: { affiliateOptIn: boolean },
): ReferralClientResult {
  if (!Number.isInteger(receipt.signupAuditId) || receipt.signupAuditId <= 0) {
    throw new Error("SIGNUP_COMPLETION_AUDIT_REQUIRED");
  }
  const rejected = receipt.referralResult === "self_referral"
    || receipt.referralResult === "invalid_silent";
  if (
    rejected
    && (!Number.isInteger(receipt.referralRejectionAuditId)
      || (receipt.referralRejectionAuditId ?? 0) <= 0)
  ) {
    throw new Error("SIGNUP_REFERRAL_AUDIT_REQUIRED");
  }
  if (!rejected && receipt.referralRejectionAuditId !== null) {
    throw new Error("SIGNUP_REFERRAL_AUDIT_UNEXPECTED");
  }
  if (receipt.replayed && receipt.referralResult !== "none") {
    throw new Error("SIGNUP_REFERRAL_REPLAY_OUTCOME_INVALID");
  }

  const shared = {
    affiliateEnrollment: options.affiliateOptIn
      ? "requested" as const
      : "not_requested" as const,
    attributionLocked: true as const,
  };
  if (receipt.referralResult === "self_referral") {
    return {
      status: "self_referral",
      coachCode: SELF_REFERRAL_CLIENT_CODE,
      message: SELF_REFERRAL_MESSAGE,
      ...shared,
    };
  }
  return {
    status: receipt.referralResult === "attributed" ? "attributed" : "none",
    coachCode: null,
    message: null,
    ...shared,
  };
}
