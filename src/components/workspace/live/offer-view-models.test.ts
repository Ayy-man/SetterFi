import { describe, expect, it } from "vitest";

import type { PersistedOfferLayer } from "@/lib/offer/types";

import {
  nullableNumber,
  nullableNumberFieldError,
  offerRefusalView,
  offerStateView,
  publishedOfferView,
  savedDraftView,
  unresolvedOfferAnswers,
} from "./offer-view-models";

function offer(status: PersistedOfferLayer["status"], version: number): PersistedOfferLayer {
  return {
    id: `${status}-${version}`,
    tenantId: "tenant-1",
    status,
    version,
    contentHash: "a".repeat(64),
    programName: "Synthetic program",
    programDescription: null,
    creditMin: 640,
    fundingGoalMinCents: 5_000_000,
    fundingGoalMaxCents: 15_000_000,
    monthlyRevenueMinCents: null,
    businessRevenueRequired: false,
    creditRepair: null,
    products: [],
    bookingHorizonDays: 21,
    bookingMode: "direct",
    brandVoice: "professional",
    resultsTimelineMinDays: null,
    resultsTimelineMaxDays: null,
    refundPosture: null,
    voiceStyleAnswer: null,
    voiceObjectionAnswer: null,
    voiceFollowupAnswer: null,
    offerPrices: [],
    proof: [],
    assets: [],
    cadencePurposes: [],
  };
}

describe("Coach offer honest-state view models", () => {
  it("keeps the prior published offer visibly live while a draft awaits review", () => {
    expect(offerStateView({ draft: offer("draft", 3), published: offer("published", 2) })).toEqual({
      label: "Draft v3 awaiting platform review",
      detail: "Published v2 remains live",
      tone: "pending",
    });
  });

  it("counts unresolved bounded answers rather than claiming readiness", () => {
    expect(unresolvedOfferAnswers(offer("draft", 1))).toBe(3);
    expect(unresolvedOfferAnswers(null)).toBe(6);
  });

  it("claims a saved draft only from a complete persisted read-back", () => {
    expect(savedDraftView({ state: "draft", draft: offer("draft", 2) })).toMatchObject({
      saved: true, label: "Saved as draft v2",
    });
    expect(savedDraftView({ state: "draft", draft: { status: "draft" } })).toMatchObject({ saved: false });
  });

  it("claims Published and Logged only from a matching registry receipt", () => {
    const published = offer("published", 4);
    expect(publishedOfferView({ state: "published", offer: published, receipt: { offerId: published.id } })).toMatchObject({ published: false, logged: false });
    expect(publishedOfferView({
      state: "published",
      offer: published,
      receipt: { auditId: "audit-1", actionKey: "offer.published", offerId: published.id, offerVersion: 4, contentHash: published.contentHash },
    })).toMatchObject({ published: true, logged: true, label: "Published v4" });
  });

  it("maps route refusals to field-oriented copy", () => {
    expect(offerRefusalView("OFFER_SAVE_REFUSED")).toBe(
      "One or more offer fields could not be saved. No draft change was confirmed. Review the offer fields and try saving again.",
    );
  });

  it("returns a discriminated result for nullable numeric input", () => {
    expect(nullableNumber(" ")).toEqual({ ok: true, value: null });
    expect(nullableNumber("640")).toEqual({ ok: true, value: 640 });
    expect(nullableNumber("not a number")).toEqual({ ok: false, reason: "not_a_number" });
    expect(nullableNumber("1.5")).toEqual({ ok: false, reason: "out_of_range" });
    expect(nullableNumber(String(Number.MAX_SAFE_INTEGER + 1))).toEqual({
      ok: false,
      reason: "out_of_range",
    });
  });

  it("names the field in every numeric input error", () => {
    expect(nullableNumberFieldError("Minimum credit score", "not_a_number")).toBe(
      "Minimum credit score must be a number.",
    );
    expect(nullableNumberFieldError("Minimum credit score", "out_of_range")).toBe(
      "Minimum credit score must be a whole number within the supported range.",
    );
  });
});
