/** Coach offer publish exposes only the draft identity and optimistic content hash. */

import { phase2Live } from "@/lib/env-contract";
import { publishCoachOfferDraft } from "@/lib/offer/service";
import {
  loadRouteActor,
  type RouteActor,
} from "@/lib/auth/actors";
import {
  hasExactKeys,
  isRouteRecord,
  nonBlank,
  PHASE2_NO_STORE_HEADERS,
} from "@/app/api/admin/brain/import/handler";

type OfferPublishDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  publish(
    tenantId: string,
    input: { actorId: string; draftId: string; expectedContentHash: string },
  ): ReturnType<typeof publishCoachOfferDraft>;
};

function isCoach(actor: RouteActor | null): actor is RouteActor {
  return actor?.role === "coach" || actor?.role === "coach_member";
}

export function createCoachOfferPublishHandler(dependencies: OfferPublishDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isCoach(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    try {
      const raw: unknown = await request.json();
      if (!isRouteRecord(raw) || !hasExactKeys(raw, ["draftId", "expectedContentHash"]) ||
        !nonBlank(raw.draftId) || !nonBlank(raw.expectedContentHash)) {
        throw new Error("OFFER_PUBLISH_BODY_INVALID");
      }
      const result = await dependencies.publish(actor.tenantId, {
        actorId: actor.userId,
        draftId: raw.draftId.trim(),
        expectedContentHash: raw.expectedContentHash.trim(),
      });
      return Response.json({ state: "published", ...result }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json(
        { state: "awaiting_review", code: "OFFER_PUBLISH_REFUSED" },
        { status: 409, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createCoachOfferPublishHandler({
  enabled: phase2Live,
  session: loadRouteActor,
  publish: publishCoachOfferDraft,
});
