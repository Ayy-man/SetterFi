import { describe, expect, it, vi } from "vitest";

import type { AccountSecurityActor } from "@/lib/auth/account-security";

import { createAccountMfaHandler } from "./handler";

const actor: AccountSecurityActor = {
  userId: "7c5ba0c4-2a11-4c6c-9f83-4835d1f1e2fd",
  tenantId: "a60c6753-f47a-4a81-aa5d-7e6ddd790039",
  email: "coach@example.test",
};
const issuedSecret = "JBSWY3DPEHPK3PXP";

function request(path: string, options: RequestInit = {}) {
  return new Request(`https://setterfi.test${path}`, options);
}

describe("account MFA route", () => {
  it("returns the secret only from the enrollment response and keeps enrollment pending", async () => {
    const status = vi.fn(async () => "pending" as const);
    const enroll = vi.fn(async () => ({ status: "pending" as const, auditId: 71 }));
    const handler = createAccountMfaHandler({
      enabled: () => true,
      context: async () => ({ actor, status, enroll, disable: async () => null }),
      throttle: async () => ({ allowed: true, retryAfter: 0 }),
      issueSecret: () => issuedSecret,
    });

    const enrollment = await handler.POST(request("/api/account/security/mfa", {
      method: "POST", headers: { origin: "https://setterfi.test" },
    }));
    expect(enrollment.status).toBe(200);
    expect(await enrollment.json()).toEqual({
      status: "pending", secret: issuedSecret, audit: { id: 71, action: "auth.mfa.enrolled" },
    });
    expect(enroll).toHaveBeenCalledWith(issuedSecret);

    const laterRead = await handler.GET();
    expect(laterRead.status).toBe(200);
    expect(await laterRead.json()).toEqual({ status: "pending" });
    expect(JSON.stringify(await (await handler.GET()).json())).not.toContain(issuedSecret);
  });

  it("requires a current authenticator code before disabling an active factor", async () => {
    const disable = vi.fn(async () => ({ auditId: 72 }));
    const handler = createAccountMfaHandler({
      enabled: () => true,
      context: async () => ({ actor, status: async () => "active" as const, enroll: async () => ({ status: "pending" as const, auditId: 0 }), disable }),
      throttle: async () => ({ allowed: true, retryAfter: 0 }),
      issueSecret: () => issuedSecret,
    });

    const invalid = await handler.DELETE(request("/api/account/security/mfa", {
      method: "DELETE", headers: { origin: "https://setterfi.test", "content-type": "application/json" }, body: JSON.stringify({ code: "wrong" }),
    }));
    expect(invalid.status).toBe(400);
    expect(disable).not.toHaveBeenCalled();

    const removed = await handler.DELETE(request("/api/account/security/mfa", {
      method: "DELETE", headers: { origin: "https://setterfi.test", "content-type": "application/json" }, body: JSON.stringify({ code: "123456" }),
    }));
    expect(removed.status).toBe(200);
    expect(disable).toHaveBeenCalledWith("123456");
    expect(await removed.json()).toEqual({ status: "none", audit: { id: 72, action: "auth.mfa.disabled" } });
  });

  it("refuses enrollment and removal before parsing a cross-origin request", async () => {
    const enroll = vi.fn();
    const disable = vi.fn();
    const handler = createAccountMfaHandler({
      enabled: () => true,
      context: async () => ({ actor, status: async () => "none" as const, enroll, disable }),
      throttle: async () => ({ allowed: true, retryAfter: 0 }),
      issueSecret: () => issuedSecret,
    });
    const response = await handler.POST(request("/api/account/security/mfa", { method: "POST", headers: { origin: "https://attacker.test" } }));
    expect(response.status).toBe(403);
    expect(enroll).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });
});
