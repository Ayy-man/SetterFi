import { describe, expect, it, vi } from "vitest";

import { PHASE3_ENGINE_CASES } from "@/lib/engine/safety-corpus";
import { ENGINE_COMPARISON_CASES } from "@/lib/evals/comparison";
import { loadSafetyCorpus } from "@/lib/evals/corpus";
import type { EngineCaseJudge } from "@/lib/evals/engine-case-scoring";
import { runAndRecordEval, runEngineCorpus, type EngineCaseExecutor } from "@/lib/evals/runner";
import type { ModelDriver } from "@/lib/integrations/types";
import type { EvalCaseResultRecord } from "@/lib/repositories/eval-runs";
import { nightlyEngineEvalCounters, runStoredEngineEvalCases } from "./nightly-engine-evals";
import { createOpenRouterEngineCaseExecutor } from "./openrouter-engine-executor";

const snapshot = { snapshotId: "snapshot-synthetic", version: 8, draftId: "draft-synthetic", contentHash: "b".repeat(64), compiledPlatform: "Published synthetic prompt" };
const configuration = { id: "config-synthetic", model: "vendor/model", params: {} };
const moderator = { id: "moderator-synthetic", model: "vendor/moderator", params: {} };
const environment = { SETTERFI_OPENROUTER_DRIVER: "real", OPENROUTER_API_KEY: "synthetic-key" };
const caseCount = ENGINE_COMPARISON_CASES.length;
const blockCases = ENGINE_COMPARISON_CASES.filter((entry) => entry.expectation.verdict === "block").length;
const passCases = caseCount - blockCases;
const executor: EngineCaseExecutor = async () => ({ passed: false, response: "Synthetic response", ruleIds: [], trace: {} });

type RunInput = Parameters<typeof runAndRecordEval>[0];

function receipt(input: RunInput, results: readonly EvalCaseResultRecord[] = []) {
  return {
    run: { id: "run-synthetic", brainDraftVersionId: input.draftId, contentHash: input.contentHash, kind: "engine" as const, modelConfigId: input.modelConfigId ?? null, corpusRevision: input.corpus!.revision, suitesComplete: true },
    results,
  };
}

/** Runs the real executor over the corpus and hands back a receipt shaped like the stored rows. */
async function recordingRun(input: RunInput) {
  const suites = await runEngineCorpus(input.engineExecutor!, input.corpus);
  const results = suites.flatMap((suite) => suite.cases.map<EvalCaseResultRecord>((entry) => ({
    ...entry, id: `result-${entry.caseKey}`, runId: "run-synthetic", suite: suite.suite, caseId: null,
  })));
  return receipt(input, results);
}

/** A model that always declines on role, so the deterministic checker never trips on a block case. */
const decliningModel: ModelDriver = {
  generate: async () => ({
    draft: "I can't speak to that, but I can get you booked with the coach to talk it through.",
    usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22 },
    provider: { name: "synthetic", generationId: null, latencyMs: 5, cost: null },
  }),
};

function judgedDependencies(judge: EngineCaseJudge, activeModerator: typeof moderator | null = moderator) {
  const createJudge = vi.fn(() => judge);
  return {
    createJudge,
    overrides: {
      environment,
      loadPublishedSnapshot: async () => snapshot,
      loadActiveGenerator: async () => configuration,
      loadActiveModerator: async () => activeModerator,
      createJudge,
      createExecutor: (input: Parameters<typeof createOpenRouterEngineCaseExecutor>[0]) =>
        createOpenRouterEngineCaseExecutor({ ...input, createModel: () => decliningModel }),
      run: recordingRun,
    },
  };
}

describe("nightly published engine evals", () => {
  it("runs the same engine cases as the comparison, Phase 3 included, against the published draft id and hash", async () => {
    const run = vi.fn(async (input: RunInput) => receipt(input));
    const result = await runStoredEngineEvalCases({
      environment: { SETTERFI_OPENROUTER_DRIVER: "real", OPENROUTER_API_KEY: "synthetic-key" },
      loadPublishedSnapshot: async () => snapshot,
      loadActiveGenerator: async () => configuration, loadActiveModerator: async () => null,
      createExecutor: () => ({ state: "ready", executor }), run,
    });
    expect(result).toMatchObject({ state: "complete", runId: "run-synthetic", snapshotId: snapshot.snapshotId, draftId: snapshot.draftId, contentHash: snapshot.contentHash, cases: caseCount });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ draftId: snapshot.draftId, contentHash: snapshot.contentHash, kind: "engine", modelConfigId: configuration.id }));
    const keys = run.mock.calls[0][0].corpus!.cases.map((entry) => entry.key);
    expect(caseCount).toBe(48);
    expect([...keys].sort()).toEqual(ENGINE_COMPARISON_CASES.map((entry) => entry.key).sort());
    for (const entry of PHASE3_ENGINE_CASES) expect(keys).toContain(entry.key);
  });

  it("passes a clean refusal the checker cannot see once the moderator allows it", async () => {
    const judge = vi.fn<EngineCaseJudge>(async () => ({ verdict: "allow", class: "none", reason: "Declined on role." }));
    const { createJudge, overrides } = judgedDependencies(judge);
    const result = await runStoredEngineEvalCases(overrides);
    expect(createJudge).toHaveBeenCalledWith({ apiKey: "synthetic-key", configuration: moderator });
    expect(judge).toHaveBeenCalledTimes(blockCases);
    expect(result).toMatchObject({
      state: "complete", cases: caseCount, passed: caseCount, judge: "moderator", moderatorConfigId: moderator.id,
      outcomes: { caught: 0, refused: blockCases, missed_by_checker: 0, uncaught: 0, clean: passCases, false_block: 0 },
    });
    expect(nightlyEngineEvalCounters(result)).toEqual({
      cases: caseCount, passed: caseCount, caught: 0, refused: blockCases, missed_by_checker: 0, uncaught: 0, clean: passCases, false_block: 0, judged: 1,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-key");
  });

  it("fails a reply the checker missed once the moderator blocks it, and the counters say so", async () => {
    const judge = vi.fn<EngineCaseJudge>(async () => ({ verdict: "block", class: "pricing", reason: "Invented a number." }));
    const result = await runStoredEngineEvalCases(judgedDependencies(judge).overrides);
    expect(result).toMatchObject({
      state: "complete", passed: passCases, judge: "moderator",
      outcomes: { caught: 0, refused: 0, missed_by_checker: blockCases, uncaught: 0, clean: passCases, false_block: 0 },
    });
    expect(nightlyEngineEvalCounters(result)).toMatchObject({ passed: passCases, missed_by_checker: blockCases, judged: 1 });
  });

  it("runs unjudged when no moderator row is active and records it as uncaught", async () => {
    const judge = vi.fn<EngineCaseJudge>();
    const { createJudge, overrides } = judgedDependencies(judge, null);
    const result = await runStoredEngineEvalCases(overrides);
    expect(createJudge).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      state: "complete", passed: passCases, judge: "unjudged", moderatorConfigId: null,
      outcomes: { refused: 0, missed_by_checker: 0, uncaught: blockCases, clean: passCases },
    });
    const counters = nightlyEngineEvalCounters(result);
    expect(counters).toMatchObject({ uncaught: blockCases, unjudged: 1 });
    expect(counters).not.toHaveProperty("judged");
  });

  it("reports no counters for an unavailable run", () => {
    expect(nightlyEngineEvalCounters({ state: "unavailable", code: "ENGINE_EVAL_UNAVAILABLE", reason: "synthetic" })).toEqual({});
  });

  it.each([
    [{}, "SETTERFI_OPENROUTER_DRIVER is not real."],
    [{ SETTERFI_OPENROUTER_DRIVER: "mock" }, "SETTERFI_OPENROUTER_DRIVER is not real."],
    [{ SETTERFI_OPENROUTER_DRIVER: "real" }, "OPENROUTER_API_KEY is missing."],
  ] as const)("returns unavailable without loading or writing for a credless arm", async (environment, reason) => {
    const loadPublishedSnapshot = vi.fn(async () => snapshot);
    const run = vi.fn();
    await expect(runStoredEngineEvalCases({ environment, loadPublishedSnapshot, run })).resolves.toEqual({ state: "unavailable", code: "ENGINE_EVAL_UNAVAILABLE", reason });
    expect(loadPublishedSnapshot).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns unavailable and never writes when published evidence is absent", async () => {
    const run = vi.fn();
    await expect(runStoredEngineEvalCases({
      environment: { SETTERFI_OPENROUTER_DRIVER: "real", OPENROUTER_API_KEY: "synthetic-key" },
      loadPublishedSnapshot: async () => null, loadActiveGenerator: async () => configuration, loadActiveModerator: async () => null, run,
    })).resolves.toMatchObject({ state: "unavailable", code: "ENGINE_EVAL_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed before writes when a Phase 3 case is missing", async () => {
    const corpus = loadSafetyCorpus();
    const run = vi.fn();
    await expect(runStoredEngineEvalCases({ corpus: { ...corpus, cases: corpus.cases.filter((entry) => entry.key !== "phase3:output:engine-nested-sanitizer") }, run })).rejects.toThrow("PHASE3_ENGINE_CASES_MISSING");
    expect(run).not.toHaveBeenCalled();
  });
});
