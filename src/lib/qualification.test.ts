import { describe, expect, it } from "vitest";

import {
  DEMO_QUALIFICATION_RULES,
  normalizeBrainOutcomeOverrides,
  resolveDemoQualification,
  type QualificationContext,
} from "@/lib/domain/qualification";

const base: QualificationContext = {
  score: 720,
  businessStage: "operating",
  annualRevenue: 90_000,
  fundingGoal: "$50K–100K",
  timeline: "1–3mo",
};

describe("resolveDemoQualification", () => {
  it("books a strong-credit lead regardless of stage or goal", () => {
    expect(resolveDemoQualification({ ...base, score: 700 })?.outcome).toBe("BOOK");
    expect(
      resolveDemoQualification({ ...base, score: 810, businessStage: "startup", fundingGoal: null })?.outcome,
    ).toBe("BOOK");
  });

  it("hard-disqualifies below 600", () => {
    const result = resolveDemoQualification({ ...base, score: 540 });
    expect(result?.outcome).toBe("HARD_DQ");
    expect(result?.id).toBe("low-credit");
  });

  it("routes a 600–640 startup to nurture rather than a call", () => {
    expect(
      resolveDemoQualification({ ...base, score: 615, businessStage: "startup" })?.outcome,
    ).toBe("SOFT_DQ");
  });

  it("returns no row for a mid-band lead missing required inputs, instead of guessing", () => {
    // 640–680 needs revenue, goal, and timeline. Missing any of them must fall
    // through to null so the agent asks rather than inventing a booking outcome.
    expect(resolveDemoQualification({ ...base, score: 660, annualRevenue: null })).toBeNull();
    expect(resolveDemoQualification({ ...base, score: 660, fundingGoal: null })).toBeNull();
    expect(resolveDemoQualification({ ...base, score: 660, timeline: null })).toBeNull();
  });

  it("books the mid band once every required input clears", () => {
    expect(resolveDemoQualification({ ...base, score: 660 })?.outcome).toBe("BOOK");
  });

  it("evaluates top to bottom so the first matching row wins", () => {
    // strong-credit sits above revenue-qualified, so a 700+ lead must never be
    // decided by the narrower row below it.
    expect(resolveDemoQualification({ ...base, score: 700 })?.id).toBe("strong-credit");
  });
});

describe("normalizeBrainOutcomeOverrides", () => {
  it("keeps overrides that name a real rule and a real outcome", () => {
    expect(normalizeBrainOutcomeOverrides({ "low-credit": "SOFT_DQ" })).toEqual({
      "low-credit": "SOFT_DQ",
    });
  });

  it("drops unknown rule ids so a caller cannot inject a rule", () => {
    expect(normalizeBrainOutcomeOverrides({ "not-a-rule": "BOOK" })).toEqual({});
  });

  it("drops values outside the outcome vocabulary", () => {
    expect(normalizeBrainOutcomeOverrides({ "low-credit": "ALWAYS_BOOK" })).toEqual({});
    expect(normalizeBrainOutcomeOverrides({ "low-credit": 1 })).toEqual({});
  });

  it("returns an empty object for non-object input rather than throwing", () => {
    expect(normalizeBrainOutcomeOverrides(null)).toEqual({});
    expect(normalizeBrainOutcomeOverrides("BOOK")).toEqual({});
    expect(normalizeBrainOutcomeOverrides(["low-credit"])).toEqual({});
  });

  it("covers every shipped rule id, so a new rule cannot be added without a decision", () => {
    const ids = DEMO_QUALIFICATION_RULES.map((rule) => rule.id);
    expect(ids).toEqual(["strong-credit", "low-credit", "startup-nurture", "revenue-qualified"]);
  });
});
