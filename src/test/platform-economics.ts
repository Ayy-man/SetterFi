/**
 * The one definition of "platform economics" that no coach or affiliate surface may show.
 *
 * CLAUDE.md: "No client-visible margin/cost economics. Cost-vs-revenue is admin-only."
 * docs/PRODUCT.md says the same for the Success/CSM role ("no cost or margin figures anywhere")
 * and that margin "lives only here -- never on a coach surface."
 *
 * WHERE THE LINE IS. The rule forbids showing a client OUR economics: what it costs the platform
 * to serve them, and what the platform keeps. It does not forbid a client seeing THEIR OWN bill.
 * So all of this stays legal on a coach surface and is deliberately not matched below:
 *
 *   - "Your plan is $300 per month", "Growth costs $300/mo"  -- the coach's own price
 *   - invoices, invoice state, payment method, billing period, receipts
 *   - "Booked-call allowance: 18 of 25", allowance warnings and crossings
 *   - "$12 per booked call" as an overage price the coach is charged
 *
 * And all of this is ours, so it is matched wherever it appears on a client surface:
 *
 *   - margin in any framing (blended, gross, net, contribution), COGS, unit economics
 *   - cost-per-anything: cost per message, cost per booking, unit cost, cost to serve
 *   - what a provider charges US: model cost, token cost, carrier cost, delivery cost
 *   - cost-vs-revenue in either order, gross profit, profitability
 *   - a bare currency figure priced per message or per token -- a coach is never billed per
 *     message, so a per-message money figure can only be the platform's send economics
 *   - the field names those figures arrive in (marginCents, blendedMarginPct, costPerBooking)
 *
 * The bare word "cost" is intentionally NOT a match. It appears legitimately in coach-facing
 * billing copy about what the coach pays, and banning it would push writers into worse words.
 * Every pattern below requires a qualifier that makes the figure ours rather than theirs.
 */

const PLATFORM_ECONOMICS_PATTERNS: ReadonlyArray<RegExp> = [
  // Margin in any framing. `-` on either side is excluded so a CSS `margin-top` in a style
  // string or a class name never reads as a margin figure.
  /(?<![\w\-[])(?:blended|gross|net|contribution|profit)?[ \t]*margins?(?![\w-])/gi,
  // Identifiers too: a `blendedMarginPct` prop or a `<MarginTile>` on a client surface is the
  // figure arriving, even before anyone writes a label for it. The CSS box-model properties are
  // the one family of `margin` identifiers that mean something else.
  /(?<![\w\-[])\w*[Mm]argin(?!Top|Bottom|Left|Right|Inline|Block|Start|End|Horizontal|Vertical|X\b|Y\b|-(?:top|bottom|left|right|inline|block|start|end|x|y)\b)\w*/g,

  // Cost of goods, in the abbreviation and in full.
  /(?<![\w-])COGS(?![\w])/g,
  /(?<![\w-])cost of (?:goods|revenue|service|delivery)(?![\w])/gi,

  // Cost per unit, in prose and as a field name.
  /(?<![\w-])(?:unit|blended|marginal|effective|average)[ \t]+costs?(?![\w])/gi,
  /(?<![\w-])unit economics(?![\w])/gi,
  /(?<![\w-])costs?[ \t]*(?:per|\/)[ \t]*(?:message|send|sms|dm|token|lead|contact|conversation|thread|reply|booking|booked[ \t]call|call|appointment|qualified[ \t]lead|coach|client|tenant)(?![\w])/gi,
  /(?<![\w-])per[ \t-](?:message|send|sms|token|lead|conversation|booking|booked[ \t-]call|call|appointment)[ \t]+costs?(?![\w])/gi,
  /(?<![\w-])costPer[A-Z]\w*/g,
  /(?<![\w-])cost[ \t]+(?:basis|to[ \t]serve)(?![\w])/gi,
  /(?<![\w-])spend[ \t]*(?:per|\/)[ \t]*(?:message|send|lead|conversation|booking|call|coach|client|tenant)(?![\w])/gi,

  // What a provider charges the platform. None of these are ever the coach's own line item.
  /(?<![\w-])(?:platform|model|provider|infra(?:structure)?|token|llm|inference|delivery|send|serving|carrier|twilio|openrouter|vendor|supplier)[ \t]+costs?(?![\w])/gi,
  /(?<![\w-])costs?[ \t]+(?:to[ \t]the[ \t]platform|we[ \t]pay|SetterFi[ \t]pays)(?![\w])/gi,

  // Cost against revenue, in either order, and the profit words that summarise it.
  /(?<![\w-])costs?[ \t]*(?:vs\.?|versus|against|-vs-)[ \t]*revenue(?![\w])/gi,
  /(?<![\w-])revenue[ \t]*(?:vs\.?|versus|against|-vs-)[ \t]*costs?(?![\w])/gi,
  /(?<![\w-])(?:gross|net|operating)[ \t]+profits?(?![\w])/gi,
  /(?<![\w-])profitabilit(?:y|ies)(?![\w])/gi,

  // A money figure priced per message or per token. "$300 per month" and "$12 per booked call"
  // are the coach's own bill and are deliberately absent from this unit list.
  /[$€£]\s?\d[\d,.]*\s*(?:per|\/)\s*(?:message|send|sms|dm|token|reply|thread)(?![\w])/gi,
];

export type PlatformEconomicsHit = {
  /** The matched phrase, as it appeared. */
  readonly phrase: string;
  /** Surrounding text, so a failure names the tile it came from. */
  readonly context: string;
};

/** Every platform-economics phrase in `text`, deduped by phrase and context. */
export function findPlatformEconomics(text: string): PlatformEconomicsHit[] {
  const hits = new Map<string, PlatformEconomicsHit>();

  for (const pattern of PLATFORM_ECONOMICS_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const phrase = match[0].trim();
      if (!phrase) continue;
      const start = match.index ?? 0;
      const context = text
        .slice(Math.max(0, start - 60), start + phrase.length + 60)
        .replace(/\s+/g, " ")
        .trim();
      hits.set(`${phrase.toLowerCase()}::${context}`, { phrase, context });
    }
  }

  return [...hits.values()];
}

/** One line per hit, for an assertion message that says what to delete and where. */
export function formatPlatformEconomicsHits(
  hits: ReadonlyArray<PlatformEconomicsHit>,
): string[] {
  return hits.map((hit) => `"${hit.phrase}" in: ...${hit.context}...`);
}
