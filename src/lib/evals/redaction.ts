/**
 * Deterministic eval-promotion redaction.
 *
 * Promotion creates a platform-wide corpus asset, so detected personal and client-identifying copy
 * is replaced before review and the final boundary refuses any residual match. The manifest holds
 * only placeholder types and counts; source values never enter errors, audits, or metadata.
 */

export const EVAL_PROMOTION_SUITES = ["qualification_accuracy", "voice_tone"] as const;
export type EvalPromotionSuite = (typeof EVAL_PROMOTION_SUITES)[number];

export const REDACTION_TYPES = ["ADDRESS", "EMAIL", "NAME", "PHONE", "URL"] as const;
export type RedactionType = (typeof REDACTION_TYPES)[number];

export type RedactedEvalTurn = {
  role: "user" | "assistant";
  content: string;
};

export type RedactionManifest = {
  placeholders: readonly { type: RedactionType; count: number }[];
};

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,!?;:]/gi;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const ADDRESS = /\b\d{1,6}\s+(?:[A-Z0-9][A-Z0-9.'-]*\s+){1,5}(?:STREET|ST|ROAD|RD|AVENUE|AVE|BOULEVARD|BLVD|LANE|LN|DRIVE|DR|COURT|CT|WAY|HIGHWAY|HWY)\b(?:\s*,?\s*(?:APT|UNIT|SUITE|#)\s*[A-Z0-9-]+)?/gi;
const MARKED_NAME = /\b(I(?:'m| am)|My name is|This is|Ask for|Contact)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})\b/g;
const MULTIWORD_NAME_OR_CLIENT = /\b[A-Z][a-z][A-Za-z.'-]*(?:\s+[A-Z][a-z][A-Za-z.'-]*){1,3}\b/g;
const SENTINEL = /\uE000(ADDRESS|EMAIL|NAME|PHONE|URL):\d+\uE001/g;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function turns(value: unknown): RedactedEvalTurn[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    throw new Error("EVAL_REDACTION_TURNS_INVALID");
  }
  return value.map((candidate) => {
    if (!record(candidate) || Object.keys(candidate).sort().join(",") !== "content,role" ||
      (candidate.role !== "user" && candidate.role !== "assistant") ||
      typeof candidate.content !== "string" || !candidate.content.trim() ||
      candidate.content.length > 4_000) {
      throw new Error("EVAL_REDACTION_TURNS_INVALID");
    }
    return { role: candidate.role, content: candidate.content.trim() };
  });
}

function placeholder(type: RedactionType, sequence: number) {
  return `\uE000${type}:${sequence}\uE001`;
}

function redactContent(content: string, counts: Map<RedactionType, number>) {
  let sequence = 0;
  const replace = (type: RedactionType) => {
    counts.set(type, (counts.get(type) ?? 0) + 1);
    sequence += 1;
    return placeholder(type, sequence);
  };
  let redacted = content
    .replace(EMAIL, () => replace("EMAIL"))
    .replace(URL, () => replace("URL"))
    .replace(PHONE, () => replace("PHONE"))
    .replace(ADDRESS, () => replace("ADDRESS"));
  redacted = redacted.replace(MARKED_NAME, (_match, marker: string, name: string) =>
    `${marker} ${name ? replace("NAME") : ""}`,
  );
  redacted = redacted.replace(MULTIWORD_NAME_OR_CLIENT, () => replace("NAME"));
  return redacted.replace(SENTINEL, (_match, type: RedactionType) => `[${type}]`);
}

function manifest(counts: Map<RedactionType, number>): RedactionManifest {
  return {
    placeholders: REDACTION_TYPES.flatMap((type) => {
      const count = counts.get(type) ?? 0;
      return count === 0 ? [] : [{ type, count }];
    }),
  };
}

export function redactEvalTurns(value: unknown) {
  const counts = new Map<RedactionType, number>();
  const redactedTurns = turns(value).map((turn) => ({
    ...turn,
    content: redactContent(turn.content, counts),
  }));
  return { redactedTurns, redactionManifest: manifest(counts) };
}

function manifestCounts(value: unknown) {
  if (!record(value) || Object.keys(value).join(",") !== "placeholders" ||
    !Array.isArray(value.placeholders)) {
    throw new Error("EVAL_REDACTION_MANIFEST_INVALID");
  }
  const counts = new Map<RedactionType, number>();
  for (const entry of value.placeholders) {
    if (!record(entry) || Object.keys(entry).sort().join(",") !== "count,type" ||
      !REDACTION_TYPES.includes(entry.type as RedactionType) ||
      !Number.isSafeInteger(entry.count) || Number(entry.count) <= 0 ||
      counts.has(entry.type as RedactionType)) {
      throw new Error("EVAL_REDACTION_MANIFEST_INVALID");
    }
    counts.set(entry.type as RedactionType, Number(entry.count));
  }
  return counts;
}

function detectedTypes(content: string) {
  const detected = new Set<RedactionType>();
  if (EMAIL.test(content)) detected.add("EMAIL");
  if (URL.test(content)) detected.add("URL");
  if (PHONE.test(content)) detected.add("PHONE");
  if (ADDRESS.test(content)) detected.add("ADDRESS");
  if (MARKED_NAME.test(content) || MULTIWORD_NAME_OR_CLIENT.test(content)) detected.add("NAME");
  EMAIL.lastIndex = 0;
  URL.lastIndex = 0;
  PHONE.lastIndex = 0;
  ADDRESS.lastIndex = 0;
  MARKED_NAME.lastIndex = 0;
  MULTIWORD_NAME_OR_CLIENT.lastIndex = 0;
  return detected;
}

export function assertPromotionRedacted(
  value: unknown,
  manifestValue: unknown,
): asserts value is RedactedEvalTurn[] {
  const parsedTurns = turns(value);
  const expected = manifestCounts(manifestValue);
  const actual = new Map<RedactionType, number>();
  for (const turn of parsedTurns) {
    if (detectedTypes(turn.content).size > 0) throw new Error("EVAL_PROMOTION_RESIDUAL_PII");
    for (const match of turn.content.matchAll(/\[(ADDRESS|EMAIL|NAME|PHONE|URL)\]/g)) {
      const type = match[1] as RedactionType;
      actual.set(type, (actual.get(type) ?? 0) + 1);
    }
  }
  for (const type of REDACTION_TYPES) {
    if ((actual.get(type) ?? 0) !== (expected.get(type) ?? 0)) {
      throw new Error("EVAL_REDACTION_MANIFEST_MISMATCH");
    }
  }
}
