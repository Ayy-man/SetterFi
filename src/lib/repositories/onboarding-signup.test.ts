import { describe, expect, it, vi } from "vitest";

import {
  completeOnboardingSignup,
  listSignupTierCatalog,
  loadSelfSignupIntentStatus,
  loadSignupIntentByAuthUser,
  persistSignupIntent,
  repairOnboardingSignup,
  recordSignupIntentFailure,
  recordSignupAccountTermsAcceptance,
  tierOfferInForce,
  type OnboardingSignupRepositoryDependencies,
  type ReferralResult,
  type SignupAuditReceipt,
  type SignupIntentRecord,
} from "@/lib/repositories/onboarding-signup";

const AUTH_USER = "auth-user-a";
const TENANT = "tenant-a";

function intent(overrides: Partial<SignupIntentRecord> = {}): SignupIntentRecord {
  return {
    id: "intent-a",
    authUserId: AUTH_USER,
    email: "coach@signup.test",
    tenantId: null,
    tierId: "tier-a",
    timezone: "Asia/Kolkata",
    referralCode: null,
    state: "started",
    errorCode: null,
    ...overrides,
  };
}

function audit(
  action: SignupAuditReceipt["action"],
  id = action === "onboarding.signup_completed" ? 41 : 40,
): SignupAuditReceipt {
  return { id, tenantId: TENANT, action };
}

function dependencies() {
  let stored = intent();
  const calls = {
    inserts: [] as Array<Record<string, unknown>>,
    completions: [] as Array<Record<string, unknown>>,
    failures: [] as string[],
    signupAuditReads: 0,
    rejectionAuditReads: 0,
  };
  let completion: {
    tenant_id: string;
    referral_result: ReferralResult;
    audit_id: number | null;
    replayed: boolean;
  } = {
    tenant_id: TENANT,
    referral_result: "none" as const,
    audit_id: 41,
    replayed: false,
  };
  const deps: OnboardingSignupRepositoryDependencies = {
    insertIntent: async (input) => {
      calls.inserts.push(input);
    },
    loadIntent: async () => stored,
    completeSignup: async (args) => {
      calls.completions.push(args);
      return completion;
    },
    recordIntentFailure: async (authUserId, errorCode) => {
      calls.failures.push(errorCode);
      stored = intent({ authUserId, state: "failed", errorCode });
      return stored;
    },
    loadSignupAudit: async () => {
      calls.signupAuditReads += 1;
      return audit("onboarding.signup_completed");
    },
    loadReferralRejectionAudit: async () => {
      calls.rejectionAuditReads += 1;
      return audit("referral.code_rejected");
    },
  };
  return {
    deps,
    calls,
    get stored() { return stored; },
    set stored(value: SignupIntentRecord) { stored = value; },
    set completion(value: typeof completion) { completion = value; },
  };
}

const completeInput = {
  authUserId: AUTH_USER,
  email: "COACH@SIGNUP.TEST",
  fullName: "Synthetic Coach",
  businessName: "Synthetic Business",
  slug: "Synthetic-Business",
  tierId: "tier-a",
  timezone: "Asia/Kolkata",
  referralCode: null,
  affiliateOptIn: false,
};

describe("onboarding signup repository", () => {
  it("calls the repair RPC with an expected tenant and accepts only audited, explicit outcomes", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const repaired = await repairOnboardingSignup({
      expectedAuthUserId: AUTH_USER,
      expectedTenantId: TENANT,
      email: "COACH@SIGNUP.TEST",
      fullName: "Synthetic Coach",
      businessName: "Synthetic Business",
      slug: "Synthetic-Business",
      tierId: "tier-a",
      timezone: "Asia/Kolkata",
      actorId: "admin-a",
      reason: "Verified original signup details.",
    }, {
      repairSignup: async (args) => {
        calls.push(args);
        return [{
          command_id: "repair-a", intent_id: "intent-a", tenant_id: TENANT,
          state: "already_healthy", outcome_code: null, audit_id: 73,
        }];
      },
    });
    expect(calls).toEqual([{
      p_expected_auth_user_id: AUTH_USER,
      p_expected_tenant: TENANT,
      p_email: "coach@signup.test",
      p_full_name: "Synthetic Coach",
      p_business_name: "Synthetic Business",
      p_slug: "synthetic-business",
      p_tier_id: "tier-a",
      p_timezone: "Asia/Kolkata",
      p_actor_id: "admin-a",
      p_reason: "Verified original signup details.",
    }]);
    expect(repaired).toEqual({
      commandId: "repair-a", intentId: "intent-a", tenantId: TENANT,
      state: "already_healthy", code: null, auditId: 73,
    });
  });

  it("does not accept a repair receipt that crosses the expected tenant boundary", async () => {
    await expect(repairOnboardingSignup({
      expectedAuthUserId: AUTH_USER,
      expectedTenantId: TENANT,
      email: "coach@signup.test",
      fullName: "Synthetic Coach",
      businessName: "Synthetic Business",
      slug: "synthetic-business",
      tierId: "tier-a",
      timezone: "Asia/Kolkata",
      actorId: "admin-a",
      reason: "Verified original signup details.",
    }, {
      repairSignup: async () => [{
        command_id: "repair-a", intent_id: "intent-a", tenant_id: "tenant-b",
        state: "resumed", outcome_code: null, audit_id: 73,
      }],
    })).rejects.toThrow("SIGNUP_REPAIR_EXPECTED_TENANT_MISMATCH");
  });

  it("preserves an explicit cannot-resume reason instead of claiming the signup is healthy", async () => {
    await expect(repairOnboardingSignup({
      expectedAuthUserId: AUTH_USER,
      expectedTenantId: null,
      email: "coach@signup.test",
      fullName: "Synthetic Coach",
      businessName: "Synthetic Business",
      slug: "synthetic-business",
      tierId: "tier-a",
      timezone: "Asia/Kolkata",
      actorId: "admin-a",
      reason: "Verified original signup details.",
    }, {
      repairSignup: async () => [{
        command_id: "repair-a", intent_id: null, tenant_id: null,
        state: "cannot_resume", outcome_code: "AUTH_IDENTITY_NOT_FOUND", audit_id: 74,
      }],
    })).resolves.toMatchObject({ state: "cannot_resume", code: "AUTH_IDENTITY_NOT_FOUND" });
  });

  it("maps the public tier id, human label and booked-call allowance, and nothing economic", async () => {
    await expect(listSignupTierCatalog(async () => [{
      id: "tier-a",
      label: "Growth",
      call_allowance: 10,
      price_cents: 99_999,
    }])).resolves.toEqual([{ id: "tier-a", label: "Growth", callAllowance: 10 }]);
    await expect(listSignupTierCatalog(async () => [{ id: "tier-a", label: "", call_allowance: 10 }]))
      .rejects.toThrow("SIGNUP_TIER_CATALOG_ROW_INVALID");
  });

  /**
   * The allowance is the number the plans differ on, so a row that cannot state it is a projection
   * defect rather than a plan that includes nothing. Every rejected shape below would otherwise
   * have reached a signup card as "0 booked calls included" -- a claim about what a customer is
   * buying, made from a missing value.
   */
  it("refuses a tier whose allowance is missing, fractional, negative or not a number", async () => {
    for (const call_allowance of [undefined, null, "10", 10.5, -1, Number.NaN]) {
      await expect(listSignupTierCatalog(async () => [{ id: "tier-a", label: "Growth", call_allowance }]))
        .rejects.toThrow("SIGNUP_TIER_CATALOG_ROW_INVALID");
    }
    // The positive control: zero is a real allowance and is not confused with a missing one.
    await expect(listSignupTierCatalog(async () => [{ id: "tier-a", label: "Starter", call_allowance: 0 }]))
      .resolves.toEqual([{ id: "tier-a", label: "Starter", callAllowance: 0 }]);
  });

  it("refuses duplicate public ids or human labels instead of choosing by row order", async () => {
    await expect(listSignupTierCatalog(async () => [
      { id: "tier-growth-a", label: "Growth", call_allowance: 10 },
      { id: "tier-growth-b", label: " growth ", call_allowance: 10 },
    ])).rejects.toThrow("SIGNUP_TIER_CATALOG_AMBIGUOUS");
    await expect(listSignupTierCatalog(async () => [
      { id: "tier-growth", label: "Growth", call_allowance: 10 },
      { id: "tier-growth", label: "Scale", call_allowance: 25 },
    ])).rejects.toThrow("SIGNUP_TIER_CATALOG_AMBIGUOUS");
  });

  it("keeps the legacy catalogue unchanged while the offer gate is off, then serves only the in-force terms", async () => {
    const legacy = vi.fn(async () => [{ id: "tier-a", label: "Growth", call_allowance: 10 }]);
    const offerSource = vi.fn(async () => [{
      id: "tier-a",
      label: "Growth",
      call_allowance: 10,
      offer_id: "offer-growth-september",
      currency: "USD",
      amount_cents: 49_900,
      billing_interval: "month",
      stripe_price_id: "price_growth_september",
      effective_from: "2026-09-01T00:00:00.000Z",
      effective_to: null,
    }]);
    const asOf = new Date("2026-09-02T00:00:00.000Z");

    await expect(listSignupTierCatalog(legacy, {
      tierOfferTermsLive: () => false,
      asOf,
      offerSource,
    })).resolves.toEqual([{ id: "tier-a", label: "Growth", callAllowance: 10 }]);
    expect(legacy).toHaveBeenCalledOnce();
    expect(offerSource).not.toHaveBeenCalled();

    await expect(listSignupTierCatalog(legacy, {
      tierOfferTermsLive: () => true,
      asOf,
      offerSource,
    })).resolves.toEqual([{
      id: "tier-a",
      label: "Growth",
      callAllowance: 10,
      commercialTerms: {
        currency: "USD",
        amountCents: 49_900,
        interval: "month",
        stripePriceId: "price_growth_september",
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        effectiveTo: null,
      },
    }]);
    expect(offerSource).toHaveBeenCalledWith(asOf);
  });

  it("maps the self-only intent projection without email, tier, or referral fields", async () => {
    await expect(loadSelfSignupIntentStatus(async () => [{
      intent_id: "intent-a",
      state: "failed",
      tenant_id: null,
      error_code: "SIGNUP_COMPLETION_FAILED",
    }])).resolves.toEqual({
      intentId: "intent-a",
      state: "failed",
      tenantId: null,
      errorCode: "SIGNUP_COMPLETION_FAILED",
    });
    await expect(loadSelfSignupIntentStatus(async () => [])).resolves.toBeNull();
  });

  it("persists an intent before tenant birth with explicit tier, timezone, and login email", async () => {
    const state = dependencies();
    const result = await persistSignupIntent({
      authUserId: AUTH_USER,
      email: "COACH@SIGNUP.TEST",
      tierId: "tier-a",
      timezone: "Asia/Kolkata",
    }, state.deps);
    expect(state.calls.inserts).toEqual([{
      authUserId: AUTH_USER,
      email: "coach@signup.test",
      tierId: "tier-a",
      timezone: "Asia/Kolkata",
      referralCode: null,
    }]);
    expect(result.id).toBe("intent-a");
  });

  it("calls the sole signup RPC and returns only after the persisted completion audit reads back", async () => {
    const state = dependencies();
    const result = await completeOnboardingSignup(completeInput, state.deps);
    expect(state.calls.completions).toEqual([{
      p_expected_auth_user_id: AUTH_USER,
      p_auth_user_id: AUTH_USER,
      p_email: "coach@signup.test",
      p_full_name: "Synthetic Coach",
      p_business_name: "Synthetic Business",
      p_slug: "synthetic-business",
      p_tier_id: "tier-a",
      p_timezone: "Asia/Kolkata",
      p_referral_code: null,
      p_affiliate_opt_in: false,
    }]);
    expect(result).toEqual({
      tenantId: TENANT,
      referralResult: "none",
      signupAuditId: 41,
      referralRejectionAuditId: null,
      replayed: false,
    });
    expect(state.calls.signupAuditReads).toBe(1);
  });

  it("returns the same tenant on replay through the RPC instead of exposing a later referral write", async () => {
    const state = dependencies();
    await completeOnboardingSignup(completeInput, state.deps);
    state.completion = {
      tenant_id: TENANT,
      referral_result: "none",
      audit_id: null,
      replayed: true,
    };
    const replay = await completeOnboardingSignup({
      ...completeInput,
      referralCode: "LATE-CODE",
    }, state.deps);
    expect(replay).toMatchObject({ tenantId: TENANT, replayed: true });
    expect(state.calls.completions).toHaveLength(2);
    expect(state.calls.rejectionAuditReads).toBe(0);
  });

  it("requires the rejection audit receipt before returning a rejected referral outcome", async () => {
    const state = dependencies();
    state.completion = {
      tenant_id: TENANT,
      referral_result: "invalid_silent",
      audit_id: 41,
      replayed: false,
    };
    state.deps.loadReferralRejectionAudit = async () => null;
    await expect(completeOnboardingSignup({
      ...completeInput,
      referralCode: "UNKNOWN-CODE",
    }, state.deps)).rejects.toThrow("SIGNUP_REFERRAL_AUDIT_REQUIRED");
  });

  it("refuses an RPC success without the persisted signup audit receipt", async () => {
    const state = dependencies();
    state.deps.loadSignupAudit = async () => null;
    await expect(completeOnboardingSignup(completeInput, state.deps)).rejects.toThrow(
      "SIGNUP_COMPLETION_AUDIT_REQUIRED",
    );
  });

  it("records a rolled-back tenant transaction as a queryable tenantless failure", async () => {
    const state = dependencies();
    state.deps.completeSignup = async () => {
      throw new Error("duplicate key value violates unique constraint tenants_slug_key");
    };
    await expect(completeOnboardingSignup(completeInput, state.deps)).rejects.toThrow(
      "SIGNUP_COMPLETION_FAILED",
    );
    const failed = await recordSignupIntentFailure(
      AUTH_USER,
      "SIGNUP_COMPLETION_FAILED",
      state.deps,
    );
    expect(failed).toMatchObject({
      state: "failed",
      tenantId: null,
      errorCode: "SIGNUP_COMPLETION_FAILED",
    });
    expect(JSON.stringify(failed)).not.toContain("duplicate key");
  });

  it("rejects an invalid timezone and a missing tier before any RPC invocation", async () => {
    const state = dependencies();
    await expect(completeOnboardingSignup({
      ...completeInput,
      timezone: "Mars/Olympus_Mons",
    }, state.deps)).rejects.toThrow("SIGNUP_TIMEZONE_INVALID");
    await expect(completeOnboardingSignup({
      ...completeInput,
      tierId: " ",
    }, state.deps)).rejects.toThrow("SIGNUP_TIER_REQUIRED");
    expect(state.calls.completions).toHaveLength(0);
  });

  it("returns no intent for an auth user absent from onboarding instead of fabricating state", async () => {
    const state = dependencies();
    state.deps.loadIntent = async () => null;
    await expect(loadSignupIntentByAuthUser(AUTH_USER, state.deps)).resolves.toBeNull();
  });
});

describe("tierOfferInForce", () => {
  const TIER = "tier-a";
  const AS_OF = new Date("2026-08-30T12:00:00.000Z");

  it("admits a tier the resolver says is offered right now", async () => {
    await expect(
      tierOfferInForce(TIER, AS_OF, async () => [{ state: "offered" }]),
    ).resolves.toBe(true);
  });

  it("refuses an active tier with no offer covering the instant", async () => {
    await expect(
      tierOfferInForce(TIER, AS_OF, async () => [{ state: "no_offer" }]),
    ).resolves.toBe(false);
  });

  it("refuses rather than picks when the resolver returns more than one row", async () => {
    // Two in-force offers mean nobody can say what the customer would be agreeing to, so this is
    // the same refusal checkout makes rather than a first-row selection.
    await expect(
      tierOfferInForce(TIER, AS_OF, async () => [{ state: "offered" }, { state: "offered" }]),
    ).resolves.toBe(false);
  });

  it("refuses an empty result", async () => {
    await expect(tierOfferInForce(TIER, AS_OF, async () => [])).resolves.toBe(false);
  });

  it("passes the caller's instant through instead of sampling its own clock", async () => {
    const seen: Date[] = [];
    await tierOfferInForce(TIER, AS_OF, async (_tierId, instantValue) => {
      seen.push(instantValue);
      return [{ state: "offered" }];
    });
    expect(seen).toEqual([AS_OF]);
  });
});

describe("recordSignupAccountTermsAcceptance", () => {
  const acceptance = {
    authUserId: AUTH_USER,
    versionKey: "2026-08-account-v1",
    contentHash: "a".repeat(64),
    requestContext: { origin: "https://setterfi.test" },
  };

  it("returns the receipt when the row echoes the version and hash it was given", async () => {
    const calls: Record<string, unknown>[] = [];
    await expect(
      recordSignupAccountTermsAcceptance(acceptance, async (args) => {
        calls.push(args);
        return [{
          version_key: acceptance.versionKey,
          content_hash: acceptance.contentHash,
          accepted_at: "2026-08-30T12:00:00.000Z",
        }];
      }),
    ).resolves.toEqual({
      versionKey: acceptance.versionKey,
      contentHash: acceptance.contentHash,
      acceptedAt: "2026-08-30T12:00:00.000Z",
    });
    expect(calls[0]).toEqual({
      p_auth_user_id: AUTH_USER,
      p_version_key: acceptance.versionKey,
      p_content_hash: acceptance.contentHash,
      p_request_context: acceptance.requestContext,
    });
  });

  it("refuses a receipt recording a different version than the one accepted", async () => {
    await expect(
      recordSignupAccountTermsAcceptance(acceptance, async () => [{
        version_key: "2026-01-stale",
        content_hash: acceptance.contentHash,
        accepted_at: "2026-08-30T12:00:00.000Z",
      }]),
    ).rejects.toThrow("ACCOUNT_TERMS_ACCEPTANCE_RECEIPT_INVALID");
  });

  it("refuses a receipt with no acceptance timestamp", async () => {
    await expect(
      recordSignupAccountTermsAcceptance(acceptance, async () => [{
        version_key: acceptance.versionKey,
        content_hash: acceptance.contentHash,
        accepted_at: "",
      }]),
    ).rejects.toThrow("ACCOUNT_TERMS_ACCEPTANCE_RECEIPT_INVALID");
  });

  it("refuses an empty result rather than reporting a silent success", async () => {
    await expect(
      recordSignupAccountTermsAcceptance(acceptance, async () => []),
    ).rejects.toThrow("ACCOUNT_TERMS_ACCEPTANCE_RECEIPT_INVALID");
  });
});
