import { describe, expect, it } from "vitest";

import { validateCoachOfferDraft } from "@/lib/offer/validation";

const BASE = {
  programName: "Funding Sprint",
  programDescription: null,
  creditMin: 640,
  fundingGoalMinCents: null,
  fundingGoalMaxCents: null,
  monthlyRevenueMinCents: null,
  creditRepair: null,
  products: [],
  bookingHorizonDays: 21,
  bookingMode: "direct",
  brandVoice: "friendly",
  resultsTimelineMinDays: null,
  resultsTimelineMaxDays: null,
  refundPosture: null,
  voiceStyleAnswer: null,
  voiceObjectionAnswer: null,
  voiceFollowupAnswer: null,
  qualificationRules: [],
  voiceGuidelines: null,
  prices: [],
  proof: [],
  assets: [],
  cadencePurposes: [],
};

describe("validateCoachOfferDraft rules and guidelines", () => {
  it("accepts a coach's rules and guidelines, trimmed", () => {
    const offer = validateCoachOfferDraft(
      {
        ...BASE,
        qualificationRules: [
          { subject: " Location ", op: "not_one_of", value: " India, Bangladesh " },
          { subject: "Open bankruptcy", op: "rules_out", value: "ignored" },
        ],
        voiceGuidelines: "  Warm, never pushy.  ",
      },
      [],
    );
    expect(offer.qualificationRules).toEqual([
      { subject: "Location", op: "not_one_of", value: "India, Bangladesh" },
      { subject: "Open bankruptcy", op: "rules_out", value: "" },
    ]);
    expect(offer.voiceGuidelines).toBe("Warm, never pushy.");
  });

  it("refuses a rule whose condition needs a value it does not have", () => {
    expect(() =>
      validateCoachOfferDraft(
        { ...BASE, qualificationRules: [{ subject: "Location", op: "is", value: "  " }] },
        [],
      ),
    ).toThrow("OFFER_RULE_VALUE_REQUIRED:qualificationRules[0].value");
  });

  it("refuses an unknown condition, an unnamed rule, and a stray key on a rule", () => {
    expect(() =>
      validateCoachOfferDraft(
        { ...BASE, qualificationRules: [{ subject: "Location", op: "near", value: "x" }] },
        [],
      ),
    ).toThrow("OFFER_ENUM_INVALID:qualificationRules[0].op");
    expect(() =>
      validateCoachOfferDraft(
        { ...BASE, qualificationRules: [{ subject: "", op: "is", value: "x" }] },
        [],
      ),
    ).toThrow("OFFER_STRING_INVALID:qualificationRules[0].subject");
    expect(() =>
      validateCoachOfferDraft(
        { ...BASE, qualificationRules: [{ subject: "Location", op: "is", value: "x", weight: 2 }] },
        [],
      ),
    ).toThrow("OFFER_PLATFORM_FIELD_FORBIDDEN:qualificationRules[0].weight");
  });

  it("caps the rules at twelve and the guidelines at their bound", () => {
    const rule = { subject: "Location", op: "is", value: "x" };
    expect(() =>
      validateCoachOfferDraft({ ...BASE, qualificationRules: Array(13).fill(rule) }, []),
    ).toThrow("OFFER_ARRAY_INVALID:qualificationRules");
    expect(() =>
      validateCoachOfferDraft({ ...BASE, voiceGuidelines: "x".repeat(1201) }, []),
    ).toThrow("OFFER_STRING_INVALID:voiceGuidelines");
  });

  it("accepts the two new billing periods", () => {
    const offer = validateCoachOfferDraft(
      {
        ...BASE,
        prices: [
          { label: "Weekly coaching", amountCents: 9_900, billingPeriod: "weekly" },
          { label: "Strategy call", amountCents: 25_000, billingPeriod: "per_session" },
        ],
      },
      [],
    );
    expect(offer.prices.map((price) => price.billingPeriod)).toEqual(["weekly", "per_session"]);
  });
});
