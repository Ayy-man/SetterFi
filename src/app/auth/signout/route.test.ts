import { describe, expect, it, vi } from "vitest";

import { createSignoutHandler } from "./handler";

function request(next = "/login", origin = "https://setterfi.test") {
  return new Request(`https://setterfi.test/auth/signout?next=${encodeURIComponent(next)}`, {
    method: "POST",
    headers: { origin },
  });
}

describe("POST /auth/signout", () => {
  it("signs out, audits the account outcome, and refuses an off-origin return", async () => {
    const signOut = vi.fn(async () => true);
    const audit = vi.fn(async () => undefined);
    const response = await createSignoutHandler({
      actor: async () => ({ userId: "user-1", tenantId: "tenant-1" }), signOut, audit,
    })(request("/\\evil.test"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://setterfi.test/login");
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("refuses a cross-site sign-out form before changing the session", async () => {
    const signOut = vi.fn(async () => true);
    const response = await createSignoutHandler({
      actor: async () => null, signOut, audit: async () => undefined,
    })(request("/login", "https://evil.test"));
    expect(response.status).toBe(403);
    expect(signOut).not.toHaveBeenCalled();
  });
});
