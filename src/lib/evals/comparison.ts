/**
 * Evidence comparison is deliberately pure.
 *
 * Repository code owns execution and persistence; this module owns the refusal boundary that
 * prevents two different case sets, content versions, or result identities becoming a verdict.
 */

import { createHash } from "node:crypto";

import { serializeCanonicalJson, type CanonicalJson } from "@/lib/brain/snapshot/canonicalize";
import {
  EVAL_SUITE_NAMES,
  type EvalSuiteName,
} from "@/lib/repositories/eval-runs";
import {
  loadSafetyCorpus,
  type SafetyCorpusCase,
} from "@/lib/evals/corpus";
import { judgmentCaseSetHash, type JudgmentCase } from "@/lib/evals/judgment-cases";

export const ENGINE_COMPARISON_CASES = loadSafetyCorpus().cases.filter(
  (testCase) => testCase.kind === "engine",
);

export type ComparisonModelConfig = {
  id: string;
  model: string;
  params: Readonly<Record<string, unknown>>;
  role: "generator" | "moderator";
  active: boolean;
};

export type ComparisonCaseResult = {
  caseKey: string;
  suite: EvalSuiteName;
  passed: boolean;
  trace: Readonly<Record<string, unknown>>;
  latencyMs: number | null;
};

export type ComparisonRunEvidence = {
  id: string;
  brainDraftVersionId: string;
  contentHash: string;
  kind: "checker" | "engine";
  modelConfigId: string | null;
  brainVersion: number | null;
  offerVersion: number | null;
  rulesVersion: string | null;
  knowledgeMode: "inline" | "retrieved" | null;
  corpusRevision: string;
  suitesComplete: boolean;
  comparisonId: string | null;
  comparisonArm: "a" | "b" | null;
  caseSetHash: string | null;
  results: readonly ComparisonCaseResult[];
};

export type ComparisonEvidence = {
  comparisonId: string;
  status: "pending" | "completed";
  brainDraftVersionId: string;
  contentHash: string;
  modelConfigAId: string;
  modelConfigBId: string;
  caseSetHash: string;
  runAId: string | null;
  runBId: string | null;
  createdAt: string;
  finishedAt: string | null;
  driverArm: "mock" | "real";
  runA: ComparisonRunEvidence | null;
  runB: ComparisonRunEvidence | null;
};

export type ComparisonSuiteState =
  | "comparable"
  | "not_configured"
  | "skipped"
  | "incomplete";

export type ComparisonArmMetrics = {
  passed: number | null;
  total: number | null;
  passRate: number | null;
  falseBlocks: number | null;
  negativeCases: number | null;
  providerCostCredits: number | null;
  costPerCaseCredits: number | null;
  costPerThousandCredits: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
};

export type ComparisonSuiteResult = {
  suite: EvalSuiteName;
  state: ComparisonSuiteState;
  armA: ComparisonArmMetrics;
  armB: ComparisonArmMetrics;
};

export type EvalComparisonResult = {
  comparisonId: string;
  status: "completed";
  state: "comparable" | "non_comparable";
  stateReason: string | null;
  driverArm: "mock" | "real";
  brainDraftVersionId: string;
  contentHash: string;
  brainVersion: number | null;
  offerVersion: number | null;
  rulesVersion: string | null;
  knowledgeMode: "inline" | "retrieved" | null;
  corpusRevision: string;
  caseSetHash: string;
  modelConfigAId: string;
  modelConfigBId: string;
  runAId: string;
  runBId: string;
  createdAt: string;
  finishedAt: string;
  suites: readonly ComparisonSuiteResult[];
};

function canonical(value: unknown) {
  return serializeCanonicalJson(value as CanonicalJson);
}

/**
 * The full corpus revision also includes checker cases; this hash owns only executed turns.
 *
 * Judgement cases append after the engine cases, so a comparison run before any conversation was
 * promoted keeps the digest it already had, and adding a promoted case changes it — two arms
 * scored against different judgement sets can never read as the same case set.
 */
export function caseSetHash(
  cases: readonly SafetyCorpusCase[] = ENGINE_COMPARISON_CASES,
  judgmentCases: readonly JudgmentCase[] = [],
) {
  const hash = createHash("sha256");
  for (const testCase of [...cases].sort((left, right) => left.key.localeCompare(right.key))) {
    hash.update(testCase.key);
    hash.update("\0");
    hash.update(canonical(testCase.turns));
    hash.update("\0");
  }
  if (judgmentCases.length > 0) hash.update(judgmentCaseSetHash(judgmentCases));
  return hash.digest("hex");
}

export function assertComparisonConfigs(
  configA: ComparisonModelConfig,
  configB: ComparisonModelConfig,
) {
  if (configA.id === configB.id) throw new Error("EVAL_COMPARISON_CONFIGS_MUST_DIFFER");
  if (configA.role !== "generator" || configB.role !== "generator") {
    throw new Error("EVAL_COMPARISON_GENERATOR_CONFIG_REQUIRED");
  }
  if (!configA.active) throw new Error("EVAL_COMPARISON_ACTIVE_CONFIG_REQUIRED");
  if (configB.active) throw new Error("EVAL_COMPARISON_CHALLENGER_MUST_BE_INACTIVE");
  if (configA.model === configB.model && canonical(configA.params) === canonical(configB.params)) {
    throw new Error("EVAL_COMPARISON_CONFIGURATIONS_IDENTICAL");
  }
}

function equal(left: unknown, right: unknown) {
  return canonical(left) === canonical(right);
}

function refuseOnEvidenceMismatch(
  evidence: ComparisonEvidence,
): asserts evidence is ComparisonEvidence & {
  status: "completed";
  runAId: string;
  runBId: string;
  finishedAt: string;
  runA: ComparisonRunEvidence;
  runB: ComparisonRunEvidence;
} {
  if (evidence.status !== "completed" || !evidence.runAId || !evidence.runBId ||
    !evidence.finishedAt || !evidence.runA || !evidence.runB) {
    throw new Error("EVAL_COMPARISON_INCOMPLETE");
  }
  const { runA, runB } = evidence;
  if (runA.id !== evidence.runAId || runB.id !== evidence.runBId || runA.id === runB.id ||
    runA.comparisonId !== evidence.comparisonId || runB.comparisonId !== evidence.comparisonId ||
    runA.comparisonArm !== "a" || runB.comparisonArm !== "b") {
    throw new Error("EVAL_COMPARISON_ARM_EVIDENCE_MISMATCH");
  }
  if (runA.modelConfigId !== evidence.modelConfigAId || runB.modelConfigId !== evidence.modelConfigBId ||
    runA.modelConfigId === runB.modelConfigId) {
    throw new Error("EVAL_COMPARISON_CONFIG_EVIDENCE_MISMATCH");
  }
  if (runA.kind !== "engine" || runB.kind !== "engine" ||
    !runA.suitesComplete || !runB.suitesComplete) {
    throw new Error("EVAL_COMPARISON_RUN_INCOMPLETE");
  }
  if (runA.brainDraftVersionId !== evidence.brainDraftVersionId ||
    runB.brainDraftVersionId !== evidence.brainDraftVersionId ||
    runA.contentHash !== evidence.contentHash || runB.contentHash !== evidence.contentHash) {
    throw new Error("EVAL_COMPARISON_DRAFT_MISMATCH");
  }
  if (runA.brainVersion !== runB.brainVersion || runA.offerVersion !== runB.offerVersion ||
    runA.rulesVersion !== runB.rulesVersion || runA.knowledgeMode !== runB.knowledgeMode ||
    runA.corpusRevision !== runB.corpusRevision) {
    throw new Error("EVAL_COMPARISON_RUN_CONTEXT_MISMATCH");
  }
  if (runA.caseSetHash !== evidence.caseSetHash || runB.caseSetHash !== evidence.caseSetHash) {
    throw new Error("EVAL_COMPARISON_CASE_SET_HASH_MISMATCH");
  }
  const identities = (run: ComparisonRunEvidence) => run.results
    .map((result) => `${result.suite}:${result.caseKey}`)
    .sort();
  if (!equal(identities(runA), identities(runB))) {
    throw new Error("EVAL_COMPARISON_RESULT_KEY_MISMATCH");
  }
}

function emptyMetrics(): ComparisonArmMetrics {
  return {
    passed: null,
    total: null,
    passRate: null,
    falseBlocks: null,
    negativeCases: null,
    providerCostCredits: null,
    costPerCaseCredits: null,
    costPerThousandCredits: null,
    latencyP50Ms: null,
    latencyP95Ms: null,
  };
}

function statusOf(results: readonly ComparisonCaseResult[]): ComparisonSuiteState {
  if (results.length === 0) return "incomplete";
  const statuses = results.map((result) => result.trace.status);
  if (statuses.includes("not_configured")) return "not_configured";
  if (statuses.includes("skipped")) return "skipped";
  // A judged case whose rubric could not be built, or whose judgment could not be read, is not a
  // result. Letting it stand would charge a provider failure to the arm as a real regression.
  if (statuses.includes("errored")) return "incomplete";
  return "comparable";
}

function percentile(values: readonly number[], percentileValue: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

function providerCost(result: ComparisonCaseResult) {
  const value = result.trace.providerCostCredits;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function metrics(
  results: readonly ComparisonCaseResult[],
  corpusByKey: ReadonlyMap<string, SafetyCorpusCase>,
): ComparisonArmMetrics {
  const passed = results.filter((result) => result.passed).length;
  const negativeCases = results.filter(
    (result) => corpusByKey.get(result.caseKey)?.expectation.verdict === "pass",
  );
  const costs = results.map(providerCost);
  const latencies = results.map((result) => result.latencyMs);
  const providerCostCredits = costs.every((value): value is number => value !== null)
    ? costs.reduce((total, value) => total + value, 0)
    : null;
  return {
    passed,
    total: results.length,
    passRate: (passed * 100) / results.length,
    falseBlocks: negativeCases.filter((result) => !result.passed).length,
    negativeCases: negativeCases.length,
    providerCostCredits,
    costPerCaseCredits: providerCostCredits === null ? null : providerCostCredits / results.length,
    costPerThousandCredits: providerCostCredits === null
      ? null
      : (providerCostCredits / results.length) * 1_000,
    latencyP50Ms: latencies.every((value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0)
      ? percentile(latencies, 0.5)
      : null,
    latencyP95Ms: latencies.every((value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0)
      ? percentile(latencies, 0.95)
      : null,
  };
}

export function compareEvalRuns(
  evidence: ComparisonEvidence,
  corpus: readonly SafetyCorpusCase[] = ENGINE_COMPARISON_CASES,
): EvalComparisonResult {
  refuseOnEvidenceMismatch(evidence);
  const corpusByKey = new Map(corpus.map((testCase) => [testCase.key, testCase]));
  const suites = EVAL_SUITE_NAMES.map<ComparisonSuiteResult>((suite) => {
    const armAResults = evidence.runA.results.filter((result) => result.suite === suite);
    const armBResults = evidence.runB.results.filter((result) => result.suite === suite);
    const stateA = statusOf(armAResults);
    const stateB = statusOf(armBResults);
    const state = stateA === stateB ? stateA : "incomplete";
    if (state !== "comparable") {
      return { suite, state, armA: emptyMetrics(), armB: emptyMetrics() };
    }
    return {
      suite,
      state,
      armA: metrics(armAResults, corpusByKey),
      armB: metrics(armBResults, corpusByKey),
    };
  });
  const firstNonComparable = suites.find((suite) => suite.state !== "comparable");
  return {
    comparisonId: evidence.comparisonId,
    status: "completed",
    state: firstNonComparable ? "non_comparable" : "comparable",
    stateReason: firstNonComparable ? `${firstNonComparable.suite}:${firstNonComparable.state}` : null,
    driverArm: evidence.driverArm,
    brainDraftVersionId: evidence.brainDraftVersionId,
    contentHash: evidence.contentHash,
    brainVersion: evidence.runA.brainVersion,
    offerVersion: evidence.runA.offerVersion,
    rulesVersion: evidence.runA.rulesVersion,
    knowledgeMode: evidence.runA.knowledgeMode,
    corpusRevision: evidence.runA.corpusRevision,
    caseSetHash: evidence.caseSetHash,
    modelConfigAId: evidence.modelConfigAId,
    modelConfigBId: evidence.modelConfigBId,
    runAId: evidence.runAId,
    runBId: evidence.runBId,
    createdAt: evidence.createdAt,
    finishedAt: evidence.finishedAt,
    suites,
  };
}
