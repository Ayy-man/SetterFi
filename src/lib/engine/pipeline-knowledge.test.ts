// The knowledge path of a runtime-backed turn: inline mode renders the whole published section
// and still ranks for the trace; retrieved mode holds on a miss instead of failing the turn; a
// retrieved answer grounds a figure only through its reviewed bindings.
import { describe, expect, it, vi } from "vitest";

import type { PublishedKnowledgeEntry, PublishedRuntimeBundle } from "@/lib/brain/contracts";
import { rewriteHash } from "@/lib/brain/provenance";
import {
  DEFAULT_RETRIEVAL_SIMILARITY_FLOOR,
  type RetrieveForTurnInput,
  type TurnRetrievalResult,
} from "@/lib/brain/retrieval";
import { GROUNDED_REPLY_IN_SCOPE, type ModeratorCall } from "@/lib/engine/moderator";
import {
  INLINE_KNOWLEDGE_TOKEN_BUDGET,
  NO_GROUNDED_ANSWER_RULE_ID,
  planInlineKnowledge,
  runEngineTurn,
  type EnginePipelineInput,
} from "@/lib/engine/pipeline";
import type { BrainSnapshot, CoachOffer, ModeratorClass } from "@/lib/engine/types";
import type { ModelDriver } from "@/lib/integrations/types";

const HELD = Object.fromEntries(
  ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN", "JUDGE", "REVOKE"].map((key) => [key, `Held for ${key}.`]),
) as Record<ModeratorClass, string>;

const LEGACY_BRAIN: BrainSnapshot = {
  version: 1,
  platformFrame: "",
  mission: "",
  qualification: "",
  complianceRules: [],
  entries: [],
  knowledgeMode: "inline",
};

const LEGACY_OFFER: CoachOffer = {
  tenantId: "tenant",
  version: 1,
  programName: "Summit",
  products: [],
  brandVoice: "direct",
  voiceAnswers: [],
  qualificationRules: [],
  voiceGuidelines: null,
  proof: [],
  assets: [],
  offerPrices: [],
  creditMin: null,
  fundingGoalMinCents: null,
  bookingHorizonDays: 30,
};

const BASE: EnginePipelineInput = {
  mode: "test",
  channel: "sms",
  brain: LEGACY_BRAIN,
  offer: LEGACY_OFFER,
  conversation: { state: "agent", currentStep: null, currentStepAsks: 0, disclosurePending: false },
  history: [{ role: "user", content: "How long does funding take?" }],
  leadMessage: { id: "lead", body: "How long does funding take?" },
  tagSecret: "test-secret",
  automatedExperienceDisclosure: "You're chatting with an automated assistant.",
  heldReplies: HELD,
  linkWhitelist: [],
  roleBoundary: "credit and funding qualification only",
  modelConfigs: [
    { id: "g", role: "generator", openrouterModel: "anthropic/generator", params: {}, active: true },
    { id: "m", role: "moderator", openrouterModel: "openai/moderator", params: {}, active: true },
  ],
  currentQuestion: null,
  extractionCandidate: null,
  qualificationState: {
    credit: null, goal: null, timeline: null, businessStage: null,
    annualRevenueCents: null, outcome: null, dqReason: null,
  },
};

const TIMING_TEMPLATE = "Most files fund within {{target_funding_amount}} range in about 45 days.";
const FEE_TEMPLATE = "The readiness review is $297 and a 640 score is the usual starting point.";

function knowledgeEntry(overrides: Partial<PublishedKnowledgeEntry> = {}): PublishedKnowledgeEntry {
  return {
    entryId: "entry-timing",
    category: "Funding Qs",
    question: "How long does funding take?",
    responseTemplate: TIMING_TEMPLATE,
    numberBindings: [],
    rewriteHash: rewriteHash(TIMING_TEMPLATE),
    sourceRef: "notion:timing",
    ...overrides,
  };
}

function feeEntry(): PublishedKnowledgeEntry {
  return knowledgeEntry({
    entryId: "entry-fee",
    question: "What does it cost?",
    responseTemplate: FEE_TEMPLATE,
    numberBindings: [{ kind: "currency", value: 297, binding: "offer_prices", offset: 24 }],
    rewriteHash: rewriteHash(FEE_TEMPLATE),
    sourceRef: "notion:fee",
  });
}

function bundle(options: {
  knowledgeMode?: "inline" | "retrieved";
  knowledgeEntries?: readonly PublishedKnowledgeEntry[];
  retrievalFloor?: number;
} = {}): PublishedRuntimeBundle {
  const knowledgeMode = options.knowledgeMode ?? "inline";
  return {
    brain: {
      id: "snapshot-7",
      version: 7,
      contentHash: "a".repeat(64),
      sourceHash: "b".repeat(64),
      payload: { entities: [] },
      compiledPlatform: "[A] Synthetic platform\n[B] Synthetic brain",
      platformTokens: 12,
      knowledgeMode,
      ...(options.retrievalFloor === undefined ? {} : { retrievalFloor: options.retrievalFloor }),
    },
    offer: {
      id: "offer-9",
      tenantId: "tenant",
      status: "published",
      version: 9,
      contentHash: "c".repeat(64),
      programName: "Published synthetic program",
      programDescription: null,
      creditMin: 640,
      fundingGoalMinCents: 5_000_000,
      fundingGoalMaxCents: 15_000_000,
      monthlyRevenueMinCents: null,
      businessRevenueRequired: false,
      creditRepair: null,
      products: [],
      bookingHorizonDays: 30,
      bookingMode: "direct",
      brandVoice: "professional",
      resultsTimelineMinDays: null,
      resultsTimelineMaxDays: null,
      refundPosture: null,
      voiceStyleAnswer: null,
      voiceObjectionAnswer: null,
      voiceFollowupAnswer: null,
      qualificationRules: [],
      voiceGuidelines: null,
      offerPrices: [],
      proof: [],
      assets: [],
    },
    qualification: [{ id: "strong-credit", label: "Strong credit", outcome: "BOOK", conditions: { minScore: 700 } }],
    qualificationApproved: true,
    qualificationSource: "platform",
    renderSources: { bookingUrl: null, qualificationSummary: "Strong credit: BOOK", qualificationInputs: ["credit score"], assetUrlsBySlug: {} },
    snapshotId: "snapshot-7",
    brainVersion: 7,
    offerVersion: 9,
    contentHash: "a".repeat(64),
    ...(options.knowledgeEntries ? { knowledgeEntries: options.knowledgeEntries } : {}),
  };
}

type GroundedCandidate = Extract<TurnRetrievalResult, { kind: "grounded" }>["included"][number];

function candidate(entryId: string, similarity: number, responseTemplate = "A grounded published answer."): GroundedCandidate {
  return {
    entryId,
    category: "Funding Qs",
    responseTemplate,
    numberBindings: [],
    rewriteHash: rewriteHash(responseTemplate),
    matchedVariant: null,
    content: responseTemplate,
    similarity,
    categoryBoost: 0 as const,
    score: similarity,
    dropped: false as const,
  };
}

function grounded(...included: GroundedCandidate[]): TurnRetrievalResult {
  return { kind: "grounded", included, dropped: [] };
}

function miss(...ranked: GroundedCandidate[]): TurnRetrievalResult {
  return {
    kind: "no_grounded_answer",
    reason: ranked.length ? "below_floor" : "nothing_renderable",
    floor: DEFAULT_RETRIEVAL_SIMILARITY_FLOOR,
    bestSimilarity: ranked[0]?.similarity ?? null,
    ranked,
    included: [],
    dropped: [],
  };
}

function dependencies(drafts: readonly string[]) {
  let index = 0;
  return {
    model: {
      generate: vi.fn<ModelDriver["generate"]>(async () => ({
        draft: drafts[Math.min(index++, drafts.length - 1)],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        provider: { name: "mock", generationId: `generation-${index}`, latencyMs: 12, cost: 0 },
      })),
    },
    moderator: {
      moderate: vi.fn<ModeratorCall>(async () => ({ verdict: "allow" as const, class: "JUDGE" as const, reason: "safe" })),
    },
  };
}

function reply(text: string, citation: string) {
  return JSON.stringify({ reply: text, citation_entry_id: citation });
}

describe("planInlineKnowledge", () => {
  it("renders every entry for the tenant and estimates the section", () => {
    const plan = planInlineKnowledge(bundle({ knowledgeEntries: [knowledgeEntry(), feeEntry()] }));
    expect(plan.mode).toBe("inline");
    if (plan.mode !== "inline") throw new Error("unreachable");
    expect(plan.inline.map((entry) => entry.entryId)).toEqual(["entry-timing", "entry-fee"]);
    expect(plan.inline[0].content).toBe("Most files fund within $50,000–$150,000 range in about 45 days.");
    expect(plan.entries[1].provenance?.numberBindings).toHaveLength(1);
    expect(plan.estimatedTokens).toBeGreaterThan(0);
  });

  it("withholds an entry this tenant cannot render and reports it as dropped", () => {
    const plan = planInlineKnowledge(bundle({
      knowledgeEntries: [knowledgeEntry(), knowledgeEntry({
        entryId: "entry-booking",
        responseTemplate: "Book here: {{booking_link}}",
      })],
    }));
    if (plan.mode !== "inline") throw new Error("unreachable");
    expect(plan.inline.map((entry) => entry.entryId)).toEqual(["entry-timing"]);
    expect(plan.dropped).toEqual([{
      entryId: "entry-booking", dropped: true, reason: "required placeholder unresolved: booking_link",
    }]);
  });

  it("falls back to retrieval when the snapshot is retrieved, entries are missing, or the budget is exceeded", () => {
    expect(planInlineKnowledge(bundle({ knowledgeMode: "retrieved" })))
      .toMatchObject({ mode: "retrieved", reason: "snapshot_retrieved" });
    expect(planInlineKnowledge(bundle())).toMatchObject({ mode: "retrieved", reason: "entries_unavailable" });
    const huge = Array.from({ length: 400 }, (_, index) => knowledgeEntry({
      entryId: `entry-${index}`,
      responseTemplate: "x".repeat(120),
      rewriteHash: null,
    }));
    const plan = planInlineKnowledge(bundle({ knowledgeEntries: huge }));
    expect(plan).toMatchObject({ mode: "retrieved", reason: "over_budget" });
    expect(plan.estimatedTokens).toBeGreaterThan(INLINE_KNOWLEDGE_TOKEN_BUDGET);
  });
});

describe("runEngineTurn inline knowledge mode", () => {
  it("puts every published entry in the prompt, ranks for evidence only, and verifies a citation against the inline set", async () => {
    const deps = dependencies([reply("Most files fund in a few weeks.", "entry-fee")]);
    const retrieve = vi.fn(async () => grounded(candidate("entry-timing", 0.91)));
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeEntries: [knowledgeEntry(), feeEntry()] }),
    }, { ...deps, retrieve });

    const system = deps.model.generate.mock.calls[0][0][0].content;
    expect(system).toContain("[B:INLINE] THE BRAIN, EVERY PUBLISHED ENTRY");
    expect(system).toContain("[entry_id:entry-timing] How long does funding take?\nMost files fund within $50,000–$150,000 range in about 45 days.");
    expect(system).toContain("[entry_id:entry-fee] What does it cost?");
    expect(system).not.toContain("[B:TURN] RENDERED BRAIN CANDIDATES");
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(result.trace.knowledgeMode).toBe("inline");
    expect(result.trace.retrievalTopThree.map((source) => source.entryId)).toEqual(["entry-timing"]);
    // The model cited an entry the ranking did not surface; in inline mode that is a valid citation.
    expect(result.trace).toMatchObject({ declaredEntryId: "entry-fee", declaredEntryVerified: true });
    expect(result.response.state).toBe("agent");
  });

  it("treats a rendered entry's question as Brain text, not leaked instructions, when the reply repeats it", async () => {
    const question = "Can I use this for personal credit or only for business funding purposes today?";
    const template = "Both are covered in the review.";
    const entry = knowledgeEntry({
      entryId: "entry-personal",
      question,
      responseTemplate: template,
      rewriteHash: rewriteHash(template),
      sourceRef: "notion:personal",
    });
    const deps = dependencies([reply(`${question} ${template}`, "entry-personal")]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeEntries: [entry] }),
    }, { ...deps, retrieve: vi.fn(async () => grounded(candidate("entry-personal", 0.9))) });
    expect(result.trace.screen).toEqual({ verdict: "continue", reason: null });
    expect(result.response.state).toBe("agent");
  });

  it("does not hold on a ranking miss, because the model was shown the whole Brain", async () => {
    const deps = dependencies([reply("Most files fund in a few weeks.", "entry-timing")]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeEntries: [knowledgeEntry()] }),
    }, { ...deps, retrieve: vi.fn(async () => miss(candidate("entry-timing", 0.1))) });
    expect(result.trace.screen.verdict).toBe("continue");
    expect(result.trace.knowledgeMode).toBe("inline");
    expect(result.trace.sources).toEqual([]);
    expect(result.trace.retrievalTopThree.map((source) => source.similarity)).toEqual([0.1]);
  });

  it("grounds inline figures through bindings: a bound price passes, an unbound score fails NUM", async () => {
    const passing = dependencies([reply("The review is $297.", "entry-fee")]);
    const passed = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeEntries: [feeEntry()] }),
    }, { ...passing, retrieve: vi.fn(async () => grounded(candidate("entry-fee", 0.9))) });
    expect(passed.trace.violations).toEqual([]);
    expect(passed.trace.numberAllowlist).toContainEqual({
      kind: "currency", value: 297, sourceType: "brain_entry", sourceId: "entry-fee",
    });
    // 640 appears in the template but no reviewer bound it; the offer's own creditMin is 640 too,
    // so lift that to make the entry the only possible source.
    const bundleWithoutThreshold = bundle({ knowledgeEntries: [feeEntry()] });
    bundleWithoutThreshold.offer = { ...bundleWithoutThreshold.offer, creditMin: null };
    const failing = dependencies([
      reply("A 640 credit score is the usual starting point.", "entry-fee"),
      reply("A 640 credit score is the usual starting point.", "entry-fee"),
    ]);
    const held = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundleWithoutThreshold,
    }, { ...failing, retrieve: vi.fn(async () => grounded(candidate("entry-fee", 0.9))) });
    expect(held.response.reply).toContain(HELD.NUM);
    expect(held.trace.violations.map((violation) => violation.class)).toContain("NUM");
  });

  it("records the mode the turn actually ran in when an inline snapshot no longer fits", async () => {
    const huge = Array.from({ length: 400 }, (_, index) => knowledgeEntry({
      entryId: `entry-${index}`,
      responseTemplate: "x".repeat(120),
      rewriteHash: null,
    }));
    const deps = dependencies([reply("A grounded published answer.", "entry-3")]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeEntries: huge }),
    }, { ...deps, retrieve: vi.fn(async () => grounded(candidate("entry-3", 0.9))) });
    expect(result.trace.knowledgeMode).toBe("retrieved");
    expect(deps.model.generate.mock.calls[0][0][0].content).toContain("[B:TURN] RENDERED BRAIN CANDIDATES");
  });
});

// The knowledge-mode eval's SCOPE false positive: "where can I check what my credit score is?"
// answered from the published FAQ "How to check my credit score?" and blocked by a moderator that
// read the role boundary literally. The verdict model must be told the reply answers a published
// entry, by that entry's question, and must still never see the entry's answer.
describe("runEngineTurn tells the moderator which published entry the reply cites", () => {
  const CHECK_SCORE_TEMPLATE = "You can go to free credit monitoring websites such as Credit Karma or Nerdwallet. Your banking app may show it too.";
  const checkScoreEntry = () => knowledgeEntry({
    entryId: "entry-check-score",
    category: "Credit",
    question: "How to check my credit score?",
    responseTemplate: CHECK_SCORE_TEMPLATE,
    rewriteHash: rewriteHash(CHECK_SCORE_TEMPLATE),
    sourceRef: "notion:check-score",
  });

  it("passes the cited entry's question alongside the boundary and never its answer", async () => {
    const deps = dependencies([reply(
      "Free credit monitoring sites like Credit Karma or Nerdwallet will show it, and your banking app may too.",
      "entry-check-score",
    )]);
    const result = await runEngineTurn({
      ...BASE,
      history: [{ role: "user", content: "where can I check what my credit score is?" }],
      leadMessage: { id: "lead", body: "where can I check what my credit score is?" },
      runtimeBundle: bundle({ knowledgeEntries: [knowledgeEntry(), checkScoreEntry()] }),
    }, { ...deps, retrieve: vi.fn(async () => grounded(candidate("entry-check-score", 0.88))) });

    expect(result.trace.screen.verdict).toBe("continue");
    expect(deps.moderator.moderate).toHaveBeenCalledTimes(1);
    const payload = deps.moderator.moderate.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual([
      "complianceLexicon", "draft", "leadMessage", "linkWhitelist", "numberAllowlist", "roleBoundary",
    ]);
    expect(payload.roleBoundary.startsWith(BASE.roleBoundary)).toBe(true);
    expect(payload.roleBoundary).toContain('"How to check my credit score?"');
    expect(payload.roleBoundary).toContain("entry-check-score");
    expect(payload.roleBoundary).toContain(GROUNDED_REPLY_IN_SCOPE);
    expect(JSON.stringify(payload)).not.toContain("Your banking app may show it too");
    expect(JSON.stringify(payload)).not.toContain(TIMING_TEMPLATE);
    expect(JSON.stringify(payload)).not.toMatch(/tenant_offer|\[B:INLINE\]/);
  });

  it("sends the bare boundary when the reply cites nothing verifiable", async () => {
    const deps = dependencies([reply("A grounded published answer.", "entry-timing")]);
    await runEngineTurn({ ...BASE, runtimeBundle: bundle({ knowledgeEntries: [knowledgeEntry()] }) }, {
      ...deps, retrieve: vi.fn(async () => grounded(candidate("entry-timing", 0.9))),
    });
    expect(deps.moderator.moderate.mock.calls[0][0].roleBoundary).toContain('"How long does funding take?"');
    const uncited = dependencies(["Plain text with no envelope, so nothing is cited."]);
    await runEngineTurn({ ...BASE }, uncited);
    expect(uncited.moderator.moderate.mock.calls[0][0].roleBoundary).toBe(BASE.roleBoundary);
  });
});

// The knowledge-mode eval's JUDGE holds: four inline turns whose reply was drawn from a rendered
// entry but whose declared id did not verify on two attempts. Inline mode renders every entry, so
// grounding is checked against all of them; a reply another rendered entry grounds passes with
// the citation corrected and the correction on the trace, and a reply nothing grounds still holds.
describe("runEngineTurn corrects an unverifiable citation to the rendered entry that grounds the reply", () => {
  const entries = () => [knowledgeEntry(), feeEntry()];

  it("passes on the first attempt with the citation corrected and the correction traced", async () => {
    const deps = dependencies([reply(
      "Yes, there is a readiness review fee of $297, and that is the usual starting point.",
      "invented-entry",
    )]);
    const result = await runEngineTurn({
      ...BASE,
      leadMessage: { id: "lead", body: "do I have to pay?" },
      runtimeBundle: bundle({ knowledgeEntries: entries() }),
    }, { ...deps, retrieve: vi.fn(async () => grounded(candidate("entry-fee", 0.8))) });

    expect(result.trace.screen.verdict).toBe("continue");
    expect(deps.model.generate).toHaveBeenCalledTimes(1);
    expect(result.trace).toMatchObject({
      attempts: 1,
      declaredEntryId: "entry-fee",
      declaredEntryVerified: true,
      citationCorrection: { declaredEntryId: "invented-entry", correctedEntryId: "entry-fee" },
    });
    expect(result.trace.citationCorrection?.evidence).toEqual(expect.any(String));
    expect(result.trace.rejectedDrafts).toEqual([]);
    // The moderator is told about the corrected entry, not the invented id.
    expect(deps.moderator.moderate.mock.calls[0][0].roleBoundary).toContain('"What does it cost?"');
    expect(deps.moderator.moderate.mock.calls[0][0].roleBoundary).not.toContain("invented-entry");
  });

  it("accepts a null citation from a writer that declined to guess, and corrects it the same way", async () => {
    const deps = dependencies([JSON.stringify({
      reply: "Yes, there is a readiness review fee of $297, and that is the usual starting point.",
      citation_entry_id: null,
    })]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeEntries: entries() }),
    }, { ...deps, retrieve: vi.fn(async () => grounded(candidate("entry-fee", 0.8))) });
    expect(result.trace.screen.verdict).toBe("continue");
    expect(result.response.reply).toContain("readiness review fee of $297");
    expect(result.trace).toMatchObject({
      declaredEntryId: "entry-fee",
      declaredEntryVerified: true,
      citationCorrection: { declaredEntryId: null, correctedEntryId: "entry-fee" },
    });
  });

  it("leaves a verified citation alone even when another entry also grounds the reply", async () => {
    const deps = dependencies([reply(
      "Yes, there is a readiness review fee of $297, and that is the usual starting point.",
      "entry-timing",
    )]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeEntries: entries() }),
    }, { ...deps, retrieve: vi.fn(async () => grounded(candidate("entry-fee", 0.8))) });
    expect(result.trace).toMatchObject({
      declaredEntryId: "entry-timing", declaredEntryVerified: true, citationCorrection: null,
    });
  });

  it("still holds with JUDGE after the regeneration when no rendered entry grounds the reply", async () => {
    const deps = dependencies([
      reply("Happy to help with whatever you need today, what are you thinking?", "invented-entry"),
      reply("Of course, tell me more about what you are after.", "still-invented"),
    ]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeEntries: entries() }),
    }, { ...deps, retrieve: vi.fn(async () => grounded(candidate("entry-fee", 0.8))) });

    expect(deps.model.generate).toHaveBeenCalledTimes(2);
    expect(deps.moderator.moderate).not.toHaveBeenCalled();
    expect(result.response).toEqual({ reply: HELD.JUDGE, state: "needs_human", booking: null });
    expect(result.trace).toMatchObject({
      attempts: 2,
      declaredEntryId: "still-invented",
      declaredEntryVerified: false,
      citationCorrection: null,
    });
    expect(result.trace.rejectedDrafts).toHaveLength(2);
  });
});

describe("runEngineTurn retrieved knowledge with no grounded answer", () => {
  it("holds with the SCOPE reply under no_match_threshold and never calls the model", async () => {
    const deps = dependencies(["must not run"]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeMode: "retrieved" }),
    }, { ...deps, retrieve: vi.fn(async () => miss(candidate("weak", 0.12))) });

    expect(deps.model.generate).not.toHaveBeenCalled();
    expect(deps.moderator.moderate).not.toHaveBeenCalled();
    expect(result.response).toEqual({ reply: HELD.SCOPE, state: "needs_human", booking: null });
    expect(result.commands).toContainEqual({ kind: "transition", state: "needs_human", reason: "no_match_threshold" });
    expect(result.commands).toContainEqual({ kind: "send", body: HELD.SCOPE, approvedInput: true });
    expect(result.trace).toMatchObject({
      knowledgeMode: "retrieved",
      screen: { verdict: "held", reason: "no_grounded_answer" },
      ruleFired: NO_GROUNDED_ANSWER_RULE_ID,
      promptHash: null,
      model: null,
      sources: [],
      declaredEntryId: null,
      declaredEntryVerified: false,
    });
    expect(result.trace.retrievalTopThree).toEqual([expect.objectContaining({ entryId: "weak", similarity: 0.12 })]);
  });

  it("passes the snapshot's retrieval floor through to retrieval", async () => {
    const retrieve = vi.fn(async (_input: RetrieveForTurnInput) => grounded(candidate("entry-a", 0.9)));
    await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeMode: "retrieved", retrievalFloor: 0.6 }),
    }, { ...dependencies([reply("A grounded published answer.", "entry-a")]), retrieve });
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ similarityFloor: 0.6 }));
    const withoutFloor = vi.fn(async (_input: RetrieveForTurnInput) => grounded(candidate("entry-a", 0.9)));
    await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeMode: "retrieved" }),
    }, { ...dependencies([reply("A grounded published answer.", "entry-a")]), retrieve: withoutFloor });
    expect(Object.keys(withoutFloor.mock.calls[0][0])).not.toContain("similarityFloor");
  });

  it("still lets a published objection response answer when knowledge missed", async () => {
    const objection = {
      objectionId: "8a000000-0000-4000-8000-000000000101",
      snapshotId: "snapshot-7",
      label: "Too slow",
      response: "Most reviews finish inside two weeks.",
      category: "timing" as const,
      hardGate: false,
      matchedKeywords: ["slow"],
      keywordHits: 1,
    };
    const deps = dependencies([reply("Most reviews finish inside two weeks.", objection.objectionId)]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeMode: "retrieved" }),
    }, {
      ...deps,
      retrieve: vi.fn(async () => ({ ...miss(), objection, objectionCandidates: [objection] })),
    });
    expect(deps.model.generate).toHaveBeenCalledTimes(1);
    expect(result.trace.screen.verdict).toBe("continue");
    expect(result.trace.declaredEntryVerified).toBe(true);
  });

  it("answers a hard-gated objection from the snapshot even when knowledge missed", async () => {
    const gated = {
      objectionId: "8a000000-0000-4000-8000-000000000102",
      snapshotId: "snapshot-7",
      label: "Too expensive",
      response: "Here is exactly what the program includes.",
      category: "pricing" as const,
      hardGate: true,
      matchedKeywords: ["expensive"],
      keywordHits: 1,
    };
    const deps = dependencies(["must not run"]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeMode: "retrieved" }),
    }, {
      ...deps,
      retrieve: vi.fn(async () => ({ ...miss(), objection: gated, objectionCandidates: [gated] })),
    });
    expect(deps.model.generate).not.toHaveBeenCalled();
    expect(result.response.reply).toContain(gated.response);
    expect(result.trace.objection?.hardGate).toBe(true);
  });

  it("admits only bound figures from a retrieved answer", async () => {
    const template = "Rates start near 8% and the review is $297.";
    const bound = {
      ...candidate("entry-fee", 0.9, template),
      numberBindings: [{ kind: "currency" as const, value: 297, binding: "offer_prices" as const }],
    };
    const deps = dependencies([reply("Rates start near 8%.", "entry-fee"), reply("Rates start near 8%.", "entry-fee")]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle({ knowledgeMode: "retrieved" }),
    }, { ...deps, retrieve: vi.fn(async () => grounded(bound)) });
    expect(result.trace.numberAllowlist).toEqual([
      { kind: "score", value: 640, sourceType: "qualification_threshold", sourceId: "credit_min" },
      { kind: "currency", value: 50_000, sourceType: "qualification_threshold", sourceId: "funding_goal_min_cents" },
      { kind: "currency", value: 297, sourceType: "brain_entry", sourceId: "entry-fee" },
    ]);
    expect(result.response.reply).toContain(HELD.NUM);
  });
});
