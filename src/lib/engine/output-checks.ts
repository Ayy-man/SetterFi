/**
 * The deterministic output floor applied to every generated draft before moderation.
 *
 * Rules are code-owned and tenant text cannot add or weaken a class. Content inputs are limited to
 * published platform rules, structured number sources, and the admin-owned host allowlist.
 */

import type {
  CheckResult,
  CheckViolation,
  CoachOffer,
  ComplianceRule,
  LeadResponse,
  NumberKind,
  NumberSource,
  OutputCheckClass,
  PublishedBrainEntry,
} from "@/lib/engine/types";

const CHECK_ORDER = ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN"] as const;
const RULE_IDS: Record<OutputCheckClass, string> = {
  NUM: "NUM-001",
  CLAIM: "CLAIM-001",
  ECHO: "ECHO-001",
  LINK: "LINK-001",
  SCOPE: "SCOPE-001",
  LEN: "LEN-001",
};

const CHANNEL_LIMITS = {
  sms: { soft: 160, hard: 320 },
  instagram: { soft: 320, hard: 800 },
  messenger: { soft: 320, hard: 800 },
  whatsapp: { soft: 320, hard: 800 },
  webchat: { soft: 400, hard: 1_200 },
} as const;

export type OutputCheckContext = {
  numberSources: readonly NumberSource[];
  complianceRules: readonly ComplianceRule[];
  linkWhitelist: readonly string[];
  systemText: string;
  echoExemptions: readonly string[];
  roleBoundary: string;
  channel: keyof typeof CHANNEL_LIMITS;
};

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function numberKey(kind: NumberKind, value: number) {
  return `${kind}:${value}`;
}

export function extractNumbers(value: string) {
  const facts: Array<{ kind: NumberKind; value: number; raw: string; start: number; end: number }> = [];
  const occupied: Array<[number, number]> = [];
  const text = value.replace(/https?:\/\/\S+/g, (url) => " ".repeat(url.length));
  const currency = /\$(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmM])?/g;
  const percentage = /\b(\d+(?:\.\d+)?)\s*%/g;
  const score = /\b([3-8]\d{2})(?:\+)?\b/g;

  for (const match of text.matchAll(currency)) {
    const multiplier = match[2]?.toLowerCase() === "k" ? 1_000 : match[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
    const start = match.index;
    const end = start + match[0].length;
    facts.push({
      kind: "currency",
      value: Number(match[1].replaceAll(",", "")) * multiplier,
      raw: match[0],
      start,
      end,
    });
    occupied.push([start, end]);
  }
  for (const match of text.matchAll(percentage)) {
    const start = match.index;
    const end = start + match[0].length;
    facts.push({ kind: "percentage", value: Number(match[1]), raw: match[0], start, end });
    occupied.push([start, end]);
  }
  for (const match of text.matchAll(score)) {
    const start = match.index;
    const end = start + match[0].length;
    if (occupied.some(([from, to]) => start >= from && start < to)) continue;
    facts.push({ kind: "score", value: Number(match[1]), raw: match[0], start, end });
  }
  return facts;
}

function sourcesFromText(value: string, sourceType: NumberSource["sourceType"], sourceId: string) {
  return extractNumbers(value).map(({ kind, value }) => ({ kind, value, sourceType, sourceId }));
}

export function buildNumberSources({
  offer,
  brainEntries,
  leadMessages,
}: {
  offer: CoachOffer;
  brainEntries: readonly PublishedBrainEntry[];
  leadMessages: readonly { id: string; body: string }[];
}): NumberSource[] {
  const sources: NumberSource[] = offer.offerPrices.map((price) => ({
    kind: "currency",
    value: price.amountCents / 100,
    sourceType: "offer_price",
    sourceId: price.id,
  }));
  if (offer.creditMin !== null) {
    sources.push({
      kind: "score",
      value: offer.creditMin,
      sourceType: "qualification_threshold",
      sourceId: "credit_min",
    });
  }
  if (offer.fundingGoalMinCents !== null) {
    sources.push({
      kind: "currency",
      value: offer.fundingGoalMinCents / 100,
      sourceType: "qualification_threshold",
      sourceId: "funding_goal_min_cents",
    });
  }
  for (const entry of brainEntries.filter((candidate) => candidate.published)) {
    sources.push(...sourcesFromText(entry.answer, "brain_entry", entry.id));
  }
  for (const message of leadMessages) {
    sources.push(...sourcesFromText(message.body, "lead_message", message.id));
  }
  return sources.filter((source, index, all) =>
    all.findIndex((candidate) =>
      candidate.sourceType === source.sourceType && candidate.sourceId === source.sourceId &&
      candidate.kind === source.kind && candidate.value === source.value,
    ) === index,
  );
}

function numberViolations(draft: string, context: OutputCheckContext) {
  const allowlist = new Set(context.numberSources.map((source) => numberKey(source.kind, source.value)));
  return extractNumbers(draft)
    .filter((fact) => !allowlist.has(numberKey(fact.kind, fact.value)))
    .map((fact) => `ungrounded ${fact.kind} at character ${fact.start}`);
}

function isNegated(text: string, phraseStart: number) {
  const prefix = text.slice(Math.max(0, phraseStart - 28), phraseStart);
  return /(?:can't|cannot|won't|will not|do not|don't|never|no)\s+(?:\w+\s+){0,2}$/.test(prefix);
}

function claimViolations(draft: string, rules: readonly ComplianceRule[]) {
  const text = normalizedText(draft);
  return rules.flatMap((rule) => {
    const phrase = normalizedText(rule.phrase);
    if (!phrase) return [];
    for (let position = text.indexOf(phrase); position >= 0;
      position = text.indexOf(phrase, position + phrase.length)) {
      if (!isNegated(text, position)) return [`${rule.id} matched`];
    }
    return [];
  });
}

function echoViolations(draft: string, context: OutputCheckContext) {
  const normalizedDraft = normalizedText(draft);
  const normalizedSystem = normalizedText(context.systemText);
  const exemptions = context.echoExemptions.map(normalizedText);
  const evidence: string[] = [];

  if (/tenant_offer(?::|&lt;|<)|\{\{[^}]+\}\}|\b[A-Z]{3,5}-\d{3}\b/i.test(draft)) {
    evidence.push("operator marker or unresolved scaffold appeared");
  }
  if (/\b(?:the brain|offer layer|decision table|grounding receipt|system prompt)\b/i.test(draft)) {
    evidence.push("operator vocabulary appeared");
  }
  for (let index = 0; index <= normalizedDraft.length - 40; index += 1) {
    const span = normalizedDraft.slice(index, index + 40);
    if (!normalizedSystem.includes(span)) continue;
    if (exemptions.some((exemption) => exemption.includes(span))) continue;
    evidence.push(`system span matched at character ${index}`);
    break;
  }
  return evidence;
}

function linkViolations(draft: string, whitelist: readonly string[]) {
  const allowed = whitelist.map((host) => host.toLowerCase().replace(/^www\./, ""));
  const links = draft.match(/(?:https?:\/\/|www\.)[^\s)\]}>,]+/gi) ?? [];
  return links.flatMap((raw, index) => {
    try {
      const url = new URL(raw.startsWith("www.") ? `https://${raw}` : raw);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const hostAllowed = allowed.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
      return url.protocol === "https:" && hostAllowed ? [] : [`unapproved link at index ${index}`];
    } catch {
      return [`malformed link at index ${index}`];
    }
  });
}

function scopeViolations(draft: string, roleBoundary: string) {
  const forbidden = /\b(?:here(?:'s| is) (?:a|your) (?:poem|essay)|legal advice|tax advice|medical advice|act as|roleplay as)\b/i;
  return forbidden.test(draft) ? [`reply crossed role boundary: ${roleBoundary}`] : [];
}

function lengthViolations(draft: string, channel: OutputCheckContext["channel"]) {
  const limits = CHANNEL_LIMITS[channel];
  return draft.length > limits.soft
    ? [`${channel} reply length ${draft.length} exceeds soft cap ${limits.soft}`]
    : [];
}

export function runOutputChecks(draft: string, context: OutputCheckContext) {
  const claimEvidence = claimViolations(draft, context.complianceRules);
  const evidenceByClass: Record<OutputCheckClass, string[]> = {
    NUM: numberViolations(draft, context),
    CLAIM: claimEvidence,
    ECHO: echoViolations(draft, context),
    LINK: linkViolations(draft, context.linkWhitelist),
    SCOPE: scopeViolations(draft, context.roleBoundary),
    LEN: lengthViolations(draft, context.channel),
  };
  const checks: CheckResult[] = CHECK_ORDER.map((checkClass) => ({
    class: checkClass,
    passed: evidenceByClass[checkClass].length === 0,
    ruleIds: checkClass === "CLAIM"
      ? claimEvidence.map((evidence) => evidence.split(" ", 1)[0])
      : evidenceByClass[checkClass].length ? [RULE_IDS[checkClass]] : [],
    evidence: evidenceByClass[checkClass],
  }));
  const violations: CheckViolation[] = checks.flatMap((check) =>
    check.evidence.map((evidence, index) => ({
      class: check.class,
      ruleId: check.ruleIds[index] ?? check.ruleIds[0] ?? RULE_IDS[check.class],
      evidence,
    })),
  );
  return { passed: violations.length === 0, checks, violations };
}

export function truncateAtSentenceBoundary(draft: string, channel: OutputCheckContext["channel"]) {
  const limit = CHANNEL_LIMITS[channel].soft;
  if (draft.length <= limit) return draft;
  const prefix = draft.slice(0, limit + 1);
  const matches = [...prefix.matchAll(/[.!?](?=\s|$)/g)];
  const boundary = matches.at(-1)?.index;
  return boundary === undefined ? null : draft.slice(0, boundary + 1);
}

export function decideCheckAttempt({
  draft,
  attempt,
  result,
  channel,
}: {
  draft: string;
  attempt: 1 | 2;
  result: ReturnType<typeof runOutputChecks>;
  channel: OutputCheckContext["channel"];
}):
  | { action: "pass"; draft: string }
  | { action: "regenerate"; ruleIds: string[]; classes: OutputCheckClass[] }
  | { action: "hold" }
  | { action: "pass_truncated"; draft: string } {
  if (result.passed) return { action: "pass", draft };
  if (attempt === 1) {
    return {
      action: "regenerate",
      ruleIds: [...new Set(result.violations.map((violation) => violation.ruleId))],
      classes: [...new Set(result.violations.map((violation) => violation.class))],
    };
  }
  if (result.violations.every((violation) => violation.class === "LEN")) {
    const truncated = truncateAtSentenceBoundary(draft, channel);
    if (truncated) return { action: "pass_truncated", draft: truncated };
  }
  return { action: "hold" };
}

export function leadResponse(input: {
  reply: string;
  state: LeadResponse["state"];
  booking: LeadResponse["booking"];
}): LeadResponse {
  return { reply: input.reply, state: input.state, booking: input.booking };
}
