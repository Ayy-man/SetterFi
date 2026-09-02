import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { tenantOwnershipLive } from "@/lib/env-contract";
import { parseTenantOwnershipRequest } from "@/lib/tenant/ownership";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

type OwnershipOffer = {
  id: string;
  tenantId: string;
  recipientUserId: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  auditId?: string;
};

export type TenantOwnershipDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  list(input: { tenantId: string; actorId: string }): Promise<OwnershipOffer[]>;
  offer(input: { tenantId: string; actorId: string; recipientMembershipId: string }): Promise<OwnershipOffer>;
  accept(input: { tenantId: string; actorId: string; offerId: string }): Promise<OwnershipOffer>;
  revoke(input: { tenantId: string; actorId: string; offerId: string }): Promise<OwnershipOffer>;
};

function reject(actor: RouteActor | null) {
  if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
  if (hasImpersonationMarker(actor)) return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
  if (actor.role !== "coach" && actor.role !== "coach_member") return Response.json({ error: "Workspace membership is required." }, { status: 403, headers: NO_STORE });
  return null;
}

function ownerRequired(actor: RouteActor) {
  return actor.role === "coach"
    ? null
    : Response.json({ error: "Only the current workspace owner can manage an ownership offer." }, { status: 403, headers: NO_STORE });
}

export function createTenantOwnershipHandlers(dependencies: TenantOwnershipDependencies) {
  return {
    GET: async () => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const denied = reject(actor);
      if (denied || !actor) return denied!;
      try {
        return Response.json({ offers: await dependencies.list({ tenantId: actor.tenantId, actorId: actor.userId }) }, { headers: NO_STORE });
      } catch {
        return Response.json({ error: "Ownership offers could not be loaded." }, { status: 409, headers: NO_STORE });
      }
    },
    POST: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const denied = reject(actor);
      if (denied || !actor) return denied!;
      const command = parseTenantOwnershipRequest(await request.json().catch(() => null));
      if (!command) return Response.json({ error: "Invalid ownership transfer request." }, { status: 400, headers: NO_STORE });
      if (command.action === "accept" && actor.role !== "coach_member") {
        return Response.json({ error: "Only the offered active teammate can accept ownership." }, { status: 403, headers: NO_STORE });
      }
      if (command.action !== "accept") {
        const ownerDenied = ownerRequired(actor);
        if (ownerDenied) return ownerDenied;
      }
      try {
        if (command.action === "offer") {
          return Response.json({ offer: await dependencies.offer({ tenantId: actor.tenantId, actorId: actor.userId, recipientMembershipId: command.recipientMembershipId }) }, { status: 201, headers: NO_STORE });
        }
        if (command.action === "accept") {
          return Response.json({ offer: await dependencies.accept({ tenantId: actor.tenantId, actorId: actor.userId, offerId: command.offerId }) }, { headers: NO_STORE });
        }
        return Response.json({ offer: await dependencies.revoke({ tenantId: actor.tenantId, actorId: actor.userId, offerId: command.offerId }) }, { headers: NO_STORE });
      } catch {
        // The service-only RPC is the authority boundary. In particular, it intentionally gives
        // the same response for an unknown offer and a cross-tenant offer.
        return Response.json({ error: "The ownership transfer is unavailable." }, { status: 409, headers: NO_STORE });
      }
    },
  };
}

function row(data: unknown, operation: string): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : undefined;
  if (!value || typeof value !== "object") throw new Error(`TENANT_OWNERSHIP_${operation}_FAILED`);
  return value as Record<string, unknown>;
}

function ownershipOffer(value: Record<string, unknown>, operation: string): OwnershipOffer {
  if (typeof value.transfer_id !== "string" || typeof value.tenant_id !== "string"
    || typeof value.recipient_user_id !== "string" || typeof value.status !== "string" || typeof value.expires_at !== "string") {
    throw new Error(`TENANT_OWNERSHIP_${operation}_SHAPE_INVALID`);
  }
  if (!["pending", "accepted", "revoked", "expired"].includes(value.status)) throw new Error(`TENANT_OWNERSHIP_${operation}_STATUS_INVALID`);
  return {
    id: value.transfer_id, tenantId: value.tenant_id, recipientUserId: value.recipient_user_id,
    status: value.status as OwnershipOffer["status"], expiresAt: value.expires_at,
    ...(typeof value.audit_id === "number" || typeof value.audit_id === "string" ? { auditId: String(value.audit_id) } : {}),
  };
}

const handlers = createTenantOwnershipHandlers({
  enabled: tenantOwnershipLive,
  session: loadRouteActor,
  list: async (input) => {
    const { data, error } = await createSupabaseServiceClient().rpc("list_tenant_ownership_transfers", {
      p_expected_tenant: input.tenantId, p_actor_id: input.actorId,
    });
    if (error || !Array.isArray(data)) throw new Error("TENANT_OWNERSHIP_LIST_FAILED");
    return data.map((item) => ownershipOffer(item as Record<string, unknown>, "LIST"));
  },
  offer: async (input) => {
    const { data, error } = await createSupabaseServiceClient().rpc("offer_tenant_ownership_transfer", {
      p_expected_tenant: input.tenantId, p_actor_id: input.actorId, p_recipient_membership_id: input.recipientMembershipId,
    });
    if (error) throw new Error("TENANT_OWNERSHIP_OFFER_FAILED");
    return ownershipOffer(row(data, "OFFER"), "OFFER");
  },
  accept: async (input) => {
    const { data, error } = await createSupabaseServiceClient().rpc("accept_tenant_ownership_transfer", {
      p_expected_tenant: input.tenantId, p_actor_id: input.actorId, p_transfer_id: input.offerId,
    });
    if (error) throw new Error("TENANT_OWNERSHIP_ACCEPT_FAILED");
    return ownershipOffer(row(data, "ACCEPT"), "ACCEPT");
  },
  revoke: async (input) => {
    const { data, error } = await createSupabaseServiceClient().rpc("revoke_tenant_ownership_transfer", {
      p_expected_tenant: input.tenantId, p_actor_id: input.actorId, p_transfer_id: input.offerId,
    });
    if (error) throw new Error("TENANT_OWNERSHIP_REVOKE_FAILED");
    return ownershipOffer(row(data, "REVOKE"), "REVOKE");
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;
