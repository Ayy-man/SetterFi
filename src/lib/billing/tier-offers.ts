/**
 * Effective-dated commercial terms are resolved against a caller-supplied instant.  The caller
 * owns the clock so a quote can be reproduced and tests never depend on wall-clock time.
 */

export const TIER_OFFER_INTERVALS = ["day", "week", "month", "year"] as const;
export type TierOfferInterval = (typeof TIER_OFFER_INTERVALS)[number];

export type TierOfferTerms = {
  id: string;
  tierId: string;
  currency: string;
  amountCents: number;
  interval: TierOfferInterval;
  stripePriceId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export type TierOfferResolution =
  | { state: "offered"; offer: TierOfferTerms }
  | { state: "no_offer"; code: "BILLING_TIER_OFFER_UNAVAILABLE" };

function validInstant(value: Date) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function assertOfferShape(offer: TierOfferTerms) {
  required(offer.id, "BILLING_TIER_OFFER_INVALID");
  required(offer.tierId, "BILLING_TIER_OFFER_INVALID");
  if (!/^[A-Z]{3}$/.test(offer.currency)) throw new Error("BILLING_TIER_OFFER_INVALID");
  if (!Number.isSafeInteger(offer.amountCents) || offer.amountCents < 0) {
    throw new Error("BILLING_TIER_OFFER_INVALID");
  }
  if (!TIER_OFFER_INTERVALS.includes(offer.interval)) {
    throw new Error("BILLING_TIER_OFFER_INVALID");
  }
  required(offer.stripePriceId, "BILLING_TIER_OFFER_INVALID");
  if (!validInstant(offer.effectiveFrom)
    || (offer.effectiveTo !== null && !validInstant(offer.effectiveTo))
    || (offer.effectiveTo !== null && offer.effectiveTo <= offer.effectiveFrom)) {
    throw new Error("BILLING_TIER_OFFER_INVALID");
  }
}

/**
 * Resolves only the requested tier.  An absent offer is an explicit refusal state, while more
 * than one matching offer is corrupt commercial data and must never be picked by position.
 */
export function resolveTierOffer(
  offers: readonly TierOfferTerms[],
  tierId: string,
  asOf: Date,
): TierOfferResolution {
  const expectedTierId = required(tierId, "BILLING_TIER_REQUIRED");
  if (!validInstant(asOf)) throw new Error("BILLING_TIER_OFFER_AS_OF_INVALID");
  const matching = offers.filter((offer) => {
    assertOfferShape(offer);
    return offer.tierId === expectedTierId
      && offer.effectiveFrom <= asOf
      && (offer.effectiveTo === null || asOf < offer.effectiveTo);
  });
  if (matching.length === 0) {
    return { state: "no_offer", code: "BILLING_TIER_OFFER_UNAVAILABLE" };
  }
  // Match the established checkout refusal rather than silently introducing a second meaning for
  // an ambiguous price selection.
  if (matching.length !== 1) throw new Error("BILLING_TIER_PRICE_AMBIGUOUS");
  return { state: "offered", offer: matching[0] };
}

/** A caller that needs a sellable offer, rather than a status, receives a refusal for no offer. */
export function requireTierOffer(
  offers: readonly TierOfferTerms[],
  tierId: string,
  asOf: Date,
): TierOfferTerms {
  const resolution = resolveTierOffer(offers, tierId, asOf);
  if (resolution.state === "no_offer") throw new Error(resolution.code);
  return resolution.offer;
}
