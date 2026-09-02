import { authMode } from "@/lib/auth/mode";
import { ACCOUNT_SECURITY_NO_STORE, accountSecuritySessions, type AccountSecurityActor } from "@/lib/auth/account-security";
import { accountSecurityLive } from "@/lib/env-contract";

import { loadAccountSecurityContext, throttleAccountSecurity, throttled } from "../shared";

type Dependencies = {
  enabled(): boolean;
  context(): Promise<{ actor: AccountSecurityActor; list(): Promise<{ sessions: unknown; auditId: number }> } | null>;
  throttle(request: Request, actor: AccountSecurityActor): Promise<{ allowed: boolean; retryAfter: number }>;
};

export function createAccountSecuritySessionsHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: ACCOUNT_SECURITY_NO_STORE });
    const context = await dependencies.context();
    if (!context) return Response.json({ error: "Authentication required." }, { status: 401, headers: ACCOUNT_SECURITY_NO_STORE });
    const limit = await dependencies.throttle(request, context.actor);
    if (!limit.allowed) return throttled(limit.retryAfter);
    try {
      const result = await context.list();
      const sessions = accountSecuritySessions(result.sessions);
      if (!sessions) throw new Error("ACCOUNT_SECURITY_SESSION_SHAPE_INVALID");
      return Response.json({ sessions, audit: { id: result.auditId, action: "auth.sessions.viewed" } }, { headers: ACCOUNT_SECURITY_NO_STORE });
    } catch (cause) {
      console.error(
        "/api/account/security/sessions failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Sessions could not be loaded." }, { status: 503, headers: ACCOUNT_SECURITY_NO_STORE });
    }
  };
}

export const GET = createAccountSecuritySessionsHandler({
  enabled: () => authMode() === "supabase" && accountSecurityLive(),
  context: async () => {
    const context = await loadAccountSecurityContext();
    if (!context) return null;
    return {
      actor: context.actor,
      list: async () => {
        const { data, error } = await context.client.rpc("list_account_security_sessions", {
          p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId,
        });
        if (error) throw new Error("ACCOUNT_SECURITY_SESSION_LIST_FAILED");
        const audit = await context.client.rpc("record_account_security_sessions_viewed", {
          p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId,
        });
        const auditRow = Array.isArray(audit.data) ? audit.data[0] : audit.data;
        if (audit.error || !auditRow || typeof auditRow !== "object" || !Number.isSafeInteger((auditRow as { audit_id?: unknown }).audit_id)) throw new Error("ACCOUNT_SECURITY_SESSION_AUDIT_FAILED");
        return { sessions: data, auditId: (auditRow as { audit_id: number }).audit_id };
      },
    };
  },
  throttle: (request, actor) => throttleAccountSecurity(request, actor, "sessions-list"),
});
