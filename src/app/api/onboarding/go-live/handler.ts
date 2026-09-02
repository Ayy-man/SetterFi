import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { createReadinessEvidence } from "@/app/api/onboarding/readiness/handler";
import { phase5Live } from "@/lib/env-contract";
import type { ReadinessResult } from "@/lib/onboarding/contracts";
import { commitGoLive, type GoLiveReceipt } from "@/lib/onboarding/readiness";

const NO_STORE = { "Cache-Control": "no-store" };

type GoLiveResult =
  | { kind: "live"; readiness: ReadinessResult; receipt: GoLiveReceipt }
  | { kind: "refused"; readiness: ReadinessResult; code: string };

type GoLiveDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  commit(input: { tenantId: string; actorId: string }): Promise<GoLiveResult>;
};

export function createGoLiveHandler(dependencies: GoLiveDependencies) {
  return async function POST() {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
    if (hasImpersonationMarker(actor)) return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
    if (actor.role !== "coach") return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
    try {
      const result = await dependencies.commit({ tenantId: actor.tenantId, actorId: actor.userId });
      if (result.kind === "refused") {
        return Response.json(result, { status: 409, headers: NO_STORE });
      }
      if (!result.receipt.auditId.trim()) throw new Error("GO_LIVE_AUDIT_RECEIPT_REQUIRED");
      return Response.json(result, { headers: NO_STORE });
    } catch {
      return Response.json({ error: "Go-live was refused." }, { status: 409, headers: NO_STORE });
    }
  };
}

export const POST = createGoLiveHandler({
  enabled: phase5Live,
  session: loadRouteActor,
  // Commit on exactly the evidence the readiness GET reported. Wiring these separately is what
  // let them drift, so the ports are built once and shared rather than restated here.
  commit: (input) => commitGoLive(input, createReadinessEvidence()),
});
