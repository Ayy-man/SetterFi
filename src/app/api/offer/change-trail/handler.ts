import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { phase2Live } from "@/lib/env-contract";
import type { OfferChangeTrailEntry } from "@/lib/offer/change-trail";
import { loadOfferChangeTrail } from "@/lib/repositories/offer-layer";

const NO_STORE = { "Cache-Control": "no-store" };

type ChangeTrailDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  load(input: { tenantId: string; actorId: string; offerId: string }): Promise<readonly OfferChangeTrailEntry[]>;
};

function isCoach(actor: RouteActor | null): actor is RouteActor {
  return actor?.role === "coach" || actor?.role === "coach_member";
}

function offerIdFrom(request: Request) {
  const offerId = new URL(request.url).searchParams.get("offerId");
  return offerId?.trim() || null;
}

/** The tenant comes exclusively from verified claims; database RPC custody is the final authority. */
export function createOfferChangeTrailHandler(dependencies: ChangeTrailDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!isCoach(actor)) return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
    const offerId = offerIdFrom(request);
    if (!offerId) return Response.json({ error: "An offer id is required." }, { status: 400, headers: NO_STORE });
    try {
      const changes = await dependencies.load({ tenantId: actor.tenantId, actorId: actor.userId, offerId });
      // An empty array is a measured result for this valid offer, never an implicit unavailable state.
      return Response.json({ state: "measured", changes }, { headers: NO_STORE });
    } catch {
      return Response.json({ error: "Offer change history is unavailable." }, { status: 403, headers: NO_STORE });
    }
  };
}

export const GET = createOfferChangeTrailHandler({
  enabled: phase2Live,
  session: loadRouteActor,
  load: loadOfferChangeTrail,
});
