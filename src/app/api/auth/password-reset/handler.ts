import { authMode } from "@/lib/auth/mode";
import { writeAuthAuditEvent } from "@/lib/auth/recovery-audit";
import {
  AUTH_REQUEST_ACCEPTED,
  authRequestRateLimitKeys,
  recoveryCallbackUrl,
  recoveryRequest,
} from "@/lib/auth/recovery";
import { callerKey } from "@/lib/rate-limit";
import { sharedRateLimit } from "@/lib/shared-rate-limit";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const LIMIT = { limit: 3, windowMs: 15 * 60_000 };
const CALLER_LIMIT = { limit: 10, windowMs: 15 * 60_000 };

type PasswordResetRequestDependencies = {
  enabled(): boolean;
  parse(request: Request): Promise<unknown>;
  throttle(request: Request, email: string | null): Promise<{ allowed: boolean; retryAfter: number }>;
  callback(next: string): string;
  send(email: string, redirectTo: string): Promise<boolean>;
  audit(request: Request): Promise<void>;
};

function unavailable() {
  return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
}

function throttled(retryAfter: number) {
  return Response.json(AUTH_REQUEST_ACCEPTED, {
    status: 429,
    headers: { ...NO_STORE, "Retry-After": String(Math.max(1, retryAfter)) },
  });
}

export function createPasswordResetRequestHandler(dependencies: PasswordResetRequestDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return unavailable();

    let body: unknown;
    try {
      body = await dependencies.parse(request);
    } catch {
      body = null;
    }
    const { email, next } = recoveryRequest(body);
    const limit = await dependencies.throttle(request, email);
    if (!limit.allowed) return throttled(limit.retryAfter);

    try {
      // Supabase deliberately returns the same public shape for absent addresses. We retain that
      // contract by collapsing every provider result to the same acknowledgement.
      const accepted = email ? await dependencies.send(email, dependencies.callback(next)) : false;
      if (accepted) await dependencies.audit(request);
    } catch (cause) {
      console.error(
        "/api/auth/password-reset failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json(AUTH_REQUEST_ACCEPTED, { status: 503, headers: NO_STORE });
    }
    return Response.json(AUTH_REQUEST_ACCEPTED, { status: 202, headers: NO_STORE });
  };
}

export const POST = createPasswordResetRequestHandler({
  enabled: () => authMode() === "supabase",
  parse: (request) => request.json(),
  throttle: async (request, email) => {
    const service = createSupabaseServiceClient();
    const caller = callerKey(request, "auth-recovery");
    const keys = authRequestRateLimitKeys("password-reset", caller, email);
    const consume = (key: string, limit: typeof LIMIT) => sharedRateLimit(key, limit, {
      client: { rpc: async (name, arguments_) => {
        const { data, error } = await service.rpc(name, arguments_);
        return { data, error };
      } },
    });
    const callerResult = await consume(keys.caller, CALLER_LIMIT);
    if (!callerResult.allowed) return callerResult;
    return consume(keys.email, LIMIT);
  },
  callback: (next) => recoveryCallbackUrl(process.env.APP_BASE_URL ?? "", "/auth/recovery", next),
  send: async (email, redirectTo) => {
    const client = await createSupabaseServerClient();
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
    return !error;
  },
  audit: (request) => writeAuthAuditEvent({
    action: "auth.password_reset.requested",
    actorId: null,
    tenantId: null,
    actorIp: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("x-real-ip") || null,
    payload: { flow: "password_reset" },
  }),
});
