/**
 * Expiring, reason-carrying read contexts for platform view-as sessions.
 *
 * The database blocks writes while the impersonation claim exists. This module mirrors that
 * boundary by exposing session lifecycle RPCs and read metadata only; on-behalf-of mutations are
 * separate admin actions and must never be smuggled through a tenant read context.
 */

import { parseAppClaims, type UserRole } from "@/lib/auth/claims";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const IMPERSONATION_ROLES = ["owner", "admin", "success"] as const;
export type ImpersonationRole = (typeof IMPERSONATION_ROLES)[number];

export type ImpersonationSession = {
  id: string;
  actorId: string;
  tenantId: string;
  reason: string;
  startedAt: string;
  endedAt: string | null;
  expiresAt: string;
};

export type ImpersonatedReadContext = {
  kind: "impersonated_read";
  actorId: string;
  tenantId: string;
  sessionId: string;
  reason: string;
  expiresAt: string;
};

type ImpersonationDependencies = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  loadSession: (sessionId: string) => Promise<ImpersonationSession>;
};

async function liveDependencies(): Promise<ImpersonationDependencies> {
  const client = createSupabaseServiceClient();
  return {
    rpc: async (name, args) => {
      const { data, error } = await client.rpc(name, args);
      if (error) throw new Error(`${name.toUpperCase()}_FAILED:${error.message}`);
      return data;
    },
    loadSession: async (sessionId) => {
      const { data, error } = await client
        .from("impersonation_sessions")
        .select("id, actor_id, tenant_id, reason, started_at, ended_at, expires_at")
        .eq("id", sessionId)
        .single();
      if (error || !data) throw new Error("IMPERSONATION_SESSION_READBACK_FAILED");
      return {
        id: data.id,
        actorId: data.actor_id,
        tenantId: data.tenant_id,
        reason: data.reason,
        startedAt: data.started_at,
        endedAt: data.ended_at,
        expiresAt: data.expires_at,
      };
    },
  };
}

function required(value: string, error: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(error);
  return normalized;
}

function requireRole(role: UserRole): asserts role is ImpersonationRole {
  if (!IMPERSONATION_ROLES.includes(role as ImpersonationRole)) {
    throw new Error(`IMPERSONATION_ROLE_FORBIDDEN:${role}`);
  }
}

function assertExactDuration(session: ImpersonationSession) {
  const started = Date.parse(session.startedAt);
  const expires = Date.parse(session.expiresAt);
  if (!Number.isFinite(started) || !Number.isFinite(expires) || expires - started !== 30 * 60_000) {
    throw new Error("IMPERSONATION_DURATION_INVALID");
  }
}

function scalarId(value: unknown, error: string) {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value)) {
    throw new Error(error);
  }
  return String(value);
}

export async function startImpersonation(
  actor: { id: string; role: UserRole },
  tenantId: string,
  reason: string,
  now = new Date(),
  dependencies?: ImpersonationDependencies,
): Promise<ImpersonationSession> {
  requireRole(actor.role);
  const actorId = required(actor.id, "IMPERSONATION_ACTOR_REQUIRED");
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  const normalizedReason = required(reason, "IMPERSONATION_REASON_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  const sessionId = scalarId(
    await deps.rpc("start_impersonation", {
      p_expected_tenant: expectedTenant,
      p_actor_id: actorId,
      p_reason: normalizedReason,
      p_now: now.toISOString(),
    }),
    "IMPERSONATION_SESSION_ID_MISSING",
  );
  const session = await deps.loadSession(sessionId);
  assertExactDuration(session);
  if (
    session.id !== sessionId ||
    session.actorId !== actorId ||
    session.tenantId !== expectedTenant ||
    session.reason !== normalizedReason ||
    session.endedAt !== null ||
    Date.parse(session.startedAt) !== now.getTime()
  ) {
    throw new Error("IMPERSONATION_START_READBACK_INVALID");
  }
  return session;
}

export async function endImpersonation(
  actorId: string,
  sessionId: string,
  now = new Date(),
  dependencies?: ImpersonationDependencies,
): Promise<{ session: ImpersonationSession; auditId: string }> {
  const expectedActor = required(actorId, "IMPERSONATION_ACTOR_REQUIRED");
  const expectedSession = required(sessionId, "IMPERSONATION_SESSION_ID_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  const auditId = scalarId(
    await deps.rpc("end_impersonation", {
      p_session_id: expectedSession,
      p_actor_id: expectedActor,
      p_now: now.toISOString(),
    }),
    "IMPERSONATION_END_AUDIT_ID_MISSING",
  );
  const session = await deps.loadSession(expectedSession);
  if (
    session.id !== expectedSession ||
    session.actorId !== expectedActor ||
    session.endedAt === null ||
    Date.parse(session.endedAt) !== now.getTime()
  ) {
    throw new Error("IMPERSONATION_END_READBACK_INVALID");
  }
  return { session, auditId };
}

export function impersonatedReadContext(
  claims: unknown,
  session: ImpersonationSession,
  now = new Date(),
): ImpersonatedReadContext {
  const parsed = parseAppClaims(claims);
  if (!parsed.role) throw new Error("IMPERSONATION_ROLE_MISSING");
  requireRole(parsed.role);
  if (typeof claims !== "object" || claims === null) {
    throw new Error("IMPERSONATION_CLAIMS_INVALID");
  }
  const raw = claims as { sub?: unknown; app_metadata?: unknown };
  const metadata =
    typeof raw.app_metadata === "object" && raw.app_metadata !== null
      ? raw.app_metadata as Record<string, unknown>
      : {};
  const actorId = typeof raw.sub === "string" ? raw.sub : null;
  const sessionId =
    typeof metadata.impersonation_session_id === "string"
      ? metadata.impersonation_session_id
      : null;
  assertExactDuration(session);
  if (
    !actorId ||
    actorId !== session.actorId ||
    !parsed.impersonatingTenant ||
    parsed.impersonatingTenant !== session.tenantId ||
    !sessionId ||
    sessionId !== session.id
  ) {
    throw new Error("IMPERSONATION_CLAIM_SESSION_MISMATCH");
  }
  if (session.endedAt !== null) throw new Error("IMPERSONATION_SESSION_ENDED");
  if (Date.parse(session.expiresAt) <= now.getTime()) throw new Error("IMPERSONATION_SESSION_EXPIRED");
  return {
    kind: "impersonated_read",
    actorId,
    tenantId: session.tenantId,
    sessionId: session.id,
    reason: session.reason,
    expiresAt: session.expiresAt,
  };
}

export function tagImpersonatedRead<T extends Record<string, unknown>>(
  context: ImpersonatedReadContext,
  metadata: T,
): T & { impersonationSessionId: string } {
  return { ...metadata, impersonationSessionId: context.sessionId };
}
