import { loadAlertActor, type AlertActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { tenantMembershipInvitationTokenHash } from "@/lib/auth/tenant-membership";
import { tenantMembershipLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

export type AcceptTenantMemberDependencies = {
  enabled(): boolean;
  session(): Promise<AlertActor | null>;
  accept(input: { actorId: string; tokenHash: string }): Promise<{ invitationId: string; tenantId: string; membershipId: string; auditId: string }>;
};

function token(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && typeof body.token === "string" && body.token.trim() ? body.token : null;
}

export function createAcceptTenantMemberHandler(dependencies: AcceptTenantMemberDependencies) {
  return async (request: Request) => {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Sign in with the invited account first." }, { status: 401, headers: NO_STORE });
    if (hasImpersonationMarker(actor)) return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
    const candidate = token(await request.json().catch(() => null));
    if (!candidate) return Response.json({ error: "An invitation token is required." }, { status: 400, headers: NO_STORE });
    try {
      const invitation = await dependencies.accept({ actorId: actor.userId, tokenHash: tenantMembershipInvitationTokenHash(candidate) });
      return Response.json({ invitation, sessionRefreshRequired: true }, { headers: NO_STORE });
    } catch {
      return Response.json({ error: "This teammate invitation cannot be accepted." }, { status: 409, headers: NO_STORE });
    }
  };
}

export const POST = createAcceptTenantMemberHandler({
  enabled: tenantMembershipLive,
  session: loadAlertActor,
  accept: async (input) => {
    const { data, error } = await createSupabaseServiceClient().rpc("accept_tenant_member_invitation", {
      p_token_hash: input.tokenHash, p_actor_id: input.actorId,
    });
    const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
    if (error || !row || typeof row.invitation_id !== "string" || typeof row.membership_id !== "string") {
      throw new Error("TENANT_MEMBERSHIP_ACCEPT_FAILED");
    }
    return { invitationId: row.invitation_id, tenantId: String(row.tenant_id), membershipId: row.membership_id, auditId: String(row.audit_id) };
  },
});
