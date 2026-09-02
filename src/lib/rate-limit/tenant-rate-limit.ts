import { callerKey, type RateLimitResult } from "@/lib/rate-limit";

type RpcError = { message?: string };

export type TenantRateLimitRpcClient = {
  rpc(
    name: "consume_tenant_rate_limit",
    arguments_: {
      p_tenant_id: string;
      p_route_key: string;
      p_caller_key: string;
      p_limit: number;
      p_window_seconds: number;
      p_now: string;
    },
  ): Promise<{ data: unknown; error: RpcError | null }>;
};

export type TenantRateLimitResult = RateLimitResult & (
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
    typeof row.allowed !== "boolean"
    || typeof row.remaining !== "number"
    || !Number.isInteger(row.remaining)
    || row.remaining < 0
    || typeof row.retry_after !== "number"
    || !Number.isInteger(row.retry_after)
    || row.retry_after < 0
  ) {
    return null;
  }
  return {
    allowed: row.allowed,
    remaining: row.remaining,
    retry_after: row.retry_after,
  };
}

function unavailable(windowSeconds: number): TenantRateLimitResult {
  return {
    allowed: false,
    remaining: 0,
    retryAfter: Math.max(1, windowSeconds),
    store: "error",
    reason: "RATE_LIMIT_STORE_UNAVAILABLE",
  };
}

/**
 * Uses the existing public-request identity logic while keeping the database's caller column
 * separate from the tenant and route columns that form the limiter's primary key.
 */
export function tenantRateLimitCallerKey(request: Request) {
  return callerKey(request, "public-request");
}

/**
 * Consumes a tenant-scoped fixed window through the database. There is deliberately no local
 * fallback: separate serverless instances must observe the same window, and an unavailable store
 * must refuse the public mutation rather than permit unbounded submissions.
 */
export async function consumeTenantRateLimit(
  input: {
    tenantId: string;
    routeKey: string;
    callerKey: string;
    limit: number;
    windowMs: number;
  },
  {
    client,
    now = () => new Date(),
  }: {
    client: TenantRateLimitRpcClient;
    now?: () => Date;
  },
): Promise<TenantRateLimitResult> {
  const windowSeconds = Math.ceil(input.windowMs / 1_000);
  if (
    !input.tenantId.trim()
    || !input.routeKey.trim()
    || !input.callerKey.trim()
    || !Number.isInteger(input.limit)
    || input.limit <= 0
    || windowSeconds <= 0
  ) {
    return unavailable(windowSeconds);
  }

  try {
    const { data, error } = await client.rpc("consume_tenant_rate_limit", {
      p_tenant_id: input.tenantId,
      p_route_key: input.routeKey,
      p_caller_key: input.callerKey,
      p_limit: input.limit,
      p_window_seconds: windowSeconds,
      p_now: now().toISOString(),
    });
    const row = error ? null : rpcRow(data);
    if (!row) throw new Error("TENANT_RATE_LIMIT_RPC_ENVELOPE_INVALID");
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      retryAfter: row.retry_after,
      store: "shared",
      reason: null,
    };
  } catch {
    return unavailable(windowSeconds);
  }
}
