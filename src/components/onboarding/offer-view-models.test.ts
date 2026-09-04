import { describe, expect, it } from "vitest";

import { offerReview } from "@/components/onboarding/offer-view-models";
import type { PersistedOfferLayer } from "@/lib/offer/types";

function offer(overrides: Partial<PersistedOfferLayer> = {}): PersistedOfferLayer {
  return {
    assets: [],
    bookingHorizonDays: 14,
    bookingMode: "direct",
    brandVoice: null,
    businessRevenueRequired: false,
    cadencePurposes: [],
    contentHash: "hash",
    creditMin: null,
    creditRepair: null,
    fundingGoalMaxCents: null,
    fundingGoalMinCents: null,
    id: "offer-1",
    monthlyRevenueMinCents: null,
    offerPrices: [],
    products: [],
    programDescription: null,
    programName: "",
    proof: [],
    refundPosture: null,
    resultsTimelineMaxDays: null,
    resultsTimelineMinDays: null,
    status: "published",
    tenantId: "tenant-1",
    version: 1,
    voiceFollowupAnswer: null,
    qualificationRules: [],
    voiceGuidelines: null,
    voiceObjectionAnswer: null,
    voiceStyleAnswer: null,
    ...overrides,
  };
}

const row = (review: ReturnType<typeof offerReview>, key: string) =>
  review.rows.find((entry) => entry.key === key)!;

describe("offerReview", () => {
  it("asks the four things the artboard asks, in its order", () => {
    const review = offerReview(null, "none");
    expect(review.rows.map((entry) => entry.key)).toEqual([
      "program",
      "prices",
      "qualifiers",
      "voice",
    ]);
  });

  it("reports no offer as an absence rather than as empty values", () => {
    const review = offerReview(null, "none");
    expect(review.source).toBe("none");
    expect(review.ready).toBe(false);
    for (const entry of review.rows.flatMap((candidate) => candidate.values)) {
      expect(entry.value.kind).toBe("absent");
    }
  });

  it("states a missing minimum as no minimum, never as zero", () => {
    const qualifiers = row(offerReview(offer(), "published"), "qualifiers");
    for (const entry of qualifiers.values) {
      expect(entry.value).toEqual({ kind: "absent", text: "No minimum" });
      expect(entry.value.text).not.toContain("0");
    }
  });

  it("reads the coach's own rules back as sentences after the three bounds", () => {
    const qualifiers = row(
      offerReview(
        offer({
          qualificationRules: [
            { subject: "Location", op: "not_one_of", value: "India, Bangladesh" },
            { subject: "", op: "is", value: "" },
          ],
        }),
        "published",
      ),
      "qualifiers",
    );
    expect(qualifiers.values.slice(3)).toEqual([
      { label: "Rule 1", value: { kind: "value", text: "Location is not one of India or Bangladesh" } },
    ]);
  });

  it("reads the voice guidelines back, and states their absence in words", () => {
    const voice = row(offerReview(offer({ voiceGuidelines: "Warm, never pushy." }), "published"), "voice");
    expect(voice.values[1]).toEqual({
      label: "Voice guidelines",
      value: { kind: "value", text: "Warm, never pushy." },
    });
    expect(row(offerReview(offer(), "published"), "voice").values[1].value.kind).toBe("absent");
  });

  it("keeps a real zero minimum distinguishable from an unset one", () => {
    const qualifiers = row(offerReview(offer({ creditMin: 0 }), "published"), "qualifiers");
    expect(qualifiers.values[0].value).toEqual({ kind: "value", text: "0" });
  });

  it("reads prices back exactly as saved, with the period they were saved with", () => {
    const prices = row(
      offerReview(
        offer({
          offerPrices: [
            {
              amountCents: 450_000,
              billingPeriod: "one_time",
              id: "price-1",
              label: "The Funding Accelerator",
            },
            {
              amountCents: 29_700,
              billingPeriod: "monthly",
              id: "price-2",
              label: "Credit Repair Plan",
            },
          ],
        }),
        "published",
      ),
      "prices",
    );
    expect(prices.values.map((entry) => entry.value.text)).toEqual([
      "The Funding Accelerator: $4,500 one time",
      "Credit Repair Plan: $297 a month",
    ]);
  });

  it("says the agent will not quote a price it does not have", () => {
    const prices = row(offerReview(offer(), "published"), "prices");
    expect(prices.values[0].value.kind).toBe("absent");
    expect(prices.values[0].value.text).toContain("will not quote");
    expect(prices.note).toContain("never invent a number");
  });

  it("is ready only once there is both a programme name and a price", () => {
    expect(offerReview(offer({ programName: "The Funding Accelerator" }), "published").ready)
      .toBe(false);
    expect(
      offerReview(
        offer({
          offerPrices: [
            { amountCents: 450_000, billingPeriod: "one_time", id: "p", label: "Accelerator" },
          ],
          programName: "The Funding Accelerator",
        }),
        "published",
      ).ready,
    ).toBe(true);
  });

  it("reports a draft as a draft, so nothing reads live that is not", () => {
    expect(offerReview(offer({ status: "draft" }), "draft").source).toBe("draft");
    expect(offerReview(null, "draft").source).toBe("none");
  });

  it("treats a whitespace-only programme name as unnamed", () => {
    const program = row(offerReview(offer({ programName: "   " }), "published"), "program");
    expect(program.values[0].value.kind).toBe("absent");
  });
});
