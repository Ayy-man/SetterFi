import { describe, expect, it } from "vitest";

import { requireTierOffer, resolveTierOffer, type TierOfferTerms } from "@/lib/billing/tier-offers";

const TIER_ID = "tier-growth";
const AS_OF = new Date("2026-09-01T00:00:00.000Z");

function offer(overrides: Partial<TierOfferTerms> = {}): TierOfferTerms {
  return {
    id: "offer-growth-september",
    tierId: TIER_ID,
    currency: "USD",
    amountCents: 49_900,
    interval: "month",
    stripePriceId: "price_growth_september",
    effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
    effectiveTo: null,
    ...overrides,
  };
}

describe("resolveTierOffer", () => {
  it("resolves the one offer in force at the caller-supplied instant", () => {
    const result = resolveTierOffer([offer()], TIER_ID, AS_OF);
    expect(result).toMatchObject({
      state: "offered",
      offer: { stripePriceId: "price_growth_september", amountCents: 49_900 },
    });
  });

  it("uses a half-open effective window so a superseded offer cannot be quoted", () => {
    const offers = [
      offer({ id: "august", effectiveFrom: new Date("2026-08-01T00:00:00.000Z"), effectiveTo: AS_OF }),
      offer({ id: "september", effectiveFrom: AS_OF }),
    ];
    expect(requireTierOffer(offers, TIER_ID, AS_OF).id).toBe("september");
  });

  it("returns an explicit no-offer state and refuses a required quote", () => {
    const beforeLaunch = new Date("2026-08-31T23:59:59.999Z");
    expect(resolveTierOffer([offer()], TIER_ID, beforeLaunch)).toEqual({
      state: "no_offer",
      code: "BILLING_TIER_OFFER_UNAVAILABLE",
    });
    expect(() => requireTierOffer([offer()], TIER_ID, beforeLaunch))
      .toThrow("BILLING_TIER_OFFER_UNAVAILABLE");
  });

  it("refuses ambiguous commercial terms instead of selecting the first row", () => {
    expect(() => resolveTierOffer([
      offer(),
      offer({ id: "offer-growth-duplicate", stripePriceId: "price_growth_duplicate" }),
    ], TIER_ID, AS_OF)).toThrow("BILLING_TIER_PRICE_AMBIGUOUS");
  });
});
