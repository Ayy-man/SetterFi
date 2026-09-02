import { describe, expect, it } from "vitest";

import {
  mapReferralOutcome,
  SELF_REFERRAL_CLIENT_CODE,
  SELF_REFERRAL_MESSAGE,
} from "@/lib/onboarding/referrals";
import type {
  CompleteSignupReceipt,
  ReferralResult,
} from "@/lib/repositories/onboarding-signup";

function receipt(
  referralResult: ReferralResult,
  overrides: Partial<CompleteSignupReceipt> = {},
): CompleteSignupReceipt {
  const rejected = referralResult === "self_referral" || referralResult === "invalid_silent";
  return {
    tenantId: "tenant-a",
    referralResult,
    signupAuditId: 41,
    referralRejectionAuditId: rejected ? 40 : null,
    replayed: false,
    ...overrides,
  };
}

describe("mapReferralOutcome", () => {
  it("maps every closed SQL outcome without exposing unknown or revoked codes", () => {
    expect(mapReferralOutcome(receipt("attributed"), { affiliateOptIn: false }))
      .toMatchObject({ status: "attributed", coachCode: null, message: null });
    expect(mapReferralOutcome(receipt("none"), { affiliateOptIn: false }))
      .toMatchObject({ status: "none", coachCode: null, message: null });
    const invalid = mapReferralOutcome(receipt("invalid_silent"), { affiliateOptIn: false });
    expect(invalid).toMatchObject({ status: "none", coachCode: null, message: null });
    expect(JSON.stringify(invalid)).not.toContain("invalid_silent");
    expect(JSON.stringify(invalid)).not.toContain("unknown");
    expect(JSON.stringify(invalid)).not.toContain("revoked");
  });

  it("returns the one approved coach-facing correction for self-referral", () => {
    expect(mapReferralOutcome(receipt("self_referral"), { affiliateOptIn: false })).toEqual({
      status: "self_referral",
      coachCode: SELF_REFERRAL_CLIENT_CODE,
      message: SELF_REFERRAL_MESSAGE,
      affiliateEnrollment: "not_requested",
      attributionLocked: true,
    });
  });

  it("requires a persisted rejection audit before mapping either rejected outcome", () => {
    for (const outcome of ["self_referral", "invalid_silent"] as const) {
      expect(() => mapReferralOutcome(receipt(outcome, {
        referralRejectionAuditId: null,
      }), { affiliateOptIn: false })).toThrow("SIGNUP_REFERRAL_AUDIT_REQUIRED");
    }
  });

  it("keeps affiliate enrollment independent when the coach already owns the referral code", () => {
    const result = mapReferralOutcome(receipt("self_referral"), { affiliateOptIn: true });
    expect(result).toMatchObject({
      status: "self_referral",
      affiliateEnrollment: "requested",
      attributionLocked: true,
    });
    expect(JSON.stringify(result)).not.toContain("commission");
  });

  it("maps a completed replay to no new attribution and rejects a forged retry outcome", () => {
    expect(mapReferralOutcome(receipt("none", { replayed: true }), {
      affiliateOptIn: true,
    })).toEqual({
      status: "none",
      coachCode: null,
      message: null,
      affiliateEnrollment: "requested",
      attributionLocked: true,
    });
    expect(() => mapReferralOutcome(receipt("attributed", { replayed: true }), {
      affiliateOptIn: false,
    })).toThrow("SIGNUP_REFERRAL_REPLAY_OUTCOME_INVALID");
  });

  it("requires the persisted signup receipt before returning any client result", () => {
    expect(() => mapReferralOutcome(receipt("none", { signupAuditId: 0 }), {
      affiliateOptIn: false,
    })).toThrow("SIGNUP_COMPLETION_AUDIT_REQUIRED");
  });
});
