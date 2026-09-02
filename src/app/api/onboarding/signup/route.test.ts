import { describe, expect, it, vi } from "vitest";

import { SELF_REFERRAL_CLIENT_CODE, SELF_REFERRAL_MESSAGE } from "@/lib/onboarding/referrals";
import type { SignupOrchestrationResult } from "@/lib/onboarding/signup";

import { createSignupCatalogHandler, createSignupHandler } from "./handler";

const TIER_ID = "11111111-1111-4111-8111-111111111111";
const input = {
  email: "coach@example.test",
  password: "synthetic-password",
  fullName: "Synthetic Coach",
  businessName: "Synthetic Coaching",
  slug: "synthetic-coaching",
  tierId: TIER_ID,
  timezone: "America/New_York",
  referralCode: null,
  affiliateOptIn: false,
};

const referralNone = {
  status: "none" as const,
  coachCode: null,
  message: null,
  affiliateEnrollment: "not_requested" as const,
  attributionLocked: true as const,
};

function request(body: unknown = input, origin = "https://setterfi.test") {
  return new Request("https://setterfi.test/api/onboarding/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

function dependencies(result: SignupOrchestrationResult) {
  return {
    enabled: () => true,
    limit: vi.fn().mockReturnValue({ allowed: true, remaining: 7, retryAfter: 0 }),
    validTier: vi.fn().mockResolvedValue(true),
    signUp: vi.fn().mockResolvedValue({
      auth: { user: { id: "auth-1", email: input.email }, session: null },
      refreshSession: vi.fn().mockResolvedValue(true),
    }),
    complete: vi.fn().mockResolvedValue(result),
    // Terms default to unpublished, which is the state every existing case was written under.
    currentTerms: vi.fn().mockResolvedValue({ state: "none_published" as const }),
    termsRequired: vi.fn().mockReturnValue(false),
    recordTermsAcceptance: vi.fn().mockResolvedValue(undefined),
  };
}

function confirmed(overrides: Partial<Extract<SignupOrchestrationResult, { state: "confirmation_required" }>> = {}) {
  return {
    state: "confirmation_required" as const,
    intentId: "intent-1",
    tenantId: "tenant-1",
    callbackDestination: "/auth/confirm?next=/onboarding" as const,
    signupAuditId: 41,
    replayed: false,
    referral: referralNone,
    ...overrides,
  };
}

describe("POST /api/onboarding/signup", () => {
  it("stays byte-safe behind the Phase 5 flag", async () => {
    const deps = dependencies(confirmed());
    deps.enabled = () => false;
    const response = await createSignupHandler(deps)(request());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found." });
    expect(deps.signUp).not.toHaveBeenCalled();
  });

  it("refuses cross-origin requests before signup work", async () => {
    const deps = dependencies(confirmed());
    const response = await createSignupHandler(deps)(request(input, "https://elsewhere.test"));
    expect(response.status).toBe(403);
    expect(deps.limit).not.toHaveBeenCalled();
    expect(deps.signUp).not.toHaveBeenCalled();
  });

  it("returns Retry-After when the public limiter refuses work", async () => {
    const deps = dependencies(confirmed());
    deps.limit.mockReturnValue({ allowed: false, remaining: 0, retryAfter: 37 });
    const response = await createSignupHandler(deps)(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(deps.signUp).not.toHaveBeenCalled();
  });

  it.each([
    ["tier", { ...input, tierId: "not-a-tier" }],
    ["timezone", { ...input, timezone: "Mars/Olympus" }],
    ["unknown field", { ...input, tenantId: "caller-chosen" }],
  ])("rejects invalid %s before calling auth", async (_label, body) => {
    const deps = dependencies(confirmed());
    const response = await createSignupHandler(deps)(request(body));
    expect(response.status).toBe(400);
    expect(deps.signUp).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("rejects an inactive or unknown well-formed tier before calling auth", async () => {
    const deps = dependencies(confirmed());
    deps.validTier.mockResolvedValue(false);
    const response = await createSignupHandler(deps)(request());
    expect(response.status).toBe(400);
    expect(deps.validTier).toHaveBeenCalledWith(TIER_ID);
    expect(deps.signUp).not.toHaveBeenCalled();
  });

  it("returns a safe body when Supabase Auth refuses signup", async () => {
    const deps = dependencies(confirmed());
    deps.signUp.mockRejectedValue(new Error("provider payload"));
    const response = await createSignupHandler(deps)(request());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Signup could not be completed." });
  });

  it("returns confirmation-required separately from session refresh", async () => {
    const deps = dependencies(confirmed());
    const response = await createSignupHandler(deps)(request());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(confirmed());
    expect(deps.signUp).toHaveBeenCalledWith(
      expect.objectContaining({ tierId: TIER_ID, timezone: "America/New_York" }),
      "https://setterfi.test/auth/confirm?next=/onboarding",
    );
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: "auth-1", email: input.email } }),
      expect.not.objectContaining({ password: expect.anything() }),
      expect.any(Function),
      undefined,
    );
  });

  it("returns session-refresh-required as its own closed state", async () => {
    const result: SignupOrchestrationResult = {
      state: "session_refresh_required",
      intentId: "intent-1",
      tenantId: "tenant-1",
      signupAuditId: 42,
      replayed: false,
      referral: referralNone,
    };
    const response = await createSignupHandler(dependencies(result))(request());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(result);
  });

  it("returns still-setting-up when tenant birth fails", async () => {
    const result: SignupOrchestrationResult = {
      state: "still_setting_up",
      intentId: "intent-1",
      tenantId: null,
      errorCode: "SIGNUP_COMPLETION_FAILED",
    };
    const response = await createSignupHandler(dependencies(result))(request());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(result);
  });

  it("returns an idempotent replay without creating a second success", async () => {
    const result = confirmed({ replayed: true });
    const response = await createSignupHandler(dependencies(result))(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(result);
  });

  it.each([
    ["attributed", { ...referralNone, status: "attributed" as const }],
    ["unknown or revoked", referralNone],
    ["self referral", {
      ...referralNone,
      status: "self_referral" as const,
      coachCode: SELF_REFERRAL_CLIENT_CODE,
      message: SELF_REFERRAL_MESSAGE,
    }],
  ])("returns the safe %s referral result", async (_label, referral) => {
    const result = confirmed({ referral });
    const response = await createSignupHandler(dependencies(result))(request());
    const body = await response.json();
    expect(body.referral).toEqual(referral);
    expect(JSON.stringify(body)).not.toMatch(/revoked|invalid_silent|unknown_code|provider/i);
  });

  describe("account terms", () => {
    const published = {
      state: "published" as const,
      versionKey: "2026-08-account-v1",
      contentHash: "a".repeat(64),
      publishedAt: "2026-08-30T00:00:00.000Z",
      termsBody: "terms",
      privacyBody: "privacy",
    };

    it("refuses a signup that does not accept the published version", async () => {
      const deps = dependencies(confirmed());
      deps.termsRequired = vi.fn().mockReturnValue(true);
      deps.currentTerms = vi.fn().mockResolvedValue(published);
      const response = await createSignupHandler(deps)(request());
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "The current account terms must be accepted to continue.",
      });
      // No auth identity is created, so a refusal cannot strand a Supabase user.
      expect(deps.signUp).not.toHaveBeenCalled();
    });

    it("refuses a signup that accepts a version the server has not published", async () => {
      const deps = dependencies(confirmed());
      deps.termsRequired = vi.fn().mockReturnValue(true);
      deps.currentTerms = vi.fn().mockResolvedValue(published);
      const response = await createSignupHandler(deps)(
        request({ ...input, acceptedTermsVersionKey: "2026-01-stale" }),
      );
      expect(response.status).toBe(400);
      expect(deps.signUp).not.toHaveBeenCalled();
    });

    it("hands orchestration a recorder carrying the server's own hash and context", async () => {
      const deps = dependencies(confirmed());
      deps.termsRequired = vi.fn().mockReturnValue(true);
      deps.currentTerms = vi.fn().mockResolvedValue(published);
      const response = await createSignupHandler(deps)(
        request({ ...input, acceptedTermsVersionKey: published.versionKey }),
      );
      expect(response.status).toBe(201);
      const recorder = deps.complete.mock.calls[0][3] as (id: string) => Promise<unknown>;
      expect(typeof recorder).toBe("function");
      await recorder("auth-1");
      const recorded = deps.recordTermsAcceptance.mock.calls[0][0];
      expect(recorded.versionKey).toBe(published.versionKey);
      expect(recorded.contentHash).toBe(published.contentHash);
      expect(recorded.authUserId).toBe("auth-1");
      // The context is what the server saw, so nothing the body sent can appear in it.
      expect(recorded.requestContext.origin).toBe("https://setterfi.test");
      expect(Object.values(recorded.requestContext)).not.toContain(input.email);
    });

    it("records nothing and accepts nothing while the gate is off", async () => {
      const deps = dependencies(confirmed());
      const response = await createSignupHandler(deps)(request());
      expect(response.status).toBe(201);
      expect(deps.currentTerms).not.toHaveBeenCalled();
      expect(deps.complete.mock.calls[0][3]).toBeUndefined();
      expect(deps.recordTermsAcceptance).not.toHaveBeenCalled();
    });

    it("refuses an acceptance it could never record rather than dropping the field", async () => {
      const deps = dependencies(confirmed());
      const response = await createSignupHandler(deps)(
        request({ ...input, acceptedTermsVersionKey: "2026-08-account-v1" }),
      );
      expect(response.status).toBe(400);
      expect(deps.signUp).not.toHaveBeenCalled();
    });
  });
});

describe("GET /api/onboarding/signup", () => {
  it("returns only public tier ids and labels", async () => {
    const list = vi.fn().mockResolvedValue([{ id: TIER_ID, label: "Growth" }]);
    const response = await createSignupCatalogHandler({ enabled: () => true, list })();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      tiers: [{ id: TIER_ID, label: "Growth" }],
    });
  });

  it("keeps an empty catalog honest and fails closed when the projection is unavailable", async () => {
    const empty = await createSignupCatalogHandler({
      enabled: () => true,
      list: async () => [],
    })();
    await expect(empty.json()).resolves.toEqual({ tiers: [] });

    const unavailable = await createSignupCatalogHandler({
      enabled: () => true,
      list: async () => { throw new Error("database detail"); },
    })();
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).not.toContain("database detail");
  });
});
