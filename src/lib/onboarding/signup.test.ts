import { describe, expect, it } from "vitest";

import {
  orchestrateSignup,
  repairSignup,
  resolveSignupAccessState,
  SIGNUP_CONFIRMATION_CALLBACK,
  type SignupOrchestrationDependencies,
} from "@/lib/onboarding/signup";
import {
  SignupRepositoryError,
  type CompleteSignupReceipt,
  type SignupIntentRecord,
} from "@/lib/repositories/onboarding-signup";

const AUTH_USER = "auth-user-a";

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

const completion: CompleteSignupReceipt = {
  tenantId: "tenant-a",
  referralResult: "none",
  signupAuditId: 41,
  referralRejectionAuditId: null,
  replayed: false,
};

function dependencies(options: { refresh?: () => Promise<boolean> } = {}) {
  const order: string[] = [];
  let persisted = intent();
  const deps: SignupOrchestrationDependencies = {
    persistIntent: async () => {
      order.push("intent");
      return persisted;
    },
    completeSignup: async () => {
      order.push("complete");
      return completion;
    },
    recordFailure: async (_authUserId, errorCode) => {
      order.push("failure");
      persisted = intent({ state: "failed", errorCode });
      return persisted;
    },
    loadIntent: async () => persisted,
    refreshSession: options.refresh
      ? async () => {
          order.push("refresh");
          return options.refresh!();
        }
      : undefined,
  };
  return {
    deps,
    order,
    get persisted() { return persisted; },
    set persisted(value: SignupIntentRecord) { persisted = value; },
  };
}

const captured = {
  email: "coach@signup.test",
  fullName: "Synthetic Coach",
  businessName: "Synthetic Business",
  slug: "synthetic-business",
  tierId: "tier-a",
  timezone: "Asia/Kolkata",
  referralCode: null,
  affiliateOptIn: false,
};

describe("orchestrateSignup terms acceptance", () => {
  it("records the acceptance after the intent commits and before the tenant is built", async () => {
    const state = dependencies();
    state.deps.recordTermsAcceptance = async () => {
      state.order.push("terms");
      return undefined;
    };
    await orchestrateSignup(
      { user: { id: AUTH_USER, email: captured.email }, session: null },
      captured,
      state.deps,
    );
    // The order is the whole point: an acceptance written after completion could be lost by a
    // retry, and one written before the intent has nothing durable to attach to.
    expect(state.order).toEqual(["intent", "terms", "complete"]);
  });

  it("stops the signup when the acceptance cannot be recorded", async () => {
    const state = dependencies();
    state.deps.recordTermsAcceptance = async () => {
      throw new SignupRepositoryError("ACCOUNT_TERMS_VERSION_NOT_PUBLISHED");
    };
    const result = await orchestrateSignup(
      { user: { id: AUTH_USER, email: captured.email }, session: null },
      captured,
      state.deps,
    );
    expect(result.state).toBe("still_setting_up");
    expect(result).toMatchObject({
      tenantId: null,
      errorCode: "ACCOUNT_TERMS_VERSION_NOT_PUBLISHED",
    });
    // No tenant is created, so nothing downstream can imply terms were agreed.
    expect(state.order).toEqual(["intent", "failure"]);
  });

  it("leaves the existing path untouched when no recorder is supplied", async () => {
    const state = dependencies();
    await orchestrateSignup(
      { user: { id: AUTH_USER, email: captured.email }, session: null },
      captured,
      state.deps,
    );
    expect(state.order).toEqual(["intent", "complete"]);
  });
});

describe("orchestrateSignup", () => {
  it("preserves the committed intent and requires confirmation when auth returns no session", async () => {
    const state = dependencies();
    const result = await orchestrateSignup({
      user: { id: AUTH_USER, email: captured.email },
      session: null,
    }, captured, state.deps);
    expect(result).toMatchObject({
      state: "confirmation_required",
      intentId: "intent-a",
      tenantId: "tenant-a",
      callbackDestination: SIGNUP_CONFIRMATION_CALLBACK,
    });
    expect(state.order).toEqual(["intent", "complete"]);
  });

  it("requires a refresh after commit when confirmation is off and no refresh callback was supplied", async () => {
    const state = dependencies();
    const result = await orchestrateSignup({
      user: { id: AUTH_USER, email: captured.email },
      session: { accessToken: "synthetic-session" },
    }, captured, state.deps);
    expect(result.state).toBe("session_refresh_required");
    expect(state.order).toEqual(["intent", "complete"]);
  });

  it("returns ready only after the committed mapping precedes a successful session refresh", async () => {
    const state = dependencies({ refresh: async () => true });
    const result = await orchestrateSignup({
      user: { id: AUTH_USER, email: captured.email },
      session: { accessToken: "synthetic-session" },
    }, captured, state.deps);
    expect(result.state).toBe("ready");
    expect(state.order).toEqual(["intent", "complete", "refresh"]);
  });

  it("keeps refresh-required state when refresh fails instead of claiming the session is ready", async () => {
    const state = dependencies({ refresh: async () => false });
    const result = await orchestrateSignup({
      user: { id: AUTH_USER, email: captured.email },
      session: { accessToken: "synthetic-session" },
    }, captured, state.deps);
    expect(result.state).toBe("session_refresh_required");
    expect(state.order).toEqual(["intent", "complete", "refresh"]);
  });

  it("returns still-setting-up with the durable intent after tenant birth rolls back", async () => {
    const state = dependencies();
    state.deps.completeSignup = async () => {
      state.order.push("complete");
      throw new SignupRepositoryError("SIGNUP_COMPLETION_FAILED");
    };
    const result = await orchestrateSignup({
      user: { id: AUTH_USER, email: captured.email },
      session: { accessToken: "synthetic-session" },
    }, captured, state.deps);
    expect(result).toEqual({
      state: "still_setting_up",
      intentId: "intent-a",
      tenantId: null,
      errorCode: "SIGNUP_COMPLETION_FAILED",
    });
    expect(state.order).toEqual(["intent", "complete", "failure"]);
    expect(state.persisted).toMatchObject({ state: "failed", tenantId: null });
  });

  it("does not create an intent when auth failed before returning a user id", async () => {
    const state = dependencies();
    await expect(orchestrateSignup({ user: null, session: null }, captured, state.deps))
      .rejects.toThrow("SIGNUP_AUTH_USER_REQUIRED");
    expect(state.order).toEqual([]);
  });

  it("refuses an auth/captured email mismatch before persisting tenant data", async () => {
    const state = dependencies();
    await expect(orchestrateSignup({
      user: { id: AUTH_USER, email: "different@signup.test" },
      session: null,
    }, captured, state.deps)).rejects.toThrow("SIGNUP_AUTH_EMAIL_MISMATCH");
    expect(state.order).toEqual([]);
  });
});

describe("resolveSignupAccessState", () => {
  it("does not mislabel an auth user without an intent as onboarding", async () => {
    await expect(resolveSignupAccessState(AUTH_USER, {
      loadIntent: async () => null,
    })).resolves.toEqual({ state: "not_onboarding" });
  });

  it("returns the durable failure for login fallback and ready only with a completed tenant", async () => {
    const failed = intent({ state: "failed", errorCode: "SIGNUP_COMPLETION_FAILED" });
    await expect(resolveSignupAccessState(AUTH_USER, {
      loadIntent: async () => failed,
    })).resolves.toEqual({
      state: "still_setting_up",
      intentId: "intent-a",
      errorCode: "SIGNUP_COMPLETION_FAILED",
    });
    await expect(resolveSignupAccessState(AUTH_USER, {
      loadIntent: async () => intent({ state: "completed", tenantId: "tenant-a" }),
    })).resolves.toEqual({ state: "ready", intentId: "intent-a", tenantId: "tenant-a" });
  });
});

describe("repairSignup", () => {
  it("turns an audited resumption receipt into a ready-to-reload outcome", async () => {
    await expect(repairSignup({
      expectedAuthUserId: AUTH_USER,
      expectedTenantId: null,
      email: captured.email,
      fullName: captured.fullName,
      businessName: captured.businessName,
      slug: captured.slug,
      tierId: captured.tierId,
      timezone: captured.timezone,
      actorId: "admin-a",
      reason: "Verified original signup details.",
    }, {
      repair: async () => ({
        commandId: "repair-a", intentId: "intent-a", tenantId: "tenant-a",
        state: "resumed", code: null, auditId: 61,
      }),
    })).resolves.toEqual({ state: "resumed", intentId: "intent-a", tenantId: "tenant-a", auditId: 61 });
  });

  it("keeps an external prerequisite explicit when the database cannot safely resume", async () => {
    await expect(repairSignup({
      expectedAuthUserId: AUTH_USER,
      expectedTenantId: null,
      email: captured.email,
      fullName: captured.fullName,
      businessName: captured.businessName,
      slug: captured.slug,
      tierId: captured.tierId,
      timezone: captured.timezone,
      actorId: "admin-a",
      reason: "Verified original signup details.",
    }, {
      repair: async () => ({
        commandId: "repair-a", intentId: null, tenantId: null,
        state: "cannot_resume", code: "REFERRAL_STATE_REQUIRES_REVIEW", auditId: 62,
      }),
    })).resolves.toEqual({
      state: "cannot_resume", intentId: null, tenantId: null,
      code: "REFERRAL_STATE_REQUIRES_REVIEW", auditId: 62,
    });
  });
});
