import { beforeEach, describe, expect, it } from "vitest";

import { callerKey, rateLimit, resetRateLimits } from "@/lib/rate-limit";

const LIMIT = { limit: 3, windowMs: 60_000 };

describe("rateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the limit and refuses the next request", () => {
    expect(rateLimit("a", LIMIT, 0).allowed).toBe(true);
    expect(rateLimit("a", LIMIT, 0).allowed).toBe(true);
    expect(rateLimit("a", LIMIT, 0).allowed).toBe(true);

    const blocked = rateLimit("a", LIMIT, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBe(60);
  });

  it("counts each caller separately, so one client cannot lock everyone out", () => {
    rateLimit("a", LIMIT, 0);
    rateLimit("a", LIMIT, 0);
    rateLimit("a", LIMIT, 0);
    expect(rateLimit("a", LIMIT, 0).allowed).toBe(false);
    expect(rateLimit("b", LIMIT, 0).allowed).toBe(true);
  });

  it("reopens once the window has passed", () => {
    for (let i = 0; i < 4; i += 1) rateLimit("a", LIMIT, 0);
    expect(rateLimit("a", LIMIT, 0).allowed).toBe(false);
    expect(rateLimit("a", LIMIT, 60_001).allowed).toBe(true);
  });

  it("reports remaining requests so a caller can back off before being refused", () => {
    expect(rateLimit("a", LIMIT, 0).remaining).toBe(2);
    expect(rateLimit("a", LIMIT, 0).remaining).toBe(1);
    expect(rateLimit("a", LIMIT, 0).remaining).toBe(0);
  });
});

describe("callerKey", () => {
  const request = (headers: Record<string, string>) => new Request("https://x.test", { headers });

  it("uses the first hop of x-forwarded-for, which is the real client on Vercel", () => {
    expect(callerKey(request({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }), "agent")).toBe("agent:9.9.9.9");
  });

  it("falls back to x-real-ip, then to a shared bucket", () => {
    expect(callerKey(request({ "x-real-ip": "8.8.8.8" }), "agent")).toBe("agent:8.8.8.8");
    // Failing closed into one shared bucket throttles anonymous traffic as a group
    // rather than failing open and enforcing nothing.
    expect(callerKey(request({}), "agent")).toBe("agent:anonymous");
  });

  it("keeps separate scopes from sharing a budget", () => {
    const headers = { "x-forwarded-for": "9.9.9.9" };
    expect(callerKey(request(headers), "agent")).not.toBe(callerKey(request(headers), "consumer-agent"));
  });
});
