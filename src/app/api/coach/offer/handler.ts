/** Coach offer reads and draft saves derive tenant and actor identity from the session. */

import { phase2Live } from "@/lib/env-contract";
import { saveCoachOfferDraft } from "@/lib/offer/service";
import type { PersistedOfferLayer } from "@/lib/offer/types";
import { createOfferLayerRepository } from "@/lib/repositories/offer-layer";
import {
  loadRouteActor,
  type RouteActor,
} from "@/lib/auth/actors";
import {
  hasExactKeys,
  isRouteRecord,
  PHASE2_NO_STORE_HEADERS,
} from "@/app/api/admin/brain/import/handler";

type OfferRouteDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  load(tenantId: string): Promise<{
    draft: PersistedOfferLayer | null;
    published: PersistedOfferLayer | null;
  }>;
  save(
    tenantId: string,
    input: {
      actorId: string;
      draftId?: string | null;
      expectedContentHash?: string | null;
      offer: unknown;
    },
  ): ReturnType<typeof saveCoachOfferDraft>;
};

const COACH_OFFER_KEYS = [
  "assets",
  "bookingHorizonDays",
  "bookingMode",
  "brandVoice",
  "cadencePurposes",
  "creditMin",
  "creditRepair",
  "fundingGoalMaxCents",
  "fundingGoalMinCents",
  "monthlyRevenueMinCents",
  "prices",
  "products",
  "programDescription",
  "programName",
  "proof",
  "refundPosture",
  "resultsTimelineMaxDays",
  "resultsTimelineMinDays",
  "voiceFollowupAnswer",
  "voiceObjectionAnswer",
  "voiceStyleAnswer",
] as const;

function isCoach(actor: RouteActor | null): actor is RouteActor {
  return actor?.role === "coach" || actor?.role === "coach_member";
}

export function createCoachOfferHandlers(dependencies: OfferRouteDependencies) {
  async function GET() {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isCoach(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    try {
      const offers = await dependencies.load(actor.tenantId);
      const state = offers.draft ? "draft" : offers.published ? "published" : "awaiting_review";
      return Response.json({ state, ...offers }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch (cause) {
      console.error(
        "/api/coach/offer failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json(
        { state: "awaiting_review", code: "OFFER_READ_FAILED" },
        { status: 503, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  }

  async function PUT(request: Request) {
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
      const saved = await dependencies.save(actor.tenantId, {
        actorId: actor.userId,
        draftId: raw.draftId,
        expectedContentHash: raw.expectedContentHash,
        offer: raw.offer,
      });
      return Response.json({ state: "draft", ...saved }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json(
        { state: "awaiting_review", code: "OFFER_SAVE_REFUSED" },
        { status: 409, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  }

  return { GET, PUT };
}

const handlers = createCoachOfferHandlers({
  enabled: phase2Live,
  session: loadRouteActor,
  load: async (tenantId) => {
    const repository = createOfferLayerRepository();
    const [draft, published] = await Promise.all([
      repository.loadOffer({ tenantId, status: "draft" }),
      repository.loadOffer({ tenantId, status: "published" }),
    ]);
    return { draft, published };
  },
  save: saveCoachOfferDraft,
});

export const GET = handlers.GET;
export const PUT = handlers.PUT;
