import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { tenantMembershipLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RevokeTenantMemberDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  revoke(input: { tenantId: string; actorId: string; membershipId: string }): Promise<{ membershipId: string; userId: string; auditId: string }>;
  revokeSessions(userId: string): Promise<void>;
};

export function createRevokeTenantMemberHandler(dependencies: RevokeTenantMemberDependencies) {
  return async (_request: Request, context: { params: Promise<{ membershipId: string }> }) => {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
    if (hasImpersonationMarker(actor) || actor.role !== "coach") return Response.json({ error: "Only the workspace coach can remove teammates." }, { status: 403, headers: NO_STORE });
    const { membershipId } = await context.params;
    if (!UUID.test(membershipId)) return Response.json({ error: "Invalid teammate membership." }, { status: 400, headers: NO_STORE });
    try {
      const membership = await dependencies.revoke({ tenantId: actor.tenantId, actorId: actor.userId, membershipId });
      await dependencies.revokeSessions(membership.userId);
      return Response.json({ membership }, { headers: NO_STORE });
    } catch {
      return Response.json({ error: "The teammate could not be removed." }, { status: 409, headers: NO_STORE });
    }
  };
}

export const DELETE = createRevokeTenantMemberHandler({
  enabled: tenantMembershipLive,
  session: loadRouteActor,
  revoke: async (input) => {
    const { data, error } = await createSupabaseServiceClient().rpc("revoke_tenant_membership", {
      p_expected_tenant: input.tenantId, p_actor_id: input.actorId, p_membership_id: input.membershipId,
    });
    const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
    if (error || !row || typeof row.membership_id !== "string" || typeof row.user_id !== "string") throw new Error("TENANT_MEMBERSHIP_REVOKE_FAILED");
    return { membershipId: row.membership_id, userId: row.user_id, auditId: String(row.audit_id) };
  },
  revokeSessions: async (userId) => {
    const { error } = await createSupabaseServiceClient().auth.admin.signOut(userId, "global");
    if (error) throw new Error("TENANT_MEMBERSHIP_SESSION_REVOCATION_FAILED");
  },
});
