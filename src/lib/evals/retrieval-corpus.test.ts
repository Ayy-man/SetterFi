import { describe, expect, it } from "vitest";

import { SAFETY_SUITES } from "./corpus";
import {
  loadRetrievalCorpus,
  normalizeEntryQuestion,
  RETRIEVAL_ENTRY_CATEGORIES,
  RETRIEVAL_SUITE,
} from "./retrieval-corpus";

function source(overrides: Record<string, unknown> = {}) {
  return {
    suite: RETRIEVAL_SUITE,
    offer: {
      programName: "Synthetic Funding",
      creditMin: 640,
      fundingGoalMinCents: 5_000_000,
      fundingGoalMaxCents: 15_000_000,
      monthlyRevenueMinCents: null,
      businessRevenueRequired: false,
      bookingUrl: null,
      qualificationSummary: "synthetic requirements",
      qualificationInputs: ["credit range"],
    },
    entries: [
      { question: "How much does it cost?", category: "Program/Service", responseTemplate: "Synthetic answer." },
    ],
    cases: [
      { key: "synthetic:cost", leadMessage: "how much is it", expected: { entryQuestion: "how much does it cost" } },
      { key: "synthetic:nomatch", leadMessage: "weather?", expected: { noMatch: true } },
    ],
    ...overrides,
  };
}

describe("retrieval corpus loader", () => {
  it("is not one of the safety suites and loads the checked-in file with both expectation shapes", () => {
    expect((SAFETY_SUITES as readonly string[]).includes(RETRIEVAL_SUITE)).toBe(false);
    const corpus = loadRetrievalCorpus();
    expect(corpus.suite).toBe(RETRIEVAL_SUITE);
    expect(corpus.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(25);
    expect(corpus.cases.filter((testCase) => testCase.expected.kind === "no_match").length).toBeGreaterThanOrEqual(6);
    expect(new Set(corpus.entries.map((entry) => entry.category))).toEqual(new Set(RETRIEVAL_ENTRY_CATEGORIES));
    expect(corpus.fixture.offer.status).toBe("published");
    expect(corpus.fixture.renderSources.bookingUrl).toMatch(/^https:\/\//);
  });

  it("never copies an entry question verbatim as a lead message", () => {
    const corpus = loadRetrievalCorpus();
    const questions = new Set(corpus.entries.map((entry) => normalizeEntryQuestion(entry.question)));
    for (const testCase of corpus.cases) {
      expect(questions.has(normalizeEntryQuestion(testCase.leadMessage)), testCase.key).toBe(false);
    }
  });

  it("resolves entryQuestion references case- and punctuation-insensitively", () => {
    const corpus = loadRetrievalCorpus(source());
    expect(corpus.cases[0].expected).toEqual({ kind: "entry", entryQuestion: "how much does it cost" });
    expect(corpus.cases[1].expected).toEqual({ kind: "no_match" });
    expect(corpus.cases[0].channel).toBeNull();
  });

  it.each([
    ["unknown entryQuestion", { cases: [
      { key: "a", leadMessage: "x", expected: { entryQuestion: "Unknown?" } },
      { key: "b", leadMessage: "y", expected: { noMatch: true } },
    ] }, "expected.entryQuestion_unknown"],
    ["both shapes at once", { cases: [
      { key: "a", leadMessage: "x", expected: { entryQuestion: "How much does it cost?", noMatch: true } },
      { key: "b", leadMessage: "y", expected: { noMatch: true } },
    ] }, "expected_exactly_one_shape"],
    ["noMatch false", { cases: [
      { key: "a", leadMessage: "x", expected: { entryQuestion: "How much does it cost?" } },
      { key: "b", leadMessage: "y", expected: { noMatch: false } },
    ] }, "expected.noMatch"],
    ["duplicate key", { cases: [
      { key: "a", leadMessage: "x", expected: { entryQuestion: "How much does it cost?" } },
      { key: "a", leadMessage: "y", expected: { noMatch: true } },
    ] }, "duplicate_case_key"],
    ["unknown channel", { cases: [
      { key: "a", leadMessage: "x", channel: "carrier_pigeon", expected: { entryQuestion: "How much does it cost?" } },
      { key: "b", leadMessage: "y", expected: { noMatch: true } },
    ] }, "channel"],
    ["missing no-match case", { cases: [
      { key: "a", leadMessage: "x", expected: { entryQuestion: "How much does it cost?" } },
    ] }, "no_match_case_required"],
    ["unknown category", { entries: [
      { question: "How much does it cost?", category: "Pricing", responseTemplate: "x" },
    ] }, "category"],
    ["duplicate entry question", { entries: [
      { question: "How much does it cost?", category: "Credit", responseTemplate: "x" },
      { question: "how much does it cost", category: "Credit", responseTemplate: "y" },
    ] }, "duplicate_question"],
    ["wrong suite", { suite: "compliance_guardrails" }, "suite"],
  ])("refuses %s", (_label, overrides, reason) => {
    expect(() => loadRetrievalCorpus(source(overrides))).toThrow(`RETRIEVAL_CORPUS_INVALID`);
    expect(() => loadRetrievalCorpus(source(overrides))).toThrow(reason);
  });
});
