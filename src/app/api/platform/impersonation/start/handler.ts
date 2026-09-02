import { loadPlatformActor, refreshAuthClaims, type PlatformActor } from "@/lib/auth/actors";
import type { AppClaims, UserRole } from "@/lib/auth/claims";
import { phase1Live } from "@/lib/env-contract";
import {
  endImpersonation,
  startImpersonation,
  type ImpersonationSession,
} from "@/lib/impersonation";

export { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";

const noStoreHeaders = { "Cache-Control": "no-store" };

type Dependencies = {
  session(): Promise<PlatformActor | null>;
  start(
    actor: { id: string; role: UserRole },
    tenantId: string,
    reason: string,
  ): Promise<ImpersonationSession>;
  refresh(): Promise<AppClaims | null>;
  end(actorId: string, sessionId: string): Promise<unknown>;
};

export function createImpersonationStartHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!phase1Live()) return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    const actor = await dependencies.session();
    if (!actor?.role || !["owner", "admin", "success"].includes(actor.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    let startedSession: ImpersonationSession | null = null;
    try {
      const body = await request.json() as { tenantId?: unknown; reason?: unknown };
      if (
        typeof body.tenantId !== "string" || !body.tenantId.trim() ||
        typeof body.reason !== "string" || !body.reason.trim()
      ) throw new Error("INVALID_BODY");
      const session = await dependencies.start(
        { id: actor.userId, role: actor.role },
        body.tenantId,
        body.reason,
      );
      startedSession = session;
      if (Date.parse(session.expiresAt) - Date.parse(session.startedAt) !== 30 * 60_000) {
        throw new Error("IMPERSONATION_DURATION_INVALID");
      }
      const refreshed = await dependencies.refresh();
      if (
        refreshed?.userId !== actor.userId ||
        refreshed.impersonationSessionId !== session.id ||
        refreshed.impersonatingTenant !== session.tenantId
      ) throw new Error("IMPERSONATION_CLAIM_REFRESH_FAILED");
      return Response.json({ session: { ...session } }, { headers: noStoreHeaders });
    } catch {
      if (startedSession) {
        try {
          await dependencies.end(actor.userId, startedSession.id);
        } catch (cause) {
          console.error(
            "/api/platform/impersonation/start failed.",
            cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
          );
          return Response.json({
            error: "Impersonation start requires cleanup.",
            recovery: {
              sessionId: startedSession.id,
              expiresAt: startedSession.expiresAt,
            },
          }, { status: 503, headers: noStoreHeaders });
        }
      }
      return Response.json({ error: "Impersonation start was refused." }, { status: 409, headers: noStoreHeaders });
    }
  };
}

export const POST = createImpersonationStartHandler({
  session: loadPlatformActor,
  start: startImpersonation,
  refresh: refreshAuthClaims,
  end: endImpersonation,
});
