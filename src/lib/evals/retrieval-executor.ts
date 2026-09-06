/**
 * Runs the retrieval integration corpus through the real `retrieveForTurn` against an injected
 * match arm, and reports four numbers that are never blended with the safety pass rate:
 *
 * - precision@1: expected-entry cases whose expected entry ranked first;
 * - recall@5: expected-entry cases whose expected entry is anywhere in the prompt candidates;
 * - no-match precision: of every case the pipeline answered "no match", the share that expected it;
 * - citation validity: of every candidate the pipeline offered the prompt, the share whose entry id
 *   exists in the snapshot the arm ranks against (a citation the engine could declare and verify).
 *
 * A denominator of zero renders the value `null`, never 100%. The arm is the only seam: unit tests
 * use the lexical fake below, the live runner supplies Supabase. `retrieveForTurn` today throws
 * `BRAIN_RETRIEVAL_NO_RENDERABLE_CANDIDATES` for an empty set; a typed no-match result is treated
 * identically, so a change on that side of the boundary changes no figure here.
 */

import type { EmbeddingsDriver } from "@/lib/integrations/embeddings/types";
import { EMBEDDING_DIMENSIONS } from "@/lib/integrations/embeddings/types";
import { retrieveForTurn, type BrainRetrievalRepository } from "@/lib/brain/retrieval";

import {
  loadRetrievalCorpus,
  normalizeEntryQuestion,
  type LoadedRetrievalCorpus,
  type RetrievalCorpusCase,
} from "./retrieval-corpus";

/** How many prompt candidates retrieval returns; the "5" in recall@5. */
export const RETRIEVAL_PROMPT_CANDIDATES = 5;

export type RetrievalArm = {
  /** Named in every report so a fake run can never be mistaken for a live one. */
  label: string;
  snapshotId: string;
  embeddings: EmbeddingsDriver;
  repository: BrainRetrievalRepository;
  /** Canonical entry question to the entry id the arm ranks; null when the snapshot lacks it. */
  entryIdFor(question: string): string | null;
  /** Whether an entry id the pipeline returned exists in the snapshot the arm ranks against. */
  knownEntry(entryId: string): boolean;
  /**
   * The similarity floor the pipeline applies for this arm. Absent means the engine default, which
   * is what a live arm should use so the suite measures the floor production runs with; the fake
   * arm's lexical embedding needs its own, lower one.
   */
  similarityFloor?: number;
};

export const RETRIEVAL_CASE_OUTCOMES = [
  "hit_at_1",
  "hit_at_5",
  "miss",
  "false_no_match",
  "no_match_correct",
  "no_match_missed",
  "unresolvable",
  "error",
] as const;
export type RetrievalCaseOutcome = (typeof RETRIEVAL_CASE_OUTCOMES)[number];

export type RetrievalCaseReport = {
  key: string;
  channel: RetrievalCorpusCase["channel"];
  expected: RetrievalCorpusCase["expected"];
  outcome: RetrievalCaseOutcome;
  passed: boolean;
  /** 1-based rank of the expected entry among the prompt candidates; null when absent or not expected. */
  expectedRank: number | null;
  includedEntryIds: readonly string[];
  /** Entry ids retrieval offered the prompt that the snapshot does not contain. */
  invalidCitations: readonly string[];
  droppedCount: number;
  error: string | null;
  latencyMs: number;
};

export type RetrievalRatio = { numerator: number; denominator: number; value: number | null };

export type RetrievalSummary = {
  suite: LoadedRetrievalCorpus["suite"];
  arm: string;
  snapshotId: string;
  corpusRevision: string;
  cases: number;
  passed: number;
  expectedEntryCases: number;
  expectedNoMatchCases: number;
  precisionAt1: RetrievalRatio;
  recallAt5: RetrievalRatio;
  noMatchPrecision: RetrievalRatio;
  citationValidity: RetrievalRatio;
  outcomes: Record<RetrievalCaseOutcome, number>;
};

export type RetrievalRun = { summary: RetrievalSummary; reports: RetrievalCaseReport[] };

type RetrievalOutcome =
  | { kind: "matched"; included: readonly { entryId: string; content: string }[]; dropped: number }
  | { kind: "no_match" }
  | { kind: "error"; message: string };

const NO_MATCH_ERROR = /NO_RENDERABLE_CANDIDATES|NO_MATCH/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads the pipeline's answer without depending on more of its shape than "did anything come
 * back". A thrown nothing-renderable, an empty `included`, or any explicit no-match marker a
 * future contract adds (`noMatch: true`, `outcome`/`kind` of `no_match`) all mean the same thing.
 */
export function classifyRetrievalResult(result: unknown): RetrievalOutcome {
  if (result instanceof Error) {
    return NO_MATCH_ERROR.test(result.message) ? { kind: "no_match" } : { kind: "error", message: result.message };
  }
  if (!isRecord(result)) return { kind: "error", message: "RETRIEVAL_RESULT_UNREADABLE" };
  if (result.noMatch === true || result.outcome === "no_match" || result.kind === "no_match") {
    return { kind: "no_match" };
  }
  const included = result.included;
  if (!Array.isArray(included)) return { kind: "error", message: "RETRIEVAL_RESULT_UNREADABLE" };
  if (included.length === 0) return { kind: "no_match" };
  const candidates = included.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.entryId !== "string") {
      throw new Error("RETRIEVAL_RESULT_CANDIDATE_UNREADABLE");
    }
    return { entryId: candidate.entryId, content: typeof candidate.content === "string" ? candidate.content : "" };
  });
  const dropped = Array.isArray(result.dropped) ? result.dropped.length : 0;
  return { kind: "matched", included: candidates, dropped };
}

async function runOne(arm: RetrievalArm, corpus: LoadedRetrievalCorpus, testCase: RetrievalCorpusCase): Promise<RetrievalCaseReport> {
  const started = Date.now();
  const expectedEntryId = testCase.expected.kind === "entry" ? arm.entryIdFor(testCase.expected.entryQuestion) : null;
  const base = {
    key: testCase.key,
    channel: testCase.channel,
    expected: testCase.expected,
    includedEntryIds: [] as readonly string[],
    invalidCitations: [] as readonly string[],
    droppedCount: 0,
    error: null as string | null,
  };
  if (testCase.expected.kind === "entry" && expectedEntryId === null) {
    return {
      ...base, outcome: "unresolvable", passed: false, expectedRank: null,
      error: `expected entry is not in snapshot ${arm.snapshotId}`, latencyMs: Date.now() - started,
    };
  }
  const answer = await retrieveForTurn({
    snapshotId: arm.snapshotId,
    inboundMessage: testCase.leadMessage,
    offer: corpus.fixture.offer,
    renderSources: corpus.fixture.renderSources,
    limit: RETRIEVAL_PROMPT_CANDIDATES,
    ...(arm.similarityFloor !== undefined ? { similarityFloor: arm.similarityFloor } : {}),
  }, {
    embeddings: arm.embeddings,
    repository: arm.repository,
    objectionsEnabled: () => false,
  }).then(classifyRetrievalResult, (error: unknown) =>
    classifyRetrievalResult(error instanceof Error ? error : new Error(String(error))));
  const latencyMs = Date.now() - started;

  if (answer.kind === "error") {
    return { ...base, outcome: "error", passed: false, expectedRank: null, error: answer.message, latencyMs };
  }
  if (answer.kind === "no_match") {
    const correct = testCase.expected.kind === "no_match";
    return { ...base, outcome: correct ? "no_match_correct" : "false_no_match", passed: correct, expectedRank: null, latencyMs };
  }
  const includedEntryIds = answer.included.map((candidate) => candidate.entryId);
  const invalidCitations = answer.included
    .filter((candidate) => !arm.knownEntry(candidate.entryId) || !candidate.content.trim())
    .map((candidate) => candidate.entryId);
  const matched = { ...base, includedEntryIds, invalidCitations, droppedCount: answer.dropped, latencyMs };
  if (testCase.expected.kind === "no_match") {
    return { ...matched, outcome: "no_match_missed", passed: false, expectedRank: null };
  }
  const index = includedEntryIds.indexOf(expectedEntryId as string);
  const expectedRank = index === -1 ? null : index + 1;
  const outcome: RetrievalCaseOutcome = expectedRank === 1 ? "hit_at_1" : expectedRank !== null ? "hit_at_5" : "miss";
  return { ...matched, outcome, passed: outcome === "hit_at_1", expectedRank };
}

function ratio(numerator: number, denominator: number): RetrievalRatio {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

export function summarizeRetrievalReports(
  reports: readonly RetrievalCaseReport[],
  context: { suite: LoadedRetrievalCorpus["suite"]; arm: string; snapshotId: string; corpusRevision: string },
): RetrievalSummary {
  const outcomes = Object.fromEntries(RETRIEVAL_CASE_OUTCOMES.map((outcome) => [outcome, 0])) as Record<RetrievalCaseOutcome, number>;
  for (const report of reports) outcomes[report.outcome] += 1;
  const entryCases = reports.filter((report) => report.expected.kind === "entry");
  const noMatchAnswers = reports.filter((report) => report.outcome === "no_match_correct" || report.outcome === "false_no_match");
  const includedTotal = reports.reduce((sum, report) => sum + report.includedEntryIds.length, 0);
  const invalidTotal = reports.reduce((sum, report) => sum + report.invalidCitations.length, 0);
  return {
    ...context,
    cases: reports.length,
    passed: reports.filter((report) => report.passed).length,
    expectedEntryCases: entryCases.length,
    expectedNoMatchCases: reports.length - entryCases.length,
    // Unresolvable and errored entry cases stay in the denominator: a figure that quietly drops
    // the cases it could not score would read higher than the retrieval it describes.
    precisionAt1: ratio(outcomes.hit_at_1, entryCases.length),
    recallAt5: ratio(outcomes.hit_at_1 + outcomes.hit_at_5, entryCases.length),
    noMatchPrecision: ratio(outcomes.no_match_correct, noMatchAnswers.length),
    citationValidity: ratio(includedTotal - invalidTotal, includedTotal),
    outcomes,
  };
}

export async function runRetrievalCorpus(
  arm: RetrievalArm,
  corpus: LoadedRetrievalCorpus = loadRetrievalCorpus(),
  options: { filter?: (testCase: RetrievalCorpusCase) => boolean; onReport?: (report: RetrievalCaseReport) => void } = {},
): Promise<RetrievalRun> {
  const reports: RetrievalCaseReport[] = [];
  for (const testCase of corpus.cases) {
    if (options.filter && !options.filter(testCase)) continue;
    const report = await runOne(arm, corpus, testCase);
    reports.push(report);
    options.onReport?.(report);
  }
  return {
    summary: summarizeRetrievalReports(reports, {
      suite: corpus.suite, arm: arm.label, snapshotId: arm.snapshotId, corpusRevision: corpus.revision,
    }),
    reports,
  };
}

// ---------------------------------------------------------------------------------------------
// The fake arm: a lexical embedding so unit tests exercise the real pipeline without a network.
// ---------------------------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "to", "of", "for", "in", "on", "at", "by", "with",
  "is", "it", "its", "be", "are", "was", "do", "does", "did", "i", "me", "my", "you", "your", "we",
  "this", "that", "these", "those", "what", "how", "can", "could", "will", "would", "if", "any",
  "there", "here", "still", "actually", "exactly", "really", "just", "ok", "okay", "get", "got",
  "from", "up", "out", "guys", "whole", "usually", "some", "who", "when", "where", "which", "also",
]);

function stem(token: string) {
  let stemmed = token.replace(/ies$/u, "y");
  // "guaranteed" and "guarantee" have to meet: strip the inflection, then a trailing e twice.
  for (const suffix of [/(ing|ed|es|s)$/u, /(al|e)$/u, /(e)$/u]) {
    stemmed = stemmed.replace(suffix, (match, _group, offset: number) => (offset >= 4 ? "" : match));
  }
  return stemmed;
}

export function lexicalTokens(value: string) {
  return (value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}%]+/gu) ?? [])
    .filter((token) => !STOPWORDS.has(token))
    .map(stem)
    .filter((token) => token.length > 1);
}

/**
 * Every stem the entries use gets its own bucket; anything else lands in one shared bucket no
 * entry touches. The shared bucket still counts toward the query's norm, so an off-topic message
 * that happens to share one word with an entry scores low rather than colliding into a hit.
 */
export type LexicalVocabulary = ReadonlyMap<string, number>;

export function buildLexicalVocabulary(texts: readonly string[]): LexicalVocabulary {
  const vocabulary = new Map<string, number>();
  for (const text of texts) {
    for (const token of lexicalTokens(text)) {
      if (!vocabulary.has(token)) vocabulary.set(token, vocabulary.size);
    }
  }
  if (vocabulary.size >= EMBEDDING_DIMENSIONS) throw new Error("RETRIEVAL_FAKE_VOCABULARY_OVERFLOW");
  return vocabulary;
}

/** Position-independent bag of stems, L2-normalized, so cosine is a dot product like the RPC's. */
export function lexicalEmbedding(value: string, vocabulary: LexicalVocabulary) {
  const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const unknownBucket = EMBEDDING_DIMENSIONS - 1;
  for (const token of lexicalTokens(value)) vector[vocabulary.get(token) ?? unknownBucket] += 1;
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return magnitude === 0 ? vector : vector.map((item) => item / magnitude);
}

function dot(left: readonly number[], right: readonly number[]) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

export const FAKE_ARM_SIMILARITY_FLOOR = 0.2;
export const FAKE_ARM_SNAPSHOT_ID = "retrieval-eval-fake-snapshot";

/**
 * Ranks the corpus's own entries with the lexical embedding and applies a similarity floor, the
 * way the database RPC is expected to. Entry ids are stable per corpus position so a report can
 * be read back against the file.
 */
export function createFakeRetrievalArm(corpus: LoadedRetrievalCorpus = loadRetrievalCorpus()): RetrievalArm {
  const vocabulary = buildLexicalVocabulary(corpus.entries.map((entry) => entry.question));
  const entries = corpus.entries.map((entry, index) => ({
    entryId: `retrieval-entry-${String(index + 1).padStart(2, "0")}`,
    category: entry.category,
    responseTemplate: entry.responseTemplate,
    normalized: normalizeEntryQuestion(entry.question),
    vector: lexicalEmbedding(entry.question, vocabulary),
  }));
  const byQuestion = new Map(entries.map((entry) => [entry.normalized, entry.entryId]));
  const ids = new Set(entries.map((entry) => entry.entryId));
  const embeddings: EmbeddingsDriver = {
    model: "mock-hash-1536",
    dimensions: EMBEDDING_DIMENSIONS,
    embed: async (input) => input.map(({ id, text }) => ({ id, vector: lexicalEmbedding(text, vocabulary) })),
  };
  const repository: BrainRetrievalRepository = {
    matchPublished: async ({ expectedSnapshotId, queryEmbedding, categoryHint, limit }) => {
      if (expectedSnapshotId !== FAKE_ARM_SNAPSHOT_ID) throw new Error("BRAIN_SNAPSHOT_NOT_CURRENT");
      return entries
        .map((entry) => {
          const similarity = dot(entry.vector, queryEmbedding);
          const categoryBoost = categoryHint !== null && categoryHint === entry.category ? 0.05 : 0;
          return {
            entry_id: entry.entryId,
            category: entry.category,
            response_template: entry.responseTemplate,
            // The fake arm has no reviewed provenance; the live RPC fills these three.
            number_bindings: [],
            rewrite_hash: null,
            matched_variant: null,
            similarity,
            category_boost: categoryBoost,
            score: similarity + categoryBoost,
          };
        })
        .filter((row) => row.similarity >= FAKE_ARM_SIMILARITY_FLOOR)
        .sort((left, right) => right.score - left.score || left.entry_id.localeCompare(right.entry_id))
        .slice(0, limit);
    },
  };
  return {
    label: "fake-lexical",
    snapshotId: FAKE_ARM_SNAPSHOT_ID,
    similarityFloor: FAKE_ARM_SIMILARITY_FLOOR,
    embeddings,
    repository,
    entryIdFor: (question) => byQuestion.get(normalizeEntryQuestion(question)) ?? null,
    knownEntry: (entryId) => ids.has(entryId),
  };
}
