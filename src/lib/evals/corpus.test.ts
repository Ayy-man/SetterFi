import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
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
