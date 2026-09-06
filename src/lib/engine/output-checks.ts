/**
 * The deterministic output floor applied to every generated draft before moderation.
 *
 * Rules are code-owned and tenant text cannot add or weaken a class. Content inputs are limited to
 * published platform rules, structured number sources, and the admin-owned host allowlist.
 */

import { authoritativeBindings } from "@/lib/brain/provenance";
import type {
  BrainEntryProvenance,
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
/** A hard-cap breach carries its own rule id so a trace names which LEN cap the draft broke. */
const LEN_HARD_RULE_ID = "LEN-002";

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

/**
 * NFKC leaves typographic quotes alone, and a model that writes "can’t" with U+2019 must read
 * the same as one that writes "can't": the negation and declining exemptions key on that word.
 */
function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ").trim().toLowerCase();
}

function numberKey(kind: NumberKind, value: number) {
  return `${kind}:${value}`;
}

/**
 * A three-digit figure in the credit-score range only reads as a score when the text says so:
 * "score", "credit" or "FICO" within a few words on either side, or "score of N". Without that
 * context the figure is a bare integer, and a bare integer never grounds itself against the
 * tenant's score threshold just because the two happen to share a value.
 */
const SCORE_CONTEXT = /\b(?:scores?|credit|fico)\b/i;
const SCORE_CONTEXT_WINDOW = 40;

function hasScoreContext(text: string, start: number, end: number) {
  const before = text.slice(Math.max(0, start - SCORE_CONTEXT_WINDOW), start);
  const after = text.slice(end, end + SCORE_CONTEXT_WINDOW);
  return /\bscore of\s*$/i.test(before) || SCORE_CONTEXT.test(before) || SCORE_CONTEXT.test(after);
}

type NumericFact = { kind: NumberKind; value: number; raw: string; start: number; end: number };

function scanNumbers(value: string) {
  const facts: NumericFact[] = [];
  const bare: Array<Omit<NumericFact, "kind">> = [];
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
    const fact = { value: Number(match[1]), raw: match[0], start, end };
    if (hasScoreContext(text, start, end)) facts.push({ kind: "score", ...fact });
    else bare.push(fact);
  }
  return { facts, bare };
}

export function extractNumbers(value: string) {
  return scanNumbers(value).facts;
}

/** Score-range integers with no score context: not a fact of any kind, but not free either. */
export function extractBareIntegers(value: string) {
  return scanNumbers(value).bare;
}

function sourcesFromText(value: string, sourceType: NumberSource["sourceType"], sourceId: string) {
  return extractNumbers(value).map(({ kind, value }) => ({ kind, value, sourceType, sourceId }));
}

/**
 * The numbers a reviewed entry may ground. A figure written into the template grounds only when a
 * binding covers it — a reviewer said which offer field or platform constant it stands for — and
 * only while the template is still the text that review saw. A figure the template did not contain
 * was rendered into the answer from this tenant's offer by a placeholder, and the offer is its
 * source. Anything else in the answer stays off the allowlist, so a model that repeats it fails NUM.
 */
function reviewedEntrySources(entry: PublishedBrainEntry & { provenance: BrainEntryProvenance }) {
  const bindings = authoritativeBindings(entry.provenance);
  const templateFigures = extractNumbers(entry.provenance.responseTemplate);
  return extractNumbers(entry.answer)
    .filter((fact) => {
      const inTemplate = templateFigures.some((figure) =>
        figure.kind === fact.kind && figure.value === fact.value);
      if (!inTemplate) return true;
      return bindings.some((binding) => binding.kind === fact.kind && binding.value === fact.value);
    })
    .map(({ kind, value }) => ({ kind, value, sourceType: "brain_entry" as const, sourceId: entry.id }));
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
    if (entry.provenance) {
      sources.push(...reviewedEntrySources({ ...entry, provenance: entry.provenance }));
    } else {
      sources.push(...sourcesFromText(entry.answer, "brain_entry", entry.id));
    }
  }
  // A lead may be reflected their own score or percentage, but a currency amount they typed is
  // never grounding for the reply: repeating it would let a lead launder a price into an offer fact.
  for (const message of leadMessages) {
    sources.push(
      ...sourcesFromText(message.body, "lead_message", message.id)
        .filter((source) => source.kind !== "currency"),
    );
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
  const allowedValues = new Set(context.numberSources.map((source) => source.value));
  // A bare integer is unattributed: it passes only when some grounded source carries that exact
  // value, whatever that source's kind, because the draft gave no kind to match against.
  return [
    ...extractNumbers(draft)
      .filter((fact) => !allowlist.has(numberKey(fact.kind, fact.value)))
      .map((fact) => `ungrounded ${fact.kind} at character ${fact.start}`),
    ...extractBareIntegers(draft)
      .filter((fact) => !allowedValues.has(fact.value))
      .map((fact) => `unattributed number at character ${fact.start}`),
  ];
}

function isDeclining(text: string, phraseStart: number) {
  const prefix = text.slice(Math.max(0, phraseStart - 48), phraseStart);
  return /(?:can't|cannot|can not|won't|will not|unable to|not able to|don't|do not|never|no|without|rather than|instead of)\s+(?:\w+\s+){0,4}$/.test(prefix);
}

function isNegated(text: string, phraseStart: number) {
  const prefix = text.slice(Math.max(0, phraseStart - 28), phraseStart);
  // "isn't guaranteed", "is not guaranteed", "not guaranteed" and "No\u2014approval isn't guaranteed"
  // are all declines; the separator admits a dash, comma or colon so punctuation after "no"
  // cannot turn a refusal into a promise.
  return /(?:can't|cannot|won't|will not|do not|don't|never|isn't|is not|aren't|are not|not|no)[\s\u2014\u2013,:-]+(?:\w+\s+){0,2}$/.test(prefix);
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
  // A paraphrase of the instructions leaks as surely as a quote. "I can't share my instructions"
  // is the refusal the invariants ask for, so a negated or declining prefix is exempt.
  const disclosure = /\b(?:i(?:'m| am) (?:designed|configured|instructed|programmed|built|trained|set up) to|my (?:instructions|guidelines|configuration|system prompt|operating (?:principles|instructions|rules)|hidden (?:instructions|rules))|(?:hidden|confidential|internal|secret) (?:operating |system |developer )?(?:instructions|rules|prompt)|(?:platform|operator|developer) (?:rules|instructions)|operating principles)\b/g;
  for (const match of normalizedDraft.matchAll(disclosure)) {
    if (isDeclining(normalizedDraft, match.index)) continue;
    evidence.push(`instruction disclosure at character ${match.index}`);
    break;
  }
  // A verbatim window of the system message is instruction text leaking unless it is something
  // the setter was given to say: a published entry (question or answer, both rendered in inline
  // mode and supplied as exemptions) or a scripted question. A scripted question is recognised
  // only when the window sits inside a question in both texts, so a guardrail line or a coach
  // configuration line quoted with a question mark after it still fails.
  const draftQuestions = questionRanges(normalizedDraft);
  const systemQuestions = questionRanges(normalizedSystem);
  for (let index = 0; index <= normalizedDraft.length - ECHO_SPAN_LENGTH; index += 1) {
    const span = normalizedDraft.slice(index, index + ECHO_SPAN_LENGTH);
    if (!normalizedSystem.includes(span)) continue;
    if (exemptions.some((exemption) => exemption.includes(span))) continue;
    if (isScriptedQuestionSpan(span, index, normalizedSystem, draftQuestions, systemQuestions)) continue;
    evidence.push(`system span matched at character ${index}`);
    break;
  }
  return evidence;
}

const ECHO_SPAN_LENGTH = 40;

/**
 * [start, end) of every sentence ending in "?" in a normalized text. Sentences split on . ! ? a
 * newline and a colon: a colon is how a script introduces the words to say ("Ask it in these
 * words: …?"), and the instruction before it must stay outside the question it introduces.
 */
function questionRanges(text: string) {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(/[^.!?:\n]*\?/g)) {
    const start = match.index + (match[0].length - match[0].trimStart().length);
    ranges.push([start, match.index + match[0].length]);
  }
  return ranges;
}

function insideRange(ranges: readonly [number, number][], start: number, end: number) {
  return ranges.some(([from, to]) => start >= from && end <= to);
}

function isScriptedQuestionSpan(
  span: string,
  draftIndex: number,
  normalizedSystem: string,
  draftQuestions: readonly [number, number][],
  systemQuestions: readonly [number, number][],
) {
  // A window may open on the space before the question; only its non-blank body must lie inside.
  const lead = span.length - span.trimStart().length;
  const trail = span.length - span.trimEnd().length;
  if (lead + trail >= span.length) return false;
  if (!insideRange(draftQuestions, draftIndex + lead, draftIndex + span.length - trail)) return false;
  for (let at = normalizedSystem.indexOf(span); at >= 0; at = normalizedSystem.indexOf(span, at + 1)) {
    if (insideRange(systemQuestions, at + lead, at + span.length - trail)) return true;
  }
  return false;
}

/**
 * One pass, scheme-bearing links first so a host inside `https://…` is consumed once. The bare
 * form wants labels, a dot, and a TLD of two or more letters, so "e.g.", "1.5", "10.30pm" and
 * "U.S." never qualify, and the lookbehind keeps an email's domain and a URL's tail out of it.
 */
const LINK_PATTERN =
  /(?:https?:\/\/|www\.)[^\s)\]}>,]+|(?<![\w@.\/-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?![a-z@])(?:\/[^\s)\]}>,]*)?/gi;

function linkViolations(draft: string, whitelist: readonly string[]) {
  const allowed = whitelist.map((host) => host.toLowerCase().replace(/^www\./, ""));
  const links = draft.match(LINK_PATTERN) ?? [];
  return links.flatMap((raw, index) => {
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const hostAllowed = allowed.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
      return url.protocol === "https:" && hostAllowed ? [] : [`unapproved link at index ${index}`];
    } catch {
      return [`malformed link at index ${index}`];
    }
  });
}

const SCOPE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["offered off-role content", /\b(?:here(?:'s| is) (?:a|your|the) (?:poem|essay|haiku|sonnet|story|song|joke)|legal advice|tax advice|medical advice|act as|roleplay as)\b/i],
  ["titled off-role content", /^\s*(?:#{1,6}\s+|\*\*)?[^\n]{0,40}\b(?:poem|haiku|sonnet|limerick|essay|short story|lyrics)\b[^\n]{0,40}(?:\*\*)?\s*$/im],
  ["adopted another role", /\b(?:i(?:'m| am) now (?:a|an|your|the)\b|from now on,? i(?:'ll| will|'m| am)?\b|as (?:a|your) (?:pirate|general assistant|ai assistant|new persona|different assistant)|developer mode|dan mode|jailbroken)\b/i],
  ["offered general assistance", /\b(?:ask me anything|help (?:you )?with anything|any (?:topic|question|task)s? you(?:'d| would)? like)\b/i],
  ["offered fabricated identifiers", /\b(?:(?:synthetic|fake|dummy|made[- ]up|fictional|placeholder) (?:profile numbers?|ssn|social security numbers?|account numbers?|identit(?:y|ies)|id numbers?|credit card numbers?)|generate (?:a|an|some) (?:fake|synthetic|dummy)\b)/i],
  ["returned code", /```/],
];

/**
 * Four or more consecutive short lines, most without terminal punctuation, is verse or a list of
 * lyrics, never a setter's reply. Bullet and number markers are stripped before the test rather
 * than exempting the line, so a poem set as a list is still a poem, while a rare itemised answer
 * of full punctuated sentences is judged by LEN, not SCOPE.
 */
function looksLikeVerse(draft: string) {
  const lines = draft.split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ""));
  let run = 0;
  let unpunctuated = 0;
  for (const line of lines) {
    const short = line.length > 0 && line.length <= 60;
    if (!short) { run = 0; unpunctuated = 0; continue; }
    run += 1;
    if (!/[.!?:]["')\]]?$/.test(line)) unpunctuated += 1;
    if (run >= 4 && unpunctuated >= 3) return true;
  }
  return false;
}

function scopeViolations(draft: string, roleBoundary: string) {
  const evidence = SCOPE_PATTERNS.filter(([, pattern]) => pattern.test(draft)).map(([label]) => label);
  if (looksLikeVerse(draft)) evidence.push("verse-shaped reply");
  return evidence.map((label) => `reply crossed role boundary (${label}): ${roleBoundary}`);
}

export function channelLengthLimits(channel: OutputCheckContext["channel"]) {
  return CHANNEL_LIMITS[channel];
}

/**
 * Two caps per channel. Over the soft cap the draft is a long reply: regenerate once, then drop
 * trailing sentences. Over the hard cap it is an essay, and the first sentence of an essay is not
 * a reply to the lead, so truncation is never offered and the turn is held. The hard cap itself
 * is still a soft breach; only a draft strictly beyond it is a hard breach.
 */
export function lengthBreach(draft: string, channel: OutputCheckContext["channel"]) {
  const limits = CHANNEL_LIMITS[channel];
  if (draft.length > limits.hard) return "hard" as const;
  if (draft.length > limits.soft) return "soft" as const;
  return "none" as const;
}

function lengthViolations(draft: string, channel: OutputCheckContext["channel"]) {
  const limits = CHANNEL_LIMITS[channel];
  switch (lengthBreach(draft, channel)) {
    case "hard":
      return [`${channel} reply length ${draft.length} exceeds hard cap ${limits.hard}`];
    case "soft":
      return [`${channel} reply length ${draft.length} exceeds soft cap ${limits.soft}`];
    default:
      return [];
  }
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
  const lengthRuleId = lengthBreach(draft, context.channel) === "hard" ? LEN_HARD_RULE_ID : RULE_IDS.LEN;
  const checks: CheckResult[] = CHECK_ORDER.map((checkClass) => ({
    class: checkClass,
    passed: evidenceByClass[checkClass].length === 0,
    ruleIds: checkClass === "CLAIM"
      ? claimEvidence.map((evidence) => evidence.split(" ", 1)[0])
      : evidenceByClass[checkClass].length
        ? [checkClass === "LEN" ? lengthRuleId : RULE_IDS[checkClass]]
        : [],
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

/**
 * Drops trailing sentences until the draft fits the soft cap. Null when no sentence ends inside
 * the cap, and null for a hard-cap breach: an essay's opening sentence is not the reply the lead
 * was owed, so the caller has nothing to send and holds.
 */
export function truncateAtSentenceBoundary(draft: string, channel: OutputCheckContext["channel"]) {
  const limit = CHANNEL_LIMITS[channel].soft;
  if (draft.length <= limit) return draft;
  if (lengthBreach(draft, channel) === "hard") return null;
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
  // A soft LEN breach on its own has a deterministic remedy, so it is applied on the first
  // attempt without a model call. `truncateAtSentenceBoundary` answers null for a hard breach,
  // so an essay regenerates once and then falls through to the held path with class LEN, and a
  // soft breach with no sentence boundary inside the cap takes the same ladder.
  if (result.violations.every((violation) => violation.class === "LEN")) {
    const truncated = truncateAtSentenceBoundary(draft, channel);
    if (truncated) return { action: "pass_truncated", draft: truncated };
  }
  if (attempt === 1) {
    return {
      action: "regenerate",
      ruleIds: [...new Set(result.violations.map((violation) => violation.ruleId))],
      classes: [...new Set(result.violations.map((violation) => violation.class))],
    };
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
