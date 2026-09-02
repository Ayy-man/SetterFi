import { describe, expect, it, vi } from "vitest";

import {
  createTierOfferTermsRepository,
  namedTierOfferTermError,
  TierOfferTermsRepositoryError,
} from "@/lib/repositories/tier-offer-terms";

const row = {
  id: "term-1",
  tier_id: "tier-1",
  tier_name: "Growth",
  currency: "USD",
  amount_cents: 49_900,
  billing_interval: "month",
  stripe_price_id: "price_live_1",
  effective_from: "2026-09-01T00:00:00.000Z",
  effective_to: null,
  reason: "Launch pricing",
  audit_id: 91,
  created_at: "2026-08-31T00:00:00.000Z",
};

describe("tier offer terms repository", () => {
  it("maps the history rows the admin surface reads", async () => {
    const rpc = vi.fn().mockResolvedValue([row]);
    const terms = await createTierOfferTermsRepository({ rpc }).list("admin-1");

    expect(rpc).toHaveBeenCalledWith("list_tier_offer_terms", { p_actor_id: "admin-1" });
    expect(terms).toEqual([{
      id: "term-1",
      tierId: "tier-1",
      tierName: "Growth",
      currency: "USD",
      amountCents: 49_900,
      interval: "month",
      stripePriceId: "price_live_1",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      effectiveTo: null,
      reason: "Launch pricing",
      auditId: 91,
    }]);
  });

  it("refuses a row whose interval is not one the ledger can sell on", async () => {
    const rpc = vi.fn().mockResolvedValue([{ ...row, billing_interval: "fortnight" }]);
    await expect(createTierOfferTermsRepository({ rpc }).list("admin-1")).rejects.toThrow(
      "TIER_OFFER_TERM_ROW_INVALID",
    );
  });

  it("sends the recorded term and returns the receipt the route prints", async () => {
    const rpc = vi.fn().mockResolvedValue([{ term_id: "term-1", audit_id: 91 }]);
    const receipt = await createTierOfferTermsRepository({ rpc }).record({
      actorId: "admin-1",
      tierId: "tier-1",
      currency: "USD",
      amountCents: 49_900,
      interval: "month",
      stripePriceId: "price_live_1",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      effectiveTo: null,
      reason: "Launch pricing",
    });

    expect(rpc).toHaveBeenCalledWith("record_tier_offer_term", {
      p_actor_id: "admin-1",
      p_tier_id: "tier-1",
      p_currency: "USD",
      p_amount_cents: 49_900,
      p_billing_interval: "month",
      p_stripe_price_id: "price_live_1",
      p_effective_from: "2026-09-01T00:00:00.000Z",
      p_effective_to: null,
      p_reason: "Launch pricing",
    });
    expect(receipt).toEqual({ termId: "term-1", auditId: 91 });
  });

  it("refuses a write whose receipt carries no audit id", async () => {
    const rpc = vi.fn().mockResolvedValue([{ term_id: "term-1", audit_id: null }]);
    await expect(
      createTierOfferTermsRepository({ rpc }).close({
        actorId: "admin-1",
        termId: "term-1",
        effectiveTo: "2026-12-01T00:00:00.000Z",
        reason: "Superseded",
      }),
    ).rejects.toThrow("TIER_OFFER_TERM_RECEIPT_INVALID");
  });

  /**
   * The two constraints only the database can decide arrive as its own message text. Losing the
   * name here is what would turn "this window overlaps" into "something went wrong".
   */
  it("keeps the database's own name for a refusal it raised", () => {
    const overlap = namedTierOfferTermError(
      'new row for relation "tier_offer_terms" violates: TIER_OFFER_TERM_WINDOW_OVERLAP',
      "RECORD_TIER_OFFER_TERM_FAILED",
    );
    expect(overlap).toBeInstanceOf(TierOfferTermsRepositoryError);
    expect(overlap.message).toBe("TIER_OFFER_TERM_WINDOW_OVERLAP");
    expect(
      namedTierOfferTermError("connection terminated", "RECORD_TIER_OFFER_TERM_FAILED").message,
    ).toBe("RECORD_TIER_OFFER_TERM_FAILED");
  });
});
