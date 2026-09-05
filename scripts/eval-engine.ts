/**
 * Runs an eval suite against the published Brain snapshot and prints one line per case plus a
 * summary. Nothing is written to the database.
 *
 * `--suite safety` (the default) runs every engine case in the four safety corpora through the
 * active generator and moderator, exactly as the nightly and the admin comparison do.
 *
 * `--suite retrieval` runs evals/corpus/retrieval.json through the real `retrieveForTurn` against
 * the published snapshot's own match RPC and the live embeddings driver, with no generator or
 * moderator involved, and reports precision@1, recall@5, no-match precision and citation
 * validity. The two suites measure different things and their summaries are never combined: a
 * retrieval run prints no pass rate and a safety run prints no ranking figure.
 *
 * Invoke with the hosted project's variables already exported in the shell (the script reads no
 * .env file), for example:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENROUTER_API_KEY=... \
 *     SETTERFI_OPENROUTER_DRIVER=real npx --yes tsx scripts/eval-engine.ts \
 *     [--suite safety|retrieval] [--only <category>] [--key <substring>] [--limit <n>] [--json]
 *
 * The retrieval suite needs SETTERFI_EMBEDDINGS_DRIVER=real instead of the OpenRouter driver flag,
 * and refuses --only (its cases have no safety category).
 *
 * Exit code 1 when any case fails (safety: false_block, missed_by_checker or uncaught; retrieval:
 * anything other than hit_at_1 or no_match_correct); 2 on a configuration error. Credential
 * values are never printed.
 */

import { createClient } from "@supabase/supabase-js";

import { ENGINE_COMPARISON_CASES } from "@/lib/evals/comparison";
import { ENGINE_CASE_CATEGORIES, type EngineCaseCategory, type SafetyCorpusCase } from "@/lib/evals/corpus";
import { type EngineCaseOutcome, moderatorJudge } from "@/lib/evals/engine-case-scoring";
import { ENGINE_CASE_OUTCOMES } from "@/lib/evals/nightly-engine-evals";
import {
  createOpenRouterEngineCaseExecutor,
  type EngineModelConfiguration,
  type PublishedEngineSnapshot,
} from "@/lib/evals/openrouter-engine-executor";
import { createRealModeratorDriver } from "@/lib/integrations/openrouter";
import { resolveEmbeddingsDriver } from "@/lib/integrations/embeddings/selector";
import { loadRetrievalCorpus, normalizeEntryQuestion } from "@/lib/evals/retrieval-corpus";
import {
  runRetrievalCorpus,
  type RetrievalArm,
  type RetrievalCaseReport,
} from "@/lib/evals/retrieval-executor";

const SUITES = ["safety", "retrieval"] as const;
type Suite = (typeof SUITES)[number];

const REQUIRED_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY"] as const;

/** Outcomes that pass but say the checker fired where a decline or a plain reply was expected. */
const CHECKER_SILENT_CATEGORIES: ReadonlySet<EngineCaseCategory> = new Set(["refusal"]);

function requireEnvironment(suite: Suite) {
  const missing = REQUIRED_NAMES.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new Error(`ENGINE_EVAL_ENV_MISSING:${missing.join(",")}`);
  if (suite === "safety" && process.env.SETTERFI_OPENROUTER_DRIVER?.trim() !== "real") {
    throw new Error("ENGINE_EVAL_DRIVER_NOT_REAL:SETTERFI_OPENROUTER_DRIVER");
  }
  if (suite === "retrieval" && process.env.SETTERFI_EMBEDDINGS_DRIVER?.trim() !== "real") {
    throw new Error("ENGINE_EVAL_DRIVER_NOT_REAL:SETTERFI_EMBEDDINGS_DRIVER");
  }
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    openRouterKey: process.env.OPENROUTER_API_KEY as string,
  };
}

function parseArguments(argv: readonly string[]) {
  let suite: Suite = "safety";
  let only: EngineCaseCategory | null = null;
  let key: string | null = null;
  let limit: number | null = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--suite") {
      const value = argv[index + 1] ?? "";
      if (!(SUITES as readonly string[]).includes(value)) throw new Error(`ENGINE_EVAL_UNKNOWN_SUITE:${value}`);
      suite = value as Suite;
      index += 1;
    } else if (argument === "--only") {
      const value = argv[index + 1] ?? "";
      if (!(ENGINE_CASE_CATEGORIES as readonly string[]).includes(value)) {
        throw new Error(`ENGINE_EVAL_UNKNOWN_CATEGORY:${value}`);
      }
      only = value as EngineCaseCategory;
      index += 1;
    } else if (argument === "--key") {
      key = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--limit") {
      limit = Number(argv[index + 1]);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error("ENGINE_EVAL_LIMIT_INVALID");
      index += 1;
    } else if (argument === "--json") {
      json = true;
    } else {
      throw new Error(`ENGINE_EVAL_UNKNOWN_ARGUMENT:${argument}`);
    }
  }
  if (suite === "retrieval" && only !== null) throw new Error("ENGINE_EVAL_ONLY_UNSUPPORTED:retrieval");
  return { suite, only, key, limit, json };
}

function serviceClient(supabaseUrl: string, serviceRoleKey: string) {
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

type ServiceClient = ReturnType<typeof serviceClient>;

/** Mirrors loadPublishedEngineSnapshot without the app's server client, so the script owns its env. */
async function loadPublishedSnapshot(client: ServiceClient): Promise<PublishedEngineSnapshot> {
  const snapshot = await client.from("brain_snapshots")
    .select("id,version,content_hash,compiled_platform,eval_run_id")
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (snapshot.error) throw new Error(`ENGINE_EVAL_PUBLISHED_READ_FAILED:${snapshot.error.message}`);
  if (!snapshot.data?.eval_run_id) throw new Error("ENGINE_EVAL_PUBLISHED_SNAPSHOT_REQUIRED");
  const sourceRun = await client.from("eval_runs")
    .select("brain_draft_version_id,content_hash").eq("id", snapshot.data.eval_run_id).maybeSingle();
  if (sourceRun.error) throw new Error(`ENGINE_EVAL_PUBLISHED_EVIDENCE_READ_FAILED:${sourceRun.error.message}`);
  if (!sourceRun.data || sourceRun.data.content_hash !== snapshot.data.content_hash) {
    throw new Error("ENGINE_EVAL_PUBLISHED_EVIDENCE_MISMATCH");
  }
  return {
    snapshotId: String(snapshot.data.id), version: Number(snapshot.data.version),
    draftId: String(sourceRun.data.brain_draft_version_id), contentHash: String(snapshot.data.content_hash),
    compiledPlatform: String(snapshot.data.compiled_platform),
  };
}

async function loadActiveConfiguration(client: ServiceClient, role: "generator" | "moderator"): Promise<EngineModelConfiguration> {
  const { data, error } = await client.from("model_configs")
    .select("id,openrouter_model,params").eq("role", role).eq("active", true);
  if (error) throw new Error(`ENGINE_EVAL_CONFIG_READ_FAILED:${role}:${error.message}`);
  if (!data || data.length !== 1) throw new Error(`ENGINE_EVAL_ACTIVE_${role.toUpperCase()}_REQUIRED:${data?.length ?? 0}`);
  const row = data[0];
  const params = row.params;
  return {
    id: String(row.id),
    model: String(row.openrouter_model),
    params: params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {},
  };
}

type CaseReport = {
  key: string;
  category: EngineCaseCategory | null;
  expected: SafetyCorpusCase["expectation"];
  outcome: EngineCaseOutcome;
  passed: boolean;
  /** A passing outcome the reader should still look at: the checker fired on a refusal case. */
  warning: string | null;
  ruleIds: readonly string[];
  judge: unknown;
  latencyMs: number | null;
  costCredits: number | null;
  draft: string;
};

function warningFor(testCase: SafetyCorpusCase, outcome: EngineCaseOutcome) {
  if (outcome === "caught" && testCase.category && CHECKER_SILENT_CATEGORIES.has(testCase.category)) {
    return "checker fired on a refusal case: either the model complied or the checker over-matched the decline";
  }
  return null;
}

/**
 * The published snapshot's own entries and match RPC, so the suite ranks against exactly what a
 * live turn ranks against. A corpus question the snapshot does not carry resolves to null and the
 * executor reports that case unresolvable rather than guessing.
 */
async function createLiveRetrievalArm(client: ServiceClient, snapshot: PublishedEngineSnapshot): Promise<RetrievalArm> {
  const { data, error } = await client.from("brain_snapshot_entries")
    .select("entry_id,inbound_message").eq("snapshot_id", snapshot.snapshotId).limit(5000);
  if (error) throw new Error(`ENGINE_EVAL_SNAPSHOT_ENTRIES_READ_FAILED:${error.message}`);
  const byQuestion = new Map<string, string>();
  const ids = new Set<string>();
  for (const row of data ?? []) {
    const entryId = String(row.entry_id);
    ids.add(entryId);
    byQuestion.set(normalizeEntryQuestion(String(row.inbound_message)), entryId);
  }
  if (ids.size === 0) throw new Error("ENGINE_EVAL_SNAPSHOT_ENTRIES_EMPTY");
  return {
    label: `supabase:${snapshot.snapshotId}`,
    snapshotId: snapshot.snapshotId,
    embeddings: resolveEmbeddingsDriver(),
    repository: {
      matchPublished: async ({ expectedSnapshotId, queryEmbedding, categoryHint, limit }) => {
        const matched = await client.rpc("match_published_brain_entries", {
          p_expected_snapshot_id: expectedSnapshotId,
          p_query_embedding: `[${queryEmbedding.join(",")}]`,
          p_category_hint: categoryHint,
          p_limit: limit,
        });
        if (matched.error) throw new Error(`BRAIN_RETRIEVAL_RPC_FAILED:${matched.error.message}`);
        return matched.data ?? [];
      },
    },
    entryIdFor: (question) => byQuestion.get(normalizeEntryQuestion(question)) ?? null,
    knownEntry: (entryId) => ids.has(entryId),
  };
}

function printRetrievalReport(report: RetrievalCaseReport) {
  const flag = report.passed ? "ok  " : "FAIL";
  const expected = report.expected.kind === "entry" ? `entry:${report.expected.entryQuestion}` : "no_match";
  const rank = report.expectedRank === null ? "-" : `#${report.expectedRank}`;
  process.stdout.write(`${flag} ${report.outcome.padEnd(17)} ${rank.padEnd(3)} ${report.key}\n`);
  process.stdout.write(`     expected ${expected}\n`);
  if (report.includedEntryIds.length > 0) process.stdout.write(`     included: ${report.includedEntryIds.join(", ")}\n`);
  if (report.invalidCitations.length > 0) process.stdout.write(`     invalid citations: ${report.invalidCitations.join(", ")}\n`);
  if (report.error) process.stdout.write(`     error: ${report.error}\n`);
}

async function runRetrievalSuite(args: ReturnType<typeof parseArguments>) {
  const environment = requireEnvironment("retrieval");
  const client = serviceClient(environment.supabaseUrl, environment.serviceRoleKey);
  const snapshot = await loadPublishedSnapshot(client);
  const corpus = loadRetrievalCorpus();
  const arm = await createLiveRetrievalArm(client, snapshot);
  const selectedKeys = new Set(
    corpus.cases.filter((testCase) => args.key === null || testCase.key.includes(args.key))
      .slice(0, args.limit ?? corpus.cases.length).map((testCase) => testCase.key),
  );
  process.stderr.write(
    `snapshot v${snapshot.version} (${snapshot.snapshotId}), embeddings ${arm.embeddings.model}, ` +
    `${selectedKeys.size} of ${corpus.cases.length} retrieval cases; no generator or moderator runs in this suite\n`,
  );
  const run = await runRetrievalCorpus(arm, corpus, {
    filter: (testCase) => selectedKeys.has(testCase.key),
    onReport: args.json ? undefined : printRetrievalReport,
  });
  if (args.json) {
    console.log(JSON.stringify({ snapshot: { id: snapshot.snapshotId, version: snapshot.version }, ...run }, null, 2));
  } else {
    process.stdout.write(`\n${JSON.stringify(run.summary, null, 2)}\n`);
  }
  process.exitCode = run.reports.some((report) => !report.passed) ? 1 : 0;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.suite === "retrieval") {
    await runRetrievalSuite(args);
    return;
  }
  const { only, key, limit, json } = args;
  const environment = requireEnvironment("safety");
  const client = serviceClient(environment.supabaseUrl, environment.serviceRoleKey);
  const [snapshot, generator, moderator] = await Promise.all([
    loadPublishedSnapshot(client),
    loadActiveConfiguration(client, "generator"),
    loadActiveConfiguration(client, "moderator"),
  ]);
  const judge = moderatorJudge(createRealModeratorDriver(environment.openRouterKey, {
    role: "moderator", model: moderator.model, params: { ...moderator.params },
  }));
  const selection = createOpenRouterEngineCaseExecutor({ snapshot, configuration: generator, judge });
  if (selection.state !== "ready") throw new Error(`${selection.code}:${selection.reason}`);

  const selected = ENGINE_COMPARISON_CASES
    .filter((testCase) => only === null || testCase.category === only)
    .filter((testCase) => key === null || testCase.key.includes(key))
    .slice(0, limit ?? ENGINE_COMPARISON_CASES.length);

  process.stderr.write(
    `snapshot v${snapshot.version} (${snapshot.snapshotId}), generator ${generator.model} (${generator.id}), ` +
    `moderator ${moderator.model} (${moderator.id}), ${selected.length} of ${ENGINE_COMPARISON_CASES.length} engine cases\n`,
  );

  const reports: CaseReport[] = [];
  for (const testCase of selected) {
    const result = await selection.executor(testCase);
    const trace = result.trace as { outcome: EngineCaseOutcome; judge: unknown; providerCostCredits?: number | null };
    const report: CaseReport = {
      key: testCase.key,
      category: testCase.category ?? null,
      expected: testCase.expectation,
      outcome: trace.outcome,
      passed: result.passed,
      warning: warningFor(testCase, trace.outcome),
      ruleIds: result.ruleIds,
      judge: trace.judge,
      latencyMs: result.latencyMs ?? null,
      costCredits: trace.providerCostCredits ?? null,
      draft: result.response ?? "",
    };
    reports.push(report);
    if (!json) {
      const flag = report.passed ? (report.warning ? "WARN" : "ok  ") : "FAIL";
      const expected = `${report.expected.verdict}:${report.expected.class}`;
      process.stdout.write(`${flag} ${report.outcome.padEnd(17)} ${expected.padEnd(11)} ${report.key}\n`);
      process.stdout.write(`     ${JSON.stringify(report.draft)}\n`);
      if (report.ruleIds.length > 0) process.stdout.write(`     checker: ${report.ruleIds.join(", ")}\n`);
      if (report.judge) process.stdout.write(`     judge: ${JSON.stringify(report.judge)}\n`);
      if (report.warning) process.stdout.write(`     warning: ${report.warning}\n`);
    }
  }

  const outcomes = Object.fromEntries(ENGINE_CASE_OUTCOMES.map((outcome) => [outcome, 0])) as Record<EngineCaseOutcome, number>;
  for (const report of reports) outcomes[report.outcome] += 1;
  const byCategory = Object.fromEntries(
    ENGINE_CASE_CATEGORIES
      .map((category) => [category, reports.filter((report) => report.category === category)] as const)
      .filter(([, rows]) => rows.length > 0)
      .map(([category, rows]) => [category, {
        total: rows.length,
        passed: rows.filter((row) => row.passed).length,
        warnings: rows.filter((row) => row.warning !== null).length,
      }]),
  );
  const summary = {
    cases: reports.length,
    passed: reports.filter((report) => report.passed).length,
    warnings: reports.filter((report) => report.warning !== null).length,
    outcomes,
    byCategory,
    costCredits: reports.reduce((sum, report) => sum + (report.costCredits ?? 0), 0),
  };
  if (json) {
    console.log(JSON.stringify({
      snapshot: { id: snapshot.snapshotId, version: snapshot.version },
      generator, moderator, summary, reports,
    }, null, 2));
  } else {
    process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  }
  process.exitCode = reports.some((report) => !report.passed || report.outcome === "uncaught") ? 1 : 0;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
