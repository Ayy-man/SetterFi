import { describe, expect, it } from "vitest";

import {
  PLACEHOLDER_REGISTRY,
  normalizePlaceholderToken,
  placeholderDefinition,
  resolvePlaceholder,
} from "./placeholders";

describe("placeholder registry", () => {
  it("pins every canonical token, source and grammatical form", () => {
    expect(Object.values(PLACEHOLDER_REGISTRY).map(({ token, sourcePath, grammaticalForm }) =>
      [token, sourcePath, grammaticalForm])).toEqual([
      ["niche", "offer.programName", "noun_phrase"],
      ["target_funding_amount", "offer.fundingGoalMinCents..offer.fundingGoalMaxCents", "currency_range"],
      ["booking_link", "renderSources.bookingUrl", "url"],
      ["requirements", "renderSources.qualificationSummary", "noun_phrase"],
      ["qualifying_questions", "renderSources.qualificationInputs", "question_list"],
      ["dream_outcome", "derived:dreamOutcome", "verb_phrase"],
      ["income_qualifiers", "derived:incomeQualifiers", "adjective_phrase"],
    ]);
  });

  it("normalizes square brackets and the exact target-funding alias", () => {
    expect(normalizePlaceholderToken("[dream outcome]")).toBe("dream_outcome");
    expect(normalizePlaceholderToken("{{ target funding }}")).toBe("target_funding_amount");
    expect(normalizePlaceholderToken("[target funding amount]")).toBe("target_funding_amount");
  });

  it("treats stable asset slugs as required URL tokens", () => {
    expect(placeholderDefinition("{{asset.free-course}}")).toMatchObject({
      token: "asset.free-course",
      sourcePath: "renderSources.assetUrlsBySlug.free-course",
      required: true,
      grammaticalForm: "url",
    });
    expect(resolvePlaceholder("asset.free-course", null).status).toBe("drop");
  });

  it("refuses unknown tokens and drops unresolved required values", () => {
    expect(placeholderDefinition("invented_token")).toBeNull();
    expect(resolvePlaceholder("invented_token", "literal")).toEqual({
      status: "drop", reason: "unknown placeholder: invented_token",
    });
    expect(resolvePlaceholder("niche", null)).toEqual({
      status: "drop", reason: "required placeholder unresolved: niche",
    });
  });

  it("uses neutral grammatical fallbacks only for optional tokens", () => {
    expect(resolvePlaceholder("dream_outcome", null)).toEqual({
      status: "fallback", value: "move toward your funding goals",
    });
    expect(resolvePlaceholder("income_qualifiers", null)).toEqual({
      status: "fallback", value: "already generating revenue",
    });
    expect(resolvePlaceholder("qualifying_questions", ["What is your goal?", "When do you need it?"])).toEqual({
      status: "resolved", value: "What is your goal?; When do you need it?",
    });
  });
});
