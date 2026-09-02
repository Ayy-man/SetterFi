/** Nightly engine evaluation against the exact currently published snapshot. */

import { PHASE3_ENGINE_CASES } from "@/lib/engine/safety-corpus";
import type { EnvironmentSource } from "@/lib/env-contract";
import { loadSafetyCorpus, type LoadedSafetyCorpus } from "@/lib/evals/corpus";
import { runAndRecordEval } from "@/lib/evals/runner";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createOpenRouterEngineCaseExecutor,
  ENGINE_EVAL_UNAVAILABLE,
  type EngineModelConfiguration,
  type OpenRouterEngineCaseExecutorSelection,
  type PublishedEngineSnapshot,
} from "./openrouter-engine-executor";

export const PHASE3_ENGINE_CASE_KEYS = [
  "phase3:compliance:engine-stop-idempotency",
  "phase3:compliance:engine-cross-class-tripwire",
  "phase3:jailbreak:engine-three-turn-scope-cap",
  "phase3:jailbreak:engine-missing-caller-history",
  "phase3:output:engine-nested-sanitizer",
  "phase3:pricing:engine-outcome-pressure",
] as const;

type NightlyDependencies = {
  environment: EnvironmentSource;
  loadPublishedSnapshot(): Promise<PublishedEngineSnapshot | null>;
  loadActiveGenerator(): Promise<EngineModelConfiguration | null>;
  createExecutor(input: { snapshot: PublishedEngineSnapshot; configuration: EngineModelConfiguration; environment: EnvironmentSource }): OpenRouterEngineCaseExecutorSelection;
  run: typeof runAndRecordEval;
  corpus: LoadedSafetyCorpus;
};

export type NightlyEngineEvalResult =
  | { state: "complete"; runId: string; snapshotId: string; draftId: string; contentHash: string; cases: number }
  | { state: "unavailable"; code: typeof ENGINE_EVAL_UNAVAILABLE; reason: string };

function phase3Corpus(corpus: LoadedSafetyCorpus): LoadedSafetyCorpus {
  const expected = [...PHASE3_ENGINE_CASE_KEYS].sort();
  const declared = PHASE3_ENGINE_CASES.map((entry) => entry.key).sort();
  if (JSON.stringify(declared) !== JSON.stringify(expected)) throw new Error("PHASE3_ENGINE_CASES_MISSING");
  const cases = corpus.cases.filter((entry) => entry.kind === "engine" && entry.key.startsWith("phase3:"));
  const actual = cases.map((entry) => entry.key).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("PHASE3_ENGINE_CASES_MISSING");
  return { revision: corpus.revision, cases };
}

async function livePublishedSnapshot(): Promise<PublishedEngineSnapshot | null> {
  const client = createSupabaseServiceClient();
  const snapshot = await client.from("brain_snapshots")
    .select("id,version,content_hash,compiled_platform,eval_run_id")
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (snapshot.error) throw new Error("ENGINE_EVAL_PUBLISHED_READ_FAILED");
  if (!snapshot.data?.eval_run_id) return null;
  const sourceRun = await client.from("eval_runs")
    .select("brain_draft_version_id,content_hash")
    .eq("id", snapshot.data.eval_run_id).maybeSingle();
  if (sourceRun.error) throw new Error("ENGINE_EVAL_PUBLISHED_EVIDENCE_READ_FAILED");
  if (!sourceRun.data || sourceRun.data.content_hash !== snapshot.data.content_hash) return null;
  return {
    snapshotId: String(snapshot.data.id), version: Number(snapshot.data.version),
    draftId: String(sourceRun.data.brain_draft_version_id), contentHash: String(snapshot.data.content_hash),
    compiledPlatform: String(snapshot.data.compiled_platform),
  };
}

async function liveActiveGenerator(): Promise<EngineModelConfiguration | null> {
  const client = createSupabaseServiceClient();
  const result = await client.from("model_configs")
    .select("id,openrouter_model,params").eq("role", "generator").eq("active", true).maybeSingle();
  if (result.error) throw new Error("ENGINE_EVAL_MODEL_CONFIG_READ_FAILED");
  if (!result.data) return null;
  const params = result.data.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  return { id: String(result.data.id), model: String(result.data.openrouter_model), params: params as Record<string, unknown> };
}

function liveDependencies(environment: EnvironmentSource): NightlyDependencies {
  return {
    environment,
    loadPublishedSnapshot: livePublishedSnapshot,
    loadActiveGenerator: liveActiveGenerator,
    createExecutor: createOpenRouterEngineCaseExecutor,
    run: runAndRecordEval,
    corpus: loadSafetyCorpus(),
  };
}

export async function runStoredEngineEvalCases(
  overrides: Partial<NightlyDependencies> = {},
): Promise<NightlyEngineEvalResult> {
  const environment = overrides.environment ?? process.env;
  const dependencies = { ...liveDependencies(environment), ...overrides, environment };
  const corpus = phase3Corpus(dependencies.corpus);

  // Select the real arm before any database work; a credless deployment cannot create evidence.
  const selector = environment.SETTERFI_OPENROUTER_DRIVER?.trim();
  if (!selector || selector === "mock") {
    return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: "SETTERFI_OPENROUTER_DRIVER is not real." };
  }
  if (selector !== "real" || !environment.OPENROUTER_API_KEY?.trim()) {
    return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: selector === "real" ? "OPENROUTER_API_KEY is missing." : "SETTERFI_OPENROUTER_DRIVER is invalid." };
  }

  const [snapshot, configuration] = await Promise.all([
    dependencies.loadPublishedSnapshot(), dependencies.loadActiveGenerator(),
  ]);
  if (!snapshot) return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: "A current published snapshot with exact draft evidence is unavailable." };
  if (!configuration) return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: "An active generator configuration is unavailable." };
  const selection = dependencies.createExecutor({ snapshot, configuration, environment });
  if (selection.state === "unavailable") return selection;
  const receipt = await dependencies.run({
    draftId: snapshot.draftId,
    contentHash: snapshot.contentHash,
    kind: "engine",
    modelConfigId: configuration.id,
    engineExecutor: selection.executor,
    corpus,
  });
  return {
    state: "complete", runId: receipt.run.id, snapshotId: snapshot.snapshotId,
    draftId: snapshot.draftId, contentHash: snapshot.contentHash, cases: corpus.cases.length,
  };
}
