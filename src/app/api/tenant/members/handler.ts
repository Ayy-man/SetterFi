import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import {
  issueTenantMembershipInvitation,
  TenantMembershipInvitationError,
} from "@/lib/auth/tenant-membership";
import { tenantMembershipLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

type Invitation = {
  id: string;
  tenantId: string;
  email: string;
  role: "coach_member";
  expiresAt: string;
  audit: { id: string; actionKey: "tenant.membership.invited" };
};

export type TenantMemberDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  save(input: {
    tenantId: string; actorId: string; email: string; role: "coach_member"; tokenHash: string; expiresAt: string;
  }): Promise<Invitation>;
  issue(email: string): ReturnType<typeof issueTenantMembershipInvitation>;
};

function invitationEmail(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.email !== "string") return null;
  return body.email;
}

function refuse(actor: RouteActor | null) {
  if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
  if (hasImpersonationMarker(actor)) return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
  if (actor.role !== "coach") return Response.json({ error: "Only the workspace coach can invite teammates." }, { status: 403, headers: NO_STORE });
  return null;
}

export function createTenantMemberHandlers(dependencies: TenantMemberDependencies) {
  return {
    POST: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const rejected = refuse(actor);
      if (rejected || !actor) return rejected!;
      const email = invitationEmail(await request.json().catch(() => null));
      if (email === null) return Response.json({ error: "An invitation email is required." }, { status: 400, headers: NO_STORE });

      try {
        const issued = dependencies.issue(email);
        const invitation = await dependencies.save({
          tenantId: actor.tenantId,
          actorId: actor.userId,
          email: issued.email,
          role: issued.role,
          tokenHash: issued.tokenHash,
          expiresAt: issued.expiresAt,
        });
        // Delivery is intentionally not coupled to the authorization write. The caller receives
        // the opaque secret once, and a future mailer can send that exact link without storing it.
        return Response.json({ invitation, invitationToken: issued.token }, { status: 201, headers: NO_STORE });
      } catch (error) {
        if (error instanceof TenantMembershipInvitationError) {
          return Response.json({ error: "Enter a valid teammate email." }, { status: 400, headers: NO_STORE });
        }
        return Response.json({ error: "The teammate invitation could not be recorded." }, { status: 409, headers: NO_STORE });
      }
    },
  };
}

const handlers = createTenantMemberHandlers({
  enabled: tenantMembershipLive,
  session: loadRouteActor,
  issue: issueTenantMembershipInvitation,
  save: async (input) => {
    const { data, error } = await createSupabaseServiceClient().rpc("create_tenant_member_invitation", {
      p_expected_tenant: input.tenantId,
      p_actor_id: input.actorId,
      p_invitee_email: input.email,
      p_role: input.role,
      p_token_hash: input.tokenHash,
      p_expires_at: input.expiresAt,
    });
    const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
    if (error || !row || typeof row.invitation_id !== "string" || typeof row.audit_id !== "number") {
      throw new Error("TENANT_MEMBERSHIP_INVITATION_WRITE_FAILED");
    }
    return {
      id: row.invitation_id,
      tenantId: String(row.tenant_id),
      email: String(row.invitee_email),
      role: "coach_member",
      expiresAt: String(row.expires_at),
      audit: { id: String(row.audit_id), actionKey: "tenant.membership.invited" },
    };
  },
});

export const POST = handlers.POST;
