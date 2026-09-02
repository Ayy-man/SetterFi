/**
 * Eval comparison repository over the Phase 7 guarded RPCs.
 *
 * The request carries only draft/hash/config ids. Case selection, driver selection, model params,
 * execution evidence, and the final comparison read-back remain server-owned.
 */

import {
  assertComparisonConfigs,
  caseSetHash,
  compareEvalRuns,
  ENGINE_COMPARISON_CASES,
  type ComparisonCaseResult,
  type ComparisonEvidence,
  type ComparisonModelConfig,
  type ComparisonRunEvidence,
  type EvalComparisonResult,
} from "@/lib/evals/comparison";
import { runOutputChecks } from "@/lib/engine/output-checks";
import { loadSafetyCorpus, type SafetyCorpusCase } from "@/lib/evals/corpus";
import { runAndRecordEval, type EngineCaseExecutor } from "@/lib/evals/runner";
import {
  parseJudgmentCases,
  type JudgmentCase,
} from "@/lib/evals/judgment-cases";
import {
  judgmentResultKeys,
  runJudgmentSuites,
  type JudgeModelConfig,
  type JudgmentRubricSource,
} from "@/lib/evals/judgment-runner";
import { loadPublishedRuntimeBundle } from "@/lib/repositories/brain-runtime";
import {
  DriverConfigurationError,
  driverSelection,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";
import {
  createMockModelDriver,
  createRealModelDriver,
} from "@/lib/integrations/openrouter";
import type { ActiveModelConfiguration } from "@/lib/integrations/selector";
import {
  type EvalRunReceipt,
  type EvalSuiteName,
} from "@/lib/repositories/eval-runs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type ChallengerModelConfig = ComparisonModelConfig & {
  auditId: string;
};

export type ChallengerDependencies = {
  create(args: Record<string, unknown>): Promise<{ modelConfigId: string; auditId: string }>;
  loadConfig(id: string): Promise<ComparisonModelConfig | null>;
  loadAudit(id: string): Promise<{
    id: string;
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string;
  } | null>;
};

export type ComparisonContext = {
  draft: { id: string; contentHash: string };
  configA: ComparisonModelConfig;
  configB: ComparisonModelConfig;
};

export type EvalComparisonDependencies = {
  loadContext(input: {
    draftId: string;
    modelConfigAId: string;
    modelConfigBId: string;
  }): Promise<ComparisonContext>;
  start(args: Record<string, unknown>): Promise<string>;
  runArm(input: {
    draftId: string;
    contentHash: string;
    config: ComparisonModelConfig;
    driver: ComparisonDriver;
    cases: readonly SafetyCorpusCase[];
    judgmentCases: readonly JudgmentCase[];
    judgeConfig: JudgeModelConfig | null;
  }): Promise<EvalRunReceipt>;
  /** Promoted judgement cases, and the moderator row that scores them. Both may be empty. */
  loadJudgmentCases(): Promise<readonly JudgmentCase[]>;
  loadJudgeConfig(): Promise<JudgeModelConfig | null>;
  finish(args: Record<string, unknown>): Promise<string>;
  load(comparisonId: string): Promise<ComparisonEvidence | null>;
};

export type ComparisonDriver = {
  arm: "mock" | "real";
  apiKey: string | null;
};

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonObject(value: unknown) {
  return object(value) ?? {};
}

function modelConfig(row: Record<string, unknown>): ComparisonModelConfig {
  return {
    id: String(row.id),
    model: String(row.openrouter_model),
    params: jsonObject(row.params),
    role: row.role === "moderator" ? "moderator" : "generator",
    active: row.active === true,
  };
}

async function liveChallengerDependencies(): Promise<ChallengerDependencies> {
  const client = createSupabaseServiceClient();
  return {
    create: async (args) => {
      const { data, error } = await client.rpc("create_challenger_model_config", args);
      const row = Array.isArray(data) ? object(data[0]) : object(data);
      if (error || !row?.model_config_id || row.audit_id === null || row.audit_id === undefined) {
        throw new Error(`EVAL_CHALLENGER_CREATE_FAILED:${error?.message ?? "empty"}`);
      }
      return { modelConfigId: String(row.model_config_id), auditId: String(row.audit_id) };
    },
    loadConfig: async (id) => {
      const { data, error } = await client.from("model_configs")
        .select("id,openrouter_model,params,role,active").eq("id", id).maybeSingle();
      return error || !data ? null : modelConfig(data as Record<string, unknown>);
    },
    loadAudit: async (id) => {
      const { data, error } = await client.from("audit_log")
        .select("id,actor_id,action,target_type,target_id").eq("id", id).maybeSingle();
      return error || !data ? null : {
        id: String(data.id),
        actorId: typeof data.actor_id === "string" ? data.actor_id : null,
        action: String(data.action),
        targetType: String(data.target_type),
        targetId: String(data.target_id),
      };
    },
  };
}

export async function createChallengerModelConfig(
  input: { actorId: string; model: string; params: Readonly<Record<string, unknown>> },
  dependencies?: ChallengerDependencies,
): Promise<ChallengerModelConfig> {
  const actorId = input.actorId.trim();
  const model = input.model.trim();
  if (!actorId || !model || !object(input.params)) throw new Error("EVAL_CHALLENGER_INPUT_INVALID");
  const deps = dependencies ?? await liveChallengerDependencies();
  const created = await deps.create({
    p_actor_id: actorId,
    p_model: model,
    p_params: input.params,
  });
  const [config, audit] = await Promise.all([
    deps.loadConfig(created.modelConfigId),
    deps.loadAudit(created.auditId),
  ]);
  if (!config || config.id !== created.modelConfigId || config.model !== model ||
    config.role !== "generator" || config.active ||
    !audit || audit.id !== created.auditId || audit.actorId !== actorId ||
    audit.action !== "eval.model_config.created" || audit.targetType !== "model_config" ||
    audit.targetId !== created.modelConfigId) {
    throw new Error("EVAL_CHALLENGER_READBACK_MISMATCH");
  }
  return { ...config, auditId: audit.id };
}

export function resolveComparisonDriver(
  environment: EnvironmentSource = process.env,
): ComparisonDriver {
  const arm = driverSelection("openrouter", "SETTERFI_OPENROUTER_DRIVER", environment);
  if (arm === "mock") return { arm, apiKey: null };
  const values = requireEnvironment("openrouter", ["OPENROUTER_API_KEY"], environment);
  return { arm, apiKey: values.OPENROUTER_API_KEY };
}

function executionPassed(testCase: SafetyCorpusCase, actual: ReturnType<typeof runOutputChecks>) {
  if (testCase.expectation.verdict === "pass") return actual.passed;
  const ruleIds = new Set(actual.violations.map((violation) => violation.ruleId));
  return actual.violations.some((violation) => violation.class === testCase.expectation.class) &&
    testCase.expectation.ruleIds.every((ruleId) => ruleIds.has(ruleId));
}

function engineExecutor(
  config: ComparisonModelConfig,
  driver: ComparisonDriver,
): EngineCaseExecutor {
  const activeConfig: ActiveModelConfiguration = {
    role: "generator",
    model: config.model,
    params: { ...config.params },
  };
  const model = driver.arm === "real"
    ? createRealModelDriver(driver.apiKey!)
    : createMockModelDriver(activeConfig);
  return async (testCase) => {
    const messages = [
      {
        role: "system" as const,
        content: `${testCase.context.systemText}\n\n${testCase.context.roleBoundary}`,
      },
      ...testCase.turns.map((turn) => ({
        role: turn.role === "lead" ? "user" as const : "assistant" as const,
        content: turn.content,
      })),
    ];
    const generated = await model.generate(messages, {
      model: config.model,
      params: { ...config.params },
    });
    const actual = runOutputChecks(generated.draft, testCase.context);
    const ruleIds = [...new Set(actual.violations.map((violation) => violation.ruleId))];
    return {
      passed: executionPassed(testCase, actual),
      response: generated.draft,
      ruleIds,
      trace: {
        driverArm: driver.arm,
        expected: testCase.expectation,
        actualPassed: actual.passed,
        checks: actual.checks,
        violations: actual.violations,
        providerCostCredits: generated.provider.cost,
      },
      latencyMs: generated.provider.latencyMs,
      // Provider credits stay in trace until their unit is approved; this legacy column is cents.
      costCents: null,
    };
  };
}

function runRow(row: Record<string, unknown>): Omit<ComparisonRunEvidence, "results"> {
  const knowledgeMode = row.knowledge_mode === "inline" || row.knowledge_mode === "retrieved"
    ? row.knowledge_mode
    : null;
  return {
    id: String(row.id),
    brainDraftVersionId: String(row.brain_draft_version_id),
    contentHash: String(row.content_hash),
    kind: row.kind === "checker" ? "checker" : "engine",
    modelConfigId: typeof row.model_config_id === "string" ? row.model_config_id : null,
    brainVersion: typeof row.brain_version === "number" ? row.brain_version : null,
    offerVersion: typeof row.offer_version === "number" ? row.offer_version : null,
    rulesVersion: typeof row.rules_version === "string" ? row.rules_version : null,
    knowledgeMode,
    corpusRevision: String(row.corpus_revision),
    suitesComplete: row.suites_complete === true,
    comparisonId: typeof row.comparison_id === "string" ? row.comparison_id : null,
    comparisonArm: row.comparison_arm === "a" || row.comparison_arm === "b"
      ? row.comparison_arm
      : null,
    caseSetHash: typeof row.case_set_hash === "string" ? row.case_set_hash : null,
  };
}

function resultRow(row: Record<string, unknown>): ComparisonCaseResult & {
  runId: string;
  driverArm: "mock" | "real" | null;
} {
  const trace = jsonObject(row.trace);
  return {
    runId: String(row.run_id),
    caseKey: String(row.case_key),
    suite: row.suite as EvalSuiteName,
    passed: row.passed === true,
    trace,
    latencyMs: typeof row.latency_ms === "number" ? row.latency_ms : null,
    driverArm: trace.driverArm === "real" || trace.driverArm === "mock" ? trace.driverArm : null,
  };
}

async function loadComparisonEvidence(
  client: ServiceClient,
  comparisonId: string,
): Promise<ComparisonEvidence | null> {
  const { data: comparisonData, error: comparisonError } = await client.from("eval_comparisons")
    .select("id,status,brain_draft_version_id,content_hash,model_config_a_id,model_config_b_id,case_set_hash,run_a_id,run_b_id,created_at,finished_at")
    .eq("id", comparisonId).maybeSingle();
  if (comparisonError) throw new Error(`EVAL_COMPARISON_READ_FAILED:${comparisonError.message}`);
  if (!comparisonData) return null;
  const runIds = [comparisonData.run_a_id, comparisonData.run_b_id]
    .filter((id): id is string => typeof id === "string");
  let runA: ComparisonRunEvidence | null = null;
  let runB: ComparisonRunEvidence | null = null;
  let driverArm: "mock" | "real" = "mock";
  if (runIds.length > 0) {
    const [{ data: runData, error: runError }, { data: resultData, error: resultError }] = await Promise.all([
      client.from("eval_runs").select(
        "id,brain_draft_version_id,content_hash,kind,model_config_id,brain_version,offer_version,rules_version,knowledge_mode,corpus_revision,suites_complete,comparison_id,comparison_arm,case_set_hash",
      ).in("id", runIds),
      client.from("eval_case_results").select(
        "run_id,case_key,suite,passed,trace,latency_ms",
      ).in("run_id", runIds).order("suite").order("case_key"),
    ]);
    if (runError || resultError) {
      throw new Error(`EVAL_COMPARISON_EVIDENCE_READ_FAILED:${runError?.message ?? resultError?.message}`);
    }
    const results = (resultData ?? []).map((row) => resultRow(row as Record<string, unknown>));
    const arms = new Set(results.map((row) => row.driverArm).filter(Boolean));
    if (arms.size > 1) throw new Error("EVAL_COMPARISON_DRIVER_ARM_MISMATCH");
    driverArm = arms.has("real") ? "real" : "mock";
    const runs = new Map((runData ?? []).map((row) => {
      const parsed = runRow(row as Record<string, unknown>);
      return [parsed.id, {
        ...parsed,
        results: results.filter((result) => result.runId === parsed.id).map((result) => ({
          caseKey: result.caseKey,
          suite: result.suite,
          passed: result.passed,
          trace: result.trace,
          latencyMs: result.latencyMs,
        })),
      } satisfies ComparisonRunEvidence] as const;
    }));
    runA = typeof comparisonData.run_a_id === "string" ? runs.get(comparisonData.run_a_id) ?? null : null;
    runB = typeof comparisonData.run_b_id === "string" ? runs.get(comparisonData.run_b_id) ?? null : null;
  }
  return {
    comparisonId: String(comparisonData.id),
    status: comparisonData.status === "completed" ? "completed" : "pending",
    brainDraftVersionId: String(comparisonData.brain_draft_version_id),
    contentHash: String(comparisonData.content_hash),
    modelConfigAId: String(comparisonData.model_config_a_id),
    modelConfigBId: String(comparisonData.model_config_b_id),
    caseSetHash: String(comparisonData.case_set_hash),
    runAId: typeof comparisonData.run_a_id === "string" ? comparisonData.run_a_id : null,
    runBId: typeof comparisonData.run_b_id === "string" ? comparisonData.run_b_id : null,
    createdAt: String(comparisonData.created_at),
    finishedAt: typeof comparisonData.finished_at === "string" ? comparisonData.finished_at : null,
    driverArm,
    runA,
    runB,
  };
}

/**
 * A judgement case is evidence from one coach's conversation, so its rubric is that coach's own
 * published configuration: the platform qualification matrix they inherited, and the voice answers
 * they wrote into their offer layer. A tenant with no published bundle yields null, which the
 * runner records as an errored case rather than a score.
 */
export async function loadJudgmentRubricSource(
  tenantId: string,
): Promise<JudgmentRubricSource | null> {
  try {
    const bundle = await loadPublishedRuntimeBundle(tenantId);
    return {
      tenantId,
      compiledPlatform: bundle.brain.compiledPlatform,
      qualification: bundle.qualification,
      qualificationApproved: bundle.qualificationApproved,
      offer: {
        brandVoice: bundle.offer.brandVoice,
        voiceStyleAnswer: bundle.offer.voiceStyleAnswer,
        voiceObjectionAnswer: bundle.offer.voiceObjectionAnswer,
        voiceFollowupAnswer: bundle.offer.voiceFollowupAnswer,
      },
    };
  } catch {
    return null;
  }
}

async function liveJudgmentCases(): Promise<readonly JudgmentCase[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("eval_cases")
    .select("id,suite,kind,turns,expectation,source_tenant_id")
    .in("suite", ["qualification_accuracy", "voice_tone"])
    .eq("active", true)
    .order("id");
  if (error) throw new Error(`EVAL_JUDGMENT_CASES_READ_FAILED:${error.message}`);
  return parseJudgmentCases((data ?? []) as Record<string, unknown>[]);
}

/** The judge is the active moderator row — the same model-config mechanism every other role uses. */
async function liveJudgeConfig(): Promise<JudgeModelConfig | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("model_configs")
    .select("id,openrouter_model,params").eq("role", "moderator").eq("active", true).maybeSingle();
  if (error) throw new Error(`EVAL_JUDGE_CONFIG_READ_FAILED:${error.message}`);
  if (!data) return null;
  return {
    id: String(data.id),
    model: String(data.openrouter_model),
    params: jsonObject(data.params),
  };
}

async function liveEvalComparisonDependencies(): Promise<EvalComparisonDependencies> {
  const client = createSupabaseServiceClient();
  return {
    loadContext: async (input) => {
      const [{ data: draft, error: draftError }, { data: configs, error: configError }] = await Promise.all([
        client.from("brain_draft_versions").select("id,content_hash").eq("id", input.draftId).maybeSingle(),
        client.from("model_configs").select("id,openrouter_model,params,role,active")
          .in("id", [input.modelConfigAId, input.modelConfigBId]),
      ]);
      if (draftError || !draft) throw new Error("EVAL_COMPARISON_DRAFT_NOT_FOUND");
      if (configError) throw new Error(`EVAL_COMPARISON_CONFIG_READ_FAILED:${configError.message}`);
      const mapped = new Map((configs ?? []).map((row) => {
        const parsed = modelConfig(row as Record<string, unknown>);
        return [parsed.id, parsed] as const;
      }));
      const configA = mapped.get(input.modelConfigAId);
      const configB = mapped.get(input.modelConfigBId);
      if (!configA || !configB) throw new Error("EVAL_COMPARISON_CONFIG_NOT_FOUND");
      return {
        draft: { id: String(draft.id), contentHash: String(draft.content_hash) },
        configA,
        configB,
      };
    },
    start: async (args) => {
      const { data, error } = await client.rpc("start_eval_comparison", args);
      if (error || typeof data !== "string") {
        throw new Error(`EVAL_COMPARISON_START_FAILED:${error?.message ?? "empty"}`);
      }
      return data;
    },
    runArm: async (input) => runAndRecordEval({
      draftId: input.draftId,
      contentHash: input.contentHash,
      kind: "engine",
      modelConfigId: input.config.id,
      engineExecutor: engineExecutor(input.config, input.driver),
      judgmentSuites: await runJudgmentSuites({
        arm: input.driver.arm,
        cases: input.judgmentCases,
        judgeConfig: input.judgeConfig,
        generatorConfig: { id: input.config.id, model: input.config.model, params: input.config.params },
        ...(input.driver.arm === "real"
          ? {
              generate: createRealModelDriver(input.driver.apiKey!).generate,
              judge: createRealModelDriver(input.driver.apiKey!).generate,
              loadRubricSource: loadJudgmentRubricSource,
            }
          : {}),
      }),
      corpus: { revision: loadSafetyCorpus().revision, cases: input.cases },
    }),
    loadJudgmentCases: liveJudgmentCases,
    loadJudgeConfig: liveJudgeConfig,
    finish: async (args) => {
      const { data, error } = await client.rpc("finish_eval_comparison", args);
      if (error || typeof data !== "string") {
        throw new Error(`EVAL_COMPARISON_FINISH_FAILED:${error?.message ?? "empty"}`);
      }
      return data;
    },
    load: async (comparisonId) => loadComparisonEvidence(client, comparisonId),
  };
}

function expectedResultKeys(
  cases: readonly SafetyCorpusCase[],
  judgmentCases: readonly JudgmentCase[],
  judgeConfigured: boolean,
) {
  return [
    ...cases.map((testCase) => `${testCase.suite}:${testCase.key}`),
    ...judgmentResultKeys({ cases: judgmentCases, judgeConfigured }),
  ].sort();
}

function assertPreFinishRun(
  receipt: EvalRunReceipt,
  input: { draftId: string; contentHash: string; configId: string; expectedKeys: readonly string[] },
) {
  if (receipt.run.brainDraftVersionId !== input.draftId ||
    receipt.run.contentHash !== input.contentHash || receipt.run.kind !== "engine" ||
    receipt.run.modelConfigId !== input.configId || !receipt.run.suitesComplete) {
    throw new Error("EVAL_COMPARISON_RUN_READBACK_MISMATCH");
  }
  const keys = receipt.results.map((result) => `${result.suite}:${result.caseKey}`).sort();
  if (JSON.stringify(keys) !== JSON.stringify(input.expectedKeys)) {
    throw new Error("EVAL_COMPARISON_RESULT_KEY_MISMATCH");
  }
}

export async function runEvalComparison(
  input: {
    actorId: string;
    draftId: string;
    contentHash: string;
    modelConfigAId: string;
    modelConfigBId: string;
  },
  dependencies?: EvalComparisonDependencies,
  environment: EnvironmentSource = process.env,
): Promise<EvalComparisonResult> {
  const normalized = {
    actorId: input.actorId.trim(),
    draftId: input.draftId.trim(),
    contentHash: input.contentHash.trim(),
    modelConfigAId: input.modelConfigAId.trim(),
    modelConfigBId: input.modelConfigBId.trim(),
  };
  if (!normalized.actorId || !normalized.draftId || !normalized.modelConfigAId ||
    !normalized.modelConfigBId || !/^[0-9a-f]{64}$/.test(normalized.contentHash)) {
    throw new Error("EVAL_COMPARISON_INPUT_INVALID");
  }
  const driver = resolveComparisonDriver(environment);
  const deps = dependencies ?? await liveEvalComparisonDependencies();
  const context = await deps.loadContext(normalized);
  if (context.draft.id !== normalized.draftId || context.draft.contentHash !== normalized.contentHash) {
    throw new Error("EVAL_COMPARISON_DRAFT_MISMATCH");
  }
  assertComparisonConfigs(context.configA, context.configB);
  const cases = ENGINE_COMPARISON_CASES;
  const [judgmentCases, judgeConfig] = await Promise.all([
    deps.loadJudgmentCases(),
    deps.loadJudgeConfig(),
  ]);
  // No judge row means the judged suites stay not-configured, exactly as they read before they
  // were built; the arms are still compared on the safety suites.
  const judged = judgeConfig ? judgmentCases : [];
  const hash = caseSetHash(cases, judged);
  const comparisonId = await deps.start({
    p_actor_id: normalized.actorId,
    p_brain_draft_version_id: context.draft.id,
    p_content_hash: context.draft.contentHash,
    p_model_config_a_id: context.configA.id,
    p_model_config_b_id: context.configB.id,
    p_case_set_hash: hash,
  });
  const [runA, runB] = await Promise.all([
    deps.runArm({ draftId: context.draft.id, contentHash: context.draft.contentHash,
      config: context.configA, driver, cases, judgmentCases: judged, judgeConfig }),
    deps.runArm({ draftId: context.draft.id, contentHash: context.draft.contentHash,
      config: context.configB, driver, cases, judgmentCases: judged, judgeConfig }),
  ]);
  const expectedKeys = expectedResultKeys(cases, judged, judgeConfig !== null);
  assertPreFinishRun(runA, {
    draftId: context.draft.id,
    contentHash: context.draft.contentHash,
    configId: context.configA.id,
    expectedKeys,
  });
  assertPreFinishRun(runB, {
    draftId: context.draft.id,
    contentHash: context.draft.contentHash,
    configId: context.configB.id,
    expectedKeys,
  });
  if (runA.run.corpusRevision !== runB.run.corpusRevision || runA.run.id === runB.run.id) {
    throw new Error("EVAL_COMPARISON_RUN_CONTEXT_MISMATCH");
  }
  const finishedId = await deps.finish({
    p_comparison_id: comparisonId,
    p_run_a_id: runA.run.id,
    p_run_b_id: runB.run.id,
    p_case_set_hash: hash,
  });
  if (finishedId !== comparisonId) throw new Error("EVAL_COMPARISON_FINISH_READBACK_MISMATCH");
  const evidence = await deps.load(comparisonId);
  if (!evidence || evidence.driverArm !== driver.arm) {
    throw new Error("EVAL_COMPARISON_READBACK_MISMATCH");
  }
  return compareEvalRuns(evidence, cases);
}

export async function loadEvalComparison(
  comparisonId: string,
): Promise<EvalComparisonResult | null> {
  const id = comparisonId.trim();
  if (!id) throw new Error("EVAL_COMPARISON_ID_REQUIRED");
  const evidence = await loadComparisonEvidence(createSupabaseServiceClient(), id);
  return evidence ? compareEvalRuns(evidence) : null;
}

export type EvalComparisonExport = {
  comparison: {
    comparisonId: string;
    status: string;
    brainDraftVersionId: string;
    contentHash: string;
    brainVersion: number | null;
    offerVersion: number | null;
    rulesVersion: string | null;
    knowledgeMode: "inline" | "retrieved" | null;
    corpusRevision: string | null;
    caseSetHash: string;
    modelConfigAId: string;
    modelConfigBId: string;
    runAId: string | null;
    runBId: string | null;
    createdAt: string;
    finishedAt: string | null;
  };
  results: readonly {
    comparisonId: string;
    arm: "a" | "b";
    suite: EvalSuiteName;
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
    state: string;
  }[];
};

export function evalComparisonExportRows(
  result: EvalComparisonResult,
): EvalComparisonExport {
  return {
    comparison: {
      comparisonId: result.comparisonId,
      status: `completed_${result.driverArm}_${result.state}`,
      brainDraftVersionId: result.brainDraftVersionId,
      contentHash: result.contentHash,
      brainVersion: result.brainVersion,
      offerVersion: result.offerVersion,
      rulesVersion: result.rulesVersion,
      knowledgeMode: result.knowledgeMode,
      corpusRevision: result.corpusRevision,
      caseSetHash: result.caseSetHash,
      modelConfigAId: result.modelConfigAId,
      modelConfigBId: result.modelConfigBId,
      runAId: result.runAId,
      runBId: result.runBId,
      createdAt: result.createdAt,
      finishedAt: result.finishedAt,
    },
    results: result.suites.flatMap((suite) => ([
      { comparisonId: result.comparisonId, arm: "a" as const, suite: suite.suite, ...suite.armA,
        state: `${result.driverArm}_${suite.state}` },
      { comparisonId: result.comparisonId, arm: "b" as const, suite: suite.suite, ...suite.armB,
        state: `${result.driverArm}_${suite.state}` },
    ])),
  };
}

/** Exact export projection; pending evidence stays non-numeric and mock evidence stays labelled. */
export async function loadEvalComparisonExport(
  comparisonId: string,
): Promise<EvalComparisonExport | null> {
  const id = comparisonId.trim();
  if (!id) throw new Error("EVAL_COMPARISON_ID_REQUIRED");
  const evidence = await loadComparisonEvidence(createSupabaseServiceClient(), id);
  if (!evidence) return null;
  if (evidence.status !== "completed") {
    return {
      comparison: {
        comparisonId: evidence.comparisonId,
        status: "pending_non_comparable",
        brainDraftVersionId: evidence.brainDraftVersionId,
        contentHash: evidence.contentHash,
        brainVersion: null,
        offerVersion: null,
        rulesVersion: null,
        knowledgeMode: null,
        corpusRevision: null,
        caseSetHash: evidence.caseSetHash,
        modelConfigAId: evidence.modelConfigAId,
        modelConfigBId: evidence.modelConfigBId,
        runAId: evidence.runAId,
        runBId: evidence.runBId,
        createdAt: evidence.createdAt,
        finishedAt: evidence.finishedAt,
      },
      results: [],
    };
  }
  const result = compareEvalRuns(evidence);
  return evalComparisonExportRows(result);
}

export function isDriverConfigurationError(error: unknown): error is DriverConfigurationError {
  return error instanceof DriverConfigurationError;
}
