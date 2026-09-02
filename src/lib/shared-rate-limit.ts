/**
 * Shared fixed-window consumption for paid Phase 1 routes.
 *
 * The database RPC owns atomicity across serverless instances. Store failures deny paid work so a
 * transient limiter outage cannot turn into unbounded provider spend; untouched fixture routes keep
 * using the existing in-memory module until their live handlers move in Plan 06.
 */

import { callerKey, type RateLimitResult } from "@/lib/rate-limit";

type RpcError = { message?: string };

export type RateLimitRpcClient = {
  rpc(
    name: "consume_rate_limit",
    arguments_: {
      p_key: string;
      p_limit: number;
      p_window_seconds: number;
      p_now: string;
    },
  ): Promise<{ data: unknown; error: RpcError | null }>;
};

export type SharedRateLimitResult = RateLimitResult &
  (
    | { store: "shared"; reason: null }
    | { store: "error"; reason: "RATE_LIMIT_STORE_UNAVAILABLE" }
  );

type RpcRow = {
  allowed: boolean;
  remaining: number;
  retry_after: number;
};

function rpcRow(value: unknown): RpcRow | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const row = candidate as Record<string, unknown>;
  if (
    typeof row.allowed !== "boolean" ||
    typeof row.remaining !== "number" ||
    !Number.isInteger(row.remaining) ||
    row.remaining < 0 ||
    typeof row.retry_after !== "number" ||
    !Number.isInteger(row.retry_after) ||
    row.retry_after < 0
  ) {
    return null;
  }
  return {
    allowed: row.allowed,
    remaining: row.remaining,
    retry_after: row.retry_after,
  };
}

export function sharedCallerKey(
  request: Request,
  { tenantId, route }: { tenantId: string; route: string },
) {
  const scope = `tenant:${encodeURIComponent(tenantId)}:route:${encodeURIComponent(route)}`;
  return callerKey(request, scope);
}

export async function sharedRateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
  {
    client,
    now = () => new Date(),
  }: {
    client: RateLimitRpcClient;
    now?: () => Date;
  },
): Promise<SharedRateLimitResult> {
  const windowSeconds = Math.ceil(windowMs / 1000);
  if (!key.trim() || !Number.isInteger(limit) || limit <= 0 || windowSeconds <= 0) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, windowSeconds),
      store: "error",
      reason: "RATE_LIMIT_STORE_UNAVAILABLE",
    };
  }

  try {
    const { data, error } = await client.rpc("consume_rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
      p_now: now().toISOString(),
    });
    const row = error ? null : rpcRow(data);
    if (!row) throw new Error("RATE_LIMIT_RPC_ENVELOPE_INVALID");
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      retryAfter: row.retry_after,
      store: "shared",
      reason: null,
    };
  } catch {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, windowSeconds),
      store: "error",
      reason: "RATE_LIMIT_STORE_UNAVAILABLE",
    };
  }
}
