import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase5Live } from "@/lib/env-contract";
import {
  loadCoachA2pRegistration,
  type CoachA2pRegistrationProjection,
} from "@/lib/repositories/onboarding-evidence";

const NO_STORE = { "Cache-Control": "no-store" };

type A2pRegistrationDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  load(tenantId: string): Promise<CoachA2pRegistrationProjection | null>;
};

export function createA2pRegistrationHandler(dependencies: A2pRegistrationDependencies) {
  return async function GET() {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json({ error: "Authentication required." }, {
        status: 401,
        headers: NO_STORE,
      });
    }
    if (hasImpersonationMarker(actor)) {
      return Response.json({ error: "Impersonated sessions are read-only." }, {
        status: 403,
        headers: NO_STORE,
      });
    }
    try {
      return Response.json({ registration: await dependencies.load(actor.tenantId) }, {
        headers: NO_STORE,
      });
    } catch (cause) {
      console.error(
        "/api/onboarding/a2p-registration failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Registration status is unavailable." }, {
        status: 503,
        headers: NO_STORE,
      });
    }
  };
}

export const GET = createA2pRegistrationHandler({
  enabled: phase5Live,
  session: loadRouteActor,
  load: loadCoachA2pRegistration,
});
