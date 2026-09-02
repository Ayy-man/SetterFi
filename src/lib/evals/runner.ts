/** Runs reviewed corpus cases through injected checker/engine arms, then records exact draft evidence. */

import { runOutputChecks } from "@/lib/engine/output-checks";
import {
  loadSafetyCorpus,
  SAFETY_SUITES,
  type LoadedSafetyCorpus,
  type SafetyCorpusCase,
  type SafetySuite,
} from "@/lib/evals/corpus";
import {
  recordEvalRun,
  type EvalCaseResultInput,
  type EvalRunReceipt,
  type EvalSuiteName,
  type EvalSuiteResultInput,
} from "@/lib/repositories/eval-runs";

export type EngineCaseExecutor = (testCase: SafetyCorpusCase) => Promise<{
  passed: boolean;
  response?: string | null;
  ruleIds: readonly string[];
  trace: Readonly<Record<string, unknown>>;
  latencyMs?: number | null;
  costCents?: number | null;
}>;

function checkerResult(testCase: SafetyCorpusCase): EvalCaseResultInput {
  const draft = testCase.turns.at(-1)?.content ?? "";
  const actual = runOutputChecks(draft, testCase.context);
  const expected = testCase.expectation;
  const actualRuleIds = [...new Set(actual.violations.map((violation) => violation.ruleId))];
  const passed = expected.verdict === "pass"
    ? actual.passed
    : actual.violations.some((violation) => violation.class === expected.class) &&
      expected.ruleIds.every((ruleId) => actualRuleIds.includes(ruleId));
  return {
    caseKey: testCase.key,
    passed,
    response: draft,
    trace: {
      expected,
      actualPassed: actual.passed,
      checks: actual.checks,
      violations: actual.violations,
      ruleIds: actualRuleIds.length ? actualRuleIds : expected.ruleIds,
    },
    latencyMs: 0,
    costCents: 0,
  };
}

function groupSafetyResults(corpus: LoadedSafetyCorpus, results: Map<string, EvalCaseResultInput>) {
  return SAFETY_SUITES.map<EvalSuiteResultInput>((suite) => ({
    suite,
    cases: corpus.cases
      .filter((testCase) => testCase.suite === suite && results.has(testCase.key))
      .map((testCase) => results.get(testCase.key) as EvalCaseResultInput),
  }));
}

export function runCheckerCorpus(corpus = loadSafetyCorpus()) {
  const results = new Map<string, EvalCaseResultInput>();
  for (const testCase of corpus.cases.filter((entry) => entry.kind === "checker")) {
    results.set(testCase.key, checkerResult(testCase));
  }
  return groupSafetyResults(corpus, results);
}

export async function runEngineCorpus(executor: EngineCaseExecutor, corpus = loadSafetyCorpus()) {
  const results = new Map<string, EvalCaseResultInput>();
  for (const testCase of corpus.cases.filter((entry) => entry.kind === "engine")) {
    const result = await executor(testCase);
    results.set(testCase.key, {
      caseKey: testCase.key,
      passed: result.passed,
      response: result.response ?? null,
      trace: { ...result.trace, ruleIds: result.ruleIds },
      latencyMs: result.latencyMs ?? null,
      costCents: result.costCents ?? null,
    });
  }
  return groupSafetyResults(corpus, results);
}

function notConfigured(suite: "qualification_accuracy" | "voice_tone"): EvalSuiteResultInput {
  return {
    suite,
    cases: [{
      caseKey: `${suite}:not-configured`,
      passed: false,
      response: null,
      trace: { status: "not_configured", ruleIds: [] },
      latencyMs: null,
      costCents: null,
    }],
  };
}

export async function runAndRecordEval(input: {
  draftId: string;
  contentHash: string;
  kind: "checker" | "engine";
  modelConfigId?: string | null;
  engineExecutor?: EngineCaseExecutor;
  judgmentSuites?: readonly EvalSuiteResultInput[];
  corpus?: LoadedSafetyCorpus;
  persist?: typeof recordEvalRun;
}): Promise<EvalRunReceipt> {
  const corpus = input.corpus ?? loadSafetyCorpus();
  const safety = input.kind === "checker"
    ? runCheckerCorpus(corpus)
    : await runEngineCorpus(input.engineExecutor ?? (() => {
        throw new Error("EVAL_ENGINE_EXECUTOR_REQUIRED");
      }), corpus);
  const judgments = new Map<EvalSuiteName, EvalSuiteResultInput>(
    input.judgmentSuites?.map((suite) => [suite.suite, suite]) ?? [],
  );
  const suites = [
    ...safety,
    judgments.get("qualification_accuracy") ?? notConfigured("qualification_accuracy"),
    judgments.get("voice_tone") ?? notConfigured("voice_tone"),
  ];
  return (input.persist ?? recordEvalRun)({
    expectedDraftId: input.draftId,
    expectedContentHash: input.contentHash,
    kind: input.kind,
    modelConfigId: input.modelConfigId ?? null,
    corpusRevision: corpus.revision,
    suites,
  });
}

export function safetySuiteNames(results: readonly EvalSuiteResultInput[]) {
  return results.map((result) => result.suite as SafetySuite);
}
