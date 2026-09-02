import { describe, expect, it, vi } from "vitest";

import { createRecoveryCallbackHandler } from "./handler";

function request(query: string) {
  return new Request(`https://setterfi.test/auth/recovery${query}`);
}

function dependencies() {
  return {
    exchangeCode: vi.fn(async () => true),
    verifyRecoveryToken: vi.fn(async () => true),
  };
}

describe("GET /auth/recovery", () => {
  it("exchanges a PKCE recovery code and continues only to a local reset destination", async () => {
    const deps = dependencies();
    const response = await createRecoveryCallbackHandler(deps)(request("?code=valid-code&next=/coach/home"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://setterfi.test/auth/reset-password?next=%2Fcoach%2Fhome",
    );
    expect(deps.exchangeCode).toHaveBeenCalledWith("valid-code");
  });

  it("accepts only a recovery OTP token, not an email-confirmation token", async () => {
    const deps = dependencies();
    const response = await createRecoveryCallbackHandler(deps)(request("?token_hash=token&type=recovery"));
    expect(response.status).toBe(303);
    expect(deps.verifyRecoveryToken).toHaveBeenCalledWith("token");

    const rejected = await createRecoveryCallbackHandler(deps)(request("?token_hash=token&type=email"));
    expect(rejected.headers.get("location")).toBe(
      "https://setterfi.test/auth/reset-password?next=%2Flogin&error=invalid-link",
    );
  });

  it.each(["?code=expired", "?token_hash=invalid&type=recovery", "?next=/\\evil.test"]) (
    "sends expired, invalid, or adversarial callbacks to the safe invalid-link state: %s",
    async (query) => {
      const deps = dependencies();
      deps.exchangeCode.mockResolvedValue(false);
      deps.verifyRecoveryToken.mockResolvedValue(false);
      const response = await createRecoveryCallbackHandler(deps)(request(query));
      expect(response.headers.get("location")).toBe(
        "https://setterfi.test/auth/reset-password?next=%2Flogin&error=invalid-link",
      );
    },
  );
});
