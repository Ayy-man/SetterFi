import {
  hasImpersonationMarker,
  parseAppClaims,
  type AppClaims,
  type UserRole,
} from "@/lib/auth/claims";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export type PlatformActor = { userId: string; role: UserRole };

export type RouteActor = AppClaims & { userId: string; tenantId: string };

/**
 * A signed-in actor with its hook-stamped capability claims intact.
 *
 * `loadPlatformActor` projects a session down to `{ userId, role }`, which is the exact shape that
 * cannot express the affiliate capability: the `affiliates` row is what grants portal access,
 * never `role = 'affiliate'`, and it reaches the app as the `affiliate_access` claim rather than
 * as a role value. A route whose
 * authority is a capability row loads this instead, so it can apply the same
 * `canAccessWorkspace` predicate the page applies and the two cannot disagree.
 */
export type CapabilityActor = AppClaims & { userId: string };

export type AlertActor = CapabilityActor;

export type ActiveImpersonationSession = {
  id: string;
  tenantId: string;
};

export type ImpersonationLifecycleActor = PlatformActor & {
  claims: AppClaims;
  activeSession: ActiveImpersonationSession | null;
};

async function loadClaims(): Promise<AppClaims | null> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims) return null;
  return parseAppClaims(data.claims);
}

export async function resolveActiveImpersonationSession(
  actorId: string,
): Promise<ActiveImpersonationSession | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("impersonation_sessions")
    .select("id, tenant_id")
    .eq("actor_id", actorId)
    .is("ended_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("ACTIVE_IMPERSONATION_RESOLUTION_FAILED");
  return data ? { id: data.id, tenantId: data.tenant_id } : null;
}

async function loadWriteClaims(): Promise<AppClaims | null> {
  const claims = await loadClaims();
  if (!claims?.userId || hasImpersonationMarker(claims)) return null;
  return await resolveActiveImpersonationSession(claims.userId) ? null : claims;
}

export async function loadPlatformActor(): Promise<PlatformActor | null> {
  const claims = await loadWriteClaims();
  if (!claims?.userId || !claims.role) return null;
  return { userId: claims.userId, role: claims.role };
}

export async function loadRouteActor(): Promise<RouteActor | null> {
  const claims = await loadWriteClaims();
  if (!claims?.userId || !claims.tenantId || !claims.role) return null;
  return { ...claims, userId: claims.userId, tenantId: claims.tenantId };
}

export async function loadCapabilityActor(): Promise<CapabilityActor | null> {
  const claims = await loadWriteClaims();
  if (!claims?.userId || !claims.role) return null;
  return { ...claims, userId: claims.userId };
}

export async function loadAlertActor(): Promise<AlertActor | null> {
  return loadCapabilityActor();
}

/** Resolves lifecycle authority from the signed user and the live session row, not stale claims. */
export async function loadImpersonationLifecycleActor(): Promise<ImpersonationLifecycleActor | null> {
  const claims = await loadClaims();
  if (!claims?.userId || !claims.role) return null;
  return {
    userId: claims.userId,
    role: claims.role,
    claims,
    activeSession: await resolveActiveImpersonationSession(claims.userId),
  };
}

export async function refreshAuthClaims(): Promise<AppClaims | null> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.refreshSession();
  if (error || !data.session?.access_token) return null;
  const claims = await client.auth.getClaims(data.session.access_token);
  if (claims.error || !claims.data?.claims) return null;
  return parseAppClaims(claims.data.claims);
}
