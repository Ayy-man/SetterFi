export type PlaceholderGrammaticalForm =
  | "noun_phrase"
  | "verb_phrase"
  | "adjective_phrase"
  | "question_list"
  | "url"
  | "currency_range";

export type PlaceholderDefinition = {
  token: string;
  aliases: readonly string[];
  sourcePath: string;
  required: boolean;
  grammaticalForm: PlaceholderGrammaticalForm;
  neutralFallback: string | null;
  formatter: (value: unknown) => string | null;
};

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const stringList = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("; ") || null
  : null;

export const PLACEHOLDER_REGISTRY = {
  niche: {
    token: "niche", aliases: [], sourcePath: "offer.programName", required: true,
    grammaticalForm: "noun_phrase", neutralFallback: null, formatter: text,
  },
  target_funding_amount: {
    token: "target_funding_amount", aliases: ["target funding"],
    sourcePath: "offer.fundingGoalMinCents..offer.fundingGoalMaxCents", required: true,
    grammaticalForm: "currency_range", neutralFallback: null, formatter: text,
  },
  booking_link: {
    token: "booking_link", aliases: [], sourcePath: "renderSources.bookingUrl", required: true,
    grammaticalForm: "url", neutralFallback: null, formatter: text,
  },
  requirements: {
    token: "requirements", aliases: [], sourcePath: "renderSources.qualificationSummary", required: false,
    grammaticalForm: "noun_phrase", neutralFallback: "the basic eligibility requirements", formatter: text,
  },
  qualifying_questions: {
    token: "qualifying_questions", aliases: [], sourcePath: "renderSources.qualificationInputs", required: false,
    grammaticalForm: "question_list", neutralFallback: "a few eligibility questions", formatter: stringList,
  },
  dream_outcome: {
    token: "dream_outcome", aliases: [], sourcePath: "derived:dreamOutcome", required: false,
    grammaticalForm: "verb_phrase", neutralFallback: "move toward your funding goals", formatter: text,
  },
  income_qualifiers: {
    token: "income_qualifiers", aliases: [], sourcePath: "derived:incomeQualifiers", required: false,
    grammaticalForm: "adjective_phrase", neutralFallback: "already generating revenue", formatter: text,
  },
} as const satisfies Record<string, PlaceholderDefinition>;

export type CanonicalPlaceholderToken = keyof typeof PLACEHOLDER_REGISTRY;

const TOKEN_SHAPE = /^[a-z][a-z0-9_]*$/;
const ASSET_TOKEN_SHAPE = /^asset\.([a-z0-9]+(?:-[a-z0-9]+)*)$/;

function normalizeWords(value: string) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const ALIASES = new Map<string, CanonicalPlaceholderToken>(
  Object.values(PLACEHOLDER_REGISTRY).flatMap((definition) => [
    [normalizeWords(definition.token), definition.token],
    ...definition.aliases.map((alias) => [normalizeWords(alias), definition.token]),
  ]) as Array<[string, CanonicalPlaceholderToken]>,
);

export function normalizePlaceholderToken(raw: string) {
  const unwrapped = raw.trim()
    .replace(/^\{\{\s*|\s*\}\}$/g, "")
    .replace(/^\[\s*|\s*\]$/g, "");
  const asset = unwrapped.trim().toLowerCase().match(ASSET_TOKEN_SHAPE);
  if (asset) return `asset.${asset[1]}`;
  const normalized = normalizeWords(unwrapped);
  return ALIASES.get(normalized) ?? (TOKEN_SHAPE.test(normalized) ? normalized : null);
}

export function placeholderDefinition(token: string): PlaceholderDefinition | null {
  const normalized = normalizePlaceholderToken(token);
  if (!normalized) return null;
  const core = PLACEHOLDER_REGISTRY[normalized as CanonicalPlaceholderToken];
  if (core) return core;
  const asset = normalized.match(ASSET_TOKEN_SHAPE);
  if (!asset) return null;
  return {
    token: normalized,
    aliases: [],
    sourcePath: `renderSources.assetUrlsBySlug.${asset[1]}`,
    required: true,
    grammaticalForm: "url",
    neutralFallback: null,
    formatter: text,
  };
}

export type PlaceholderResolution =
  | { status: "resolved"; value: string }
  | { status: "fallback"; value: string }
  | { status: "drop"; reason: string };

export function resolvePlaceholder(token: string, value: unknown): PlaceholderResolution {
  const definition = placeholderDefinition(token);
  if (!definition) return { status: "drop", reason: `unknown placeholder: ${token}` };
  const formatted = definition.formatter(value);
  if (formatted) return { status: "resolved", value: formatted };
  if (!definition.required && definition.neutralFallback) {
    return { status: "fallback", value: definition.neutralFallback };
  }
  return { status: "drop", reason: `required placeholder unresolved: ${definition.token}` };
}
