import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  COACH_OWNED_SECTIONS,
  coachOwnedAnswers,
  qualificationFacts,
  type CoachOwnedAnswerSource,
} from "./coach-owned-sections";

function offer(overrides: Partial<CoachOwnedAnswerSource> = {}): CoachOwnedAnswerSource {
  return {
    creditMin: null,
    fundingGoalMinCents: null,
    fundingGoalMaxCents: null,
    monthlyRevenueMinCents: null,
    creditRepair: null,
    refundPosture: null,
    brandVoice: null,
    voiceStyleAnswer: null,
    voiceObjectionAnswer: null,
    voiceFollowupAnswer: null,
    offerPrices: [],
    cadencePurposes: [],
    ...overrides,
  };
}

describe("COACH_OWNED_SECTIONS", () => {
  it("names four sections, each with real coach-writable storage behind it", () => {
    expect(COACH_OWNED_SECTIONS.map((section) => section.key)).toEqual([
      "prices",
      "voice",
      "qualification",
      "cadence",
    ]);
  });

  // The two rows screen 5c draws that have no writable column behind them. "When you take calls"
  // would need a weekday set and an hours window, and `calendar_connections` stores neither;
  // "Who gets hot leads" would need a nominated owner, and `conversations.taken_over_by` only
  // records who took a thread after the fact. Both belong to the managed strip, and this keeps
  // them from drifting back into a list that promises the coach a control.
  it("does not offer to set the two things the schema cannot store", () => {
    const labels = COACH_OWNED_SECTIONS.map((section) => section.label);
    expect(labels).not.toContain("When you take calls");
    expect(labels).not.toContain("Who gets hot leads");
  });

  it("is the only place the count comes from, so the two pages cannot disagree", () => {
    const source = readFileSync("src/components/workspace/live/coach-offer.tsx", "utf8");
    expect(source).toContain("countWord(COACH_OWNED_SECTIONS.length)");
    // A local array here is the regression: it would let the editor say "five things are yours to
    // set" while the Dashboard summarised four, about the same setter, on the same account.
    expect(source).not.toMatch(/const\s+\w+_SECTIONS\s*:\s*readonly OfferTab\[\]/u);
  });
});

describe("qualificationFacts", () => {
  it("counts six facts, and an untouched control is not one of them", () => {
    expect(qualificationFacts(offer())).toHaveLength(6);
    expect(qualificationFacts(offer()).filter((value) => value !== null)).toHaveLength(0);
    expect(
      qualificationFacts(offer({ creditMin: 620, monthlyRevenueMinCents: 500_000 }))
        .filter((value) => value !== null),
    ).toHaveLength(2);
  });
});

describe("coachOwnedAnswers", () => {
  it("returns null when nothing is published, rather than four rows of our defaults", () => {
    expect(coachOwnedAnswers(null)).toBeNull();
  });

  it("says what we do instead for every section the coach has never set", () => {
    const answers = coachOwnedAnswers(offer());
    expect(answers).not.toBeNull();
    for (const section of COACH_OWNED_SECTIONS) {
      expect(answers?.[section.key].set).toBe(false);
    }
    expect(answers?.prices.text).toBe("no price the agent can quote");
    expect(answers?.voice.text).toBe("using our standard voice");
    expect(answers?.qualification.text).toBe("no qualifying rules saved");
    expect(answers?.cadence.text).toBe("using our default purposes");
  });

  it("states what the coach saved, and marks it as theirs", () => {
    const answers = coachOwnedAnswers(offer({
      offerPrices: [{}, {}],
      brandVoice: "neutral",
      voiceStyleAnswer: "short sentences",
      creditMin: 620,
      cadencePurposes: [{}],
    }));

    expect(answers?.prices).toEqual({ set: true, text: "2 prices the agent may quote" });
    expect(answers?.voice).toEqual({ set: true, text: "Balanced, 1 answer written" });
    expect(answers?.qualification).toEqual({ set: true, text: "1 of 6 qualifying facts" });
    expect(answers?.cadence).toEqual({ set: true, text: "1 touch given a purpose" });
  });

  // Whitespace is not an answer. A voice field saved as spaces would otherwise count as written
  // and tell the coach they had set something they had not.
  it("does not count a blank voice answer as written", () => {
    const answers = coachOwnedAnswers(offer({ voiceStyleAnswer: "   " }));
    expect(answers?.voice).toEqual({ set: false, text: "using our standard voice" });
  });
});
