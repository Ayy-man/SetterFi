import { afterEach, describe, expect, it } from "vitest";

import {
  MIN_ACCOUNT_PASSWORD_LENGTH,
  accountSecurityRateLimitKeys,
  accountSecuritySessions,
  passwordChange,
  sameOrigin,
  sessionId,
  sessionRevocationReason,
} from "./account-security";

const session = "f9d3a026-4df6-4eb1-b48c-2c43e4e1a9ce";

describe("account security input contracts", () => {
  it("keys an account throttle by a hash rather than the raw account identifier", () => {
    const keys = accountSecurityRateLimitKeys("password-change", "auth-account-security:203.0.113.9", "user-1");
    expect(keys.caller).toBe("auth-account-security:password-change:caller:auth-account-security:203.0.113.9");
    expect(keys.account).toMatch(/^auth-account-security:password-change:account:[0-9a-f]{64}$/);
    expect(keys.account).not.toContain("user-1");
  });

  it("requires a concrete, bounded audit reason for a session revocation", () => {
    expect(sessionRevocationReason("  I do not recognise this browser. ")).toBe("I do not recognise this browser.");
    expect(sessionRevocationReason(" ")).toBeNull();
    expect(sessionRevocationReason("a".repeat(501))).toBeNull();
  });

  it("accepts only UUID session ids", () => {
    expect(sessionId(session)).toBe(session);
    expect(sessionId("session-1")).toBeNull();
  });

  it("requires a current password and a distinct, sufficiently long replacement", () => {
    expect(passwordChange({ currentPassword: "old-password", password: "new-password-123" })).toEqual({
      currentPassword: "old-password", password: "new-password-123",
    });
    expect(passwordChange({ currentPassword: "old-password", password: "old-password" })).toBeNull();
    expect(passwordChange({ currentPassword: "old-password", password: "x".repeat(MIN_ACCOUNT_PASSWORD_LENGTH - 1) })).toBeNull();
    expect(passwordChange({ password: "new-password-123" })).toBeNull();
  });

  it("admits a real current password without trimming it", () => {
    expect(passwordChange({ currentPassword: " current password ", password: "a new password 123" })).toMatchObject({
      currentPassword: " current password ", password: "a new password 123",
    });
  });

  it("keeps mutations same-origin", () => {
    expect(sameOrigin(new Request("https://setterfi.test/api/account/security/password", {
      method: "POST", headers: { origin: "https://setterfi.test" },
    }))).toBe(true);
    expect(sameOrigin(new Request("https://setterfi.test/api/account/security/password", {
      method: "POST", headers: { origin: "https://attacker.test" },
    }))).toBe(false);
  });

  /**
   * The second accepted origin, for the case where the runtime's own view of the host is not the
   * one a browser sends. `new URL(request.url).origin` is the host as reconstructed, and behind a
   * proxy that can be an internal name; `APP_BASE_URL` is what the deployment is configured to be
   * and what the emailed recovery link is built from, so a post arriving back from that page must
   * not be refused for disagreeing with the runtime.
   */
  describe("the configured public origin", () => {
    const APP_BASE_URL = process.env.APP_BASE_URL;
    const from = (origin: string, url = "http://internal.vercel.invalid/api/auth/password-reset/complete") =>
      sameOrigin(new Request(url, { method: "POST", headers: { origin } }));

    afterEach(() => {
      if (APP_BASE_URL === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = APP_BASE_URL;
    });

    it("accepts a browser's origin when the runtime host is an internal one", () => {
      process.env.APP_BASE_URL = "https://app.setterfi.test";
      expect(from("https://app.setterfi.test")).toBe(true);
    });

    it("still refuses a foreign origin -- a second accepted value, not a weaker comparison", () => {
      process.env.APP_BASE_URL = "https://app.setterfi.test";
      expect(from("https://attacker.test")).toBe(false);
      expect(from("https://app.setterfi.test.attacker.test")).toBe(false);
      // The two shapes a loosened comparison lets through. `evil-app.setterfi.test` *ends with*
      // the configured host, so a suffix or `includes` check accepts it while an equality check
      // does not -- and a first draft of this test missed it, because the subdomain-style
      // impostor above is refused by both.
      expect(from("https://evil-app.setterfi.test")).toBe(false);
      expect(from("https://attacker.test/?next=https://app.setterfi.test")).toBe(false);
      // An absent Origin is still a refusal; the arm adds a value to match, never a way to skip.
      expect(sameOrigin(new Request("http://internal.vercel.invalid/x", { method: "POST" }))).toBe(false);
    });

    it("refuses rather than throwing when the configured base URL is unusable", () => {
      // configuredOrigin rejects a non-https or credentialed base URL. A throw here would turn a
      // misconfigured variable into a 500 on every mutating route.
      process.env.APP_BASE_URL = "http://app.setterfi.test";
      expect(from("http://app.setterfi.test")).toBe(false);
      delete process.env.APP_BASE_URL;
      expect(from("https://app.setterfi.test")).toBe(false);
    });

    it("keeps accepting the request's own origin when the two agree", () => {
      process.env.APP_BASE_URL = "https://app.setterfi.test";
      expect(from("https://setterfi.test", "https://setterfi.test/api/x")).toBe(true);
    });
  });
});

describe("account-security session output", () => {
  it("preserves only the Auth session signals the product can honestly show", () => {
    expect(accountSecuritySessions([{
      id: session,
      started_at: "2026-08-30T09:00:00.000Z",
      last_seen_at: "2026-08-30T10:00:00.000Z",
      ip_address: "203.0.113.9",
      user_agent: "Mozilla/5.0",
      is_current: true,
    }])).toEqual([{
      id: session,
      startedAt: "2026-08-30T09:00:00.000Z",
      lastSeenAt: "2026-08-30T10:00:00.000Z",
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      isCurrent: true,
    }]);
  });

  it("refuses malformed provider-shaped rows", () => {
    expect(accountSecuritySessions([{ id: session, started_at: "when", is_current: "yes" }])).toBeNull();
  });
});
