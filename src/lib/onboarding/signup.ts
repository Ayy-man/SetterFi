/**
 * Auth-to-database signup orchestration with an explicit session handoff.
 *
 * Supabase may create the auth identity before tenant birth. The durable intent makes that gap
 * visible, while refresh is held until the transaction commits so the hook can stamp real claims.
 */

import {
  completeOnboardingSignup,
  loadSignupIntentByAuthUser,
  persistSignupIntent,
  recordSignupIntentFailure,
  SignupRepositoryError,
  type CompleteSignupReceipt,
  type SignupRepairReceipt,
  type SignupIntentRecord,
  repairOnboardingSignup,
} from "@/lib/repositories/onboarding-signup";

import { mapReferralOutcome, type ReferralClientResult } from "./referrals";

export const SIGNUP_CONFIRMATION_CALLBACK = "/auth/confirm?next=/onboarding";

export type SignupAuthResult = {
  user: { id: string; email: string | null } | null;
  session: unknown | null;
};

export type SignupCapturedFields = {
  email: string;
  fullName: string;
  businessName: string;
  slug: string;
  tierId: string;
  timezone: string;
  referralCode?: string | null;
  affiliateOptIn: boolean;
};

export type SignupOrchestrationResult =
  | {
      state: "confirmation_required";
      intentId: string;
      tenantId: string;
      callbackDestination: typeof SIGNUP_CONFIRMATION_CALLBACK;
      signupAuditId: number;
      replayed: boolean;
      referral: ReferralClientResult;
    }
  | {
      state: "session_refresh_required";
      intentId: string;
      tenantId: string;
      signupAuditId: number;
      replayed: boolean;
      referral: ReferralClientResult;
    }
  | {
      state: "ready";
      intentId: string;
      tenantId: string;
      signupAuditId: number;
      replayed: boolean;
      referral: ReferralClientResult;
    }
  | {
      state: "still_setting_up";
      intentId: string;
      tenantId: null;
      errorCode: string;
    };

export type SignupAccessState =
  | { state: "not_onboarding" }
  | {
      state: "still_setting_up";
      intentId: string;
      errorCode: string | null;
    }
  | { state: "ready"; intentId: string; tenantId: string };

export type SignupRepairResult =
  | { state: "resumed"; intentId: string; tenantId: string; auditId: number }
  | { state: "already_healthy"; intentId: string | null; tenantId: string; auditId: number }
  | { state: "cannot_resume"; intentId: string | null; tenantId: string | null; code: string; auditId: number };

export type SignupOrchestrationDependencies = {
  persistIntent: typeof persistSignupIntent;
  completeSignup: typeof completeOnboardingSignup;
  recordFailure: typeof recordSignupIntentFailure;
  loadIntent: typeof loadSignupIntentByAuthUser;
  refreshSession?: () => Promise<boolean>;
  /**
   * Supplied only when the terms gate is on and a version is published. Absent, signup behaves
   * exactly as it did before terms existed and records nothing — a placeholder acceptance would be
   * worse than none, because a receipt is the thing a dispute would rest on.
   */
  recordTermsAcceptance?: (authUserId: string) => Promise<unknown>;
};

export type SignupRepairDependencies = {
  repair: typeof repairOnboardingSignup;
};

const LIVE_DEPENDENCIES: SignupOrchestrationDependencies = {
  persistIntent: persistSignupIntent,
  completeSignup: completeOnboardingSignup,
  recordFailure: recordSignupIntentFailure,
  loadIntent: loadSignupIntentByAuthUser,
};

const LIVE_REPAIR_DEPENDENCIES: SignupRepairDependencies = { repair: repairOnboardingSignup };

export class SignupOrchestrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SignupOrchestrationError";
  }
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new SignupOrchestrationError(code);
  return normalized;
}

function safeCompletionCode(cause: unknown) {
  return cause instanceof SignupRepositoryError
    ? cause.code
    : "SIGNUP_COMPLETION_FAILED";
}

export async function orchestrateSignup(
  auth: SignupAuthResult,
  captured: SignupCapturedFields,
  dependencies: SignupOrchestrationDependencies = LIVE_DEPENDENCIES,
): Promise<SignupOrchestrationResult> {
  const authUserId = auth.user?.id.trim();
  if (!authUserId) throw new SignupOrchestrationError("SIGNUP_AUTH_USER_REQUIRED");
  const email = required(captured.email, "SIGNUP_EMAIL_REQUIRED").toLowerCase();
  const authEmail = auth.user?.email?.trim().toLowerCase() ?? null;
  if (authEmail && authEmail !== email) {
    throw new SignupOrchestrationError("SIGNUP_AUTH_EMAIL_MISMATCH");
  }
  const persistedIntent = await dependencies.persistIntent({
    authUserId,
    email,
    tierId: captured.tierId,
    timezone: captured.timezone,
    referralCode: captured.referralCode,
  });

  if (dependencies.recordTermsAcceptance) {
    // Ordered between intent and completion on purpose: the acceptance rides the same durable
    // intent the tenant is built from, so it cannot be lost by a retry, and a failure to record it
    // stops the signup rather than producing a tenant with no record of what was agreed.
    try {
      await dependencies.recordTermsAcceptance(authUserId);
    } catch (cause) {
      const errorCode = cause instanceof SignupRepositoryError
        ? cause.code
        : "ACCOUNT_TERMS_ACCEPTANCE_FAILED";
      const failedIntent = await dependencies.recordFailure(authUserId, errorCode);
      return {
        state: "still_setting_up",
        intentId: failedIntent.id,
        tenantId: null,
        errorCode,
      };
    }
  }

  let completion: CompleteSignupReceipt;
  try {
    completion = await dependencies.completeSignup({
      authUserId,
      email,
      fullName: captured.fullName,
      businessName: captured.businessName,
      slug: captured.slug,
      tierId: captured.tierId,
      timezone: captured.timezone,
      referralCode: captured.referralCode,
      affiliateOptIn: captured.affiliateOptIn,
    });
  } catch (cause) {
    const errorCode = safeCompletionCode(cause);
    const failedIntent = await dependencies.recordFailure(authUserId, errorCode);
    return {
      state: "still_setting_up",
      intentId: failedIntent.id,
      tenantId: null,
      errorCode,
    };
  }

  if (auth.session === null) {
    const referral = mapReferralOutcome(completion, {
      affiliateOptIn: captured.affiliateOptIn,
    });
    return {
      state: "confirmation_required",
      intentId: persistedIntent.id,
      tenantId: completion.tenantId,
      callbackDestination: SIGNUP_CONFIRMATION_CALLBACK,
      signupAuditId: completion.signupAuditId,
      replayed: completion.replayed,
      referral,
    };
  }
  if (!dependencies.refreshSession) {
    const referral = mapReferralOutcome(completion, {
      affiliateOptIn: captured.affiliateOptIn,
    });
    return {
      state: "session_refresh_required",
      intentId: persistedIntent.id,
      tenantId: completion.tenantId,
      signupAuditId: completion.signupAuditId,
      replayed: completion.replayed,
      referral,
    };
  }
  let refreshed = false;
  try {
    refreshed = await dependencies.refreshSession();
  } catch {
    refreshed = false;
  }
  const referral = mapReferralOutcome(completion, {
    affiliateOptIn: captured.affiliateOptIn,
  });
  return refreshed
    ? {
        state: "ready",
        intentId: persistedIntent.id,
        tenantId: completion.tenantId,
        signupAuditId: completion.signupAuditId,
        replayed: completion.replayed,
        referral,
      }
    : {
        state: "session_refresh_required",
        intentId: persistedIntent.id,
        tenantId: completion.tenantId,
        signupAuditId: completion.signupAuditId,
        replayed: completion.replayed,
        referral,
      };
}

export function signupAccessStateFromIntent(intent: SignupIntentRecord | null): SignupAccessState {
  if (!intent) return { state: "not_onboarding" };
  if (intent.state === "completed") {
    if (!intent.tenantId) throw new SignupOrchestrationError("SIGNUP_COMPLETED_TENANT_REQUIRED");
    return { state: "ready", intentId: intent.id, tenantId: intent.tenantId };
  }
  return {
    state: "still_setting_up",
    intentId: intent.id,
    errorCode: intent.errorCode,
  };
}

export async function resolveSignupAccessState(
  authUserId: string,
  dependencies: Pick<SignupOrchestrationDependencies, "loadIntent"> = LIVE_DEPENDENCIES,
) {
  const expectedAuthUserId = required(authUserId, "SIGNUP_AUTH_USER_REQUIRED");
  return signupAccessStateFromIntent(await dependencies.loadIntent(expectedAuthUserId));
}

/**
 * The operator may supply the non-sensitive form fields needed to resume a tenantless attempt,
 * but never referral consent, affiliate opt-in, billing, or provider state. The RPC is the
 * transactional authority for identity/tenant assertions and the audit receipt.
 */
export async function repairSignup(
  input: {
    expectedAuthUserId: string;
    expectedTenantId: string | null;
    email: string;
    fullName: string;
    businessName: string;
    slug: string;
    tierId: string;
    timezone: string;
    actorId: string;
    reason: string;
  },
  dependencies: SignupRepairDependencies = LIVE_REPAIR_DEPENDENCIES,
): Promise<SignupRepairResult> {
  const receipt: SignupRepairReceipt = await dependencies.repair(input);
  if (receipt.state === "resumed") {
    if (!receipt.intentId || !receipt.tenantId) throw new SignupOrchestrationError("SIGNUP_REPAIR_RECEIPT_INVALID");
    return { state: "resumed", intentId: receipt.intentId, tenantId: receipt.tenantId, auditId: receipt.auditId };
  }
  if (receipt.state === "already_healthy") {
    if (!receipt.tenantId) throw new SignupOrchestrationError("SIGNUP_REPAIR_RECEIPT_INVALID");
    return { state: "already_healthy", intentId: receipt.intentId, tenantId: receipt.tenantId, auditId: receipt.auditId };
  }
  if (!receipt.code) throw new SignupOrchestrationError("SIGNUP_REPAIR_RECEIPT_INVALID");
  return {
    state: "cannot_resume",
    intentId: receipt.intentId,
    tenantId: receipt.tenantId,
    code: receipt.code,
    auditId: receipt.auditId,
  };
}
