import { describe, expect, it } from "vitest";

import { loadSafetyCorpus, type SafetyCorpusCase } from "@/lib/evals/corpus";
import {
  assertComparisonConfigs,
  caseSetHash,
  compareEvalRuns,
  ENGINE_COMPARISON_CASES,
  type ComparisonCaseResult,
  type ComparisonEvidence,
  type ComparisonModelConfig,
} from "@/lib/evals/comparison";
import { EVAL_SUITE_NAMES, type EvalSuiteName } from "@/lib/repositories/eval-runs";

const HASH = "a".repeat(64);
const CASE_HASH = caseSetHash();

function config(overrides: Partial<ComparisonModelConfig> = {}): ComparisonModelConfig {
  return {
    id: "config-a",
    model: "vendor/model-a",
    params: { temperature: 0 },
    role: "generator",
    active: true,
    ...overrides,
  };
}

function result(
  suite: EvalSuiteName,
  caseKey: string,
  overrides: Partial<ComparisonCaseResult> = {},
): ComparisonCaseResult {
  return {
    suite,
    caseKey,
    passed: true,
    trace: { providerCostCredits: 0.25 },
    latencyMs: 10,
    ...overrides,
  };
}

function evidence(overrides: Partial<ComparisonEvidence> = {}): ComparisonEvidence {
  const engineResults = ENGINE_COMPARISON_CASES.map((testCase, index) => result(
    testCase.suite,
    testCase.key,
    { latencyMs: (index + 1) * 10 },
  ));
  const judgments = (["qualification_accuracy", "voice_tone"] as const).map((suite) => result(
    suite,
    `${suite}:not-configured`,
    { passed: false, trace: { status: "not_configured" }, latencyMs: null },
  ));
  const baseRun = {
    brainDraftVersionId: "draft-1",
    contentHash: HASH,
    kind: "engine" as const,
    brainVersion: 4,
    offerVersion: 2,
    rulesVersion: "rules-1",
    knowledgeMode: "inline" as const,
    corpusRevision: loadSafetyCorpus().revision,
    suitesComplete: true,
    comparisonId: "comparison-1",
    caseSetHash: CASE_HASH,
    results: [...engineResults, ...judgments],
  };
  return {
    comparisonId: "comparison-1",
    status: "completed",
    brainDraftVersionId: "draft-1",
    contentHash: HASH,
    modelConfigAId: "config-a",
    modelConfigBId: "config-b",
    caseSetHash: CASE_HASH,
    runAId: "run-a",
    runBId: "run-b",
    createdAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:01:00.000Z",
    driverArm: "mock",
    runA: { ...baseRun, id: "run-a", modelConfigId: "config-a", comparisonArm: "a" },
    runB: { ...baseRun, id: "run-b", modelConfigId: "config-b", comparisonArm: "b" },
    ...overrides,
  };
}

describe("evidence-bound eval comparison", () => {
  it("hashes the exact engine case keys and normalized turns independently of corpus order", () => {
    expect(caseSetHash([...ENGINE_COMPARISON_CASES].reverse())).toBe(CASE_HASH);
    expect(CASE_HASH).not.toBe(loadSafetyCorpus().revision);
    const changed = ENGINE_COMPARISON_CASES.map((testCase, index) => index === 0
      ? { ...testCase, turns: [{ ...testCase.turns[0], content: `${testCase.turns[0].content} changed` }] }
      : testCase) as readonly SafetyCorpusCase[];
    expect(caseSetHash(changed)).not.toBe(CASE_HASH);
  });

  it("admits active generator A and inactive distinct challenger B", () => {
    expect(() => assertComparisonConfigs(
      config(),
      config({ id: "config-b", model: "vendor/model-b", active: false }),
    )).not.toThrow();
  });

  it("refuses the same config, a moderator, and a differently identified duplicate configuration", () => {
    expect(() => assertComparisonConfigs(config(), config())).toThrow(
      "EVAL_COMPARISON_CONFIGS_MUST_DIFFER",
    );
    expect(() => assertComparisonConfigs(
      config(),
      config({ id: "config-b", role: "moderator", active: false }),
    )).toThrow("EVAL_COMPARISON_GENERATOR_CONFIG_REQUIRED");
    expect(() => assertComparisonConfigs(
      config(),
      config({ id: "config-b", active: false }),
    )).toThrow("EVAL_COMPARISON_CONFIGURATIONS_IDENTICAL");
  });

  it("refuses draft, runtime, case-hash and result-key drift before returning metrics", () => {
    const base = evidence();
    const mismatches: ComparisonEvidence[] = [
      { ...base, runB: { ...base.runB!, contentHash: "b".repeat(64) } },
      { ...base, runB: { ...base.runB!, offerVersion: 3 } },
      { ...base, runB: { ...base.runB!, caseSetHash: "c".repeat(64) } },
      { ...base, runB: { ...base.runB!, results: base.runB!.results.slice(1) } },
    ];
    for (const mismatch of mismatches) expect(() => compareEvalRuns(mismatch)).toThrow();
  });

  it("renders not-configured suites as non-comparable with no numeric residue", () => {
    const compared = compareEvalRuns(evidence());
    expect(compared.state).toBe("non_comparable");
    expect(compared.stateReason).toBe("qualification_accuracy:not_configured");
    for (const suite of compared.suites.filter((entry) => entry.state === "not_configured")) {
      expect(Object.values(suite.armA).every((value) => value === null)).toBe(true);
      expect(Object.values(suite.armB).every((value) => value === null)).toBe(true);
    }
  });

  it("holds a judged suite incomplete when either arm errored on a case", () => {
    const base = evidence();
    const scored = (results: readonly ComparisonCaseResult[]) => results.map((entry) =>
      entry.caseKey === "qualification_accuracy:not-configured"
        ? { ...entry, passed: true, trace: { status: "scored", providerCostCredits: 0.25 }, latencyMs: 12 }
        : entry);
    const bothScored = {
      ...base,
      runA: { ...base.runA!, results: scored(base.runA!.results) },
      runB: { ...base.runB!, results: scored(base.runB!.results) },
    };
    expect(compareEvalRuns(bothScored).suites
      .find((suite) => suite.suite === "qualification_accuracy")!.state).toBe("comparable");

    const errored = compareEvalRuns({
      ...bothScored,
      runB: {
        ...bothScored.runB,
        results: bothScored.runB.results.map((entry) =>
          entry.caseKey === "qualification_accuracy:not-configured"
            ? { ...entry, passed: false, trace: { status: "errored", code: "JUDGE_VERDICT_REFUSED" } }
            : entry),
      },
    });
    const suite = errored.suites.find((entry) => entry.suite === "qualification_accuracy")!;
    expect(suite.state).toBe("incomplete");
    expect(Object.values(suite.armA).every((value) => value === null)).toBe(true);
    expect(errored.state).toBe("non_comparable");
  });

  it("computes per-suite pass, false-block, provider-credit and nearest-rank latency evidence", () => {
    const base = evidence();
    const targetSuite = ENGINE_COMPARISON_CASES[0].suite;
    const suiteCases = ENGINE_COMPARISON_CASES.filter((entry) => entry.suite === targetSuite);
    const negative = suiteCases.find((entry) => entry.expectation.verdict === "pass");
    const armAResults = base.runA!.results.map((entry) => entry.caseKey === negative?.key
      ? { ...entry, passed: false }
      : entry);
    const compared = compareEvalRuns({ ...base, runA: { ...base.runA!, results: armAResults } });
    const suite = compared.suites.find((entry) => entry.suite === targetSuite)!;
    expect(suite.state).toBe("comparable");
    expect(suite.armA.total).toBe(suiteCases.length);
    expect(suite.armA.providerCostCredits).toBe(suiteCases.length * 0.25);
    expect(suite.armA.costPerThousandCredits).toBe(250);
    expect(suite.armA.latencyP50Ms).not.toBeNull();
    expect(suite.armA.latencyP95Ms).not.toBeNull();
    expect(suite.armA.falseBlocks).toBe(negative ? 1 : 0);
  });

  it("keeps missing provider cost unavailable instead of treating it as zero", () => {
    const base = evidence();
    const first = base.runA!.results[0];
    const results = base.runA!.results.map((entry) => entry === first
      ? { ...entry, trace: {} }
      : entry);
    const compared = compareEvalRuns({ ...base, runA: { ...base.runA!, results } });
    const suite = compared.suites.find((entry) => entry.suite === first.suite)!;
    expect(suite.armA.providerCostCredits).toBeNull();
    expect(suite.armA.costPerCaseCredits).toBeNull();
    expect(suite.armA.costPerThousandCredits).toBeNull();
  });

  it("keeps the closed six-suite ordering so a new suite cannot acquire partial evidence", () => {
    expect(compareEvalRuns(evidence()).suites.map((suite) => suite.suite)).toEqual(EVAL_SUITE_NAMES);
  });
});
