import { describe, expect, it, vi } from "vitest";

import {
  consumeTenantRateLimit,
  type TenantRateLimitRpcClient,
} from "./tenant-rate-limit";

const input = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  routeKey: "opt-in-consent",
  callerKey: "public-request:203.0.113.7",
  limit: 12,
  windowMs: 15 * 60 * 1_000,
};

describe("consumeTenantRateLimit", () => {
  it("sends the tenant, route, and caller as distinct database scope fields", async () => {
    const rpc = vi.fn<TenantRateLimitRpcClient["rpc"]>(async () => ({
      data: [{ allowed: true, remaining: 11, retry_after: 0 }],
      error: null,
    }));

    await expect(consumeTenantRateLimit(input, {
      client: { rpc },
      now: () => new Date("2030-01-02T00:00:00.000Z"),
    })).resolves.toEqual({
      allowed: true,
      remaining: 11,
      retryAfter: 0,
      store: "shared",
      reason: null,
    });
    expect(rpc).toHaveBeenCalledWith("consume_tenant_rate_limit", {
      p_tenant_id: input.tenantId,
      p_route_key: input.routeKey,
      p_caller_key: input.callerKey,
      p_limit: 12,
      p_window_seconds: 900,
      p_now: "2030-01-02T00:00:00.000Z",
    });
  });

  it("fails closed when the limiter store read or RPC result is unavailable", async () => {
    await expect(consumeTenantRateLimit(input, {
      client: {
        rpc: async () => ({ data: null, error: { message: "database unavailable" } }),
      },
    })).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfter: 900,
      store: "error",
      reason: "RATE_LIMIT_STORE_UNAVAILABLE",
    });
  });
});
