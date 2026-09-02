import { describe, expect, it, vi } from "vitest";

import { AUTH_REQUEST_ACCEPTED, recoveryCallbackUrl } from "@/lib/auth/recovery";

import { createResendVerificationHandler } from "./handler";

function request(body: unknown) {
  return new Request("https://setterfi.test/api/auth/resend-verification", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/resend-verification", () => {
  it("resends a signup verification through the canonical confirmation callback", async () => {
    const send = vi.fn(async () => true);
    const response = await createResendVerificationHandler({
      enabled: () => true,
      parse: (value) => value.json(),
      throttle: async () => ({ allowed: true, retryAfter: 0 }),
      callback: (next) => recoveryCallbackUrl("https://setterfi.test", "/auth/confirm", next),
      send,
      audit: async () => undefined,
    })(request({ email: "coach@example.test", next: "/onboarding/profile" }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(AUTH_REQUEST_ACCEPTED);
    expect(send).toHaveBeenCalledWith(
      "coach@example.test",
      "https://setterfi.test/auth/confirm?next=%2Fonboarding%2Fprofile",
    );
  });
});
