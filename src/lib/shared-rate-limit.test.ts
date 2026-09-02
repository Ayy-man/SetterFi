import { describe, expect, it, vi } from "vitest";

import {
  sharedCallerKey,
  sharedRateLimit,
  type RateLimitRpcClient,
} from "./shared-rate-limit";

function request(headers: Record<string, string>) {
  return new Request("https://setterfi.test/api/paid", { headers });
}

function atomicMockClient(): RateLimitRpcClient {
  const windows = new Map<string, { startedAt: number; hits: number }>();
  return {
    rpc: async (_name, args) => {
      const now = new Date(args.p_now).getTime();
      const existing = windows.get(args.p_key);
      const expired =
        !existing || now >= existing.startedAt + args.p_window_seconds * 1000;
      const window = expired ? { startedAt: now, hits: 0 } : existing;
      if (window.hits >= args.p_limit) {
        windows.set(args.p_key, window);
        return {
          data: [
            {
              allowed: false,
              remaining: 0,
              retry_after: Math.max(
                1,
                args.p_window_seconds - Math.floor((now - window.startedAt) / 1000),
              ),
            },
          ],
          error: null,
        };
      }
      window.hits += 1;
      windows.set(args.p_key, window);
      return {
        data: [
          {
            allowed: true,
            remaining: args.p_limit - window.hits,
            retry_after: 0,
          },
        ],
        error: null,
      };
    },
  };
}

describe("sharedCallerKey", () => {
  it("includes tenant, route, and the same caller identity used by fixture routes", () => {
    expect(
      sharedCallerKey(request({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }), {
        tenantId: "tenant-1",
        route: "agent.generate",
      }),
    ).toBe("tenant:tenant-1:route:agent.generate:9.9.9.9");
    expect(
      sharedCallerKey(request({}), { tenantId: "tenant-1", route: "agent.generate" }),
    ).toBe("tenant:tenant-1:route:agent.generate:anonymous");
  });

  it("keeps tenant and route components unambiguous when they contain separators", () => {
    expect(
      sharedCallerKey(request({ "x-real-ip": "8.8.8.8" }), {
        tenantId: "tenant:one",
        route: "agent/moderate",
      }),
    ).toBe("tenant:tenant%3Aone:route:agent%2Fmoderate:8.8.8.8");
  });
});

describe("sharedRateLimit", () => {
  it("preserves the existing result semantics while calling the named RPC", async () => {
    const rpc = vi.fn<RateLimitRpcClient["rpc"]>(async () => ({
      data: [{ allowed: true, remaining: 2, retry_after: 0 }],
      error: null,
    }));
    await expect(
      sharedRateLimit("tenant:t:route:r:caller", { limit: 3, windowMs: 60_000 }, {
        client: { rpc },
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      allowed: true,
      remaining: 2,
      retryAfter: 0,
      store: "shared",
      reason: null,
    });
    expect(rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_key: "tenant:t:route:r:caller",
      p_limit: 3,
      p_window_seconds: 60,
      p_now: "2026-08-17T00:00:00.000Z",
    });
  });

  it("atomically refuses concurrent calls beyond the configured window", async () => {
    const client = atomicMockClient();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        sharedRateLimit("one-window", { limit: 3, windowMs: 60_000 }, {
          client,
          now: () => new Date("2026-08-17T00:00:00.000Z"),
        }),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(results.filter((result) => !result.allowed)).toHaveLength(5);
    expect(results.at(-1)).toMatchObject({ allowed: false, remaining: 0, retryAfter: 60 });
  });

  it("opens a fresh shared window after expiry", async () => {
    const client = atomicMockClient();
    let now = new Date("2026-08-17T00:00:00.000Z");
    await sharedRateLimit("window", { limit: 1, windowMs: 60_000 }, { client, now: () => now });
    await expect(
      sharedRateLimit("window", { limit: 1, windowMs: 60_000 }, { client, now: () => now }),
    ).resolves.toMatchObject({ allowed: false });
    now = new Date("2026-08-17T00:01:00.001Z");
    await expect(
      sharedRateLimit("window", { limit: 1, windowMs: 60_000 }, { client, now: () => now }),
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
  });

  it("fails closed with a typed result and prevents the paid provider call on store errors", async () => {
    const provider = vi.fn();
    const result = await sharedRateLimit("paid", { limit: 3, windowMs: 60_000 }, {
      client: {
        rpc: async () => ({ data: null, error: { message: "store unavailable" } }),
      },
    });
    if (result.allowed) provider();
    expect(result).toEqual({
      allowed: false,
      remaining: 0,
      retryAfter: 60,
      store: "error",
      reason: "RATE_LIMIT_STORE_UNAVAILABLE",
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails closed on malformed RPC rows instead of trusting partial data", async () => {
    await expect(
      sharedRateLimit("paid", { limit: 3, windowMs: 60_000 }, {
        client: { rpc: async () => ({ data: [{ allowed: true }], error: null }) },
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "RATE_LIMIT_STORE_UNAVAILABLE" });
  });
});
