import {
  FUNDING_GOALS,
  FUNDING_TIMELINES,
  resolveDemoQualification,
  type BrainOutcomeOverrides,
  type FundingGoal,
  type FundingTimeline,
} from "@/lib/domain/qualification";

export type AgentStage =
  | "greeting"
  | "qualify"
  | "objection"
  | "book"
  | "guardrail"
  | "closing";

export type AgentDecision = "BOOK" | "SOFT_DQ" | "HARD_DQ" | "NONE";

export type GuardrailEvent = {
  type: "deflect" | "block";
  rule: "stay-in-role" | "no-guaranteed-outcomes" | "no-cpn-compliance";
};

export type Booking = {
  slot: string;
  calendar: string;
};

export type AgentTurn = {
  reply: string;
  thinking: string;
  stage: AgentStage;
  decision: AgentDecision;
  decisionRow: string;
  brainPassage: string;
  grounded: boolean;
  guardrail: GuardrailEvent | null;
  booked: Booking | null;
  model: string;
  tenant: string;
  tokenEstimate: number;
  source: "rules-preview";
};

/**
 * The coach's saved offer layer, carried into the test agent so Meet Your Agent
 * proves the settings actually steer behavior. Everything is optional on the wire;
 * defaults reproduce the shared-brain behavior with no coach overrides.
 */
export type CoachOfferOverrides = {
  programName: string | null;
  /** Published credit floor; null when the coach has no floor set. */
  creditMinimum: number | null;
  revenueRequired: boolean;
  /** The pricing gate: true = the agent may state only the pricing saved in the offer. */
  quotePricing: boolean;
  askFundingAmount: boolean;
  askTimeline: boolean;
};

/** The offer layer belongs to one coach, so it is tenant-scoped. See tenant-storage.ts. */
export const COACH_OFFER_SCOPE = "tenant" as const;

const DEFAULT_OFFER: CoachOfferOverrides = {
  programName: null,
  creditMinimum: null,
  revenueRequired: true,
  quotePricing: false,
  askFundingAmount: true,
  askTimeline: true,
};

export function normalizeCoachOfferOverrides(value: unknown): CoachOfferOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_OFFER;
  const raw = value as Partial<Record<keyof CoachOfferOverrides, unknown>>;
  const floor = typeof raw.creditMinimum === "number" && Number.isFinite(raw.creditMinimum)
    ? Math.min(850, Math.max(300, Math.round(raw.creditMinimum)))
    : null;
  return {
    programName: typeof raw.programName === "string" && raw.programName.trim()
      ? raw.programName.trim().slice(0, 80)
      : null,
    creditMinimum: floor,
    revenueRequired: typeof raw.revenueRequired === "boolean" ? raw.revenueRequired : true,
    quotePricing: typeof raw.quotePricing === "boolean" ? raw.quotePricing : false,
    askFundingAmount: typeof raw.askFundingAmount === "boolean" ? raw.askFundingAmount : true,
    askTimeline: typeof raw.askTimeline === "boolean" ? raw.askTimeline : true,
  };
}

type EvaluateOptions = {
  outcomes?: BrainOutcomeOverrides;
  offer?: CoachOfferOverrides;
  history?: readonly string[];
  version: "published" | "draft";
};


function fundingGoalFromText(text: string): FundingGoal | null {
  const amountPattern = "(\\d{1,3}(?:,\\d{3})+|\\d{4,6}|\\d{1,3}\\s*k)";
  const forward = new RegExp(`\\b(?:need|seeking|looking for|aiming for|funding goal(?: is)?|raise|borrow)\\b.{0,24}?\\$?\\s*${amountPattern}\\b`, "i");
  const reverse = new RegExp(`\\$?\\s*${amountPattern}\\b.{0,18}\\b(?:in funding|funding goal|to fund)\\b`, "i");
  const match = text.match(forward) ?? text.match(reverse);
  if (!match?.[1]) return null;
  const raw = match[1].replaceAll(",", "").replaceAll(" ", "").toLowerCase();
  const amount = raw.endsWith("k") ? Number(raw.slice(0, -1)) * 1_000 : Number(raw);
  if (!Number.isFinite(amount)) return null;
  if (amount < 50_000) return FUNDING_GOALS[0];
  if (amount < 100_000) return FUNDING_GOALS[1];
  if (amount < 150_000) return FUNDING_GOALS[2];
  return FUNDING_GOALS[3];
}

function fundingTimelineFromText(text: string): FundingTimeline | null {
  if (/\b(asap|right away|immediately|this month|within (?:30|thirty) days?)\b/.test(text)) return FUNDING_TIMELINES[0];
  if (/\b(?:in |within )?(?:1|one|2|two|3|three)(?:\s*(?:-|to)\s*(?:3|three))?\s*months?\b|\bnext quarter\b/.test(text)) return FUNDING_TIMELINES[1];
  if (/\b(?:in |within )?(?:4|four|5|five|6|six)(?:\s*(?:-|to)\s*(?:6|six))?\s*months?\b/.test(text)) return FUNDING_TIMELINES[2];
  if (/\b(exploring|just looking|no rush|someday|researching)\b/.test(text)) return FUNDING_TIMELINES[3];
  return null;
}

const NONE = {
  decision: "NONE" as const,
  decisionRow: "",
  booked: null,
};

function nextThursdaySlot(now = new Date()): string {
  const result = new Date(now);
  const daysUntilThursday = (4 - result.getDay() + 7) % 7 || 7;
  result.setDate(result.getDate() + daysUntilThursday);

  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(result);

  return `${date}, 2:30 PM`;
}

function response(
  message: string,
  turn: Omit<AgentTurn, "model" | "tenant" | "tokenEstimate" | "source">,
  version: EvaluateOptions["version"],
): AgentTurn {
  return {
    ...turn,
    model: version === "draft" ? "SetterFi rules preview · draft" : "SetterFi rules preview · published",
    tenant: "summit-credit · request scoped",
    tokenEstimate: Math.max(24, Math.round((message.length + turn.reply.length) / 4)),
    source: "rules-preview",
  };
}

export function evaluateAgentMessage(message: string, options: EvaluateOptions): AgentTurn {
  const offer = options.offer ?? DEFAULT_OFFER;
  const text = message.trim();
  const lower = text.toLowerCase();
  const contextLower = [...(options.history ?? []), text].join(" ").toLowerCase();
  const scoreMatches = Array.from(contextLower.matchAll(/\b([3-8]\d\d)\b/g));
  const score = scoreMatches.length ? Number(scoreMatches.at(-1)?.[1]) : null;

  if (/\b(cpns?|credit privacy numbers?|fake ssn|new social)\b/.test(lower)) {
    return response(text, {
      ...NONE,
      reply:
        "I can’t help with that. CPNs and false identities aren’t legitimate credit strategies, but I can walk you through improving your real file.",
      thinking: "compliance tripwire",
      stage: "guardrail",
      brainPassage: "Compliance · identity integrity",
      grounded: true,
      guardrail: { type: "block", rule: "no-cpn-compliance" },
    }, options.version);
  }

  if (/\b(guarantee|guaranteed|promise)\b.*\b(score|funding|750|800)\b|\b750 score\b/.test(lower)) {
    return response(text, {
      ...NONE,
      reply:
        "I won’t promise a specific score or funding outcome. What I can do is get you a straight assessment based on your actual file.",
      thinking: "outcome guarantee blocked",
      stage: "guardrail",
      brainPassage: "Compliance · no guaranteed outcomes",
      grounded: true,
      guardrail: { type: "block", rule: "no-guaranteed-outcomes" },
    }, options.version);
  }

  if (/\b(poem|general assistant|essay|roleplay)\b|ignore .*instruction|write me|you(?:’|')?re now|act as/.test(lower)) {
    return response(text, {
      ...NONE,
      reply: "Nice try. I only help credit and funding leads figure out their next step. Where’s your credit score sitting right now?",
      thinking: "staying in role",
      stage: "guardrail",
      brainPassage: "Guardrails · stay in role",
      grounded: true,
      guardrail: { type: "deflect", rule: "stay-in-role" },
    }, options.version);
  }

  if (/\b(diy|myself|on my own|do it my)\b/.test(lower)) {
    return response(text, {
      ...NONE,
      reply:
        "You can, and most clients tried the DIY route first. We focus the work on the disputes that can actually move your file instead of guessing. What’s your score around now?",
      thinking: "handling DIY objection",
      stage: "objection",
      brainPassage: "Objections · DIY route",
      grounded: true,
      guardrail: null,
    }, options.version);
  }

  if (/\b(cost|price|pricing|fee|how much (?:is|does|will|would))\b/.test(lower)) {
    const program = offer.programName ?? "the program";
    return response(text, {
      ...NONE,
      reply: offer.quotePricing
        ? `Pricing for ${program} is fixed in my setup, so I only state the saved numbers, never an improvised one, and the coach confirms them on the call. What’s your score around now?`
        : "It depends on where you’re starting, so I won’t throw out a random number. If you’re a fit, the coach covers pricing on the call with no surprise fees. What’s your score around now?",
      thinking: offer.quotePricing ? "pricing gate open · saved numbers only" : "pricing gated to the call",
      stage: "objection",
      brainPassage: offer.quotePricing ? "Offer layer · saved pricing only" : "Offer layer · pricing gated to call",
      grounded: true,
      guardrail: null,
    }, options.version);
  }

  if (/\b(scam|trust|legit|legitimate)\b/.test(lower)) {
    return response(text, {
      ...NONE,
      reply:
        "That’s fair to ask. The process uses real timelines and doesn’t promise outcomes up front. I can first check whether a call would even be useful for you.",
      thinking: "handling trust objection",
      stage: "objection",
      brainPassage: "Objections · trust and transparency",
      grounded: true,
      guardrail: null,
    }, options.version);
  }

  if (score !== null) {
    // The coach's published floor outranks the shared decision table — this is the
    // offer layer visibly overriding the Brain, which is the whole product story.
    if (offer.creditMinimum !== null && score < offer.creditMinimum) {
      return response(text, {
        ...NONE,
        reply: `Thanks for being straight with me. This offer has a published ${offer.creditMinimum} credit floor, and at ${score} a call wouldn’t help yet, and I’d rather not waste your time. I can give you the first two areas to work on instead.`,
        thinking: "below the coach credit floor",
        stage: "qualify",
        decision: "HARD_DQ",
        decisionRow: `Below coach credit floor ${offer.creditMinimum} → HARD DQ`,
        brainPassage: "Offer layer · published credit floor",
        grounded: true,
        guardrail: null,
      }, options.version);
    }

    const hasQualifiedRevenue = (
      /\b(50k|50,000|[5-9]\d\s?k|six figures)\b.{0,24}\b(revenue|sales|annually|annual)\b/.test(contextLower) ||
      /\b(revenue|sales|making|generating|annual)\b.{0,24}\b(50k|50,000|[5-9]\d\s?k|six figures)\b/.test(contextLower)
    );
    const hasNoRevenue = !hasQualifiedRevenue && /\b(pre.revenue|pre-revenue|no revenue|zero revenue)\b/.test(contextLower);
    const businessStage = /\b(startup|starting|early.stage)\b/.test(contextLower) || hasNoRevenue
      ? "startup" as const
      : /\b(revenue|operating|existing business)\b/.test(contextLower)
        ? "operating" as const
        : "unknown" as const;
    const annualRevenue = hasQualifiedRevenue
      ? 50_000
      : hasNoRevenue
        ? 0
        : null;
    const fundingGoal = fundingGoalFromText(contextLower);
    const timeline = fundingTimelineFromText(contextLower);
    // Questions the coach switched off stop blocking resolution: a disabled input
    // resolves to a permissive default instead of being demanded from the lead.
    const effectiveRevenue = !offer.revenueRequired && annualRevenue === null ? 50_000 : annualRevenue;
    const effectiveGoal = !offer.askFundingAmount && fundingGoal === null ? FUNDING_GOALS[1] : fundingGoal;
    const effectiveTimeline = !offer.askTimeline && timeline === null ? FUNDING_TIMELINES[1] : timeline;
    // `options.outcomes` carries what the admin published on the Brain screen, so a
    // published rule change reaches the test agent the way it will reach every
    // coach's agent. Deliberately not gated on `version` — gating it there would
    // mean publishing a change stopped affecting the published agent.
    //
    // The trust problem is real, sits one layer up, and stays recorded in GAPS.md:
    // the overrides arrive on the wire, so the caller rather than the server is
    // asserting what "published" means. Rule ids and outcome values are allowlisted
    // in normalizeBrainOutcomeOverrides, the lead-facing /api/consumer-agent never
    // accepts them at all, and a deployment with SETTERFI_ACCESS_PASSWORD set does
    // not expose this route to strangers. The real close is the Brain backend owning
    // the published matrix so the client stops carrying it — that needs a database.
    const qualification = resolveDemoQualification(
      { score, businessStage, annualRevenue: effectiveRevenue, fundingGoal: effectiveGoal, timeline: effectiveTimeline },
      options.outcomes,
    );

    if (qualification?.outcome === "BOOK") {
      const slot = nextThursdaySlot();
      const addedInputThisTurn = (
        /\b[3-8]\d\d\b/.test(lower) ||
        fundingGoalFromText(lower) !== null ||
        fundingTimelineFromText(lower) !== null ||
        /\b(revenue|sales|pre.revenue|generating|annually)\b/.test(lower)
      );

      if (!addedInputThisTurn) {
        return response(text, {
          reply: `Your test slot is still held for ${slot}. Nothing else is needed from you here. Ask me anything else a lead would and the same rules apply.`,
          thinking: "booking already held",
          stage: "book",
          decision: "BOOK",
          decisionRow: `${qualification.label} → BOOK`,
          brainPassage: "Qualification · decision table",
          grounded: true,
          guardrail: null,
          booked: { slot, calendar: "SetterFi test calendar" },
        }, options.version);
      }

      return response(text, {
        reply: `That combination clears the published demo rule. I’ve held ${slot} on the test calendar so you can see the full booking path.`,
        thinking: "qualified for booking",
        stage: "book",
        decision: "BOOK",
        decisionRow: `${qualification.label} → BOOK`,
        brainPassage: "Qualification · decision table",
        grounded: true,
        guardrail: null,
        booked: { slot, calendar: "SetterFi test calendar" },
      }, options.version);
    }

    if (qualification?.outcome === "HARD_DQ") {
      return response(text, {
        ...NONE,
        reply: `Thanks for being straight with me. At ${score}, a call wouldn’t help yet, and I don’t want to waste your time. I can give you the first two areas to work on instead.`,
        thinking: "hard disqualification",
        stage: "qualify",
        decision: "HARD_DQ",
        decisionRow: `${qualification.label} → HARD DQ`,
        brainPassage: "Qualification · decision table",
        grounded: true,
        guardrail: null,
      }, options.version);
    }

    if (qualification?.outcome === "SOFT_DQ") {
      return response(text, {
        ...NONE,
        reply: `This published demo row routes to nurture instead of a call. I can map the next steps and have the team re-score the lead when the inputs change.`,
        thinking: "soft disqualification",
        stage: "qualify",
        decision: "SOFT_DQ",
        decisionRow: `${qualification.label} → SOFT DQ`,
        brainPassage: "Qualification · decision table",
        grounded: true,
        guardrail: null,
      }, options.version);
    }

    const missing = [
      offer.revenueRequired && annualRevenue === null ? "current annual revenue" : null,
      offer.askFundingAmount && fundingGoal === null ? "funding goal" : null,
      offer.askTimeline && timeline === null ? "timeline" : null,
    ].filter(Boolean);
    return response(text, {
      ...NONE,
      reply: missing.length
        ? `Got it, ${score}. I still need the ${missing.join(" and ")} before this row can resolve.`
        : `Got it, ${score}. Those inputs sit in a manual-review band, so this demo won’t invent a booking outcome.`,
      thinking: "collecting decision inputs",
      stage: "qualify",
      brainPassage: "Qualification · required fields",
      grounded: true,
      guardrail: null,
    }, options.version);
  }

  const askedBefore = (options.history?.length ?? 0) > 0;
  return response(text, {
    ...NONE,
    reply: askedBefore
      ? offer.revenueRequired
        ? "I still need a number to work with. Roughly where’s your credit score, and what’s the business doing in annual revenue?"
        : "I still need a number to work with. Roughly where’s your credit score sitting?"
      : offer.revenueRequired
        ? "Good question. What’s your credit score sitting around, and is the business already generating revenue?"
        : "Good question. What’s your credit score sitting around these days?",
    thinking: "collecting qualification inputs",
    stage: "qualify",
    brainPassage: "Qualification · required fields",
    grounded: true,
    guardrail: null,
  }, options.version);
}
