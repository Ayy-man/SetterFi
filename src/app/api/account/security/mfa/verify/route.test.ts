import { describe, expect, it, vi } from "vitest";

import type { AccountSecurityActor } from "@/lib/auth/account-security";

import { createAccountMfaVerifyHandler } from "./handler";

const actor: AccountSecurityActor = {
  userId: "7c5ba0c4-2a11-4c6c-9f83-4835d1f1e2fd",
  tenantId: "a60c6753-f47a-4a81-aa5d-7e6ddd790039",
  email: "coach@example.test",
};

function request(options: RequestInit = {}) {
  return new Request("https://setterfi.test/api/account/security/mfa/verify", options);
}

describe("account MFA verification", () => {
  it("activates only after a throttled signed-in verification and records the activation receipt", async () => {
    const activate = vi.fn(async () => ({ auditId: 73 }));
    const throttle = vi.fn(async () => ({ allowed: true, retryAfter: 0 }));
    const response = await createAccountMfaVerifyHandler({
      enabled: () => true, context: async () => ({ actor, activate }), throttle,
    })(request({
      method: "POST", headers: { origin: "https://setterfi.test", "content-type": "application/json" }, body: JSON.stringify({ code: "123456" }),
    }));
    expect(response.status).toBe(200);
    expect(throttle).toHaveBeenCalledWith(expect.any(Request), actor);
    expect(activate).toHaveBeenCalledWith("123456");
    expect(await response.json()).toEqual({ status: "active", audit: { id: 73, action: "auth.mfa.activated" } });
  });

  it("does not activate a failed verification and preserves the account lockout response", async () => {
    const activate = vi.fn(async () => null);
    const handler = createAccountMfaVerifyHandler({
      enabled: () => true, context: async () => ({ actor, activate }), throttle: async () => ({ allowed: false, retryAfter: 61 }),
    });
    const locked = await handler(request({
      method: "POST", headers: { origin: "https://setterfi.test", "content-type": "application/json" }, body: JSON.stringify({ code: "123456" }),
    }));
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("61");
    expect(activate).not.toHaveBeenCalled();

    const refused = await createAccountMfaVerifyHandler({
      enabled: () => true, context: async () => ({ actor, activate }), throttle: async () => ({ allowed: true, retryAfter: 0 }),
    })(request({
      method: "POST", headers: { origin: "https://setterfi.test", "content-type": "application/json" }, body: JSON.stringify({ code: "123456" }),
    }));
    expect(refused.status).toBe(400);
    expect(activate).toHaveBeenCalledWith("123456");
  });

  it("refuses cross-origin and malformed code requests before verification", async () => {
    const activate = vi.fn(async () => ({ auditId: 74 }));
    const handler = createAccountMfaVerifyHandler({
      enabled: () => true, context: async () => ({ actor, activate }), throttle: async () => ({ allowed: true, retryAfter: 0 }),
    });
    const crossOrigin = await handler(request({ method: "POST", headers: { origin: "https://attacker.test" } }));
    expect(crossOrigin.status).toBe(403);
    const malformed = await handler(request({
      method: "POST", headers: { origin: "https://setterfi.test", "content-type": "application/json" }, body: JSON.stringify({ code: "12345" }),
    }));
    expect(malformed.status).toBe(400);
    expect(activate).not.toHaveBeenCalled();
  });
});
