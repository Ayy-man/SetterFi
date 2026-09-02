import { describe, expect, it, vi } from "vitest";

import {
  AUTH_REQUEST_ACCEPTED,
  recoveryCallbackUrl,
} from "@/lib/auth/recovery";

import { createPasswordResetRequestHandler } from "./handler";

function request(body: unknown) {
  return new Request("https://setterfi.test/api/auth/password-reset", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

function dependencies() {
  const throttle = vi.fn(async () => ({ allowed: true, retryAfter: 0 }));
  const callback = vi.fn((next: string) => recoveryCallbackUrl(
    "https://setterfi.test", "/auth/recovery", next,
  ));
  // Declaring the parameters keeps the recorded call typed, so the assertion on the redirect
  // target below reads an argument the mock actually knows about.
  const send = vi.fn(async (_email: string, _redirectTo: string) => true);
  const audit = vi.fn(async () => undefined);
  return {
    throttle,
    callback,
    send,
    audit,
    values: {
      enabled: () => true,
      parse: (value: Request) => value.json(),
      throttle,
      callback,
      send,
      audit,
    },
  };
}

describe("POST /api/auth/password-reset", () => {
  it("queues a password-recovery email and records the anonymous request", async () => {
    const deps = dependencies();
    const response = await createPasswordResetRequestHandler(deps.values)(request({
      email: "Coach@Example.test ", next: "/coach/home",
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(AUTH_REQUEST_ACCEPTED);
    expect(deps.send).toHaveBeenCalledWith(
      "coach@example.test",
      "https://setterfi.test/auth/recovery?next=%2Fcoach%2Fhome",
    );
    expect(deps.audit).toHaveBeenCalledTimes(1);
  });

  it("gives known and unknown addresses the identical public acknowledgement", async () => {
    const known = dependencies();
    const unknown = dependencies();
    unknown.send.mockResolvedValue(false);
    const handlerForKnown = createPasswordResetRequestHandler(known.values);
    const handlerForUnknown = createPasswordResetRequestHandler(unknown.values);

    const [knownResponse, unknownResponse] = await Promise.all([
      handlerForKnown(request({ email: "known@example.test" })),
      handlerForUnknown(request({ email: "unknown@example.test" })),
    ]);

    expect({ status: knownResponse.status, body: await knownResponse.json() }).toEqual({
      status: unknownResponse.status,
      body: await unknownResponse.json(),
    });
    expect(knownResponse.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["//evil.test", "/\\evil.test", "/%255cevil.test"]) (
    "refuses an adversarial return destination %s before making the mail callback",
    async (next) => {
      const deps = dependencies();
      const response = await createPasswordResetRequestHandler(deps.values)(request({
        email: "coach@example.test", next,
      }));

      expect(response.status).toBe(202);
      expect(deps.callback).toHaveBeenCalledWith("/login");
      expect(deps.send.mock.calls[0][1]).toBe("https://setterfi.test/auth/recovery?next=%2Flogin");
    },
  );

  it("throttles before sending a recovery email", async () => {
    const deps = dependencies();
    deps.throttle.mockResolvedValue({ allowed: false, retryAfter: 71 });
    const response = await createPasswordResetRequestHandler(deps.values)(request({
      email: "coach@example.test",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("71");
    expect(await response.json()).toEqual(AUTH_REQUEST_ACCEPTED);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });
});
