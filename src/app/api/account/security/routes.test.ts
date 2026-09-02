import { describe, expect, it, vi } from "vitest";

import type { AccountSecurityActor } from "@/lib/auth/account-security";

import { createAccountSecurityPasswordHandler } from "./password/handler";
import { createAccountSecuritySessionDeleteHandler } from "./sessions/[sessionId]/handler";
import { createAccountSecurityOthersDeleteHandler } from "./sessions/others/handler";
import { createAccountSecuritySessionsHandler } from "./sessions/handler";

const actor: AccountSecurityActor = { userId: "7c5ba0c4-2a11-4c6c-9f83-4835d1f1e2fd", tenantId: "a60c6753-f47a-4a81-aa5d-7e6ddd790039", email: "coach@example.test" };
const sessionId = "f9d3a026-4df6-4eb1-b48c-2c43e4e1a9ce";
const otherSessionId = "d7cd1b84-6568-47ec-a7fa-2c71b85df51f";

function request(url: string, options: RequestInit = {}) {
  return new Request(`https://setterfi.test${url}`, options);
}

describe("account-security routes", () => {
  it("lists only validated Auth session metadata after throttling the signed-in account", async () => {
    const list = vi.fn(async () => ({ sessions: [{
      id: sessionId, started_at: "2026-08-30T09:00:00.000Z", last_seen_at: null,
      ip_address: "203.0.113.9", user_agent: null, is_current: true,
    }], auditId: 90 }));
    const throttle = vi.fn(async () => ({ allowed: true, retryAfter: 0 }));
    const response = await createAccountSecuritySessionsHandler({
      enabled: () => true, context: async () => ({ actor, list }), throttle,
    })(request("/api/account/security/sessions"));

    expect(response.status).toBe(200);
    expect(throttle).toHaveBeenCalledWith(expect.any(Request), actor);
    expect(await response.json()).toEqual({ sessions: [{
      id: sessionId, startedAt: "2026-08-30T09:00:00.000Z", lastSeenAt: null,
      ipAddress: "203.0.113.9", userAgent: null, isCurrent: true,
    }], audit: { id: 90, action: "auth.sessions.viewed" } });
  });

  it("does not parse or revoke a selected session from a cross-origin request", async () => {
    const revoke = vi.fn();
    const response = await createAccountSecuritySessionDeleteHandler({
      enabled: () => true, context: async () => ({ actor, revoke }), throttle: async () => ({ allowed: true, retryAfter: 0 }),
    })(request(`/api/account/security/sessions/${sessionId}`, {
      method: "DELETE", headers: { origin: "https://attacker.test", "content-type": "application/json" }, body: JSON.stringify({ reason: "Unknown device" }),
    }), { params: Promise.resolve({ sessionId }) });

    expect(response.status).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("ends every other session under an explicit audit reason", async () => {
    const revokeOthers = vi.fn(async () => ({ revokedCount: 2, auditId: 91 }));
    const response = await createAccountSecurityOthersDeleteHandler({
      enabled: () => true, context: async () => ({ actor, revokeOthers }), throttle: async () => ({ allowed: true, retryAfter: 0 }),
    })(request("/api/account/security/sessions/others", {
      method: "DELETE", headers: { origin: "https://setterfi.test", "content-type": "application/json" }, body: JSON.stringify({ reason: "Password may have been shared" }),
    }));

    expect(response.status).toBe(200);
    expect(revokeOthers).toHaveBeenCalledWith("Password may have been shared");
    expect(await response.json()).toEqual({ revokedCount: 2, audit: { id: 91, action: "auth.sessions.others_revoked" } });
  });

  it("passes the current password to the credential update and audits only a completed change", async () => {
    const update = vi.fn(async () => true);
    const audit = vi.fn(async () => ({ auditId: 92 }));
    const verifyCurrentPassword = vi.fn(async () => true);
    const endOtherSessions = vi.fn(async () => 2);
    const response = await createAccountSecurityPasswordHandler({
      enabled: () => true, context: async () => ({ actor, verifyCurrentPassword, endOtherSessions, update, audit }), throttle: async () => ({ allowed: true, retryAfter: 0 }),
    })(request("/api/account/security/password", {
      method: "POST", headers: { origin: "https://setterfi.test", "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "correct current password", password: "correct replacement password" }),
    }));

    expect(response.status).toBe(200);
    expect(verifyCurrentPassword).toHaveBeenCalledWith("correct current password");
    expect(update).toHaveBeenCalledWith({ currentPassword: "correct current password", password: "correct replacement password" });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  /*
   * The route said "Other sessions have been ended" and ended none of them, and
   * `record_account_security_password_change` wrote `'other_sessions': 'ended'` into the audit row,
   * so the claim was in the log as fact as well as on the screen. These three pin the fix: the
   * sessions are ended by our own delete, the count is the counted one, and the ordering is what
   * keeps the audit row from ever asserting something false.
   */
  it("ends the other sessions itself and reports the count it was given", async () => {
    const endOtherSessions = vi.fn(async () => 3);
    const response = await createAccountSecurityPasswordHandler({
      enabled: () => true,
      context: async () => ({ actor, verifyCurrentPassword: async () => true, endOtherSessions, update: async () => true, audit: async () => ({ auditId: 94 }) }),
      throttle: async () => ({ allowed: true, retryAfter: 0 }),
    })(request("/api/account/security/password", {
      method: "POST", headers: { origin: "https://setterfi.test", "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "correct current password", password: "correct replacement password" }),
    }));

    expect(endOtherSessions).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      message: "Password changed. 3 other sessions have been ended.",
      revokedCount: 3,
    });
  });

  it("says one session rather than 1 sessions", async () => {
    const response = await createAccountSecurityPasswordHandler({
      enabled: () => true,
      context: async () => ({ actor, verifyCurrentPassword: async () => true, endOtherSessions: async () => 1, update: async () => true, audit: async () => ({ auditId: 95 }) }),
      throttle: async () => ({ allowed: true, retryAfter: 0 }),
    })(request("/api/account/security/password", {
      method: "POST", headers: { origin: "https://setterfi.test", "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "correct current password", password: "correct replacement password" }),
    }));

    expect(await response.json()).toMatchObject({ message: "Password changed. 1 other session has been ended." });
  });

  it("changes no password and writes no audit row when the sessions cannot be ended", async () => {
    const update = vi.fn(async () => true);
    const audit = vi.fn(async () => ({ auditId: 96 }));
    const response = await createAccountSecurityPasswordHandler({
      enabled: () => true,
      context: async () => ({
        actor,
        verifyCurrentPassword: async () => true,
        endOtherSessions: async () => { throw new Error("ACCOUNT_SECURITY_PASSWORD_OTHERS_REVOKE_FAILED"); },
        update,
        audit,
      }),
      throttle: async () => ({ allowed: true, retryAfter: 0 }),
    })(request("/api/account/security/password", {
      method: "POST", headers: { origin: "https://setterfi.test", "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "correct current password", password: "correct replacement password" }),
    }));

    // The audit row hardcodes `'other_sessions': 'ended'` in SQL, so it must be unreachable unless
    // the sessions actually went. Revoking first is what makes that true: a failed revoke returns
    // before the password changes and before any row is written.
    expect(response.status).toBe(503);
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("never attempts a password update for an invalid or throttled request", async () => {
    const update = vi.fn(async () => true);
    const audit = vi.fn(async () => ({ auditId: 93 }));
    const verifyCurrentPassword = vi.fn(async () => true);
    const endOtherSessions = vi.fn(async () => 0);
    const handler = createAccountSecurityPasswordHandler({
      enabled: () => true, context: async () => ({ actor, verifyCurrentPassword, endOtherSessions, update, audit }), throttle: async () => ({ allowed: false, retryAfter: 61 }),
    });
    const response = await handler(request("/api/account/security/password", {
      method: "POST", headers: { origin: "https://setterfi.test", "content-type": "application/json" }, body: JSON.stringify({}),
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("61");
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
