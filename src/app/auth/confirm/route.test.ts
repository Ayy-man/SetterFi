import { describe, expect, it, vi } from "vitest";

import { createConfirmationHandler } from "./handler";

function request(query = "?token_hash=synthetic-token&next=/onboarding") {
  return new Request(`https://setterfi.test/auth/confirm${query}`);
}

function dependencies() {
  return {
    enabled: () => true,
    exchange: vi.fn().mockResolvedValue("auth-1"),
    resolve: vi.fn().mockResolvedValue({
      state: "ready" as const,
      intentId: "intent-1",
      tenantId: "tenant-1",
    }),
  };
}

describe("GET /auth/confirm", () => {
  it("returns the disabled response before token exchange", async () => {
    const deps = dependencies();
    deps.enabled = () => false;
    const response = await createConfirmationHandler(deps)(request());
    expect(response.status).toBe(404);
    expect(deps.exchange).not.toHaveBeenCalled();
  });

  it("redirects a verified, completed signup to its local next path", async () => {
    const deps = dependencies();
    const response = await createConfirmationHandler(deps)(request("?token_hash=token&next=/onboarding/profile"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://setterfi.test/onboarding/profile");
    expect(deps.exchange).toHaveBeenCalledWith("token");
    expect(deps.resolve).toHaveBeenCalledWith("auth-1");
  });

  it.each([
    "//elsewhere.test/path",
    "/\\elsewhere.test/path",
    "/%5celsewhere.test/path",
    "/%255Celsewhere.test/path",
    "/line%0abreak",
  ])("does not accept the external next destination %s", async (next) => {
    const response = await createConfirmationHandler(dependencies())(
      request(`?token_hash=token&next=${encodeURIComponent(next)}`),
    );
    expect(response.headers.get("location")).toBe("https://setterfi.test/onboarding");
  });

  it("routes an incomplete intent to the honest setup state", async () => {
    const deps = dependencies();
    deps.resolve.mockResolvedValue({
      state: "still_setting_up",
      intentId: "intent-1",
      errorCode: "SIGNUP_COMPLETION_FAILED",
    });
    const response = await createConfirmationHandler(deps)(request());
    expect(response.headers.get("location")).toBe(
      "https://setterfi.test/onboarding?state=still-setting-up",
    );
  });

  it("keeps a non-onboarding identity out of a blank workspace", async () => {
    const deps = dependencies();
    deps.resolve.mockResolvedValue({ state: "not_onboarding" });
    const response = await createConfirmationHandler(deps)(request());
    expect(response.headers.get("location")).toBe(
      "https://setterfi.test/login?error=workspace-not-attached",
    );
  });

  it.each(["", "?token_hash=", "?token_hash=synthetic-token"])(
    "returns a safe confirmation failure for missing or refused exchange: %s",
    async (query) => {
      const deps = dependencies();
      if (query.includes("synthetic-token")) deps.exchange.mockResolvedValue(null);
      const response = await createConfirmationHandler(deps)(request(query));
      expect(response.headers.get("location")).toBe(
        "https://setterfi.test/login?error=confirmation-failed",
      );
    },
  );

  it("normalizes intent lookup failures to a safe redirect", async () => {
    const deps = dependencies();
    deps.resolve.mockRejectedValue(new Error("database detail"));
    const response = await createConfirmationHandler(deps)(request());
    expect(response.headers.get("location")).toBe(
      "https://setterfi.test/login?error=confirmation-failed",
    );
  });
});
