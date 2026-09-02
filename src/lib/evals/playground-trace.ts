import {
  OUTPUT_CHECK_CLASSES,
  type CheckResult,
  type CheckViolation,
  type EngineTrace,
  type NumberSource,
  type OutputCheckClass,
} from "@/lib/engine/types";

/**
 * The eval playground's view of one engine turn.
 *
 * Pure: it takes the `EngineTrace` the engine already produces and returns what the screen shows.
 * No I/O, no Supabase, no React, so the one thing this screen has to get right can be tested
 * without rendering anything.
 *
 * **That one thing is how a refusal reads.** The agent is retrieval-grounded and pricing,
 * guarantees and outcomes are hard-gated, so on this screen the agent declining to state a figure
 * is the safeguard working. If the playground drew that as an error -- red, "failed", an alert --
 * it would teach the client's own team to distrust the mechanism that keeps the product legally
 * safe, and the first thing anyone does when they distrust a safeguard is ask for it to be turned
 * down. So a held turn is `outcome: "refused"` carrying `correct: true`, and the sentence beside
 * it says what the gate protected rather than what went wrong.
 *
 * The distinction that costs the most to get wrong is a REFUSAL against a DEGRADATION. A held
 * turn is the product working. A moderator that could not be reached is the product running
 * without one of its screens, which is not a refusal and must never be dressed as one -- so
 * `moderator: "unavailable"` produces `outcome: "degraded"`, and the screen says the turn
 * completed with a check missing rather than implying anything was caught.
 */

export type PlaygroundStepTone = "neutral" | "good" | "warning";

export type PlaygroundStep = {
  /** 1-based, in the order the engine took them. */
  order: number;
  /** What the engine did, as a past-tense phrase. */
  name: string;
  /** The engine's own word for the outcome of this step. */
  label: string;
  tone: PlaygroundStepTone;
  /** One sentence explaining the step in terms of what it protects. */
  sentence: string;
  /**
   * What the step actually read or produced, as short lines. Never prose: these are the
   * receipts -- entry ids, allowed numbers with their source, rule ids -- and a reader checking
   * the agent's work needs them terse enough to scan.
   */
  readings: readonly string[];
};

export type PlaygroundVerdict = {
  outcome: "answered" | "refused" | "degraded";
  /**
   * True when the outcome is the behaviour we want. A refusal is correct; an answer is correct;
   * a degradation is not incorrect either, but it is not a clean run, so it is neither.
   */
  correct: boolean;
  label: string;
  /** What the gate protected, or what is missing. One sentence. */
  sentence: string;
  /** The engine's rule id, where one fired. Shown verbatim: it is what an auditor will quote. */
  ruleFired: string | null;
};

export type PlaygroundRun = {
  answer: string;
  verdict: PlaygroundVerdict;
  steps: readonly PlaygroundStep[];
  meta: {
    model: string | null;
    latencyMs: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    /** Admin-only, and this is the one console surface where it is allowed to be real. */
    costUsd: number | null;
    brainVersion: number;
    offerVersion: number;
    knowledgeMode: "inline" | "retrieved";
  };
};

/**
 * What each output-check class is actually protecting, in the words a reader needs.
 *
 * These are not restatements of the class name. `NUM` is the pricing gate: the engine builds an
 * allowlist of every number it is permitted to say -- from the coach's own offer, the
 * qualification thresholds, the Brain, and the lead's own message -- and refuses any figure that
 * is not on it. That is the mechanism behind "the agent cannot invent numbers", and naming it
 * here is what turns a rule id into something a reviewer can check.
 */
const CHECK_SUBJECT: Record<OutputCheckClass, string> = {
  NUM: "a number that was not on the allowlist the engine built for this turn",
  CLAIM: "a guarantee or an outcome the agent is not allowed to promise",
  ECHO: "coach configuration being repeated back into the reply",
  LINK: "a link that is not on this tenant's whitelist",
  SCOPE: "a request outside what this agent is for",
  LEN: "a reply longer than the channel allows",
};

const SOURCE_LABEL: Record<NumberSource["sourceType"], string> = {
  offer_price: "the coach's own offer layer",
  qualification_threshold: "this tenant's qualification bounds",
  brain_entry: "a Brain document",
  lead_message: "the lead's own message",
};

/** Sorted and deduplicated so the sentence reads the same way for the same set of violations. */
function violationClasses(violations: readonly CheckViolation[]): OutputCheckClass[] {
  const seen = new Set(violations.map((violation) => violation.class));
  return OUTPUT_CHECK_CLASSES.filter((cls) => seen.has(cls));
}

function retrievalStep(trace: EngineTrace): PlaygroundStep {
  const top = trace.retrievalTopThree;
  const dropped = trace.droppedEntryIds.length;

  // `inline` means the whole Brain was in the prompt rather than retrieved against, so there is
  // no retrieval to report. Saying "0 passages" there would claim a search that never ran.
  if (trace.knowledgeMode === "inline") {
    return {
      order: 1,
      name: "Read The Brain",
      label: "Inline",
      tone: "neutral",
      sentence:
        "This tenant's Brain is small enough to be given to the model whole, so nothing was retrieved and nothing was ranked.",
      readings: [`Brain version ${trace.brainVersion}`],
    };
  }

  return {
    order: 1,
    name: "Retrieved from The Brain",
    label: top.length === 0 ? "Nothing above threshold" : "Retrieval",
    tone: top.length === 0 ? "warning" : "neutral",
    sentence: top.length === 0
      ? "Retrieval returned nothing above the similarity threshold, so the agent had no grounded passage to answer from."
      : "The agent searches the shared Brain first and answers second, so every claim it makes can be traced to a document.",
    readings: [
      ...top.map((citation) =>
        `${citation.entryId} · similarity ${citation.similarity.toFixed(3)} · score ${citation.score.toFixed(3)}`),
      ...(dropped > 0
        ? [`${dropped} candidate${dropped === 1 ? "" : "s"} discarded as off-topic`]
        : []),
    ],
  };
}

/**
 * The number allowlist, which is the pricing gate in its positive form.
 *
 * Worth stating as its own step rather than folding into the checks: the interesting fact is not
 * that a number passed a check, it is WHERE the agent was allowed to get it from. Pricing is
 * tenant-specific and must never be generalised out of the shared Brain, so an allowlist entry
 * reading `offer_price` is the proof that the price came from this coach's own settings.
 */
function groundingStep(trace: EngineTrace): PlaygroundStep {
  const allowlist = trace.numberAllowlist;
  const bySource = new Map<NumberSource["sourceType"], number>();
  for (const source of allowlist) {
    bySource.set(source.sourceType, (bySource.get(source.sourceType) ?? 0) + 1);
  }

  return {
    order: 2,
    name: "Built the number allowlist",
    label: allowlist.length === 0 ? "No numbers permitted" : `${allowlist.length} permitted`,
    tone: "neutral",
    sentence: allowlist.length === 0
      ? "Nothing on this turn permitted a figure, so any number in the reply would have been refused."
      : "Every figure the agent is allowed to say on this turn, and where it is allowed to get it from. Anything else is refused before the reply leaves.",
    readings: [...bySource.entries()].map(([sourceType, count]) =>
      `${count} from ${SOURCE_LABEL[sourceType]}`),
  };
}

function screenStep(trace: EngineTrace): PlaygroundStep {
  const failed = trace.checks.filter((check: CheckResult) => !check.passed);
  const rejected = trace.rejectedDrafts.length;

  return {
    order: 3,
    name: "Screened the draft",
    label: failed.length === 0 ? "Every check passed" : `${failed.length} check${failed.length === 1 ? "" : "s"} caught it`,
    tone: failed.length === 0 ? "good" : "good",
    sentence: failed.length === 0
      ? "The draft was checked against every output rule before it was allowed out, and none of them fired."
      : "The checks run on the draft before the reply leaves, so a bad draft never reaches the lead.",
    readings: [
      ...failed.map((check) => `${check.class} · ${check.ruleIds.join(", ") || "no rule id"}`),
      `${trace.attempts} generation attempt${trace.attempts === 1 ? "" : "s"}`,
      ...(rejected > 0 ? [`${rejected} draft${rejected === 1 ? "" : "s"} rejected and regenerated`] : []),
    ],
  };
}

function moderatorStep(trace: EngineTrace): PlaygroundStep {
  const state = trace.moderator;
  const label = state === "allowed"
    ? "Allowed"
    : state === "blocked"
      ? "Blocked"
      : state === "unavailable"
        ? "Could not be reached"
        : "Not run";

  return {
    order: 4,
    name: "Asked the moderator",
    label,
    // Unavailable is the only warning here. A block is the moderator doing its job, and colouring
    // it as a problem is the same mistake as drawing a refusal in red.
    tone: state === "unavailable" ? "warning" : state === "blocked" ? "good" : "neutral",
    sentence: state === "unavailable"
      ? "The moderator could not be reached, so this turn completed with one of its screens missing. Nothing was caught here because nothing ran."
      : state === "blocked"
        ? "A second model reviews the draft independently, and it stopped this one."
        : state === "not_run"
          ? "The moderator was not asked on this turn."
          : "A second model reviewed the draft independently and had no objection.",
    readings: trace.moderatorReason ? [trace.moderatorReason] : [],
  };
}

/**
 * The verdict, and the whole reason this module is separate from the component.
 *
 * Order matters. An unavailable moderator is checked BEFORE the held branch, because a turn that
 * was held while a screen was down is still a turn with a screen down, and calling it a clean
 * refusal would overstate what the product proved.
 */
export function derivePlaygroundVerdict(trace: EngineTrace): PlaygroundVerdict {
  if (trace.moderator === "unavailable") {
    return {
      outcome: "degraded",
      correct: false,
      label: "Ran with a screen down",
      sentence:
        "The moderator could not be reached, so this reply was produced with one of its two screens missing. Read the result accordingly rather than as a clean pass.",
      ruleFired: trace.ruleFired,
    };
  }

  if (trace.screen.verdict === "held") {
    const classes = violationClasses(trace.violations);
    const subjects = classes.map((cls) => CHECK_SUBJECT[cls]);
    return {
      outcome: "refused",
      correct: true,
      label: "Refused, correctly",
      sentence: subjects.length === 0
        ? "The reply was held before it left. This is the gate working, not a failure."
        : `The reply was held because it contained ${subjects.join(", and ")}. This is the gate working, not a failure.`,
      ruleFired: trace.ruleFired,
    };
  }

  if (trace.moderator === "blocked") {
    return {
      outcome: "refused",
      correct: true,
      label: "Blocked by the moderator",
      sentence:
        "The second model reviewing the draft stopped it. The lead never sees a reply the moderator rejected, which is the behaviour we want.",
      ruleFired: trace.ruleFired,
    };
  }

  // A hard-gated objection is answered from the Brain's published wording verbatim -- the model
  // does not compose it. That is neither a refusal nor an ordinary answer, and saying so is the
  // difference between a reader trusting the wording and assuming the model chose it.
  if (trace.objection?.hardGate) {
    return {
      outcome: "answered",
      correct: true,
      label: "Answered from a hard gate",
      sentence:
        "This matched a hard-gated objection, so the agent sent the Brain's published wording word for word. The model did not compose this reply and could not have changed it.",
      ruleFired: trace.ruleFired,
    };
  }

  return {
    outcome: "answered",
    correct: true,
    label: "Answered",
    sentence:
      "The reply passed every output check and the moderator, and every claim in it traces to a retrieved passage.",
    ruleFired: trace.ruleFired,
  };
}

export function derivePlaygroundRun(input: {
  reply: string;
  trace: EngineTrace;
}): PlaygroundRun {
  const { reply, trace } = input;
  return {
    answer: reply,
    verdict: derivePlaygroundVerdict(trace),
    steps: [retrievalStep(trace), groundingStep(trace), screenStep(trace), moderatorStep(trace)],
    meta: {
      model: trace.model,
      latencyMs: trace.latencyMs,
      promptTokens: trace.usage?.promptTokens ?? null,
      completionTokens: trace.usage?.completionTokens ?? null,
      costUsd: trace.cost,
      brainVersion: trace.brainVersion,
      offerVersion: trace.offerVersion,
      knowledgeMode: trace.knowledgeMode,
    },
  };
}
