import { authMode } from "@/lib/auth/mode";
import { ACCOUNT_SECURITY_NO_STORE, sameOrigin, sessionId, sessionRevocationReason, type AccountSecurityActor } from "@/lib/auth/account-security";
import { accountSecurityLive } from "@/lib/env-contract";

import { loadAccountSecurityContext, throttleAccountSecurity, throttled } from "../../shared";

type Dependencies = {
  enabled(): boolean;
  context(): Promise<{ actor: AccountSecurityActor; revoke(input: { sessionId: string; reason: string }): Promise<{ auditId: number; isCurrent?: boolean }>; signOutCurrent?(): Promise<void> } | null>;
  throttle(request: Request, actor: AccountSecurityActor): Promise<{ allowed: boolean; retryAfter: number }>;
};

export function createAccountSecuritySessionDeleteHandler(dependencies: Dependencies) {
  return async function DELETE(request: Request, context: { params: Promise<{ sessionId: string }> }) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: ACCOUNT_SECURITY_NO_STORE });
    if (!sameOrigin(request)) return Response.json({ error: "Request origin was refused." }, { status: 403, headers: ACCOUNT_SECURITY_NO_STORE });
    const security = await dependencies.context();
    if (!security) return Response.json({ error: "Authentication required." }, { status: 401, headers: ACCOUNT_SECURITY_NO_STORE });
    const limit = await dependencies.throttle(request, security.actor);
    if (!limit.allowed) return throttled(limit.retryAfter);
    let reason: string | null = null;
    try { reason = sessionRevocationReason((await request.json() as Record<string, unknown>).reason); } catch { reason = null; }
    const target = sessionId((await context.params).sessionId);
    if (!target || !reason) return Response.json({ error: "A session id and audit reason are required." }, { status: 400, headers: ACCOUNT_SECURITY_NO_STORE });
    try {
      const result = await security.revoke({ sessionId: target, reason });
      // Removing the Auth session ends it server-side. Clearing this browser's cookie as well
      // keeps a self-revocation from leaving a stale credential parked in the response client.
      if (result.isCurrent) await security.signOutCurrent?.();
      return Response.json({ revokedSessionId: target, audit: { id: result.auditId, action: "auth.session.revoked" } }, { headers: ACCOUNT_SECURITY_NO_STORE });
    } catch {
      return Response.json({ error: "The session could not be revoked." }, { status: 409, headers: ACCOUNT_SECURITY_NO_STORE });
    }
  };
}

export const DELETE = createAccountSecuritySessionDeleteHandler({
  enabled: () => authMode() === "supabase" && accountSecurityLive(),
  context: async () => {
    const context = await loadAccountSecurityContext();
    if (!context) return null;
    return { actor: context.actor, revoke: async ({ sessionId: target, reason }) => {
      const { data, error } = await context.client.rpc("revoke_account_security_session", {
        p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId,
        p_session_id: target, p_reason: reason,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row || typeof row !== "object" || !Number.isSafeInteger((row as { audit_id?: unknown }).audit_id)) throw new Error("ACCOUNT_SECURITY_REVOKE_FAILED");
      return { auditId: (row as { audit_id: number }).audit_id, isCurrent: (row as { is_current?: unknown }).is_current === true };
    }, signOutCurrent: async () => {
      await context.client.auth.signOut({ scope: "local" });
    } };
  },
  throttle: (request, actor) => throttleAccountSecurity(request, actor, "session-revoke"),
});
