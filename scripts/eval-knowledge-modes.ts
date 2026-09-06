/**
 * Side-by-side eval of the two knowledge modes (`inline` and `retrieved`, docs/BRAIN-COMPILER.md
 * §2) over one unpublished import batch. Nothing is written to the database.
 *
 * Every case in evals/corpus/retrieval.json runs one single-turn conversation per arm through the
 * real engine (`runEngineTurn`) with the active generator and moderator, the demo coach's live
 * published runtime bundle and the approved platform content, exactly as an admin test turn
 * would. Only the knowledge portion is swapped: the batch rows (`brain_import_items.after_payload`)
 * replace the snapshot's entries in memory. The `inline` arm hands them to the engine as the
 * bundle's `knowledgeEntries` under an `inline` snapshot, so `planInlineKnowledge` renders and
 * budget-checks them the way a live inline turn does. The `retrieved` arm marks the snapshot
 * `retrieved` and both arms rank the same rows through the draft in-process retriever (cosine
 * similarity, the 0.05 category boost, the engine's similarity floor and its typed
 * `no_grounded_answer` miss), because the published match RPC cannot rank rows that are not on
 * the current snapshot.
 *
 * Invoke with the hosted project's variables already exported in the shell (the script reads no
 * .env file), for example:
 *
 *   env -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_ANON_KEY -u SUPABASE_JWT_SECRET zsh -c \
 *     'set -a; source .env.local; set +a; npx --yes tsx --tsconfig tsconfig.json \
 *      scripts/eval-knowledge-modes.ts [--batch <uuid>] [--limit <n>] [--only <key-substring>] [--json]'
 *
 * Requires SETTERFI_OPENROUTER_DRIVER=real, SETTERFI_EMBEDDINGS_DRIVER=real and
 * SETTERFI_PHASE2_LIVE=true, plus SETTERFI_TAG_SECRET for the coach block. Roughly two generator
 * turns, two moderator calls and one embedding per case.
 *
 * Prints a per-case table, a per-arm summary and up to ten cases where the arms disagree, with
 * both replies, so a reader can judge quality. Exit code 1 when any turn errored, 2 on a
 * configuration error. Credential values are never printed.
 */

import type { PublishedKnowledgeEntry, PublishedRuntimeBundle } from "@/lib/brain/contracts";
import { knowledgeNumberBindings, rewriteHash } from "@/lib/brain/provenance";
import { DEFAULT_RETRIEVAL_SIMILARITY_FLOOR } from "@/lib/brain/retrieval";
import { activeModelConfigurations } from "@/lib/engine/model-config";
import {
  engineBrainFromRuntimeBundle,
  engineOfferFromRuntimeBundle,
  INLINE_KNOWLEDGE_TOKEN_BUDGET,
  planInlineKnowledge,
  runEngineTurn,
  type EnginePipelineInput,
} from "@/lib/engine/pipeline";
import type { EngineTurnResult, ModeratorClass, PromptMessage } from "@/lib/engine/types";
import {
  loadRetrievalCorpus,
  normalizeEntryQuestion,
  type RetrievalCorpusCase,
} from "@/lib/evals/retrieval-corpus";
import { resolveEmbeddingsDriver } from "@/lib/integrations/embeddings/selector";
import type { EmbeddingsDriver } from "@/lib/integrations/embeddings/types";
import {
  createMockModelDriver,
  createMockModeratorDriver,
  createRealModelDriver,
  createRealModeratorDriver,
} from "@/lib/integrations/openrouter";
import { selectModelDrivers } from "@/lib/integrations/selector";
import type { ModelDriver, ModeratorDriver } from "@/lib/integrations/types";
import { resolveDemoCoachTenant } from "@/lib/operations/smoke";
import {
  createDraftRetriever,
  type DraftKnowledgeRow,
  type RetrieveForTurn,
} from "@/lib/repositories/brain-revision-runtime";
import { loadPublishedRuntimeBundle } from "@/lib/repositories/brain-runtime";
import { heldClassOf, type TestTurnChannel } from "@/lib/repositories/brain-test-turn";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { loadApprovedPlatformAgentContent } from "@/lib/webhooks/live-preview";

const DEFAULT_BATCH_ID = "73347367-768d-4aa4-bc7a-3ae96a909483";
const ARMS = ["inline", "retrieved"] as const;
type Arm = (typeof ARMS)[number];
const DISAGREEMENTS_PRINTED = 10;

const REQUIRED_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY",
  "SETTERFI_TAG_SECRET",
] as const;
const REQUIRED_VALUES = {
  SETTERFI_OPENROUTER_DRIVER: "real",
  SETTERFI_EMBEDDINGS_DRIVER: "real",
  SETTERFI_PHASE2_LIVE: "true",
} as const;

function requireEnvironment() {
  const missing = REQUIRED_NAMES.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new Error(`KNOWLEDGE_EVAL_ENV_MISSING:${missing.join(",")}`);
  for (const [name, expected] of Object.entries(REQUIRED_VALUES)) {
    if (process.env[name]?.trim() !== expected) throw new Error(`KNOWLEDGE_EVAL_ENV_VALUE:${name}=${expected}`);
  }
  return { tagSecret: process.env.SETTERFI_TAG_SECRET as string };
}

function parseArguments(argv: readonly string[]) {
  let batchId = DEFAULT_BATCH_ID;
  let limit: number | null = null;
  let only: string | null = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--batch") {
      batchId = argv[index + 1] ?? "";
      if (!/^[0-9a-f-]{36}$/.test(batchId)) throw new Error("KNOWLEDGE_EVAL_BATCH_INVALID");
      index += 1;
    } else if (argument === "--limit") {
      limit = Number(argv[index + 1]);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error("KNOWLEDGE_EVAL_LIMIT_INVALID");
      index += 1;
    } else if (argument === "--only") {
      only = argv[index + 1] ?? null;
      if (!only) throw new Error("KNOWLEDGE_EVAL_ONLY_INVALID");
      index += 1;
    } else if (argument === "--json") {
      json = true;
    } else {
      throw new Error(`KNOWLEDGE_EVAL_UNKNOWN_ARGUMENT:${argument}`);
    }
  }
  return { batchId, limit, only, json };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseEmbedding(value: unknown): readonly number[] | null {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    return null;
  }
  return parsed as number[];
}

/** One batch row in both shapes the engine reads: the inline entry and the draft retrieval row. */
type BatchEntry = {
  entry: PublishedKnowledgeEntry;
  retrieval: DraftKnowledgeRow;
};

async function loadBatchEntries(batchId: string): Promise<BatchEntry[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("brain_import_items")
    .select("id,source_ref,after_payload,number_bindings")
    .eq("batch_id", batchId)
    .order("id", { ascending: true });
  if (error) throw new Error(`KNOWLEDGE_EVAL_BATCH_READ_FAILED:${error.message}`);
  const entries = (data ?? []).flatMap((row): BatchEntry[] => {
    const payload = row.after_payload;
    if (!isRecord(payload)) throw new Error(`KNOWLEDGE_EVAL_BATCH_ROW_INVALID:${row.id}`);
    const question = typeof payload.inboundMessage === "string" ? payload.inboundMessage.trim() : "";
    const category = typeof payload.category === "string" ? payload.category.trim() : "";
    const responseTemplate = typeof payload.responseTemplate === "string" ? payload.responseTemplate : "";
    const embedding = parseEmbedding(payload.embedding);
    if (!question || !category || !responseTemplate.trim() || !embedding) {
      throw new Error(`KNOWLEDGE_EVAL_BATCH_ROW_INVALID:${row.id}`);
    }
    const numberBindings = knowledgeNumberBindings(row.number_bindings);
    const hash = rewriteHash(responseTemplate);
    const entryId = String(row.id);
    return [{
      entry: {
        entryId,
        category,
        question,
        responseTemplate,
        numberBindings,
        rewriteHash: hash,
        sourceRef: typeof row.source_ref === "string" ? row.source_ref : null,
      },
      retrieval: { id: entryId, category, responseTemplate, embedding, numberBindings, rewriteHash: hash },
    }];
  });
  if (entries.length === 0) throw new Error("KNOWLEDGE_EVAL_BATCH_EMPTY");
  return entries;
}

/** The same lead text embeds once and both arms rank against an identical query vector. */
function memoizedEmbeddings(driver: EmbeddingsDriver): EmbeddingsDriver {
  const cache = new Map<string, readonly number[]>();
  return {
    model: driver.model,
    dimensions: driver.dimensions,
    embed: async (input) => {
      const pending = input.filter((item) => !cache.has(item.text));
      if (pending.length > 0) {
        const embedded = await driver.embed(pending);
        for (const result of embedded) {
          const source = pending.find((item) => item.id === result.id);
          if (source) cache.set(source.text, result.vector);
        }
      }
      return input.map((item) => {
        const vector = cache.get(item.text);
        if (!vector) throw new Error("KNOWLEDGE_EVAL_EMBEDDING_MISSING");
        return { id: item.id, vector };
      });
    },
  };
}

function armBundle(base: PublishedRuntimeBundle, arm: Arm, entries: readonly BatchEntry[]): PublishedRuntimeBundle {
  const { knowledgeEntries: _live, ...rest } = base;
  void _live;
  return {
    ...rest,
    brain: { ...base.brain, knowledgeMode: arm },
    ...(arm === "inline" ? { knowledgeEntries: entries.map((entry) => entry.entry) } : {}),
  };
}

async function loadModelConfigs(): Promise<EnginePipelineInput["modelConfigs"]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("model_configs").select("id, role, openrouter_model, params, active");
  if (error) throw new Error(`KNOWLEDGE_EVAL_MODEL_CONFIG_READ_FAILED:${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id,
    role: row.role as "generator" | "moderator",
    openrouterModel: row.openrouter_model,
    params: (row.params ?? {}) as Record<string, unknown>,
    active: row.active,
  }));
}

/** The same driver selection the admin test turn makes, so the arms run the active model pair. */
async function selectDrivers(modelConfigs: EnginePipelineInput["modelConfigs"]): Promise<{ model: ModelDriver; moderator: ModeratorDriver }> {
  return selectModelDrivers({
    loadActiveConfigurations: async () => activeModelConfigurations(modelConfigs),
    factories: {
      mockModel: createMockModelDriver,
      mockModerator: createMockModeratorDriver,
      realModel: (_configuration, apiKey) => createRealModelDriver(apiKey),
      realModerator: (configuration, apiKey) => createRealModeratorDriver(apiKey, configuration),
    },
  });
}

type ArmReport = {
  arm: Arm;
  reply: string;
  held: boolean;
  heldClass: ModeratorClass | null;
  heldReason: string | null;
  verdict: EngineTurnResult["trace"]["screen"]["verdict"];
  /** The mode the engine recorded for the turn, which is the arm unless inline fell back. */
  knowledgeMode: EngineTurnResult["trace"]["knowledgeMode"];
  declaredEntryId: string | null;
  declaredEntryVerified: boolean;
  /** Inline: every rendered entry. Retrieved: the rows above the floor the model was shown. */
  promptEntryIds: readonly string[];
  topThree: readonly { entryId: string; similarity: number; score: number }[];
  citedExpected: boolean | null;
  /** No-match cases: how the arm handled a question the batch cannot answer. */
  noMatchOutcome: "miss_held" | "replied" | "held_other" | null;
  ruleFired: string | null;
  moderator: EngineTurnResult["trace"]["moderator"];
  moderatorReason: string | null;
  attempts: number;
  promptTokens: number | null;
  completionTokens: number | null;
  modelLatencyMs: number | null;
  wallMs: number;
  cost: number | null;
  error: string | null;
};

type CaseReport = {
  key: string;
  channel: TestTurnChannel;
  leadMessage: string;
  expected: { kind: "entry"; entryId: string; entryQuestion: string } | { kind: "no_match" };
  /** False when the expected entry is dropped at render for this coach, so neither arm can cite it. */
  expectedRenderable: boolean;
  arms: Record<Arm, ArmReport>;
  disagree: boolean;
};

type Harness = {
  bundles: Record<Arm, PublishedRuntimeBundle>;
  retrieve: RetrieveForTurn;
  content: Awaited<ReturnType<typeof loadApprovedPlatformAgentContent>>;
  modelConfigs: EnginePipelineInput["modelConfigs"];
  drivers: { model: ModelDriver; moderator: ModeratorDriver };
  tagSecret: string;
  linkWhitelist: readonly string[];
  inlineEntryIds: readonly string[];
  droppedEntryIds: ReadonlySet<string>;
};

function publishedLinkWhitelist(bundle: PublishedRuntimeBundle) {
  const urls = [bundle.renderSources.bookingUrl, ...Object.values(bundle.renderSources.assetUrlsBySlug)];
  return [...new Set(urls.flatMap((value) => {
    if (!value) return [];
    try {
      return [new URL(value).hostname];
    } catch {
      return [];
    }
  }))];
}

async function runArm(harness: Harness, arm: Arm, testCase: RetrievalCorpusCase, expected: CaseReport["expected"]): Promise<ArmReport> {
  const bundle = harness.bundles[arm];
  const channel: TestTurnChannel = testCase.channel ?? "sms";
  const history: PromptMessage[] = [{ role: "user", content: testCase.leadMessage }];
  const started = Date.now();
  const base = {
    arm, reply: "", held: false, heldClass: null, heldReason: null, verdict: "held" as const,
    knowledgeMode: arm, declaredEntryId: null, declaredEntryVerified: false, promptEntryIds: [],
    topThree: [], citedExpected: null, noMatchOutcome: null, ruleFired: null, moderator: "not_run" as const,
    moderatorReason: null, attempts: 0, promptTokens: null, completionTokens: null, modelLatencyMs: null, wallMs: 0, cost: null, error: null,
  } satisfies ArmReport;
  let result: EngineTurnResult;
  try {
    result = await runEngineTurn({
      mode: "test",
      channel,
      brain: engineBrainFromRuntimeBundle(bundle),
      offer: engineOfferFromRuntimeBundle(bundle),
      conversation: { state: "agent", currentStep: null, currentStepAsks: 0, disclosurePending: false },
      history,
      leadMessage: { id: `knowledge-eval:${arm}:${testCase.key}`, body: testCase.leadMessage },
      tagSecret: harness.tagSecret,
      automatedExperienceDisclosure: harness.content.automatedExperienceDisclosure,
      heldReplies: harness.content.heldReplies,
      linkWhitelist: harness.linkWhitelist,
      roleBoundary: harness.content.roleBoundary,
      modelConfigs: harness.modelConfigs,
      currentQuestion: null,
      extractionCandidate: null,
      qualificationState: {
        credit: null, goal: null, timeline: null, businessStage: null,
        annualRevenueCents: null, outcome: null, dqReason: null,
      },
      runtimeBundle: bundle,
    }, { model: harness.drivers.model, moderator: harness.drivers.moderator, retrieve: harness.retrieve });
  } catch (error) {
    return { ...base, wallMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
  const { trace, response } = result;
  const held = trace.screen.verdict === "held";
  const cited = trace.declaredEntryVerified ? trace.declaredEntryId : null;
  const promptEntryIds = trace.knowledgeMode === "inline"
    ? harness.inlineEntryIds
    : trace.sources.map((source) => source.entryId);
  const noMatchOutcome: ArmReport["noMatchOutcome"] = expected.kind === "no_match"
    ? (held ? (trace.screen.reason === "no_grounded_answer" ? "miss_held" : "held_other") : "replied")
    : null;
  return {
    ...base,
    reply: response.reply,
    held,
    heldClass: heldClassOf(result, harness.content.heldReplies) ?? null,
    heldReason: held ? trace.screen.reason : null,
    verdict: trace.screen.verdict,
    knowledgeMode: trace.knowledgeMode,
    declaredEntryId: trace.declaredEntryId,
    declaredEntryVerified: trace.declaredEntryVerified,
    promptEntryIds,
    topThree: trace.retrievalTopThree.map(({ entryId, similarity, score }) => ({ entryId, similarity, score })),
    citedExpected: expected.kind === "entry" ? cited === expected.entryId : null,
    noMatchOutcome,
    ruleFired: trace.ruleFired,
    moderator: trace.moderator,
    moderatorReason: trace.moderatorReason,
    attempts: trace.attempts,
    promptTokens: trace.usage?.promptTokens ?? null,
    completionTokens: trace.usage?.completionTokens ?? null,
    modelLatencyMs: trace.latencyMs,
    wallMs: Date.now() - started,
    cost: trace.cost,
  };
}

function armsDisagree(inline: ArmReport, retrieved: ArmReport) {
  return inline.held !== retrieved.held
    || inline.citedExpected !== retrieved.citedExpected
    || inline.noMatchOutcome !== retrieved.noMatchOutcome
    || Boolean(inline.error) !== Boolean(retrieved.error);
}

function mean(values: readonly (number | null)[]) {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length === 0 ? null : Math.round(present.reduce((sum, value) => sum + value, 0) / present.length);
}

function armSummary(reports: readonly CaseReport[], arm: Arm) {
  const rows = reports.map((report) => report.arms[arm]);
  const entryRows = reports.filter((report) => report.expected.kind === "entry").map((report) => report.arms[arm]);
  const noMatchRows = reports.filter((report) => report.expected.kind === "no_match").map((report) => report.arms[arm]);
  const count = (outcome: ArmReport["noMatchOutcome"]) => noMatchRows.filter((row) => row.noMatchOutcome === outcome).length;
  return {
    cases: rows.length,
    errors: rows.filter((row) => row.error).length,
    ranAsMode: Object.fromEntries(ARMS.map((mode) => [mode, rows.filter((row) => !row.error && row.knowledgeMode === mode).length])),
    entryCases: entryRows.length,
    expectedCited: entryRows.filter((row) => row.citedExpected === true).length,
    expectedCitedRate: entryRows.length ? Number((entryRows.filter((row) => row.citedExpected === true).length / entryRows.length).toFixed(3)) : null,
    held: rows.filter((row) => row.held).length,
    heldRate: rows.length ? Number((rows.filter((row) => row.held).length / rows.length).toFixed(3)) : null,
    heldByClass: Object.fromEntries(
      [...new Set(rows.filter((row) => row.held).map((row) => row.heldClass ?? "unknown"))]
        .sort()
        .map((heldClass) => [heldClass, rows.filter((row) => row.held && (row.heldClass ?? "unknown") === heldClass).length]),
    ),
    noMatchCases: noMatchRows.length,
    noMatch: { missHeld: count("miss_held"), replied: count("replied"), heldOther: count("held_other") },
    meanPromptTokens: mean(rows.map((row) => row.promptTokens)),
    meanCompletionTokens: mean(rows.map((row) => row.completionTokens)),
    meanModelLatencyMs: mean(rows.map((row) => row.modelLatencyMs)),
    meanWallMs: mean(rows.map((row) => row.wallMs)),
    regenerations: rows.filter((row) => row.attempts > 1).length,
    totalCost: Number(rows.reduce((sum, row) => sum + (row.cost ?? 0), 0).toFixed(6)),
    costKnown: rows.filter((row) => typeof row.cost === "number").length,
  };
}

function flag(value: boolean | null, when: string) {
  return value === null ? " -  " : value ? when.padEnd(4) : "no  ";
}

function armCell(row: ArmReport) {
  if (row.error) return "ERROR          ";
  const cite = row.noMatchOutcome ? row.noMatchOutcome.padEnd(10) : `cite:${flag(row.citedExpected, "yes")}`;
  const held = row.held ? `held:${(row.heldClass ?? "?").padEnd(5)}` : "ok        ";
  return `${cite} ${held}`;
}

function printCaseLine(report: CaseReport) {
  const expected = report.expected.kind === "entry" ? (report.expectedRenderable ? "entry   " : "entry(x)") : "no_match";
  const marker = report.disagree ? "!=" : "  ";
  process.stdout.write(
    `${marker} ${report.key.padEnd(44)} ${expected} | inline: ${armCell(report.arms.inline)} | retrieved: ${armCell(report.arms.retrieved)}\n`,
  );
}

function printDisagreements(reports: readonly CaseReport[]) {
  const disagreements = reports.filter((report) => report.disagree);
  process.stdout.write(`\n${disagreements.length} of ${reports.length} cases disagree between the arms`);
  if (disagreements.length > DISAGREEMENTS_PRINTED) process.stdout.write(`; the first ${DISAGREEMENTS_PRINTED} follow`);
  process.stdout.write("\n");
  for (const report of disagreements.slice(0, DISAGREEMENTS_PRINTED)) {
    process.stdout.write(`\n--- ${report.key} (${report.channel})\n`);
    process.stdout.write(`lead: ${JSON.stringify(report.leadMessage)}\n`);
    if (report.expected.kind === "entry") {
      process.stdout.write(`expected entry: ${report.expected.entryId} ${JSON.stringify(report.expected.entryQuestion)}${report.expectedRenderable ? "" : " (dropped at render for this coach)"}\n`);
    }
    else process.stdout.write("expected: no match\n");
    for (const arm of ARMS) {
      const row = report.arms[arm];
      const status = row.error
        ? `error ${row.error}`
        : row.held
          ? `held ${row.heldClass ?? "?"} (${row.heldReason ?? row.ruleFired ?? "?"})`
          : `ok, cited ${row.declaredEntryId ?? "none"}${row.declaredEntryVerified ? "" : " (unverified)"}`;
      const closest = row.topThree[0] ? `, closest ${row.topThree[0].entryId} sim ${row.topThree[0].similarity.toFixed(3)}` : "";
      const moderated = row.moderator === "blocked" ? `, moderator blocked: ${row.moderatorReason ?? "?"}` : "";
      process.stdout.write(`[${arm}] ${status}${closest}${moderated}\n`);
      process.stdout.write(`  ${JSON.stringify(row.reply)}\n`);
    }
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const { tagSecret } = requireEnvironment();

  const [entries, tenant, modelConfigs] = await Promise.all([
    loadBatchEntries(args.batchId),
    resolveDemoCoachTenant(),
    loadModelConfigs(),
  ]);
  if (!tenant) throw new Error("KNOWLEDGE_EVAL_DEMO_TENANT_MISSING");
  const [base, content, drivers] = await Promise.all([
    loadPublishedRuntimeBundle(tenant.id),
    loadApprovedPlatformAgentContent(tenant.id),
    selectDrivers(modelConfigs),
  ]);

  const corpus = loadRetrievalCorpus();
  const entryIdByQuestion = new Map(entries.map((entry) => [normalizeEntryQuestion(entry.entry.question), entry.entry.entryId]));
  const unmapped = corpus.cases.filter((testCase) =>
    testCase.expected.kind === "entry" && !entryIdByQuestion.has(normalizeEntryQuestion(testCase.expected.entryQuestion)));
  if (unmapped.length > 0) {
    throw new Error(`KNOWLEDGE_EVAL_EXPECTED_QUESTION_UNMAPPED:${unmapped.map((testCase) => testCase.key).join(",")}`);
  }

  const bundles: Record<Arm, PublishedRuntimeBundle> = {
    inline: armBundle(base, "inline", entries),
    retrieved: armBundle(base, "retrieved", entries),
  };
  const inlinePlan = planInlineKnowledge(bundles.inline);
  if (inlinePlan.mode !== "inline") {
    throw new Error(`KNOWLEDGE_EVAL_INLINE_UNAVAILABLE:${inlinePlan.reason}:${inlinePlan.estimatedTokens ?? "?"}`);
  }
  const embeddings = memoizedEmbeddings(resolveEmbeddingsDriver());
  const retrieve = createDraftRetriever({
    loadDraftKnowledge: async () => entries.map((entry) => entry.retrieval),
    embeddings: () => embeddings,
  });
  const harness: Harness = {
    bundles,
    retrieve,
    content,
    modelConfigs,
    drivers,
    tagSecret,
    linkWhitelist: publishedLinkWhitelist(base),
    inlineEntryIds: inlinePlan.inline.map((entry) => entry.entryId),
    droppedEntryIds: new Set(inlinePlan.dropped.map((entry) => entry.entryId)),
  };

  const selected = corpus.cases
    .filter((testCase) => args.only === null || testCase.key.includes(args.only))
    .slice(0, args.limit ?? corpus.cases.length);
  const generator = activeModelConfigurations(modelConfigs).find((row) => row.role === "generator");
  const moderator = activeModelConfigurations(modelConfigs).find((row) => row.role === "moderator");
  process.stderr.write(
    `tenant ${tenant.slug}, base snapshot v${base.brainVersion} (${base.snapshotId}, published ${base.brain.knowledgeMode}), ` +
    `offer v${base.offerVersion}, batch ${args.batchId} (${entries.length} rows), ` +
    `inline section ${inlinePlan.inline.length} entries ~${inlinePlan.estimatedTokens} tokens of ${INLINE_KNOWLEDGE_TOKEN_BUDGET}` +
    `${inlinePlan.dropped.length ? `, ${inlinePlan.dropped.length} dropped at render` : ""}, ` +
    `floor ${base.brain.retrievalFloor ?? DEFAULT_RETRIEVAL_SIMILARITY_FLOOR}, embeddings ${embeddings.model}, ` +
    `generator ${generator?.model ?? "?"}, moderator ${moderator?.model ?? "?"}, ` +
    `${selected.length} of ${corpus.cases.length} cases x ${ARMS.length} arms\n`,
  );

  for (const dropped of inlinePlan.dropped) {
    const question = entries.find((entry) => entry.entry.entryId === dropped.entryId)?.entry.question ?? "?";
    process.stderr.write(`dropped at render: ${dropped.entryId} (${dropped.reason}) ${JSON.stringify(question)}\n`);
  }

  const reports: CaseReport[] = [];
  for (const testCase of selected) {
    const expected: CaseReport["expected"] = testCase.expected.kind === "entry"
      ? {
          kind: "entry",
          entryId: entryIdByQuestion.get(normalizeEntryQuestion(testCase.expected.entryQuestion)) as string,
          entryQuestion: testCase.expected.entryQuestion,
        }
      : { kind: "no_match" };
    const [inline, retrieved] = await Promise.all(ARMS.map((arm) => runArm(harness, arm, testCase, expected)));
    const report: CaseReport = {
      key: testCase.key,
      channel: testCase.channel ?? "sms",
      leadMessage: testCase.leadMessage,
      expected,
      expectedRenderable: expected.kind === "no_match" || !harness.droppedEntryIds.has(expected.entryId),
      arms: { inline, retrieved },
      disagree: armsDisagree(inline, retrieved),
    };
    reports.push(report);
    if (!args.json) printCaseLine(report);
  }

  const summary = {
    cases: reports.length,
    disagreements: reports.filter((report) => report.disagree).length,
    expectedEntryUnrenderable: reports.filter((report) => !report.expectedRenderable).length,
    inline: armSummary(reports, "inline"),
    retrieved: armSummary(reports, "retrieved"),
  };
  if (args.json) {
    console.log(JSON.stringify({
      tenant,
      baseSnapshot: { id: base.snapshotId, version: base.brainVersion, publishedMode: base.brain.knowledgeMode },
      batchId: args.batchId,
      batchRows: entries.length,
      inlineEstimatedTokens: inlinePlan.estimatedTokens,
      generator: generator?.model ?? null,
      moderator: moderator?.model ?? null,
      summary,
      reports,
    }, null, 2));
  } else {
    process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
    printDisagreements(reports);
  }
  process.exitCode = reports.some((report) => ARMS.some((arm) => report.arms[arm].error)) ? 1 : 0;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
