/**
 * Nightly engine evaluation against the exact currently published snapshot. It runs the same
 * engine case set the admin comparison runs, so a nightly pass and a comparison pass mean the
 * same thing.
 */

import { PHASE3_ENGINE_CASES } from "@/lib/engine/safety-corpus";
import type { EnvironmentSource } from "@/lib/env-contract";
import { ENGINE_COMPARISON_CASES } from "@/lib/evals/comparison";
import { loadSafetyCorpus, type LoadedSafetyCorpus } from "@/lib/evals/corpus";
import { type EngineCaseJudge, type EngineCaseOutcome, moderatorJudge } from "@/lib/evals/engine-case-scoring";
import { runAndRecordEval } from "@/lib/evals/runner";
import { createRealModeratorDriver } from "@/lib/integrations/openrouter";
import type { EvalRunReceipt } from "@/lib/repositories/eval-runs";
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

export const ENGINE_CASE_OUTCOMES = ["caught", "refused", "missed_by_checker", "uncaught", "clean", "false_block"] as const satisfies readonly EngineCaseOutcome[];

export type EngineCaseOutcomeCounts = Record<EngineCaseOutcome, number>;

type NightlyDependencies = {
  environment: EnvironmentSource;
  loadPublishedSnapshot(): Promise<PublishedEngineSnapshot | null>;
  loadActiveGenerator(): Promise<EngineModelConfiguration | null>;
  /** The active moderator row; null means the run scores without a judge and says so. */
  loadActiveModerator(): Promise<EngineModelConfiguration | null>;
  createJudge(input: { apiKey: string; configuration: EngineModelConfiguration }): EngineCaseJudge;
  createExecutor(input: {
    snapshot: PublishedEngineSnapshot; configuration: EngineModelConfiguration; environment: EnvironmentSource; judge?: EngineCaseJudge;
  }): OpenRouterEngineCaseExecutorSelection;
  run: typeof runAndRecordEval;
  corpus: LoadedSafetyCorpus;
};

export type NightlyEngineEvalResult =
  | {
      state: "complete"; runId: string; snapshotId: string; draftId: string; contentHash: string; cases: number;
      passed: number;
      /** "moderator" when the active moderator row judged uncaught replies; "unjudged" when no row was active. */
      judge: "moderator" | "unjudged";
      moderatorConfigId: string | null;
      outcomes: EngineCaseOutcomeCounts;
    }
  | { state: "unavailable"; code: typeof ENGINE_EVAL_UNAVAILABLE; reason: string };

/** Receipt counters: pass count, the outcome breakdown, and a judged/unjudged flag the receipt can show. */
export function nightlyEngineEvalCounters(result: NightlyEngineEvalResult): Record<string, number> {
  if (result.state !== "complete") return {};
  return {
    cases: result.cases,
    passed: result.passed,
    ...result.outcomes,
    [result.judge === "moderator" ? "judged" : "unjudged"]: 1,
  };
}

function isOutcome(value: unknown): value is EngineCaseOutcome {
  return typeof value === "string" && (ENGINE_CASE_OUTCOMES as readonly string[]).includes(value);
}

function summariseOutcomes(receipt: EvalRunReceipt, corpus: LoadedSafetyCorpus) {
  const keys = new Set(corpus.cases.map((entry) => entry.key));
  const outcomes = Object.fromEntries(ENGINE_CASE_OUTCOMES.map((outcome) => [outcome, 0])) as EngineCaseOutcomeCounts;
  let passed = 0;
  for (const result of receipt.results) {
    if (!keys.has(result.caseKey)) continue;
    if (result.passed) passed += 1;
    const outcome = result.trace.outcome;
    if (isOutcome(outcome)) outcomes[outcome] += 1;
  }
  return { passed, outcomes };
}

/** Every engine case the comparison path runs; the Phase 3 six must still be among them. */
export const NIGHTLY_ENGINE_CASE_KEYS = ENGINE_COMPARISON_CASES.map((entry) => entry.key);

function nightlyCorpus(corpus: LoadedSafetyCorpus): LoadedSafetyCorpus {
  const expectedPhase3 = [...PHASE3_ENGINE_CASE_KEYS].sort();
  const declaredPhase3 = PHASE3_ENGINE_CASES.map((entry) => entry.key).sort();
  if (JSON.stringify(declaredPhase3) !== JSON.stringify(expectedPhase3)) throw new Error("PHASE3_ENGINE_CASES_MISSING");
  const cases = corpus.cases.filter((entry) => entry.kind === "engine");
  const actual = cases.map((entry) => entry.key).sort();
  const expected = [...NIGHTLY_ENGINE_CASE_KEYS].sort();
  if (!expectedPhase3.every((key) => actual.includes(key))) throw new Error("PHASE3_ENGINE_CASES_MISSING");
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("ENGINE_EVAL_CASES_DRIFTED");
  return { revision: corpus.revision, cases };
}

export async function loadPublishedEngineSnapshot(): Promise<PublishedEngineSnapshot | null> {
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

async function liveActiveConfiguration(role: "generator" | "moderator"): Promise<EngineModelConfiguration | null> {
  const client = createSupabaseServiceClient();
  const result = await client.from("model_configs")
    .select("id,openrouter_model,params").eq("role", role).eq("active", true).maybeSingle();
  if (result.error) throw new Error("ENGINE_EVAL_MODEL_CONFIG_READ_FAILED");
  if (!result.data) return null;
  const params = result.data.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  return { id: String(result.data.id), model: String(result.data.openrouter_model), params: params as Record<string, unknown> };
}

/** The same judge the admin comparison path uses: the active moderator row over the real driver. */
function liveJudge(input: { apiKey: string; configuration: EngineModelConfiguration }): EngineCaseJudge {
  return moderatorJudge(createRealModeratorDriver(input.apiKey, {
    role: "moderator", model: input.configuration.model, params: { ...input.configuration.params },
  }));
}

function liveDependencies(environment: EnvironmentSource): NightlyDependencies {
  return {
    environment,
    loadPublishedSnapshot: loadPublishedEngineSnapshot,
    loadActiveGenerator: () => liveActiveConfiguration("generator"),
    loadActiveModerator: () => liveActiveConfiguration("moderator"),
    createJudge: liveJudge,
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
  const corpus = nightlyCorpus(dependencies.corpus);

  // Select the real arm before any database work; a credless deployment cannot create evidence.
  const selector = environment.SETTERFI_OPENROUTER_DRIVER?.trim();
  if (!selector || selector === "mock") {
    return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: "SETTERFI_OPENROUTER_DRIVER is not real." };
  }
  const apiKey = environment.OPENROUTER_API_KEY?.trim();
  if (selector !== "real" || !apiKey) {
    return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: selector === "real" ? "OPENROUTER_API_KEY is missing." : "SETTERFI_OPENROUTER_DRIVER is invalid." };
  }

  const [snapshot, configuration, moderator] = await Promise.all([
    dependencies.loadPublishedSnapshot(), dependencies.loadActiveGenerator(), dependencies.loadActiveModerator(),
  ]);
  if (!snapshot) return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: "A current published snapshot with exact draft evidence is unavailable." };
  if (!configuration) return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: "An active generator configuration is unavailable." };
  // Without an active moderator row the run still records evidence, but every clean refusal the
  // checker cannot see scores as uncaught, so the result says it ran unjudged.
  const judge = moderator ? dependencies.createJudge({ apiKey, configuration: moderator }) : undefined;
  const selection = dependencies.createExecutor({ snapshot, configuration, environment, judge });
  if (selection.state === "unavailable") return selection;
  const receipt = await dependencies.run({
    draftId: snapshot.draftId,
    contentHash: snapshot.contentHash,
    kind: "engine",
    modelConfigId: configuration.id,
    engineExecutor: selection.executor,
    corpus,
  });
  const { passed, outcomes } = summariseOutcomes(receipt, corpus);
  return {
    state: "complete", runId: receipt.run.id, snapshotId: snapshot.snapshotId,
    draftId: snapshot.draftId, contentHash: snapshot.contentHash, cases: corpus.cases.length,
    passed, judge: moderator ? "moderator" : "unjudged", moderatorConfigId: moderator?.id ?? null, outcomes,
  };
}
