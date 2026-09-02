import { describe, expect, it, vi } from "vitest";

import { authIdentityFailure, createAccountEmailChangeConfirmHandler } from "./handler";

const TOKEN = "a".repeat(43);
const HASH = /^[a-f0-9]{64}$/;

function dependencies(overrides: Partial<Parameters<typeof createAccountEmailChangeConfirmHandler>[0]> = {}) {
  return {
    enabled: () => true,
    resolve: vi.fn(async () => ({ userId: "user-1", newEmail: "new@example.test" })),
    syncAuthIdentity: vi.fn(async () => "synced" as const),
    voidRequest: vi.fn(async () => undefined),
    recordDivergence: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({ state: "confirmed" as const, auditId: 88 })),
    ...overrides,
  };
}

function confirmRequest(token = TOKEN) {
  return new Request(`https://setterfi.test/api/account/security/email/confirm?action=confirm&token=${token}`);
}

describe("account email-change confirmation", () => {
  it("moves the Supabase Auth identity before the application row and confirms once both are written", async () => {
    const order: string[] = [];
    const dependency = dependencies({
      syncAuthIdentity: vi.fn(async () => { order.push("auth"); return "synced" as const; }),
      complete: vi.fn(async () => { order.push("app"); return { state: "confirmed" as const, auditId: 88 }; }),
    });
    const response = await createAccountEmailChangeConfirmHandler(dependency).GET(confirmRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "confirmed", audit: { id: 88, action: "auth.email_change.confirmed" } });
    expect(dependency.syncAuthIdentity).toHaveBeenCalledWith({ userId: "user-1", newEmail: "new@example.test" });
    expect(dependency.complete).toHaveBeenCalledWith({ action: "confirm", tokenHash: expect.stringMatching(HASH) });
    expect(order).toEqual(["auth", "app"]);
    expect(dependency.recordDivergence).not.toHaveBeenCalled();
  });

  it("records the divergence direction and refuses to claim success when the application row fails after auth moved", async () => {
    const dependency = dependencies({
      complete: vi.fn(async () => { throw new Error("ACCOUNT_EMAIL_CHANGE_COMPLETE_FAILED"); }),
    });
    const response = await createAccountEmailChangeConfirmHandler(dependency).GET(confirmRequest());

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/Sign-in already uses the new address/);
    expect(dependency.recordDivergence).toHaveBeenCalledWith(expect.stringMatching(HASH));
  });

  it("records the divergence when the redemption answers invalid after the auth identity already moved", async () => {
    const dependency = dependencies({ complete: vi.fn(async () => ({ state: "invalid" as const, auditId: null })) });
    const response = await createAccountEmailChangeConfirmHandler(dependency).GET(confirmRequest());

    expect(response.status).toBe(503);
    expect(dependency.recordDivergence).toHaveBeenCalledWith(expect.stringMatching(HASH));
  });

  it("leaves both stores untouched and stays retryable when the auth API is unavailable", async () => {
    const dependency = dependencies({ syncAuthIdentity: vi.fn(async () => "unavailable" as const) });
    const response = await createAccountEmailChangeConfirmHandler(dependency).GET(confirmRequest());

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/Neither address was changed/);
    expect(dependency.complete).not.toHaveBeenCalled();
    expect(dependency.recordDivergence).not.toHaveBeenCalled();
    expect(dependency.voidRequest).not.toHaveBeenCalled();
  });

  it("refuses an address another identity already holds with the same answer a bad link gets", async () => {
    const dependency = dependencies({ syncAuthIdentity: vi.fn(async () => "taken" as const) });
    const response = await createAccountEmailChangeConfirmHandler(dependency).GET(confirmRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "This email-change link is invalid or expired." });
    expect(dependency.voidRequest).toHaveBeenCalledWith(expect.stringMatching(HASH));
    expect(dependency.complete).not.toHaveBeenCalled();
  });

  it("does not touch the auth identity for a link that resolves to nothing", async () => {
    const dependency = dependencies({ resolve: vi.fn(async () => null) });
    const response = await createAccountEmailChangeConfirmHandler(dependency).GET(confirmRequest());

    expect(response.status).toBe(400);
    expect(dependency.syncAuthIdentity).not.toHaveBeenCalled();
    expect(dependency.complete).not.toHaveBeenCalled();
  });

  it("records an old-address refusal through the same single-use capability endpoint", async () => {
    const dependency = dependencies({ complete: vi.fn(async () => ({ state: "refused" as const, auditId: 89 })) });
    const response = await createAccountEmailChangeConfirmHandler(dependency).POST(new Request("https://setterfi.test/api/account/security/email/confirm", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refuse", token: "b".repeat(43) }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "refused", audit: { id: 89, action: "auth.email_change.refused" } });
    expect(dependency.syncAuthIdentity).not.toHaveBeenCalled();
  });

  it("does not call the database for malformed or expired-looking links", async () => {
    const dependency = dependencies();
    const response = await createAccountEmailChangeConfirmHandler(dependency).GET(confirmRequest("bad"));

    expect(response.status).toBe(400);
    expect(dependency.resolve).not.toHaveBeenCalled();
    expect(dependency.complete).not.toHaveBeenCalled();
  });

  it("classifies an occupied address as taken and every other provider failure as retryable", () => {
    expect(authIdentityFailure(null)).toBe("synced");
    expect(authIdentityFailure({ code: "email_exists", status: 422, message: "A user with this email address has already been registered" })).toBe("taken");
    expect(authIdentityFailure({ status: 500, message: "internal server error" })).toBe("unavailable");
    expect(authIdentityFailure({ message: "fetch failed" })).toBe("unavailable");
  });
});
