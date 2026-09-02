import { describe, expect, it } from "vitest";

import {
  EVAL_SUITE_NAMES,
  recordEvalRun,
  type EvalRunDependencies,
  type EvalSuiteResultInput,
} from "@/lib/repositories/eval-runs";

const HASH = "b".repeat(64);

function suites(): EvalSuiteResultInput[] {
  return EVAL_SUITE_NAMES.map((suite) => ({
    suite,
    cases: [{
      caseKey: `${suite}:synthetic`,
      passed: suite !== "voice_tone",
      response: null,
      trace: suite === "voice_tone" ? { status: "not_configured", ruleIds: [] } : { ruleIds: [] },
      latencyMs: null,
      costCents: null,
    }],
  }));
}

function dependencies() {
  let recorded: Record<string, unknown> | null = null;
  let reads = 0;
  const deps: EvalRunDependencies = {
    record: async (args) => {
      recorded = args;
      if (args.p_expected_content_hash !== HASH) throw new Error("EVAL_DRAFT_HASH_MISMATCH");
      return "run-1";
    },
    loadRun: async () => {
      reads += 1;
      return {
        id: "run-1",
        brainDraftVersionId: "draft-1",
        contentHash: HASH,
        kind: "checker",
        modelConfigId: null,
        corpusRevision: "corpus-1",
        suitesComplete: true,
      };
    },
    loadResults: async () => {
      reads += 1;
      return suites().map((suite, index) => ({
        id: `result-${index}`,
        runId: "run-1",
        caseId: null,
        suite: suite.suite,
        ...suite.cases[0],
      }));
    },
  };
  return { deps, get recorded() { return recorded; }, get reads() { return reads; } };
}

describe("recordEvalRun", () => {
  it("persists checker keys with null case and model ids, then matches the full read-back", async () => {
    const state = dependencies();
    const result = await recordEvalRun({
      expectedDraftId: "draft-1",
      expectedContentHash: HASH,
      kind: "checker",
      modelConfigId: null,
      corpusRevision: "corpus-1",
      suites: suites(),
    }, state.deps);
    expect(state.recorded).toMatchObject({
      p_expected_draft_id: "draft-1",
      p_expected_content_hash: HASH,
      p_kind: "checker",
      p_model_config_id: null,
    });
    expect(result.results).toHaveLength(6);
    expect(result.results.every((entry) => entry.caseId === null)).toBe(true);
    expect(state.reads).toBe(2);
  });

  it("returns no success and performs no read-back after a one-character RPC hash refusal", async () => {
    const state = dependencies();
    await expect(recordEvalRun({
      expectedDraftId: "draft-1",
      expectedContentHash: `${HASH.slice(0, -1)}a`,
      kind: "checker",
      modelConfigId: null,
      corpusRevision: "corpus-1",
      suites: suites(),
    }, state.deps)).rejects.toThrow("EVAL_DRAFT_HASH_MISMATCH");
    expect(state.reads).toBe(0);
  });

  it("requires a model config for engine runs and refuses one for checker runs", async () => {
    const state = dependencies();
    await expect(recordEvalRun({
      expectedDraftId: "draft-1",
      expectedContentHash: HASH,
      kind: "engine",
      modelConfigId: null,
      corpusRevision: "corpus-1",
      suites: suites(),
    }, state.deps)).rejects.toThrow("EVAL_MODEL_CONFIG_SHAPE_INVALID");
    expect(state.recorded).toBeNull();
  });
});
