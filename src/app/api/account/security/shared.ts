import { hasImpersonationMarker, parseAppClaims } from "@/lib/auth/claims";
import {
  ACCOUNT_SECURITY_CALLER_LIMIT,
  ACCOUNT_SECURITY_LIMIT,
  accountSecurityRateLimitKeys,
  type AccountSecurityActor,
  type AccountSecurityOperation,
} from "@/lib/auth/account-security";
import { callerKey } from "@/lib/rate-limit";
import { sharedRateLimit } from "@/lib/shared-rate-limit";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

/** Account security is deliberately unavailable to a view-as session, even though it is an account rather than a tenant mutation. */
export async function loadAccountSecurityContext() {
  const client = await createSupabaseServerClient();
  const [{ data: userData, error: userError }, { data: claimsData, error: claimsError }] = await Promise.all([
    client.auth.getUser(),
    client.auth.getClaims(),
  ]);
  if (userError || claimsError || !userData.user?.id || !userData.user.email || !claimsData?.claims) return null;
  const claims = parseAppClaims(claimsData.claims);
  if (claims.userId !== userData.user.id || hasImpersonationMarker(claims)) return null;
  return { client, actor: { userId: userData.user.id, tenantId: claims.tenantId, email: userData.user.email } satisfies AccountSecurityActor };
}

export async function throttleAccountSecurity(
  request: Request,
  actor: AccountSecurityActor,
  operation: AccountSecurityOperation,
) {
  const service = createSupabaseServiceClient();
  const keys = accountSecurityRateLimitKeys(operation, callerKey(request, "auth-account-security"), actor.userId);
  const consume = (key: string, limit: typeof ACCOUNT_SECURITY_LIMIT) => sharedRateLimit(key, limit, {
    client: { rpc: async (name, arguments_) => {
      const { data, error } = await service.rpc(name, arguments_);
      return { data, error };
    } },
  });
  const caller = await consume(keys.caller, ACCOUNT_SECURITY_CALLER_LIMIT);
  return caller.allowed ? consume(keys.account, ACCOUNT_SECURITY_LIMIT) : caller;
}

export function throttled(retryAfter: number) {
  return Response.json({ error: "Too many account-security requests." }, {
    status: 429,
    headers: { "Cache-Control": "no-store", "Retry-After": String(Math.max(1, retryAfter)) },
  });
}
