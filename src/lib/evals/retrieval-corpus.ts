/**
 * Loader for the retrieval integration corpus under evals/corpus/retrieval.json.
 *
 * This suite is deliberately not a member of `SAFETY_SUITES`: it measures whether the Brain's
 * retrieval ranks the right entry for a lead's phrasing, and its numbers are never blended with the
 * safety pass rate. JSON is the only case-data authority; this module validates and projects it,
 * and a malformed file refuses the whole run before a figure can look green.
 */

import { createHash } from "node:crypto";

import retrieval from "../../../evals/corpus/retrieval.json";

import type { PublishedCoachOffer, PublishedRuntimeBundle } from "@/lib/brain/contracts";
import { serializeCanonicalJson, type CanonicalJson } from "@/lib/brain/snapshot/canonicalize";

export const RETRIEVAL_SUITE = "retrieval_integration" as const;

/** The six Prospect FAQ Sheet categories, as `docs/BRAIN-COMPILER.md` §6 records them. */
export const RETRIEVAL_ENTRY_CATEGORIES = [
  "General Questions",
  "Credit",
  "Business",
  "Program/Service",
  "Application/Booking",
  "Funding Qs",
] as const;
export type RetrievalEntryCategory = (typeof RETRIEVAL_ENTRY_CATEGORIES)[number];

export const RETRIEVAL_CHANNELS = ["sms", "instagram", "messenger", "whatsapp"] as const;
export type RetrievalChannel = (typeof RETRIEVAL_CHANNELS)[number];

export type RetrievalCorpusEntry = {
  question: string;
  category: RetrievalEntryCategory;
  responseTemplate: string;
};

export type RetrievalExpectation =
  | { kind: "entry"; entryQuestion: string }
  | { kind: "no_match" };

export type RetrievalCorpusCase = {
  key: string;
  leadMessage: string;
  channel: RetrievalChannel | null;
  expected: RetrievalExpectation;
  notes: readonly string[];
};

/** The small coach-offer fixture every case renders against; the same one on the fake and live arms. */
export type RetrievalOfferFixture = {
  offer: PublishedCoachOffer;
  renderSources: PublishedRuntimeBundle["renderSources"];
};

export type LoadedRetrievalCorpus = {
  suite: typeof RETRIEVAL_SUITE;
  revision: string;
  fixture: RetrievalOfferFixture;
  entries: readonly RetrievalCorpusEntry[];
  cases: readonly RetrievalCorpusCase[];
};

const CATEGORIES = new Set<string>(RETRIEVAL_ENTRY_CATEGORIES);
const CHANNELS = new Set<string>(RETRIEVAL_CHANNELS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refuse(where: string, reason: string): never {
  throw new Error(`RETRIEVAL_CORPUS_INVALID:${where}:${reason}`);
}

function nonEmptyString(value: unknown, where: string, field: string) {
  if (typeof value !== "string" || !value.trim()) refuse(where, field);
  return value;
}

function optionalCents(value: unknown, where: string, field: string) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) refuse(where, field);
  return value;
}

/** Whitespace, case and trailing punctuation never decide whether two questions are the same entry. */
export function normalizeEntryQuestion(value: string) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/u, "");
}

function fixture(value: unknown): RetrievalOfferFixture {
  if (!isRecord(value)) refuse("offer", "shape");
  const programName = nonEmptyString(value.programName, "offer", "programName");
  const fundingGoalMinCents = optionalCents(value.fundingGoalMinCents, "offer", "fundingGoalMinCents");
  const fundingGoalMaxCents = optionalCents(value.fundingGoalMaxCents, "offer", "fundingGoalMaxCents");
  const monthlyRevenueMinCents = optionalCents(value.monthlyRevenueMinCents, "offer", "monthlyRevenueMinCents");
  if (value.creditMin !== null && (typeof value.creditMin !== "number" || !Number.isInteger(value.creditMin))) {
    refuse("offer", "creditMin");
  }
  if (typeof value.businessRevenueRequired !== "boolean") refuse("offer", "businessRevenueRequired");
  if (value.bookingUrl !== null && typeof value.bookingUrl !== "string") refuse("offer", "bookingUrl");
  const qualificationSummary = nonEmptyString(value.qualificationSummary, "offer", "qualificationSummary");
  if (!Array.isArray(value.qualificationInputs) ||
    value.qualificationInputs.some((entry) => typeof entry !== "string" || !entry.trim())) {
    refuse("offer", "qualificationInputs");
  }
  const contentHash = createHash("sha256").update(serializeCanonicalJson(value as CanonicalJson)).digest("hex");
  return {
    offer: {
      id: "retrieval-eval-offer",
      tenantId: "retrieval-eval-tenant",
      status: "published",
      version: 1,
      contentHash,
      programName,
      programDescription: null,
      creditMin: value.creditMin as number | null,
      fundingGoalMinCents,
      fundingGoalMaxCents,
      monthlyRevenueMinCents,
      businessRevenueRequired: value.businessRevenueRequired,
      creditRepair: null,
      products: [],
      bookingHorizonDays: 30,
      bookingMode: "direct",
      brandVoice: "neutral",
      resultsTimelineMinDays: null,
      resultsTimelineMaxDays: null,
      refundPosture: null,
      voiceStyleAnswer: null,
      voiceObjectionAnswer: null,
      voiceFollowupAnswer: null,
      qualificationRules: [],
      voiceGuidelines: null,
      offerPrices: [],
      proof: [],
      assets: [],
    },
    renderSources: {
      bookingUrl: value.bookingUrl as string | null,
      qualificationSummary,
      qualificationInputs: value.qualificationInputs as string[],
      assetUrlsBySlug: {},
    },
  };
}

function entries(value: unknown): RetrievalCorpusEntry[] {
  if (!Array.isArray(value) || value.length === 0) refuse("entries", "shape");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const where = `entries[${index}]`;
    if (!isRecord(entry)) refuse(where, "shape");
    const question = nonEmptyString(entry.question, where, "question");
    const normalized = normalizeEntryQuestion(question);
    if (seen.has(normalized)) refuse(where, "duplicate_question");
    seen.add(normalized);
    if (typeof entry.category !== "string" || !CATEGORIES.has(entry.category)) refuse(where, "category");
    return {
      question,
      category: entry.category as RetrievalEntryCategory,
      responseTemplate: nonEmptyString(entry.responseTemplate, where, "responseTemplate"),
    };
  });
}

function expectation(value: unknown, key: string, questions: ReadonlySet<string>): RetrievalExpectation {
  if (!isRecord(value)) refuse(key, "expected");
  const hasEntry = value.entryQuestion !== undefined;
  const hasNoMatch = value.noMatch !== undefined;
  if (hasEntry === hasNoMatch) refuse(key, "expected_exactly_one_shape");
  if (hasNoMatch) {
    if (value.noMatch !== true) refuse(key, "expected.noMatch");
    return { kind: "no_match" };
  }
  const entryQuestion = nonEmptyString(value.entryQuestion, key, "expected.entryQuestion");
  if (!questions.has(normalizeEntryQuestion(entryQuestion))) refuse(key, "expected.entryQuestion_unknown");
  return { kind: "entry", entryQuestion };
}

function cases(value: unknown, questions: ReadonlySet<string>): RetrievalCorpusCase[] {
  if (!Array.isArray(value) || value.length === 0) refuse("cases", "shape");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const fallbackKey = `${RETRIEVAL_SUITE}:${index}`;
    if (!isRecord(entry) || typeof entry.key !== "string" || !entry.key.trim()) refuse(fallbackKey, "key");
    const key = entry.key;
    if (seen.has(key)) refuse(key, "duplicate_case_key");
    seen.add(key);
    const leadMessage = nonEmptyString(entry.leadMessage, key, "leadMessage");
    if (entry.channel !== undefined && (typeof entry.channel !== "string" || !CHANNELS.has(entry.channel))) {
      refuse(key, "channel");
    }
    if (entry.notes !== undefined && (!Array.isArray(entry.notes) ||
      entry.notes.some((note) => typeof note !== "string" || !note.trim()))) {
      refuse(key, "notes");
    }
    return {
      key,
      leadMessage,
      channel: entry.channel === undefined ? null : (entry.channel as RetrievalChannel),
      expected: expectation(entry.expected, key, questions),
      notes: (entry.notes as string[] | undefined) ?? [],
    };
  });
}

export function loadRetrievalCorpus(source: unknown = retrieval): LoadedRetrievalCorpus {
  if (!isRecord(source) || source.suite !== RETRIEVAL_SUITE) refuse("file", "suite");
  const parsedEntries = entries(source.entries);
  const questions = new Set(parsedEntries.map((entry) => normalizeEntryQuestion(entry.question)));
  const parsedCases = cases(source.cases, questions);
  if (!parsedCases.some((testCase) => testCase.expected.kind === "no_match")) refuse("cases", "no_match_case_required");
  if (!parsedCases.some((testCase) => testCase.expected.kind === "entry")) refuse("cases", "entry_case_required");
  return {
    suite: RETRIEVAL_SUITE,
    revision: createHash("sha256").update(serializeCanonicalJson(source as CanonicalJson)).digest("hex"),
    fixture: fixture(source.offer),
    entries: parsedEntries,
    cases: parsedCases,
  };
}
