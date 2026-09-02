/**
 * Session-derived support operations for coach and platform routes.
 *
 * Tenant, actor and role never enter through request data. The repository owns expected-tenant
 * RPC custody and persisted read-back; this layer owns the role and impersonation matrix.
 */

import { hasImpersonationMarker, parseAppClaims, type UserRole } from "@/lib/auth/claims";
import type {
  SupportBook,
  SupportRepository,
  SupportStatus,
} from "@/lib/repositories/support";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type SupportSession = {
  userId: string;
  role: UserRole;
  tenantId: string | null;
  impersonatingTenant: string | null;
  impersonationSessionId?: string | null;
};

export class SupportServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SupportServiceError";
  }
}

export async function loadSupportSession(): Promise<SupportSession | null> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims) return null;
  const claims = parseAppClaims(data.claims);
  if (!claims.userId || !claims.role) return null;
  return {
    userId: claims.userId,
    role: claims.role,
    tenantId: claims.tenantId,
    impersonatingTenant: claims.impersonatingTenant,
    impersonationSessionId: claims.impersonationSessionId,
  };
}

function coachSession(session: SupportSession) {
  if (hasImpersonationMarker(session)) throw new SupportServiceError("SUPPORT_IMPERSONATION_READ_ONLY");
  if (!session.tenantId || !["coach", "coach_member"].includes(session.role)) {
    throw new SupportServiceError("COACH_SUPPORT_FORBIDDEN");
  }
  return { expectedTenant: session.tenantId, userId: session.userId };
}

function platformSession(session: SupportSession) {
  if (hasImpersonationMarker(session)) throw new SupportServiceError("SUPPORT_IMPERSONATION_READ_ONLY");
  if (!["owner", "admin", "success"].includes(session.role)) {
    throw new SupportServiceError("PLATFORM_SUPPORT_FORBIDDEN");
  }
  return { actorId: session.userId, role: session.role };
}

export function createSupportService(repository: SupportRepository) {
  return {
    async listCoachThreads(session: SupportSession) {
      const actor = coachSession(session);
      return repository.listCoachSupportThreads(actor.expectedTenant, actor.userId);
    },
    async getCoachThread(session: SupportSession, threadId: string) {
      const actor = coachSession(session);
      return repository.getCoachSupportThread(actor.expectedTenant, actor.userId, threadId);
    },
    async createCoachThread(session: SupportSession, input: { subject: string; body: string }) {
      const actor = coachSession(session);
      return repository.createCoachSupportThread({ ...actor, ...input });
    },
    async appendCoachMessage(session: SupportSession, input: { threadId: string; body: string }) {
      const actor = coachSession(session);
      return repository.appendCoachSupportMessage({ ...actor, ...input });
    },
    async listPlatformThreads(
      session: SupportSession,
      input: { book: SupportBook; status?: SupportStatus },
    ) {
      const actor = platformSession(session);
      return repository.listPlatformSupportThreads({ actorId: actor.actorId, ...input });
    },
    async getPlatformThread(session: SupportSession, threadId: string) {
      const actor = platformSession(session);
      return repository.getPlatformSupportThread(actor.actorId, threadId);
    },
    async appendPlatformMessage(
      session: SupportSession,
      input: { threadId: string; body: string; internal: boolean },
    ) {
      const actor = platformSession(session);
      return repository.appendPlatformSupportMessage({ actorId: actor.actorId, ...input });
    },
    async listClientBook(session: SupportSession, book: SupportBook) {
      const actor = platformSession(session);
      return repository.listSuccessClientBook({ actorId: actor.actorId, book });
    },
    async reassignSuccessOwner(
      session: SupportSession,
      input: { expectedTenant: string; assigneeId: string; reason: string },
    ) {
      const actor = platformSession(session);
      if (actor.role === "success" && input.assigneeId !== actor.actorId) {
        throw new SupportServiceError("SUCCESS_OWNER_SELF_TAKE_ONLY");
      }
      return repository.reassignSuccessOwner({ actorId: actor.actorId, ...input });
    },
  };
}
