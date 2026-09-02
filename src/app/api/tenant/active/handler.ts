import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { tenantMembershipLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ActiveTenantWorkspace = {
  id: string;
  name: string;
  active: boolean;
};

export type ActiveTenantDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  list(input: { actorId: string; claimTenantId: string }): Promise<ActiveTenantWorkspace[]>;
  select(input: { actorId: string; claimTenantId: string; tenantId: string }): Promise<{
    tenantId: string;
    auditId: string;
  }>;
};

function reject(actor: RouteActor | null) {
  if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
  if (hasImpersonationMarker(actor)) return Response.json({ error: "Impersonated sessions cannot switch workspaces." }, { status: 403, headers: NO_STORE });
  if (actor.role !== "coach" && actor.role !== "coach_member") {
    return Response.json({ error: "An active workspace membership is required." }, { status: 403, headers: NO_STORE });
  }
  return null;
}

function requestedTenant(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && typeof body.tenantId === "string" && UUID.test(body.tenantId)
    ? body.tenantId
    : null;
}

export function createActiveTenantHandlers(dependencies: ActiveTenantDependencies) {
  return {
    GET: async () => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const denied = reject(actor);
      if (denied || !actor) return denied!;
      try {
        const workspaces = await dependencies.list({ actorId: actor.userId, claimTenantId: actor.tenantId });
        const active = workspaces.find((workspace) => workspace.active);
        if (!active) throw new Error("ACTIVE_TENANT_UNAVAILABLE");
        return Response.json({ workspaces, activeTenantId: active.id }, { headers: NO_STORE });
      } catch {
        return Response.json({ error: "Workspaces could not be loaded." }, { status: 409, headers: NO_STORE });
      }
    },
    POST: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const denied = reject(actor);
      if (denied || !actor) return denied!;
      const tenantId = requestedTenant(await request.json().catch(() => null));
      if (!tenantId) return Response.json({ error: "A valid workspace is required." }, { status: 400, headers: NO_STORE });
      try {
        const selection = await dependencies.select({ actorId: actor.userId, claimTenantId: actor.tenantId, tenantId });
        return Response.json({
          activeTenantId: selection.tenantId,
          audit: { id: selection.auditId, actionKey: "tenant.membership.switched" },
        }, { headers: NO_STORE });
      } catch {
        // The service-only RPC intentionally gives the same response for an unknown workspace,
        // a revoked membership, and a workspace that belongs to someone else.
        return Response.json({ error: "The workspace switch is unavailable." }, { status: 409, headers: NO_STORE });
      }
    },
  };
}

function row(data: unknown, operation: string): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : undefined;
  if (!value || typeof value !== "object") throw new Error(`ACTIVE_TENANT_${operation}_FAILED`);
  return value as Record<string, unknown>;
}

const handlers = createActiveTenantHandlers({
  enabled: tenantMembershipLive,
  session: loadRouteActor,
  list: async (input) => {
    const { data, error } = await createSupabaseServiceClient().rpc("list_active_tenants", {
      p_actor_id: input.actorId,
      p_claim_tenant_id: input.claimTenantId,
    });
    if (error || !Array.isArray(data)) throw new Error("ACTIVE_TENANT_LIST_FAILED");
    return data.map((value) => {
      const workspace = value as Record<string, unknown>;
      if (typeof workspace.tenant_id !== "string" || typeof workspace.tenant_name !== "string" || typeof workspace.active !== "boolean") {
        throw new Error("ACTIVE_TENANT_LIST_SHAPE_INVALID");
      }
      return { id: workspace.tenant_id, name: workspace.tenant_name, active: workspace.active };
    });
  },
  select: async (input) => {
    const { data, error } = await createSupabaseServiceClient().rpc("select_active_tenant", {
      p_actor_id: input.actorId,
      p_claim_tenant_id: input.claimTenantId,
      p_tenant_id: input.tenantId,
    });
    const selection = row(data, "SELECT");
    if (error || typeof selection.tenant_id !== "string" || (typeof selection.audit_id !== "number" && typeof selection.audit_id !== "string")) {
      throw new Error("ACTIVE_TENANT_SELECT_FAILED");
    }
    return { tenantId: selection.tenant_id, auditId: String(selection.audit_id) };
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;
