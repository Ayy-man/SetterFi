/**
 * Deterministic review flags for provider-neutral Brain rows.
 *
 * Flags point to fields and offsets instead of copying source excerpts. Human review owns the
 * disposition and resolution; these detectors never infer that client-specific content is safe.
 */

import type { ImportDisposition, ImportFlagCode } from "@/lib/brain/contracts";
import {
  normalizePlaceholderToken,
  placeholderDefinition,
} from "@/lib/brain/placeholders";
import { extractNumbers } from "@/lib/engine/output-checks";

export const FAQ_CATEGORIES = [
  "Credit",
  "General Questions",
  "Funding Qs",
  "Application/Booking",
  "Program/Service",
  "Business",
] as const;

export const FIGURE_BINDING_FIELDS = [
  "credit_min",
  "funding_goal_min_cents",
  "funding_goal_max_cents",
  "monthly_revenue_min_cents",
  "results_timeline_min_days",
  "results_timeline_max_days",
  "offer_prices",
  "booking_horizon_days",
  "platform_constant",
] as const;

export type FigureBindingField = (typeof FIGURE_BINDING_FIELDS)[number];
export type ImportFlagField = "source" | "category" | "inboundMessage" | "responseTemplate";

export type ImportFlag = {
  id: string;
  code: ImportFlagCode;
  severity: "blocking";
  field: ImportFlagField;
  offset: number;
  resolved: boolean;
  resolution: { kind: string; value: string | null } | null;
};

export type ImportFigure = {
  kind: "currency" | "percentage" | "score";
  value: number;
  field: "responseTemplate";
  offset: number;
};

export type NumberBinding = ImportFigure & { binding: FigureBindingField };

export type FlaggableImportRow = {
  sourceRef: string;
  categories: readonly string[];
  category: string;
  inboundMessage: string;
  responseTemplate: string;
  sourceShapeValid: boolean;
  proseShape: boolean;
};

function flag(
  code: ImportFlagCode,
  field: ImportFlagField,
  offset: number,
): ImportFlag {
  return {
    id: `${code}:${field}:${offset}`,
    code,
    severity: "blocking",
    field,
    offset,
    resolved: false,
    resolution: null,
  };
}

function matches(value: string, patterns: readonly RegExp[]) {
  return patterns.flatMap((pattern) => {
    const local = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    return [...value.matchAll(local)].map((match) => match.index);
  });
}

const FIRST_PERSON_PATTERNS = [
  /\b(?:i\s+(?:am|live|have|started|run)|i['’]m|my\s+(?:company|business|team)|we\s+(?:are|have)|our\s+(?:company|business|team))\b/gi,
] as const;
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?:\+?\d[\d ().-]{7,}\d)/g,
  /https?:\/\/[^\s)\]}>,]+/gi,
] as const;

/**
 * A social handle is an `@` that does not continue an email local part: the lookbehind refuses a
 * word character or a dot before it, so `team@example.test` stays an email (PII) and `@coach`
 * becomes a handle. Handles are coach identity and never belong in the shared Brain.
 */
const SOCIAL_HANDLE_PATTERNS = [
  /(?<![\w.])@[a-z0-9_][a-z0-9_.]{1,29}\b/gi,
] as const;

/**
 * Indirect proof: outcomes attributed to a coach's own clients, a headcount the coach claims to
 * have served, or a dollar figure presented as money the coach has already funded. None of these
 * can be checked against the offer layer, so none may ship as shared copy.
 */
const PROOF_CLAIM_PATTERNS = [
  // "our clients got approved", "my students secured"
  /\b(?:our|my)\s+(?:clients?|students?|members?|customers?|coaching\s+clients?)\s+(?:got|get|received|secured|raised|earned|made|saw|achieved|obtained|were\s+(?:approved|funded))\b/gi,
  // "we've helped 400", "we have funded over $2,000,000", "I've coached"
  /\b(?:we|i)(?:['’]ve|\s+have)\s+(?:helped|funded|coached|served|worked\s+with)\b/gi,
  // "$500,000 funded", "$X funded", "$2M in funding secured"
  /\$\s?(?:X|\d[\d,.]*)\s*(?:k|m|mm|million|thousand|billion)?\+?\s+(?:funded|in\s+funding|secured|raised|approved)\b/gi,
  // "funded over $2,000,000", "raised $1M"
  /\b(?:funded|secured|raised)\s+(?:over|more\s+than|up\s+to|nearly|almost)?\s*\$\s?(?:X|\d)/gi,
  // "1,200 clients funded", "400 business owners helped"
  /\b\d[\d,]*\+?\s+(?:clients?|students?|members?|people|businesses|business\s+owners|entrepreneurs)\s+(?:funded|helped|approved|served|coached)\b/gi,
] as const;

/**
 * The client's own names. A batch may carry a different list (see `brandNames` on the import
 * batch); this is the list scanned when a batch was created before the column existed.
 */
export const DEFAULT_BRAND_NAMES = ["Legacy Strong", "Live Legacy Strong", "CCA"] as const;

export type ImportFlagOptions = {
  /** Brand and business names that mark a row as coach-specific wherever they appear. */
  brandNames?: readonly string[];
};

/** Flag codes that describe the copy itself. Ticking one as reviewed never makes the copy shared-safe. */
export const CONTENT_FLAG_CODES = [
  "first_person_pii",
  "multi_category",
  "social_handle",
  "brand_name",
  "proof_claim",
] as const satisfies readonly ImportFlagCode[];

export function isContentFlag(flag: Pick<ImportFlag, "code">) {
  return (CONTENT_FLAG_CODES as readonly string[]).includes(flag.code);
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function brandPatterns(brandNames: readonly string[]) {
  return brandNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => new RegExp(`\\b${name.split(/\s+/).map(escapePattern).join("\\s+")}\\b`, "gi"));
}

export function figuresInResponse(responseTemplate: string): ImportFigure[] {
  return extractNumbers(responseTemplate).map(({ kind, value, start }) => ({
    kind,
    value,
    field: "responseTemplate",
    offset: start,
  }));
}

export function flagImportRow(
  row: FlaggableImportRow,
  options: ImportFlagOptions = {},
): {
  flags: ImportFlag[];
  figures: ImportFigure[];
} {
  const flags: ImportFlag[] = [];
  if (!row.sourceShapeValid) flags.push(flag("source_shape", "source", 0));
  if (row.proseShape) flags.push(flag("prose_shape", "source", 0));
  if (row.categories.length === 0) flags.push(flag("source_shape", "category", 0));
  if (row.categories.length > 1) flags.push(flag("multi_category", "category", 0));

  for (const offset of matches(row.responseTemplate, [...FIRST_PERSON_PATTERNS, ...PII_PATTERNS])) {
    flags.push(flag("first_person_pii", "responseTemplate", offset));
  }
  for (const offset of matches(row.responseTemplate, SOCIAL_HANDLE_PATTERNS)) {
    flags.push(flag("social_handle", "responseTemplate", offset));
  }
  for (const offset of matches(row.responseTemplate, brandPatterns(options.brandNames ?? DEFAULT_BRAND_NAMES))) {
    flags.push(flag("brand_name", "responseTemplate", offset));
  }
  for (const offset of matches(row.responseTemplate, PROOF_CLAIM_PATTERNS)) {
    flags.push(flag("proof_claim", "responseTemplate", offset));
  }

  const figures = figuresInResponse(row.responseTemplate);
  for (const figure of figures) {
    flags.push(flag("unbound_figure", figure.field, figure.offset));
  }

  const placeholderPattern = /\{\{\s*([^{}]+?)\s*\}\}|\[\s*([^\[\]\n]+?)\s*\]/g;
  for (const match of row.responseTemplate.matchAll(placeholderPattern)) {
    const raw = match[1] ?? match[2] ?? "";
    const token = normalizePlaceholderToken(raw);
    if (!token || !placeholderDefinition(token)) {
      flags.push(flag("unknown_placeholder", "responseTemplate", match.index));
    }
  }

  for (const match of row.responseTemplate.matchAll(/\bX\b/g)) {
    flags.push(flag("bare_x", "responseTemplate", match.index));
  }

  const unique = flags.filter((candidate, index, all) =>
    all.findIndex((other) => other.id === candidate.id) === index,
  );
  return { flags: unique, figures };
}

export function acceptanceFlags({
  flags,
  disposition,
  numberBindings,
  resolvedFlagIds = [],
}: {
  flags: readonly ImportFlag[];
  disposition: ImportDisposition;
  numberBindings: readonly NumberBinding[];
  resolvedFlagIds?: readonly string[];
}) {
  const reviewed = new Set(resolvedFlagIds);
  return flags.map((candidate) => {
    const binding = candidate.code === "unbound_figure"
      ? numberBindings.find((item) => item.field === candidate.field && item.offset === candidate.offset)
      : null;
    const resolved = Boolean(binding) || reviewed.has(candidate.id);
    return resolved
      ? {
          ...candidate,
          resolved: true,
          resolution: binding
            ? { kind: "number_binding", value: binding.binding }
            : { kind: "admin_review", value: disposition },
        }
      : candidate;
  });
}

export function allBlockingFlagsResolved(flags: readonly ImportFlag[]) {
  return flags.every((candidate) => candidate.severity !== "blocking" || candidate.resolved);
}
