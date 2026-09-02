import { phase1Live } from "@/lib/env-contract";
import { endImpersonation, type ImpersonationSession } from "@/lib/impersonation";

import {
  loadImpersonationLifecycleActor,
  refreshAuthClaims,
  type ImpersonationLifecycleActor,
} from "@/lib/auth/actors";
import type { AppClaims } from "@/lib/auth/claims";

const noStoreHeaders = { "Cache-Control": "no-store" };

type Dependencies = {
  session(): Promise<ImpersonationLifecycleActor | null>;
  end(actorId: string, sessionId: string): Promise<{ session: ImpersonationSession; auditId: string }>;
  refresh(): Promise<AppClaims | null>;
};

export function createImpersonationEndHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!phase1Live()) return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    const actor = await dependencies.session();
    if (!actor?.role || !["owner", "admin", "success"].includes(actor.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    try {
      const body = await request.json() as { sessionId?: unknown };
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("INVALID_BODY");
      if (actor.activeSession?.id !== body.sessionId) throw new Error("IMPERSONATION_SESSION_NOT_ACTIVE");
      const result = await dependencies.end(actor.userId, body.sessionId);
      const refreshed = await dependencies.refresh();
      if (
        refreshed?.userId !== actor.userId ||
        refreshed.impersonatingTenant ||
        refreshed.impersonationSessionId
      ) throw new Error("IMPERSONATION_CLAIM_REFRESH_FAILED");
      return Response.json({ session: { ...result.session }, auditId: result.auditId }, { headers: noStoreHeaders });
    } catch {
      return Response.json({ error: "Impersonation end was refused." }, { status: 409, headers: noStoreHeaders });
    }
  };
}

export const POST = createImpersonationEndHandler({
  session: loadImpersonationLifecycleActor,
  end: endImpersonation,
  refresh: refreshAuthClaims,
});
