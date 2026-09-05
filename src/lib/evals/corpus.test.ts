import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { OUTPUT_CHECK_CLASSES } from "@/lib/engine/types";
import {
  ENGINE_CASE_CATEGORIES,
  loadSafetyCorpus,
  PHASE3_INBOUND_EXPECTATIONS,
  SAFETY_SUITES,
} from "./corpus";

function syntheticCase(overrides: Record<string, unknown> = {}) {
  const reference = loadSafetyCorpus().cases[0];
  return {
    key: "synthetic:phase3",
    kind: "checker",
    turns: [{ role: "agent", content: "Synthetic reviewed output" }],
    expectation: { verdict: "pass", class: "CLAIM", ruleIds: [] },
    context: reference.context,
    ...overrides,
  };
}

describe("Phase 3 safety corpus metadata", () => {
  it("keeps the four existing suites closed without a suppression suite or file", () => {
    expect(SAFETY_SUITES).toEqual([
      "compliance_guardrails",
      "pricing_discipline",
      "jailbreak_injection",
      "output_integrity",
    ]);
    expect(existsSync(resolve(process.cwd(), "evals/corpus/suppression.json"))).toBe(false);
    expect([...new Set(loadSafetyCorpus().cases.map((testCase) => testCase.suite))])
      .toEqual(SAFETY_SUITES);
  });

  it("accepts only the five frozen optional inbound expectation classes", () => {
    expect(PHASE3_INBOUND_EXPECTATIONS).toEqual([
      "scope_attack",
      "tripwire_refuse",
      "tripwire_escalate",
      "suppression_keyword",
      "sanitizer",
    ]);
    for (const inboundExpectation of PHASE3_INBOUND_EXPECTATIONS) {
      const loaded = loadSafetyCorpus([{
        suite: "compliance_guardrails",
        cases: [syntheticCase({ inboundExpectation })],
      }], { requireAllSuites: false });
      expect(loaded.cases[0].inboundExpectation).toBe(inboundExpectation);
    }
  });

  it("refuses an unknown inbound class and duplicate key before loading any run", () => {
    expect(() => loadSafetyCorpus([{
      suite: "compliance_guardrails",
      cases: [syntheticCase({ inboundExpectation: "invented_class" })],
    }], { requireAllSuites: false })).toThrow(
      "SAFETY_CORPUS_INVALID:synthetic:phase3:inboundExpectation",
    );

    expect(() => loadSafetyCorpus([{
      suite: "compliance_guardrails",
      cases: [syntheticCase(), syntheticCase()],
    }], { requireAllSuites: false })).toThrow(
      "SAFETY_CORPUS_INVALID:synthetic:phase3:duplicate_case_key",
    );
  });
});

describe("engine case corpus shape", () => {
  const engineCases = loadSafetyCorpus().cases.filter((testCase) => testCase.kind === "engine");

  it("gives every engine case a unique key, a known category and a well-formed expectation", () => {
    expect(engineCases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(engineCases.map((testCase) => testCase.key)).size).toBe(engineCases.length);
    for (const testCase of engineCases) {
      expect(ENGINE_CASE_CATEGORIES, testCase.key).toContain(testCase.category);
      expect(OUTPUT_CHECK_CLASSES, testCase.key).toContain(testCase.expectation.class);
      expect(testCase.turns.at(-1)?.role, testCase.key).toBe("lead");
      if (testCase.expectation.verdict === "block") {
        expect(testCase.expectation.ruleIds, testCase.key).toEqual([`${testCase.expectation.class}-001`]);
      } else {
        expect(testCase.expectation.ruleIds, testCase.key).toEqual([]);
      }
      for (const note of testCase.notes ?? []) expect(note.trim(), testCase.key).not.toBe("");
    }
  });

  it("measures real work as well as attacks: every category has at least one case", () => {
    const categories = new Set(engineCases.map((testCase) => testCase.category));
    for (const category of ENGINE_CASE_CATEGORIES) expect(categories, category).toContain(category);
    const clean = engineCases.filter((testCase) => testCase.expectation.verdict === "pass");
    expect(clean.length).toBeGreaterThanOrEqual(12);
  });

  it("refuses an engine case without a category, an unknown category, a category on a checker case, and a blank note", () => {
    const engine = (overrides: Record<string, unknown>) => loadSafetyCorpus([{
      suite: "compliance_guardrails",
      cases: [syntheticCase({ kind: "engine", turns: [{ role: "lead", content: "hi" }], ...overrides })],
    }], { requireAllSuites: false });
    expect(() => engine({})).toThrow("SAFETY_CORPUS_INVALID:synthetic:phase3:category");
    expect(() => engine({ category: "invented" })).toThrow("SAFETY_CORPUS_INVALID:synthetic:phase3:category");
    expect(() => engine({ category: "booking", notes: [" "] })).toThrow("SAFETY_CORPUS_INVALID:synthetic:phase3:notes");
    expect(engine({ category: "booking", notes: ["Must not invent a slot."] }).cases[0]).toMatchObject({
      category: "booking", notes: ["Must not invent a slot."],
    });
    expect(() => loadSafetyCorpus([{
      suite: "compliance_guardrails",
      cases: [syntheticCase({ category: "booking" })],
    }], { requireAllSuites: false })).toThrow("SAFETY_CORPUS_INVALID:synthetic:phase3:checker_category");
  });
});
