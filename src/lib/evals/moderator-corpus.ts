/**
 * Loader for the labelled moderator corpus under evals/corpus/moderator.json.
 *
 * Mirrors the safety corpus loader: JSON is the only case-data authority, this module only
 * validates and projects. A malformed entry, an unknown class or category, or a duplicate key
 * refuses the whole corpus before a run can look green. The safety loader in ./corpus is
 * untouched; the two corpora measure different things (the deterministic checker versus the
 * cross-vendor moderator) and are loaded separately on purpose.
 */

import { createHash } from "node:crypto";

import moderator from "../../../evals/corpus/moderator.json";

import { serializeCanonicalJson, type CanonicalJson } from "@/lib/brain/snapshot/canonicalize";
import { OUTPUT_CHECK_CLASSES, type OutputCheckClass } from "@/lib/engine/types";
import type { ModeratorPayload } from "@/lib/engine/moderator";

export const MODERATOR_CORPUS_SUITE = "moderator" as const;

export const MODERATOR_CASE_CATEGORIES = [
  "negated_lexicon",
  "invented_number",
  "lead_currency_echo",
  "lead_score_reflection",
  "instruction_disclosure",
  "role_adoption",
  "unapproved_link",
  "embedded_instruction",
  "qualification",
  "length",
] as const;
export type ModeratorCaseCategory = (typeof MODERATOR_CASE_CATEGORIES)[number];

export type ModeratorCorpusExpectation =
  | { verdict: "allow" }
  | { verdict: "block"; class: OutputCheckClass };

export type ModeratorCorpusCase = {
  key: string;
  category: ModeratorCaseCategory;
  note?: string;
  expectation: ModeratorCorpusExpectation;
  /** The exact payload the production pipeline hands the moderator driver. */
  payload: ModeratorPayload;
};

export type LoadedModeratorCorpus = {
  revision: string;
  cases: readonly ModeratorCorpusCase[];
};

const RAW_CORPUS = [moderator] as readonly unknown[];
const CATEGORIES = new Set<string>(MODERATOR_CASE_CATEGORIES);
const BLOCK_CLASSES = new Set<string>(OUTPUT_CHECK_CLASSES);
const NUMBER_KINDS = new Set(["currency", "percentage", "score"]);
const NUMBER_SOURCE_TYPES = new Set([
  "offer_price",
  "qualification_threshold",
  "brain_entry",
  "lead_message",
]);
const CONTEXT_FIELDS = ["numberAllowlist", "complianceLexicon", "linkWhitelist", "roleBoundary"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refuse(caseKey: string, reason: string): never {
  throw new Error(`MODERATOR_CORPUS_INVALID:${caseKey}:${reason}`);
}

function nonEmptyStrings(value: unknown, caseKey: string, field: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    refuse(caseKey, field);
  }
  return value as string[];
}

/**
 * The production format is `kind:value:sourceType:sourceId`, built in the engine pipeline from
 * `buildNumberSources`. A malformed entry would silently teach the moderator a different
 * allowlist grammar than production uses, so the format is enforced here rather than trusted.
 */
export function parseNumberAllowlistEntry(entry: string) {
  const parts = entry.split(":");
  if (parts.length < 4) return null;
  const [kind, rawValue, sourceType, ...sourceIdParts] = parts;
  const sourceId = sourceIdParts.join(":");
  const value = Number(rawValue);
  if (!NUMBER_KINDS.has(kind) || !NUMBER_SOURCE_TYPES.has(sourceType) || !Number.isFinite(value) ||
    rawValue.trim() === "" || !sourceId.trim()) {
    return null;
  }
  return { kind, value, sourceType, sourceId };
}

function numberAllowlist(value: unknown, caseKey: string) {
  return nonEmptyStrings(value, caseKey, "context.numberAllowlist").map((entry, index) => {
    const parsed = parseNumberAllowlistEntry(entry);
    if (!parsed) refuse(caseKey, `context.numberAllowlist[${index}]`);
    if (parsed.sourceType === "lead_message" && parsed.kind === "currency") {
      // The pipeline never allowlists a currency the lead typed; a corpus entry that does would
      // label a laundered price as grounded.
      refuse(caseKey, `context.numberAllowlist[${index}]:lead_currency`);
    }
    return entry;
  });
}

function context(
  own: unknown,
  shared: unknown,
  caseKey: string,
): Omit<ModeratorPayload, "draft" | "leadMessage"> {
  if (own !== undefined && !isRecord(own)) refuse(caseKey, "context");
  if (shared !== undefined && !isRecord(shared)) refuse(caseKey, "shared_context");
  const merged: Record<string, unknown> = { ...(shared ?? {}), ...(own ?? {}) };
  for (const field of CONTEXT_FIELDS) {
    if (!(field in merged)) refuse(caseKey, `context.${field}`);
  }
  if (typeof merged.roleBoundary !== "string" || !merged.roleBoundary.trim()) {
    refuse(caseKey, "context.roleBoundary");
  }
  return {
    numberAllowlist: numberAllowlist(merged.numberAllowlist, caseKey),
    complianceLexicon: nonEmptyStrings(merged.complianceLexicon, caseKey, "context.complianceLexicon"),
    linkWhitelist: nonEmptyStrings(merged.linkWhitelist, caseKey, "context.linkWhitelist"),
    roleBoundary: merged.roleBoundary,
  };
}

function expectation(value: unknown, caseKey: string): ModeratorCorpusExpectation {
  if (!isRecord(value)) refuse(caseKey, "expectation");
  if (value.verdict === "allow") {
    if ("class" in value) refuse(caseKey, "expectation.allow_has_class");
    return { verdict: "allow" };
  }
  if (value.verdict === "block") {
    if (typeof value.class !== "string" || !BLOCK_CLASSES.has(value.class)) {
      refuse(caseKey, "expectation.class");
    }
    return { verdict: "block", class: value.class as OutputCheckClass };
  }
  return refuse(caseKey, "expectation.verdict");
}

function parseFile(value: unknown): ModeratorCorpusCase[] {
  if (!isRecord(value) || value.suite !== MODERATOR_CORPUS_SUITE || !Array.isArray(value.cases)) {
    refuse("file", "shape");
  }
  if (value.cases.length === 0) refuse("file", "empty");
  return value.cases.map((entry, index) => {
    const fallbackKey = `${MODERATOR_CORPUS_SUITE}:${index}`;
    if (!isRecord(entry) || typeof entry.key !== "string" || !entry.key.trim()) {
      refuse(fallbackKey, "key");
    }
    const key = entry.key;
    if (typeof entry.category !== "string" || !CATEGORIES.has(entry.category)) {
      refuse(key, "category");
    }
    if (typeof entry.leadMessage !== "string" || !entry.leadMessage.trim()) refuse(key, "leadMessage");
    if (typeof entry.draft !== "string" || !entry.draft.trim()) refuse(key, "draft");
    if (entry.note !== undefined && (typeof entry.note !== "string" || !entry.note.trim())) {
      refuse(key, "note");
    }
    return {
      key,
      category: entry.category as ModeratorCaseCategory,
      ...(typeof entry.note === "string" ? { note: entry.note } : {}),
      expectation: expectation(entry.expectation, key),
      payload: {
        draft: entry.draft,
        leadMessage: entry.leadMessage,
        ...context(entry.context, value.context, key),
      },
    };
  });
}

export function loadModeratorCorpus(
  sources: readonly unknown[] = RAW_CORPUS,
): LoadedModeratorCorpus {
  const cases = sources.flatMap(parseFile);
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.key)) refuse(testCase.key, "duplicate_case_key");
    seen.add(testCase.key);
  }
  const revision = createHash("sha256")
    .update(serializeCanonicalJson(sources as unknown as CanonicalJson))
    .digest("hex");
  return { revision, cases };
}
