/** Platform-only, audited review decision for the current immutable offer revision. */

import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { phase5Live } from "@/lib/env-contract";
import {
  recordOfferReview,
  type OfferReviewDecision,
  type RecordOfferReviewInput,
} from "@/lib/repositories/offer-review";

const NO_STORE = { "Cache-Control": "no-store" };
const BODY_KEYS = ["tenantId", "offerId", "offerVersion", "offerContentHash", "decision", "reason"] as const;

type OfferReviewDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  review(input: RecordOfferReviewInput): ReturnType<typeof recordOfferReview>;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function exactKeys(value: Record<string, unknown>) {
  return Object.keys(value).sort().join(",") === [...BODY_KEYS].sort().join(",");
}

function isOwnerAdmin(actor: PlatformActor | null): actor is PlatformActor {
  return actor?.role === "owner" || actor?.role === "admin";
}

export function createOfferReviewHandler(dependencies: OfferReviewDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!isOwnerAdmin(actor)) return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
    try {
      const body: unknown = await request.json();
      if (!record(body) || !exactKeys(body) || !nonBlank(body.tenantId) || !nonBlank(body.offerId) ||
        !nonBlank(body.offerContentHash) || !nonBlank(body.reason) ||
        !Number.isSafeInteger(body.offerVersion) || Number(body.offerVersion) < 1 ||
        (body.decision !== "clear" && body.decision !== "rejected")) {
        throw new Error("OFFER_REVIEW_BODY_INVALID");
      }
      return Response.json(await dependencies.review({
        expectedTenant: body.tenantId.trim(),
        actorId: actor.userId,
        offerId: body.offerId.trim(),
        offerVersion: Number(body.offerVersion),
        offerContentHash: body.offerContentHash.trim(),
        decision: body.decision as OfferReviewDecision,
        reason: body.reason.trim(),
      }), { headers: NO_STORE });
    } catch {
      return Response.json({ state: "refused", code: "OFFER_REVIEW_REFUSED" }, { status: 409, headers: NO_STORE });
    }
  };
}

export const POST = createOfferReviewHandler({
  enabled: phase5Live,
  session: loadPlatformActor,
  review: recordOfferReview,
});
