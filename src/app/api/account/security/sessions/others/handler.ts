import { authMode } from "@/lib/auth/mode";
import { ACCOUNT_SECURITY_NO_STORE, sameOrigin, sessionRevocationReason, type AccountSecurityActor } from "@/lib/auth/account-security";
import { accountSecurityLive } from "@/lib/env-contract";

import { loadAccountSecurityContext, throttleAccountSecurity, throttled } from "../../shared";

type Dependencies = {
  enabled(): boolean;
  context(): Promise<{ actor: AccountSecurityActor; revokeOthers(reason: string): Promise<{ revokedCount: number; auditId: number }> } | null>;
  throttle(request: Request, actor: AccountSecurityActor): Promise<{ allowed: boolean; retryAfter: number }>;
};

export function createAccountSecurityOthersDeleteHandler(dependencies: Dependencies) {
  return async function DELETE(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: ACCOUNT_SECURITY_NO_STORE });
    if (!sameOrigin(request)) return Response.json({ error: "Request origin was refused." }, { status: 403, headers: ACCOUNT_SECURITY_NO_STORE });
    const security = await dependencies.context();
    if (!security) return Response.json({ error: "Authentication required." }, { status: 401, headers: ACCOUNT_SECURITY_NO_STORE });
    const limit = await dependencies.throttle(request, security.actor);
    if (!limit.allowed) return throttled(limit.retryAfter);
    let reason: string | null = null;
    try { reason = sessionRevocationReason((await request.json() as Record<string, unknown>).reason); } catch { reason = null; }
    if (!reason) return Response.json({ error: "An audit reason is required." }, { status: 400, headers: ACCOUNT_SECURITY_NO_STORE });
    try {
      const result = await security.revokeOthers(reason);
      return Response.json({ revokedCount: result.revokedCount, audit: { id: result.auditId, action: "auth.sessions.others_revoked" } }, { headers: ACCOUNT_SECURITY_NO_STORE });
    } catch {
      return Response.json({ error: "Other sessions could not be revoked." }, { status: 409, headers: ACCOUNT_SECURITY_NO_STORE });
    }
  };
}

export const DELETE = createAccountSecurityOthersDeleteHandler({
  enabled: () => authMode() === "supabase" && accountSecurityLive(),
  context: async () => {
    const context = await loadAccountSecurityContext();
    if (!context) return null;
    return { actor: context.actor, revokeOthers: async (reason) => {
      const { data, error } = await context.client.rpc("revoke_other_account_security_sessions", {
        p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId, p_reason: reason,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row || typeof row !== "object" || !Number.isSafeInteger((row as { audit_id?: unknown }).audit_id) || !Number.isSafeInteger((row as { revoked_count?: unknown }).revoked_count)) throw new Error("ACCOUNT_SECURITY_OTHERS_REVOKE_FAILED");
      return { auditId: (row as { audit_id: number }).audit_id, revokedCount: (row as { revoked_count: number }).revoked_count };
    } };
  },
  throttle: (request, actor) => throttleAccountSecurity(request, actor, "sessions-revoke-others"),
});
