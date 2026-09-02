/** Hash-bound eval persistence; the committed run and every case row are read before success. */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const EVAL_SUITE_NAMES = [
  "compliance_guardrails",
  "pricing_discipline",
  "jailbreak_injection",
  "output_integrity",
  "qualification_accuracy",
  "voice_tone",
] as const;
export type EvalSuiteName = (typeof EVAL_SUITE_NAMES)[number];

export type EvalCaseResultInput = {
  caseKey: string;
  passed: boolean;
  response: string | null;
  trace: Readonly<Record<string, unknown>>;
  latencyMs: number | null;
  costCents: number | null;
};
export type EvalSuiteResultInput = { suite: EvalSuiteName; cases: readonly EvalCaseResultInput[] };

export type EvalRunRecord = {
  id: string;
  brainDraftVersionId: string;
  contentHash: string;
  kind: "checker" | "engine";
  modelConfigId: string | null;
  corpusRevision: string;
  suitesComplete: boolean;
};
export type EvalCaseResultRecord = EvalCaseResultInput & {
  id: string;
  runId: string;
  suite: EvalSuiteName;
  caseId: string | null;
};
export type EvalRunReceipt = { run: EvalRunRecord; results: readonly EvalCaseResultRecord[] };

export type EvalRunDependencies = {
  record: (args: Record<string, unknown>) => Promise<string>;
  loadRun: (id: string) => Promise<EvalRunRecord | null>;
  loadResults: (id: string) => Promise<EvalCaseResultRecord[]>;
};

function runRow(row: Record<string, unknown>): EvalRunRecord {
  return {
    id: String(row.id),
    brainDraftVersionId: String(row.brain_draft_version_id),
    contentHash: String(row.content_hash),
    kind: row.kind as EvalRunRecord["kind"],
    modelConfigId: typeof row.model_config_id === "string" ? row.model_config_id : null,
    corpusRevision: String(row.corpus_revision),
    suitesComplete: row.suites_complete === true,
  };
}

async function liveDependencies(): Promise<EvalRunDependencies> {
  const client = createSupabaseServiceClient();
  return {
    record: async (args) => {
      const { data, error } = await client.rpc("record_eval_run", args);
      if (error || typeof data !== "string") throw new Error(`EVAL_RUN_RECORD_FAILED:${error?.message ?? "empty"}`);
      return data;
    },
    loadRun: async (id) => {
      const { data, error } = await client.from("eval_runs").select(
        "id,brain_draft_version_id,content_hash,kind,model_config_id,corpus_revision,suites_complete",
      ).eq("id", id).single();
      return error || !data ? null : runRow(data as Record<string, unknown>);
    },
    loadResults: async (id) => {
      const { data, error } = await client.from("eval_case_results").select(
        "id,run_id,case_id,case_key,suite,passed,response,trace,latency_ms,cost_cents",
      ).eq("run_id", id).order("suite").order("case_key");
      if (error) throw new Error(`EVAL_RESULTS_READ_FAILED:${error.message}`);
      return (data ?? []).map((row) => ({
        id: String(row.id),
        runId: String(row.run_id),
        caseId: typeof row.case_id === "string" ? row.case_id : null,
        caseKey: String(row.case_key),
        suite: row.suite as EvalSuiteName,
        passed: row.passed === true,
        response: typeof row.response === "string" ? row.response : null,
        trace: row.trace as Readonly<Record<string, unknown>>,
        latencyMs: typeof row.latency_ms === "number" ? row.latency_ms : null,
        costCents: typeof row.cost_cents === "number" ? row.cost_cents : null,
      }));
    },
  };
}

function validateInput(input: Parameters<typeof recordEvalRun>[0]) {
  if (!input.expectedDraftId.trim()) throw new Error("EVAL_DRAFT_ID_REQUIRED");
  if (!/^[0-9a-f]{64}$/.test(input.expectedContentHash)) throw new Error("EVAL_CONTENT_HASH_INVALID");
  if ((input.kind === "checker" && input.modelConfigId !== null) ||
    (input.kind === "engine" && !input.modelConfigId)) {
    throw new Error("EVAL_MODEL_CONFIG_SHAPE_INVALID");
  }
  const suites = input.suites.map((suite) => suite.suite).sort();
  if (JSON.stringify(suites) !== JSON.stringify([...EVAL_SUITE_NAMES].sort())) {
    throw new Error("EVAL_SUITES_INCOMPLETE");
  }
  const keys = input.suites.flatMap((suite) => {
    if (suite.cases.length === 0) throw new Error(`EVAL_SUITE_CASES_REQUIRED:${suite.suite}`);
    return suite.cases.map((result) => result.caseKey);
  });
  if (keys.some((key) => !key.trim()) || new Set(keys).size !== keys.length) {
    throw new Error("EVAL_CASE_KEYS_INVALID");
  }
}

export async function recordEvalRun(
  input: {
    expectedDraftId: string;
    expectedContentHash: string;
    kind: "checker" | "engine";
    modelConfigId: string | null;
    corpusRevision: string;
    suites: readonly EvalSuiteResultInput[];
  },
  dependencies?: EvalRunDependencies,
): Promise<EvalRunReceipt> {
  validateInput(input);
  const deps = dependencies ?? (await liveDependencies());
  const id = await deps.record({
    p_expected_draft_id: input.expectedDraftId,
    p_expected_content_hash: input.expectedContentHash,
    p_kind: input.kind,
    p_model_config_id: input.modelConfigId,
    p_corpus_revision: input.corpusRevision,
    p_suite_results: input.suites,
  });
  const [run, results] = await Promise.all([deps.loadRun(id), deps.loadResults(id)]);
  if (!run || run.brainDraftVersionId !== input.expectedDraftId ||
    run.contentHash !== input.expectedContentHash || run.kind !== input.kind ||
    run.modelConfigId !== input.modelConfigId || run.corpusRevision !== input.corpusRevision ||
    !run.suitesComplete) {
    throw new Error("EVAL_RUN_READBACK_MISMATCH");
  }
  const expected = input.suites.flatMap((suite) => suite.cases.map((result) => ({
    suite: suite.suite,
    caseKey: result.caseKey,
    passed: result.passed,
  }))).sort((left, right) => left.suite.localeCompare(right.suite) || left.caseKey.localeCompare(right.caseKey));
  const persisted = results.map((result) => ({
    suite: result.suite,
    caseKey: result.caseKey,
    passed: result.passed,
  })).sort((left, right) => left.suite.localeCompare(right.suite) || left.caseKey.localeCompare(right.caseKey));
  if (JSON.stringify(persisted) !== JSON.stringify(expected) || results.some((result) => result.caseId !== null)) {
    throw new Error("EVAL_RESULTS_READBACK_MISMATCH");
  }
  return { run, results };
}

export async function loadEvalRun(id: string, dependencies?: EvalRunDependencies): Promise<EvalRunReceipt | null> {
  const deps = dependencies ?? (await liveDependencies());
  const run = await deps.loadRun(id);
  if (!run) return null;
  return { run, results: await deps.loadResults(id) };
}
