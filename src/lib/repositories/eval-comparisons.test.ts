import { describe, expect, it, vi } from "vitest";

import { caseSetHash, ENGINE_COMPARISON_CASES, type ComparisonEvidence } from "@/lib/evals/comparison";
import { parseJudgmentCases } from "@/lib/evals/judgment-cases";
import { loadSafetyCorpus } from "@/lib/evals/corpus";
import { DriverConfigurationError } from "@/lib/env-contract";
import {
  createChallengerModelConfig,
  evalComparisonExportRows,
  resolveComparisonDriver,
  runEvalComparison,
  type ChallengerDependencies,
  type EvalComparisonDependencies,
} from "@/lib/repositories/eval-comparisons";
import { EVAL_SUITE_NAMES, type EvalRunReceipt } from "@/lib/repositories/eval-runs";

const HASH = "a".repeat(64);
const CASE_HASH = caseSetHash();
const MOCK_OPENROUTER_ENVIRONMENT = { SETTERFI_OPENROUTER_DRIVER: "mock" };

function runReceipt(id: string, configId: string): EvalRunReceipt {
  const engine = ENGINE_COMPARISON_CASES.map((testCase, index) => ({
    id: `${id}-result-${index}`,
    runId: id,
    caseId: null,
    caseKey: testCase.key,
    suite: testCase.suite,
    passed: true,
    response: "Synthetic response",
    trace: { driverArm: "mock", providerCostCredits: null },
    latencyMs: 1,
    costCents: null,
  }));
  const judgments = (["qualification_accuracy", "voice_tone"] as const).map((suite, index) => ({
    id: `${id}-judgment-${index}`,
    runId: id,
    caseId: null,
    caseKey: `${suite}:not-configured`,
    suite,
    passed: false,
    response: null,
    trace: { status: "not_configured", ruleIds: [] },
    latencyMs: null,
    costCents: null,
  }));
  return {
    run: {
      id,
      brainDraftVersionId: "draft-1",
      contentHash: HASH,
      kind: "engine",
      modelConfigId: configId,
      corpusRevision: loadSafetyCorpus().revision,
      suitesComplete: true,
    },
    results: [...engine, ...judgments],
  };
}

function completedEvidence(): ComparisonEvidence {
  const a = runReceipt("run-a", "config-a");
  const b = runReceipt("run-b", "config-b");
  const mapRun = (receipt: EvalRunReceipt, arm: "a" | "b") => ({
    ...receipt.run,
    brainVersion: null,
    offerVersion: null,
    rulesVersion: receipt.run.corpusRevision,
    knowledgeMode: null,
    comparisonId: "comparison-1",
    comparisonArm: arm,
    caseSetHash: CASE_HASH,
    results: receipt.results.map((result) => ({
      caseKey: result.caseKey,
      suite: result.suite,
      passed: result.passed,
      trace: result.trace,
      latencyMs: result.latencyMs,
    })),
  });
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
    runA: mapRun(a, "a"),
    runB: mapRun(b, "b"),
  };
}

function dependencies(overrides: Partial<EvalComparisonDependencies> = {}) {
  const start = vi.fn(async () => "comparison-1");
  const finish = vi.fn(async () => "comparison-1");
  const runArm = vi.fn(async ({ config }: Parameters<EvalComparisonDependencies["runArm"]>[0]) =>
    runReceipt(config.id === "config-a" ? "run-a" : "run-b", config.id));
  const load = vi.fn(async () => completedEvidence());
  const values: EvalComparisonDependencies = {
    loadContext: async () => ({
      draft: { id: "draft-1", contentHash: HASH },
      configA: { id: "config-a", model: "vendor/model-a", params: {}, role: "generator", active: true },
      configB: { id: "config-b", model: "vendor/model-b", params: {}, role: "generator", active: false },
    }),
    start,
    runArm,
    finish,
    load,
    loadJudgmentCases: async () => [],
    loadJudgeConfig: async () => null,
    ...overrides,
  };
  return { values, start, runArm, finish, load };
}

describe("challenger model repository", () => {
  it("returns success only after the inactive generator and exact audit both read back", async () => {
    const deps: ChallengerDependencies = {
      create: async () => ({ modelConfigId: "config-b", auditId: "41" }),
      loadConfig: async () => ({
        id: "config-b", model: "vendor/model-b", params: { temperature: 0 },
        role: "generator", active: false,
      }),
      loadAudit: async () => ({
        id: "41", actorId: "actor-1", action: "eval.model_config.created",
        targetType: "model_config", targetId: "config-b",
      }),
    };
    await expect(createChallengerModelConfig({
      actorId: "actor-1",
      model: "vendor/model-b",
      params: { temperature: 0 },
    }, deps)).resolves.toMatchObject({ id: "config-b", role: "generator", active: false, auditId: "41" });
  });

  it("returns no optimistic success when either read-back is missing", async () => {
    const deps: ChallengerDependencies = {
      create: async () => ({ modelConfigId: "config-b", auditId: "41" }),
      loadConfig: async () => null,
      loadAudit: async () => null,
    };
    await expect(createChallengerModelConfig({
      actorId: "actor-1", model: "vendor/model-b", params: {},
    }, deps)).rejects.toThrow("EVAL_CHALLENGER_READBACK_MISMATCH");
  });
});

describe("eval comparison repository", () => {
  const input = {
    actorId: "actor-1",
    draftId: "draft-1",
    contentHash: HASH,
    modelConfigAId: "config-a",
    modelConfigBId: "config-b",
  };

  it("starts once, runs both configs over the same case objects, finishes with the same hash, and re-reads", async () => {
    const deps = dependencies();
    const receipt = await runEvalComparison(input, deps.values, MOCK_OPENROUTER_ENVIRONMENT);
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ p_case_set_hash: CASE_HASH }));
    expect(deps.runArm).toHaveBeenCalledTimes(2);
    expect(deps.runArm.mock.calls[0][0].cases).toBe(deps.runArm.mock.calls[1][0].cases);
    expect(deps.finish).toHaveBeenCalledWith({
      p_comparison_id: "comparison-1",
      p_run_a_id: "run-a",
      p_run_b_id: "run-b",
      p_case_set_hash: CASE_HASH,
    });
    expect(deps.load).toHaveBeenCalledWith("comparison-1");
    expect(receipt.driverArm).toBe("mock");
    expect(receipt.state).toBe("non_comparable");
    const exported = evalComparisonExportRows(receipt);
    expect(exported.comparison.status).toBe("completed_mock_non_comparable");
    expect(exported.results).toHaveLength(EVAL_SUITE_NAMES.length * 2);
    expect(exported.results.filter((row) => row.state === "mock_not_configured"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ suite: "qualification_accuracy", passed: null, passRate: null }),
        expect.objectContaining({ suite: "voice_tone", passed: null, passRate: null }),
      ]));
  });

  it("carries promoted judgement cases into both arms and into the bound case-set hash", async () => {
    const judgmentCases = parseJudgmentCases([{
      id: "case-q1",
      suite: "qualification_accuracy",
      kind: "engine",
      source_tenant_id: "tenant-1",
      turns: [{ role: "user", content: "My score is 720." }],
      expectation: {
        suite: "qualification_accuracy",
        outcome: "BOOK",
        disclosed: {
          credit: "700+", goal: "$50K–100K", timeline: "ASAP–30d",
          businessStage: "operating", annualRevenueCents: 5_000_000,
        },
      },
    }]);
    const judgeConfig = { id: "moderator-1", model: "vendor/judge", params: {} };
    const deps = dependencies({
      loadJudgmentCases: async () => judgmentCases,
      loadJudgeConfig: async () => judgeConfig,
    });
    // The arm receipt still reports not-configured, so the expected key set no longer matches and
    // the comparison refuses before it can finish on evidence that skipped a promoted case.
    await expect(runEvalComparison(input, deps.values, MOCK_OPENROUTER_ENVIRONMENT))
      .rejects.toThrow("EVAL_COMPARISON_RESULT_KEY_MISMATCH");
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({
      p_case_set_hash: caseSetHash(ENGINE_COMPARISON_CASES, judgmentCases),
    }));
    expect(caseSetHash(ENGINE_COMPARISON_CASES, judgmentCases)).not.toBe(CASE_HASH);
    for (const call of deps.runArm.mock.calls) {
      expect(call[0].judgmentCases).toBe(judgmentCases);
      expect(call[0].judgeConfig).toBe(judgeConfig);
    }
  });

  it("keeps the case-set hash unmoved while nothing has been promoted", () => {
    expect(caseSetHash(ENGINE_COMPARISON_CASES, [])).toBe(CASE_HASH);
  });

  it("does not finish when either arm returns a different result-key set", async () => {
    const deps = dependencies({
      runArm: async ({ config }) => {
        const receipt = runReceipt(config.id === "config-a" ? "run-a" : "run-b", config.id);
        return config.id === "config-b" ? { ...receipt, results: receipt.results.slice(1) } : receipt;
      },
    });
    await expect(runEvalComparison(input, deps.values, MOCK_OPENROUTER_ENVIRONMENT)).rejects.toThrow(
      "EVAL_COMPARISON_RESULT_KEY_MISMATCH",
    );
    expect(deps.finish).not.toHaveBeenCalled();
    expect(deps.load).not.toHaveBeenCalled();
  });

  it("does not start when challenger B duplicates active A by model and params", async () => {
    const deps = dependencies({
      loadContext: async () => ({
        draft: { id: "draft-1", contentHash: HASH },
        configA: { id: "config-a", model: "vendor/model", params: {}, role: "generator", active: true },
        configB: { id: "config-b", model: "vendor/model", params: {}, role: "generator", active: false },
      }),
    });
    await expect(runEvalComparison(input, deps.values, MOCK_OPENROUTER_ENVIRONMENT)).rejects.toThrow(
      "EVAL_COMPARISON_CONFIGURATIONS_IDENTICAL",
    );
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("selects the explicitly configured mock driver", () => {
    expect(resolveComparisonDriver(MOCK_OPENROUTER_ENVIRONMENT)).toEqual({ arm: "mock", apiKey: null });
  });

  it("fails explicit real selection closed by the missing variable name only", () => {
    try {
      resolveComparisonDriver({ SETTERFI_OPENROUTER_DRIVER: "real" });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverConfigurationError);
      expect(error).toMatchObject({ variableNames: ["OPENROUTER_API_KEY"] });
      expect(String(error)).not.toMatch(/sk-|token|secret/i);
    }
  });

  it("keeps the persisted result identity equal to the six-suite runner contract", () => {
    const receipt = runReceipt("run-a", "config-a");
    expect([...new Set(receipt.results.map((row) => row.suite))]).toEqual(EVAL_SUITE_NAMES);
  });
});
