import { describe, expect, it } from "vitest";

import type { EngineTrace } from "@/lib/engine/types";

import { derivePlaygroundRun, derivePlaygroundVerdict } from "./playground-trace";

/**
 * The refusal-versus-degradation rule, which is the only thing this module exists to get right.
 *
 * `playground-trace.ts` shipped complete, reasoned and untested. Its docstring makes two claims
 * about the product that nothing executed:
 *
 *   1. **A held turn is the safeguard working, not a failure.** The agent is retrieval-grounded
 *      and pricing, guarantees and outcomes are hard-gated (`CLAUDE.md`), so an admin watching
 *      the agent decline to state a figure is watching the mechanism that keeps the product
 *      legally safe. Drawing that as an error teaches the client's own team to distrust it, and
 *      the first thing anyone does with a safeguard they distrust is ask for it to be turned
 *      down. So `correct` is true on a refusal, and the sentence names what was protected.
 *   2. **A missing moderator is not a refusal.** A turn that ran with one of its two screens down
 *      completed without being checked; calling it a clean refusal claims something was caught
 *      when nothing ran. It has to outrank the held branch, because a turn can be both.
 *
 * Neither claim is expressible as a type, and the second is an ORDERING between two branches --
 * the kind of thing a later edit reorders without noticing. Every test below is about one of
 * those two, or about the receipts a reviewer quotes when checking the agent's work.
 */

const CITATION = {
  entryId: "entry-1",
  content: "Funding basics",
  similarity: 0.842,
  categoryBoost: 0.05,
  score: 0.892,
  categoryAgreement: true,
} as const;

function trace(overrides: Partial<EngineTrace> = {}): EngineTrace {
  return {
    brainVersion: 12,
    offerVersion: 4,
    brainContentHash: null,
    offerContentHash: null,
    knowledgeMode: "retrieved",
    promptHash: "hash",
    model: "anthropic/claude-opus-4.1",
    paramsHash: null,
    ruleFired: null,
    sources: [CITATION],
    declaredEntryId: "entry-1",
    declaredEntryVerified: true,
    retrievalTopThree: [CITATION],
    droppedEntryIds: [],
    numberAllowlist: [
      { kind: "currency", value: 4500, sourceType: "offer_price", sourceId: "offer-1" },
      { kind: "score", value: 640, sourceType: "qualification_threshold", sourceId: "bounds-1" },
    ],
    objection: null,
    checks: [{ class: "NUM", passed: true, ruleIds: ["NUM-1"], evidence: [] }],
    violations: [],
    rejectedDrafts: [],
    attempts: 1,
    screen: { verdict: "continue", reason: null },
    latencyMs: 1_240,
    usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1_020 },
    cost: 0.0184,
    moderator: "allowed",
    moderatorReason: null,
    ...overrides,
  };
}

describe("derivePlaygroundVerdict", () => {
  it("calls a held turn a correct refusal and names what the gate protected", () => {
    const verdict = derivePlaygroundVerdict(trace({
      screen: { verdict: "held", reason: "NUM" },
      ruleFired: "NUM-1",
      violations: [{ class: "NUM", ruleId: "NUM-1", evidence: "$9,000" }],
    }));

    expect(verdict.outcome).toBe("refused");
    // The whole point: a refusal is the product working, so it is not drawn as a failure.
    expect(verdict.correct).toBe(true);
    expect(verdict.sentence).toContain("the allowlist the engine built for this turn");
    expect(verdict.sentence).toContain("This is the gate working, not a failure.");
    // The rule id is what an auditor quotes, so it is passed through rather than summarised.
    expect(verdict.ruleFired).toBe("NUM-1");
  });

  it("names every distinct violation class once, in a stable order", () => {
    const verdict = derivePlaygroundVerdict(trace({
      screen: { verdict: "held", reason: "NUM" },
      violations: [
        { class: "CLAIM", ruleId: "CLAIM-2", evidence: "guaranteed" },
        { class: "NUM", ruleId: "NUM-1", evidence: "$9,000" },
        { class: "NUM", ruleId: "NUM-3", evidence: "$12,000" },
      ],
    }));

    // Two NUM violations are one subject, and the order follows OUTPUT_CHECK_CLASSES rather than
    // the order the checks happened to fire, so the same held turn reads the same way twice.
    const sentence = verdict.sentence;
    expect(sentence.indexOf("allowlist")).toBeLessThan(sentence.indexOf("guarantee"));
    expect(sentence.match(/allowlist/g)).toHaveLength(1);
  });

  it("treats an unreachable moderator as a degradation, even when the turn was also held", () => {
    const verdict = derivePlaygroundVerdict(trace({
      moderator: "unavailable",
      screen: { verdict: "held", reason: "NUM" },
      violations: [{ class: "NUM", ruleId: "NUM-1", evidence: "$9,000" }],
    }));

    // The ordering is the assertion. A turn that was held while a screen was down is still a turn
    // with a screen down, and reporting it as a clean refusal overstates what the product proved.
    expect(verdict.outcome).toBe("degraded");
    expect(verdict.correct).toBe(false);
    expect(verdict.sentence).toContain("one of its two screens missing");
    // Never dressed as something being caught, because nothing ran.
    expect(verdict.sentence).not.toMatch(/gate working|blocked|refused/i);
  });

  it("calls a moderator block a correct refusal rather than an error", () => {
    const verdict = derivePlaygroundVerdict(trace({ moderator: "blocked" }));

    expect(verdict.outcome).toBe("refused");
    expect(verdict.correct).toBe(true);
    expect(verdict.sentence).toContain("which is the behaviour we want");
  });

  it("says a hard-gated answer was published wording, not something the model composed", () => {
    const verdict = derivePlaygroundVerdict(trace({
      objection: { snapshotId: "snap-1", objectionId: "objection-1", hardGate: true },
    }));

    expect(verdict.outcome).toBe("answered");
    // A reader who thinks the model wrote this will read the wording as negotiable. It is not.
    expect(verdict.sentence).toContain("The model did not compose this reply");
  });

  it("does not claim a hard gate for a soft objection match", () => {
    const verdict = derivePlaygroundVerdict(trace({
      objection: { snapshotId: "snap-1", objectionId: "objection-1", hardGate: false },
    }));

    expect(verdict.label).toBe("Answered");
    expect(verdict.sentence).not.toContain("hard-gated");
  });
});

describe("derivePlaygroundRun", () => {
  it("reports the retrieval receipts a reviewer needs to check the agent's work", () => {
    const run = derivePlaygroundRun({ reply: "Here is what I can tell you.", trace: trace({
      droppedEntryIds: ["entry-9", "entry-11"],
    }) });
    const [retrieval] = run.steps;

    expect(retrieval.name).toBe("Retrieved from The Brain");
    // Entry id, similarity and score, terse enough to scan: this is the evidence, not prose.
    expect(retrieval.readings[0]).toBe("entry-1 · similarity 0.842 · score 0.892");
    expect(retrieval.readings[1]).toBe("2 candidates discarded as off-topic");
  });

  it("claims no retrieval when the whole Brain went into the prompt", () => {
    const [retrieval] = derivePlaygroundRun({
      reply: "Sure.",
      trace: trace({ knowledgeMode: "inline", retrievalTopThree: [] }),
    }).steps;

    // "0 passages" would report a search that never ran, which is the same class of claim as a
    // provisioning card reading "all set" while a carrier is still vetting.
    expect(retrieval.label).toBe("Inline");
    expect(retrieval.sentence).toContain("nothing was retrieved and nothing was ranked");
    expect(retrieval.readings).toEqual(["Brain version 12"]);
  });

  it("warns when retrieval returned nothing above threshold, which is not the same as inline", () => {
    const [retrieval] = derivePlaygroundRun({
      reply: "Sure.",
      trace: trace({ retrievalTopThree: [] }),
    }).steps;

    expect(retrieval.tone).toBe("warning");
    expect(retrieval.sentence).toContain("had no grounded passage to answer from");
  });

  it("says where each permitted figure was allowed to come from, not just how many there were", () => {
    const [, grounding] = derivePlaygroundRun({ reply: "Sure.", trace: trace() }).steps;

    expect(grounding.label).toBe("2 permitted");
    // Pricing is tenant-specific and must never generalise out of the shared Brain, so the source
    // is the interesting half: `offer_price` is the proof it came from this coach's own settings.
    expect(grounding.readings).toEqual([
      "1 from the coach's own offer layer",
      "1 from this tenant's qualification bounds",
    ]);
  });

  it("says an empty allowlist means any figure would have been refused", () => {
    const [, grounding] = derivePlaygroundRun({
      reply: "Sure.",
      trace: trace({ numberAllowlist: [] }),
    }).steps;

    expect(grounding.label).toBe("No numbers permitted");
    expect(grounding.sentence).toContain("any number in the reply would have been refused");
  });

  it("keeps a caught draft in a good tone, because a check firing is the screen working", () => {
    const [, , screen] = derivePlaygroundRun({ reply: "Held.", trace: trace({
      checks: [{ class: "NUM", passed: false, ruleIds: ["NUM-1"], evidence: ["$9,000"] }],
      rejectedDrafts: ["a draft that quoted a price"],
      attempts: 2,
    }) }).steps;

    expect(screen.label).toBe("1 check caught it");
    // Same rule as the verdict: colouring a caught draft as a problem teaches the reader to
    // distrust the thing that stopped it.
    expect(screen.tone).toBe("good");
    expect(screen.readings).toEqual([
      "NUM · NUM-1",
      "2 generation attempts",
      "1 draft rejected and regenerated",
    ]);
  });

  it("marks only an unreachable moderator as a warning, never a block", () => {
    const blocked = derivePlaygroundRun({ reply: "", trace: trace({ moderator: "blocked" }) })
      .steps[3];
    const missing = derivePlaygroundRun({
      reply: "",
      trace: trace({ moderator: "unavailable", moderatorReason: "gateway timeout" }),
    }).steps[3];

    expect(blocked.tone).toBe("good");
    expect(missing.tone).toBe("warning");
    expect(missing.sentence).toContain("Nothing was caught here because nothing ran.");
    expect(missing.readings).toEqual(["gateway timeout"]);
  });

  it("carries the run's own cost, which is allowed here and nowhere a coach can see", () => {
    const run = derivePlaygroundRun({ reply: "Sure.", trace: trace() });

    // `CLAUDE.md` keeps cost off every client-visible surface; this is an admin-only screen, so
    // the figure is real rather than withheld. If this module ever feeds a coach surface, this
    // assertion is the thing that should have stopped it.
    expect(run.meta.costUsd).toBe(0.0184);
    expect(run.meta.promptTokens).toBe(900);
    expect(run.meta.completionTokens).toBe(120);
    expect(run.answer).toBe("Sure.");
    expect(run.steps.map((step) => step.order)).toEqual([1, 2, 3, 4]);
  });

  it("reports absent telemetry as absent rather than as zero", () => {
    const run = derivePlaygroundRun({
      reply: "Sure.",
      trace: trace({ usage: null, cost: null, latencyMs: null, model: null }),
    });

    // A zero cost and a missing cost are different facts, and a screen that prints $0.00 for the
    // second one is claiming a measurement nobody made.
    expect(run.meta).toMatchObject({
      costUsd: null,
      latencyMs: null,
      model: null,
      promptTokens: null,
      completionTokens: null,
    });
  });
});
