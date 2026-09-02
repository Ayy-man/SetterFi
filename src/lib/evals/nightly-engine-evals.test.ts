import { describe, expect, it, vi } from "vitest";

import { loadSafetyCorpus } from "@/lib/evals/corpus";
import { runAndRecordEval, type EngineCaseExecutor } from "@/lib/evals/runner";
import { runStoredEngineEvalCases } from "./nightly-engine-evals";

const snapshot = { snapshotId: "snapshot-synthetic", version: 8, draftId: "draft-synthetic", contentHash: "b".repeat(64), compiledPlatform: "Published synthetic prompt" };
const configuration = { id: "config-synthetic", model: "vendor/model", params: {} };
const executor: EngineCaseExecutor = async () => ({ passed: false, response: "Synthetic response", ruleIds: [], trace: {} });

type RunInput = Parameters<typeof runAndRecordEval>[0];

function receipt(input: RunInput) {
  return {
    run: { id: "run-synthetic", brainDraftVersionId: input.draftId, contentHash: input.contentHash, kind: "engine" as const, modelConfigId: input.modelConfigId ?? null, corpusRevision: input.corpus!.revision, suitesComplete: true },
    results: [],
  };
}

describe("nightly published engine evals", () => {
  it("runs exactly the six Phase 3 cases against the published draft id and hash", async () => {
    const run = vi.fn(async (input: RunInput) => receipt(input));
    const result = await runStoredEngineEvalCases({
      environment: { SETTERFI_OPENROUTER_DRIVER: "real", OPENROUTER_API_KEY: "synthetic-key" },
      loadPublishedSnapshot: async () => snapshot,
      loadActiveGenerator: async () => configuration,
      createExecutor: () => ({ state: "ready", executor }), run,
    });
    expect(result).toEqual({ state: "complete", runId: "run-synthetic", snapshotId: snapshot.snapshotId, draftId: snapshot.draftId, contentHash: snapshot.contentHash, cases: 6 });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ draftId: snapshot.draftId, contentHash: snapshot.contentHash, kind: "engine", modelConfigId: configuration.id }));
    const keys = run.mock.calls[0][0].corpus!.cases.map((entry) => entry.key);
    expect(keys).toHaveLength(6);
    expect(keys.every((key) => key.startsWith("phase3:"))).toBe(true);
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
      loadPublishedSnapshot: async () => null, loadActiveGenerator: async () => configuration, run,
    })).resolves.toMatchObject({ state: "unavailable", code: "ENGINE_EVAL_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed before writes when the exact six-case contract drifts", async () => {
    const corpus = loadSafetyCorpus();
    const run = vi.fn();
    await expect(runStoredEngineEvalCases({ corpus: { ...corpus, cases: corpus.cases.filter((entry) => entry.key !== "phase3:output:engine-nested-sanitizer") }, run })).rejects.toThrow("PHASE3_ENGINE_CASES_MISSING");
    expect(run).not.toHaveBeenCalled();
  });
});
