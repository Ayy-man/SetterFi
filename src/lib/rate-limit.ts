/**
 * A fixed-window request limiter for the demo agent routes.
 *
 * Deliberately in-memory: the demo has no Redis and no database, so the counter
 * lives per serverless instance and a spread-out attacker gets one window per
 * instance they land on. That is weaker than a shared store and is the reason
 * this file exists as its own module — the real build swaps `hits` for Redis or
 * Postgres without touching either route. What it does buy today is a hard stop
 * on a single client hammering `/api/agent` in a loop, which is the actual
 * exposure while the routes are unauthenticated.
 */

type Window = {
  count: number;
  resetAt: number;
};

const hits = new Map<string, Window>();

/** Drop expired windows so a long-lived instance doesn't grow a key per visitor. */
function evictExpired(now: number) {
  for (const [key, window] of hits) {
    if (window.resetAt <= now) hits.delete(key);
  }
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets, for the Retry-After header. */
  retryAfter: number;
};

export function rateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
  now = Date.now(),
): RateLimitResult {
  evictExpired(now);

  const existing = hits.get(key);
  if (!existing || existing.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }

  existing.count += 1;
  const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

  if (existing.count > limit) {
    return { allowed: false, remaining: 0, retryAfter };
  }

  return { allowed: true, remaining: limit - existing.count, retryAfter };
}

/**
 * Best-effort caller identity. Vercel sets `x-forwarded-for`; everything else
 * falls back to a shared bucket, which throttles anonymous traffic as a group
 * rather than failing open.
 */
export function callerKey(request: Request, scope: string) {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "anonymous";
  return `${scope}:${ip}`;
}

/** Test seam — the module-level map would otherwise leak between test cases. */
export function resetRateLimits() {
  hits.clear();
}
