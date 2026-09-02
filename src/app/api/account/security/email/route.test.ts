import { describe, expect, it, vi } from "vitest";

import type { AccountSecurityActor } from "@/lib/auth/account-security";
import { decodeTotpSecret, totpCode } from "@/lib/auth/mfa";

import { createAccountEmailChangeHandler } from "./handler";

const actor: AccountSecurityActor = {
  userId: "7c5ba0c4-2a11-4c6c-9f83-4835d1f1e2fd",
  tenantId: "a60c6753-f47a-4a81-aa5d-7e6ddd790039",
  email: "coach@example.test",
};

function request(body: unknown, origin = "https://setterfi.test") {
  return new Request("https://setterfi.test/api/account/security/email", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /api/account/security/email", () => {
  it("is unavailable when the account-security gate is off", async () => {
    const response = await createAccountEmailChangeHandler({
      enabled: () => false, context: vi.fn(), throttle: vi.fn(), issueToken: vi.fn(), send: vi.fn(),
    })(request({}));
    expect(response.status).toBe(404);
  });

  it("does not inspect credentials from a cross-origin request", async () => {
    const context = vi.fn();
    const response = await createAccountEmailChangeHandler({
      enabled: () => true, context, throttle: vi.fn(), issueToken: vi.fn(), send: vi.fn(),
    })(request({ currentPassword: "current-password", newEmail: "new@example.test" }, "https://attacker.test"));
    expect(response.status).toBe(403);
    expect(context).not.toHaveBeenCalled();
  });

  it("requires current password and a current MFA code before creating a request", async () => {
    const verifyCurrentPassword = vi.fn(async () => false);
    const start = vi.fn();
    const response = await createAccountEmailChangeHandler({
      enabled: () => true,
      context: async () => ({ actor, verifyCurrentPassword, factor: async () => ({ state: "active" as const, secret: "JBSWY3DPEHPK3PXP" }), recordFailedMfaVerification: vi.fn(), start }),
      throttle: async () => ({ allowed: true, retryAfter: 0 }), issueToken: () => "a".repeat(43), send: vi.fn(),
    })(request({ currentPassword: "wrong", newEmail: "new@example.test", mfaCode: "123456" }));
    expect(response.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps a requested address pending, sends both capabilities, and never returns either token", async () => {
    const start = vi.fn(async (input: { confirmationTokenHash: string; refusalTokenHash: string }) => {
      expect(input.confirmationTokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(input.refusalTokenHash).toMatch(/^[a-f0-9]{64}$/);
      return { requestId: "a8a60ef3-90f7-4c62-bc2f-b7f4b40defa2", expiresAt: "2026-08-30T12:00:00.000Z", auditId: 77 };
    });
    const send = vi.fn(async () => true);
    const tokens = ["a".repeat(43), "b".repeat(43)];
    const response = await createAccountEmailChangeHandler({
      enabled: () => true,
      context: async () => ({ actor, verifyCurrentPassword: async () => true, factor: async () => ({ state: "none" as const, secret: null }), recordFailedMfaVerification: vi.fn(), start }),
      throttle: async () => ({ allowed: true, retryAfter: 0 }), issueToken: () => tokens.shift()!, send,
    })(request({ currentPassword: "current-password", newEmail: "new@example.test" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "pending", expiresAt: "2026-08-30T12:00:00.000Z", audit: { id: 77, action: "auth.email_change.requested" } });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ currentEmail: actor.email, newEmail: "new@example.test" }));
    expect(JSON.stringify(start.mock.calls)).not.toContain("a".repeat(43));
  });

  it("consumes a currently valid active-factor code as part of the request", async () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const decoded = decodeTotpSecret(secret)!;
    const code = totpCode(decoded, Math.floor(Date.now() / 1_000));
    const start = vi.fn(async () => ({ requestId: "a8a60ef3-90f7-4c62-bc2f-b7f4b40defa2", expiresAt: "2026-08-30T12:00:00.000Z", auditId: 78 }));
    const tokens = ["a".repeat(43), "b".repeat(43)];
    const response = await createAccountEmailChangeHandler({
      enabled: () => true,
      context: async () => ({ actor, verifyCurrentPassword: async () => true, factor: async () => ({ state: "active" as const, secret }), recordFailedMfaVerification: vi.fn(), start }),
      throttle: async () => ({ allowed: true, retryAfter: 0 }), issueToken: () => tokens.shift()!, send: async () => true,
    })(request({ currentPassword: "current-password", newEmail: "new@example.test", mfaCode: code }));
    expect(response.status).toBe(202);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mfaCounter: expect.any(Number) }));
  });

  it("uses the same generic refusal for an already-taken address", async () => {
    const tokens = ["a".repeat(43), "b".repeat(43)];
    const response = await createAccountEmailChangeHandler({
      enabled: () => true,
      context: async () => ({ actor, verifyCurrentPassword: async () => true, factor: async () => ({ state: "none" as const, secret: null }), recordFailedMfaVerification: vi.fn(), start: async () => { throw new Error("ACCOUNT_EMAIL_CHANGE_REFUSED"); } }),
      throttle: async () => ({ allowed: true, retryAfter: 0 }), issueToken: () => tokens.shift()!, send: vi.fn(),
    })(request({ currentPassword: "current-password", newEmail: "taken@example.test" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The email address could not be changed." });
  });
});
