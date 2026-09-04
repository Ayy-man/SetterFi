/**
 * `/api/coach/offer/save-and-publish` -- one Save, no coach-facing draft state.
 *
 * `SIMPLIFICATION-SPEC.md` Q4's chosen default replaces the coach's separate Save-then-Publish
 * steps with one Save button; platform review still runs behind the publish, the coach just never
 * takes it as its own step. This route accepts the same body PUT `/api/coach/offer` does and
 * returns what POST `/api/coach/offer/publish` returns, composing `saveCoachOfferDraft` and
 * `publishCoachOfferDraft` (`saveAndPublishCoachOffer`, `src/lib/offer/service.ts`) into one
 * request. The two-step routes are untouched for any caller still on the explicit shape.
 */

import { phase2Live } from "@/lib/env-contract";
import { saveAndPublishCoachOffer } from "@/lib/offer/service";
import {
  loadRouteActor,
  type RouteActor,
} from "@/lib/auth/actors";
import {
  hasExactKeys,
  isRouteRecord,
  PHASE2_NO_STORE_HEADERS,
} from "@/app/api/admin/brain/import/handler";
import { COACH_OFFER_KEYS } from "@/app/api/coach/offer/keys";

type Dependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  saveAndPublish(
    tenantId: string,
    input: {
      actorId: string;
      draftId?: string | null;
      expectedContentHash?: string | null;
      offer: unknown;
    },
  ): ReturnType<typeof saveAndPublishCoachOffer>;
};

function isCoach(actor: RouteActor | null): actor is RouteActor {
  return actor?.role === "coach" || actor?.role === "coach_member";
}

export function createCoachOfferSaveAndPublishHandler(dependencies: Dependencies) {
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
      if (!isRouteRecord(raw) || !hasExactKeys(raw, ["draftId", "expectedContentHash", "offer"]) ||
        (raw.draftId !== null && typeof raw.draftId !== "string") ||
        (raw.expectedContentHash !== null && typeof raw.expectedContentHash !== "string") ||
        !isRouteRecord(raw.offer) || !hasExactKeys(raw.offer, COACH_OFFER_KEYS)) {
        throw new Error("OFFER_SAVE_BODY_INVALID");
      }
      const result = await dependencies.saveAndPublish(actor.tenantId, {
        actorId: actor.userId,
        draftId: raw.draftId,
        expectedContentHash: raw.expectedContentHash,
        offer: raw.offer,
      });
      return Response.json({ state: "published", ...result }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json(
        { state: "awaiting_review", code: "OFFER_SAVE_AND_PUBLISH_REFUSED" },
        { status: 409, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createCoachOfferSaveAndPublishHandler({
  enabled: phase2Live,
  session: loadRouteActor,
  saveAndPublish: saveAndPublishCoachOffer,
});
