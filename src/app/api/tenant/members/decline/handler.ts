import { loadAlertActor, type AlertActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { tenantMembershipInvitationTokenHash } from "@/lib/auth/tenant-membership";
import { tenantMembershipLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

export type DeclineTenantMemberDependencies = {
  enabled(): boolean;
  session(): Promise<AlertActor | null>;
  decline(input: { actorId: string; tokenHash: string }): Promise<{ invitationId: string; tenantId: string; auditId: string }>;
};

export function createDeclineTenantMemberHandler(dependencies: DeclineTenantMemberDependencies) {
  return async (request: Request) => {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Sign in with the invited account first." }, { status: 401, headers: NO_STORE });
    if (hasImpersonationMarker(actor)) return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Object.keys(body).length !== 1 || typeof body.token !== "string" || !body.token.trim()) {
      return Response.json({ error: "An invitation token is required." }, { status: 400, headers: NO_STORE });
    }
    try {
      return Response.json({ invitation: await dependencies.decline({ actorId: actor.userId, tokenHash: tenantMembershipInvitationTokenHash(body.token) }) }, { headers: NO_STORE });
    } catch {
      return Response.json({ error: "This teammate invitation cannot be declined." }, { status: 409, headers: NO_STORE });
    }
  };
}

export const POST = createDeclineTenantMemberHandler({
  enabled: tenantMembershipLive,
  session: loadAlertActor,
  decline: async (input) => {
    const { data, error } = await createSupabaseServiceClient().rpc("decline_tenant_member_invitation", {
      p_token_hash: input.tokenHash, p_actor_id: input.actorId,
    });
    const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
    if (error || !row || typeof row.invitation_id !== "string") throw new Error("TENANT_MEMBERSHIP_DECLINE_FAILED");
    return { invitationId: row.invitation_id, tenantId: String(row.tenant_id), auditId: String(row.audit_id) };
  },
});
