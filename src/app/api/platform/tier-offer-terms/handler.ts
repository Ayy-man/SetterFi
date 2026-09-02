/**
 * The writer for the commercial-terms ledger.
 *
 * Gated on `phase6Live` and nothing else. It deliberately does NOT gate on
 * `SETTERFI_TIER_OFFER_TERMS_LIVE`: that flag makes signup quote from this table, and a flag you
 * can only switch on after the table already holds a term is a flag nobody can ever switch on.
 * Recording terms is what makes it switch-on-able, so recording has to work while it is off.
 *
 * Every refusal the database names is carried through with its name and a sentence a person can
 * act on. Nothing here calls Stripe: `stripePriceId` is recorded, not verified.
 */

import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { TIER_OFFER_INTERVALS, type TierOfferInterval } from "@/lib/billing/tier-offers";
import { phase6Live } from "@/lib/env-contract";
import {
  createTierOfferTermsRepository,
  type TierOfferTermsRepository,
} from "@/lib/repositories/tier-offer-terms";

const headers = { "Cache-Control": "no-store" };

type Operations = Pick<TierOfferTermsRepository, "list" | "record" | "close">;

type Dependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  operations: Operations;
};

/**
 * One sentence per refusal, in the operator's terms. The overlap and duplicate cases are the two
 * the database alone can decide, so they say what to do next rather than restating the constraint.
 */
const REFUSALS: Record<string, string> = {
  BILLING_TIER_NOT_FOUND: "That plan no longer exists, so no term was recorded.",
  PHASE6_ACTOR_REQUIRED: "This session could not be verified, so no term was recorded.",
  PHASE6_OWNER_ADMIN_REQUIRED: "Only an owner or admin can record commercial terms.",
  TIER_OFFER_TERM_ALREADY_CLOSED: "That term already has an end date, so it cannot be closed again.",
  TIER_OFFER_TERM_AMOUNT_INVALID: "The amount must be zero or more, in whole cents.",
  TIER_OFFER_TERM_CURRENCY_INVALID: "The currency must be a three-letter code, such as USD.",
  TIER_OFFER_TERM_INTERVAL_INVALID: "The billing interval must be day, week, month, or year.",
  TIER_OFFER_TERM_NOT_FOUND: "That term is no longer recorded, so nothing was closed.",
  TIER_OFFER_TERM_REASON_REQUIRED: "A reason is required and is retained with the record.",
  TIER_OFFER_TERM_STRIPE_PRICE_DUPLICATE:
    "That Stripe price id is already recorded on another term. Each term carries its own price id.",
  TIER_OFFER_TERM_STRIPE_PRICE_REQUIRED: "A Stripe price id is required.",
  TIER_OFFER_TERM_WINDOW_INVALID: "The end must be after the start.",
  TIER_OFFER_TERM_WINDOW_OVERLAP:
    "This window overlaps a term already recorded for this plan. Close the standing window first, then record the next one.",
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("INVALID_BODY");
  return value.trim();
}

function integer(value: unknown) {
  if (!Number.isSafeInteger(value)) throw new Error("INVALID_BODY");
  return value as number;
}

function timestamp(value: unknown) {
  const candidate = text(value);
  if (!Number.isFinite(Date.parse(candidate))) throw new Error("INVALID_BODY");
  return candidate;
}

function interval(value: unknown): TierOfferInterval {
  if (!TIER_OFFER_INTERVALS.includes(value as TierOfferInterval)) throw new Error("INVALID_BODY");
  return value as TierOfferInterval;
}

function refusal(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  if (code === "INVALID_BODY") {
    return Response.json({ error: "The request was not understood." }, { status: 400, headers });
  }
  const body = REFUSALS[code];
  return Response.json(
    body
      ? { error: body, code }
      : { error: "The commercial term could not be recorded." },
    { status: 409, headers },
  );
}

export function createTierOfferTermsHandlers(dependencies: Dependencies) {
  async function actor(): Promise<{ response: Response } | { session: PlatformActor }> {
    if (!dependencies.enabled()) {
      return { response: Response.json({ error: "Not found." }, { status: 404, headers }) };
    }
    const session = await dependencies.session();
    // Reading a price and changing one are the same permission on this surface: the page says
    // only an owner or admin can see plan pricing, so success sees no terms here either.
    if (!session || !["owner", "admin"].includes(session.role)) {
      return { response: Response.json({ error: "Forbidden." }, { status: 403, headers }) };
    }
    return { session };
  }

  return {
    GET: async () => {
      const auth = await actor();
      if ("response" in auth) return auth.response;
      try {
        return Response.json(
          { terms: await dependencies.operations.list(auth.session.userId) },
          { headers },
        );
      } catch (failure) {
        console.error(
          "/api/platform/tier-offer-terms failed.",
          failure instanceof Error ? failure.message : "NON_ERROR_THROWN",
        );
        return Response.json(
          { error: "Commercial terms could not be loaded." },
          { status: 503, headers },
        );
      }
    },
    POST: async (request: Request) => {
      const auth = await actor();
      if ("response" in auth) return auth.response;
      const session = auth.session;
      let input: { action: "record" | "close"; body: Record<string, unknown> };
      try {
        const body: unknown = await request.json();
        if (!record(body) || typeof body.action !== "string") throw new Error("INVALID_BODY");
        if (body.action !== "record_term" && body.action !== "close_term") {
          throw new Error("INVALID_ACTION");
        }
        input = { action: body.action === "record_term" ? "record" : "close", body };
      } catch {
        return Response.json({ error: "The request was not understood." }, { status: 400, headers });
      }

      try {
        const body = input.body;
        const result = input.action === "record"
          ? await dependencies.operations.record({
            actorId: session.userId,
            tierId: text(body.tierId),
            currency: text(body.currency).toUpperCase(),
            amountCents: integer(body.amountCents),
            interval: interval(body.interval),
            stripePriceId: text(body.stripePriceId),
            effectiveFrom: timestamp(body.effectiveFrom),
            effectiveTo: body.effectiveTo === null ? null : timestamp(body.effectiveTo),
            reason: text(body.reason),
          })
          : await dependencies.operations.close({
            actorId: session.userId,
            termId: text(body.termId),
            effectiveTo: timestamp(body.effectiveTo),
            reason: text(body.reason),
          });
        return Response.json({ result }, { headers });
      } catch (cause) {
        return refusal(cause);
      }
    },
  };
}

const handlers = createTierOfferTermsHandlers({
  enabled: phase6Live,
  session: loadPlatformActor,
  operations: createTierOfferTermsRepository(),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
