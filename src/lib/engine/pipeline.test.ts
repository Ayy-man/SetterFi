import { describe, expect, it, vi } from "vitest";

import type { PublishedRuntimeBundle } from "@/lib/brain/contracts";
import type { TurnRetrievalResult } from "@/lib/brain/retrieval";
import type { ModeratorCall } from "@/lib/engine/moderator";
import { runEngineTurn, type EnginePipelineInput } from "@/lib/engine/pipeline";
import type { BrainSnapshot, CoachOffer, EngineTrace, ModeratorClass } from "@/lib/engine/types";
import type { ModelDriver } from "@/lib/integrations/types";

const DISCLOSURE = "You're chatting with an automated assistant for Summit Funding.";
const HELD = Object.fromEntries(
  ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN", "JUDGE", "REVOKE"].map((key) => [key, `Held for ${key}.`]),
) as Record<ModeratorClass, string>;

const BRAIN: BrainSnapshot = {
  version: 1,
  platformFrame: "Never invent claims, numbers, or outcomes.",
  mission: "Qualify a lead for a useful funding call.",
  qualification: "Ask only the server-selected current step.",
  complianceRules: [{ id: "CLAIM-001", phrase: "guarantee" }],
  entries: [{
    id: "trust-entry",
    category: "trust",
    question: "How do I know this is legitimate?",
    answer: "The process starts with an assessment of the lead's actual file.",
    published: true,
  }],
  knowledgeMode: "inline",
};

const OFFER: CoachOffer = {
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
  offerPrices: [{ id: "price", label: "Program", amountCents: 29700 }],
  creditMin: 640,
  fundingGoalMinCents: null,
  bookingHorizonDays: 30,
};

const INBOUND_SAFETY: NonNullable<EnginePipelineInput["inboundSafety"]> = {
  state: {
    tenantId: "tenant",
    conversationId: "conversation",
    status: "agent",
    scopeAttackCount: 0,
    tripwireCount: 0,
    tripwireClasses: [],
  },
  content: {
    approved: true,
    scopeDeflection1: "Approved first scope response.",
    scopeDeflection2: "Approved second scope response.",
    scopeClosing: "Approved scope closing response.",
  },
  signal: { kind: "none" },
};

const BASE: EnginePipelineInput = {
  mode: "production",
  channel: "sms",
  brain: BRAIN,
  offer: OFFER,
  conversation: { state: "agent", currentStep: null, currentStepAsks: 0, disclosurePending: false },
  history: [{ role: "user", content: "Is this legitimate?" }],
  leadMessage: { id: "lead", body: "Is this legitimate?" },
  tagSecret: "test-secret",
  automatedExperienceDisclosure: DISCLOSURE,
  heldReplies: HELD,
  linkWhitelist: ["summit.example"],
  roleBoundary: "credit and funding qualification only",
  modelConfigs: [
    { id: "g", role: "generator", openrouterModel: "anthropic/generator", params: {}, active: true },
    { id: "m", role: "moderator", openrouterModel: "openai/moderator", params: {}, active: true },
  ],
  currentQuestion: null,
  extractionCandidate: null,
  qualificationState: {
    credit: null,
    goal: null,
    timeline: null,
    businessStage: null,
    annualRevenueCents: null,
    outcome: null,
    dqReason: null,
  },
  decision: null,
  booking: null,
  declaredEntryId: "trust-entry",
  inboundSafety: INBOUND_SAFETY,
};

function dependencies(drafts: readonly string[], moderator: "allow" | "block" | "error" = "allow") {
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
      moderate: vi.fn<ModeratorCall>(async () => {
        if (moderator === "error") throw new Error("MODERATOR_DOWN");
        return moderator === "allow"
          ? { verdict: "allow" as const, class: "JUDGE" as const, reason: "safe" }
          : { verdict: "block" as const, class: "JUDGE" as const, reason: "unsafe" };
      }),
    },
  };
}

function expectCompleteTrace(trace: EngineTrace) {
  expect(Object.keys(trace).sort()).toEqual([
    "attempts", "brainContentHash", "brainVersion", "checks", "cost", "declaredEntryId", "declaredEntryVerified",
    "droppedEntryIds", "knowledgeMode", "latencyMs", "model", "moderator", "moderatorClass", "moderatorModelConfigId", "moderatorReason", "moderatorRuleId", "numberAllowlist",
    "objection", "offerContentHash", "offerVersion", "paramsHash", "promptHash", "rejectedDrafts", "retrievalTopThree",
    "ruleFired", "screen", "sources", "usage", "violations",
  ]);
  expect(trace.checks.length).toBeGreaterThanOrEqual(6);
}

function runtimeBundle(version = 7, offerVersion = 9): PublishedRuntimeBundle {
  return {
    brain: {
      id: `snapshot-${version}`,
      version,
      contentHash: `brain-hash-${version}`,
      sourceHash: "source-hash",
      payload: {
        entities: [{ id: "CLAIM-001", type: "compliance_rule", value: { phrase: "guarantee" } }],
      },
      compiledPlatform: "[A] Synthetic published platform rules\n[B] Synthetic published Brain rules",
      platformTokens: 12,
      knowledgeMode: "retrieved",
    },
    offer: {
      id: `offer-${offerVersion}`,
      tenantId: "tenant",
      status: "published",
      version: offerVersion,
      contentHash: `offer-hash-${offerVersion}`,
      programName: "Published synthetic program",
      programDescription: null,
      creditMin: 640,
      fundingGoalMinCents: null,
      fundingGoalMaxCents: null,
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
    qualification: [{
      id: "strong-credit",
      label: "Synthetic published qualification",
      outcome: "BOOK",
      conditions: { minScore: 700 },
    }],
    qualificationApproved: true,
    qualificationSource: "platform",
    renderSources: {
      bookingUrl: null,
      qualificationSummary: "Synthetic published qualification: BOOK",
      qualificationInputs: ["credit score"],
      assetUrlsBySlug: {},
    },
    snapshotId: `snapshot-${version}`,
    brainVersion: version,
    offerVersion,
    contentHash: `brain-hash-${version}`,
  };
}

function retrieved(): TurnRetrievalResult {
  return {
    kind: "grounded",
    included: [
      {
        entryId: "candidate-a",
        category: "trust",
        responseTemplate: "Synthetic source A",
        numberBindings: [],
        rewriteHash: null,
        matchedVariant: null,
        content: "Synthetic source A",
        similarity: 0.91,
        categoryBoost: 0 as const,
        score: 0.91,
        dropped: false as const,
      },
      {
        entryId: "candidate-b",
        category: "trust",
        responseTemplate: "Synthetic source B",
        numberBindings: [],
        rewriteHash: null,
        matchedVariant: null,
        content: "Synthetic source B",
        similarity: 0.85,
        categoryBoost: 0.05 as const,
        score: 0.9,
        dropped: false as const,
      },
    ],
    dropped: [{ entryId: "candidate-dropped", dropped: true as const, reason: "synthetic unresolved placeholder" }],
  };
}

describe("runEngineTurn", () => {
  it("fails production closed on absent safety state before retrieval or model work", async () => {
    const deps = dependencies(["should not run"]);
    const retrieve = vi.fn(async () => retrieved());
    await expect(runEngineTurn({
      ...BASE,
      inboundSafety: undefined,
      runtimeBundle: runtimeBundle(),
    }, { ...deps, retrieve })).rejects.toThrow("INBOUND_SAFETY_STATE_REQUIRED");
    expect(retrieve).not.toHaveBeenCalled();
    expect(deps.model.generate).not.toHaveBeenCalled();
    expect(deps.moderator.moderate).not.toHaveBeenCalled();
  });

  it("persists a scope signal before generation and returns only approved ladder copy", async () => {
    const deps = dependencies(["should not run"]);
    const applyScopeSignal = vi.fn(async () => ({
      persistedCount: 3,
      action: "scope_blocked" as const,
    }));
    const result = await runEngineTurn({
      ...BASE,
      inboundSafety: {
        ...INBOUND_SAFETY,
        signal: { kind: "scope", signalKey: "lead:SCOPE" },
      },
    }, {
      ...deps,
      persistInboundSafety: {
        applyScopeSignal,
        applyTripwireSignal: vi.fn(async () => ({ persistedCount: 1, action: "refused" as const })),
      },
    });
    expect(applyScopeSignal).toHaveBeenCalledOnce();
    expect(deps.model.generate).not.toHaveBeenCalled();
    expect(result.response).toEqual({
      reply: INBOUND_SAFETY.content.scopeClosing,
      state: "scope_blocked",
      booking: null,
    });
    expect(result.commands.at(-1)).toEqual({
      kind: "send",
      body: INBOUND_SAFETY.content.scopeClosing,
      approvedInput: true,
    });
  });

  it("returns copy_unapproved with zero outbound after persisting the scope threshold", async () => {
    const deps = dependencies(["should not run"]);
    const result = await runEngineTurn({
      ...BASE,
      inboundSafety: {
        ...INBOUND_SAFETY,
        content: { ...INBOUND_SAFETY.content, approved: false },
        signal: { kind: "scope", signalKey: "lead:SCOPE" },
      },
    }, {
      ...deps,
      persistInboundSafety: {
        applyScopeSignal: vi.fn(async () => ({ persistedCount: 1, action: "deflect_1" as const })),
        applyTripwireSignal: vi.fn(async () => ({ persistedCount: 1, action: "refused" as const })),
      },
    });
    expect(result.response).toEqual({ reply: "", state: "agent", booking: null });
    expect(result.commands).toEqual([]);
    expect(result.trace.screen).toEqual({ verdict: "held", reason: "copy_unapproved" });
    expect(deps.model.generate).not.toHaveBeenCalled();
  });

  it("does not re-run inbound persistence during checker or moderator regeneration", async () => {
    const persistInboundSafety = {
      applyScopeSignal: vi.fn(async () => ({ persistedCount: 1, action: "deflect_1" as const })),
      applyTripwireSignal: vi.fn(async () => ({ persistedCount: 1, action: "refused" as const })),
    };
    const result = await runEngineTurn(BASE, {
      ...dependencies(["I guarantee approval.", "I guarantee approval."]),
      persistInboundSafety,
    });
    expect(result.trace.attempts).toBe(2);
    expect(persistInboundSafety.applyScopeSignal).not.toHaveBeenCalled();
    expect(persistInboundSafety.applyTripwireSignal).not.toHaveBeenCalled();
  });

  it("returns a trusted BOOK command only after the current step is complete", async () => {
    const booking = { id: "booking", startAt: "2026-08-20T10:00:00Z", timezone: "UTC" };
    const result = await runEngineTurn({ ...BASE, booking }, dependencies(["Your call is booked."]));
    expect(result.response.booking).toEqual(booking);
    expect(result.commands).toContainEqual({ kind: "record_booking_intent", booking });
    expect(result.commands.at(-1)).toEqual({ kind: "send", body: "Your call is booked.", approvedInput: false });
    expectCompleteTrace(result.trace);
  });

  it("stores a typed hard-DQ reason instead of accepting a model-directed state", async () => {
    const result = await runEngineTurn({
      ...BASE,
      decision: { outcome: "HARD_DQ", reason: "credit_below_published_floor" },
    }, dependencies(["A call would not be useful yet."]));
    expect(result.response.state).toBe("closed");
    expect(result.commands).toContainEqual({ kind: "record_hard_dq", reason: "credit_below_published_floor" });
  });

  it("records a stable knowledge citation on the legacy inline arm", async () => {
    const result = await runEngineTurn(BASE, dependencies([BRAIN.entries[0].answer]));
    expect(result.trace.sources[0].entryId).toBe("trust-entry");
    expect(result.trace.declaredEntryVerified).toBe(true);
  });

  it("emits held reply, transition, alert, and audit together on the second violation", async () => {
    const result = await runEngineTurn(BASE, dependencies([
      "I guarantee approval.",
      "I guarantee approval.",
    ]));
    expect(result.commands).toContainEqual({ kind: "send", body: HELD.CLAIM, approvedInput: true });
    expect(result.commands).toContainEqual({ kind: "transition", state: "needs_human", reason: "output_check_failed" });
    expect(result.commands).toContainEqual({ kind: "alert", eventKey: "conversation.needs_human" });
    expect(result.commands).toContainEqual({ kind: "audit", actionKey: "conversation.escalated" });
    expect(result.trace.rejectedDrafts).toHaveLength(2);
    expect(result.trace.attempts).toBe(2);
    expectCompleteTrace(result.trace);
  });

  it("uses the same single regeneration when the moderator blocks", async () => {
    const result = await runEngineTurn(BASE, dependencies(["A safe draft.", "A second safe draft."], "block"));
    expect(result.response.state).toBe("needs_human");
    expect(result.trace.attempts).toBe(2);
    expect(result.trace.moderator).toBe("blocked");
    expect(result.trace).toMatchObject({
      moderatorClass: "JUDGE",
      moderatorRuleId: null,
      moderatorModelConfigId: "m",
    });
    expect(result.trace.rejectedDrafts).toEqual(["A safe draft.", "A second safe draft."]);
    expectCompleteTrace(result.trace);
  });

  it("holds and records the named counter when production moderation is unavailable", async () => {
    const result = await runEngineTurn(BASE, dependencies(["A safe draft."], "error"));
    expect(result.commands).toContainEqual({
      kind: "increment_moderator_unavailable",
      counter: "model_configs.moderator_unavailable_count",
      by: 1,
    });
    expect(result.commands).toContainEqual({ kind: "send", body: HELD.JUDGE, approvedInput: true });
    expect(result.commands).toContainEqual({
      kind: "transition", state: "needs_human", reason: "output_check_failed",
    });
    expect(result.response).toEqual({ reply: HELD.JUDGE, state: "needs_human", booking: null });
    expect(result.trace).toMatchObject({
      moderator: "unavailable",
      moderatorReason: "MODERATOR_DOWN",
      moderatorClass: null,
      moderatorRuleId: null,
      moderatorModelConfigId: "m",
    });
    expectCompleteTrace(result.trace);
  });

  it("refuses an unavailable eval instead of converting it into passing evidence", async () => {
    const result = await runEngineTurn({ ...BASE, mode: "eval" }, dependencies(["A safe draft."], "error"));
    expect(result.commands).toContainEqual({ kind: "send", body: HELD.JUDGE, approvedInput: true });
    expect(result.commands).toContainEqual({
      kind: "transition", state: "needs_human", reason: "output_check_failed",
    });
    expect(result.trace.screen).toEqual({ verdict: "held", reason: "output_check_failed" });
    expectCompleteTrace(result.trace);
  });

  it("rejects skip-ahead extraction and booking while the current question remains", async () => {
    const result = await runEngineTurn({
      ...BASE,
      conversation: { ...BASE.conversation, currentStep: "credit", currentStepAsks: 0 },
      currentQuestion: { id: "credit", field: "credit", type: "credit_range" },
      extractionCandidate: { field: "goal", value: "$50K–100K" },
      booking: { id: "booking", startAt: "2026-08-20T10:00:00Z", timezone: "UTC" },
    }, dependencies(["What credit range are you in?"]));
    expect(result.commands).toContainEqual({ kind: "increment_step_asks", stepId: "credit", nextAskCount: 1 });
    expect(result.commands.some((command) => command.kind === "record_booking_intent")).toBe(false);
    expect(result.response.booking).toBeNull();
  });

  it("persists a valid value before advancing and advances unset only on the third miss", async () => {
    const question = { id: "credit", field: "credit", type: "credit_range" } as const;
    const valid = await runEngineTurn({
      ...BASE,
      conversation: { ...BASE.conversation, currentStep: "credit", currentStepAsks: 1 },
      currentQuestion: question,
      extractionCandidate: { field: "credit", value: "680–700" },
    }, dependencies(["Thanks, what is your funding goal?"]));
    expect(valid.commands.slice(0, 2)).toEqual([
      { kind: "persist_qualification", stepId: "credit", value: { field: "credit", value: "680–700" } },
      { kind: "advance_step", stepId: "credit", valuePersisted: true, nextAskCount: 0 },
    ]);
    const thirdMiss = await runEngineTurn({
      ...BASE,
      conversation: { ...BASE.conversation, currentStep: "credit", currentStepAsks: 2 },
      currentQuestion: question,
      extractionCandidate: null,
    }, dependencies(["Let's move to the next question."]));
    expect(thirdMiss.commands[0]).toEqual({
      kind: "advance_step", stepId: "credit", valuePersisted: false, nextAskCount: 0,
    });
  });

  it.each(["opening thread", "post-release handback"])(
    "prepends and consumes disclosure once for an %s",
    async () => {
      const first = await runEngineTurn({
        ...BASE,
        conversation: { ...BASE.conversation, disclosurePending: true },
      }, dependencies(["How can I help?"]));
      expect(first.response.reply).toBe(`${DISCLOSURE}\n\nHow can I help?`);
      expect(first.commands).toContainEqual({
        kind: "persist_agent_turn",
        body: `${DISCLOSURE}\n\nHow can I help?`,
        disclosureConsumed: true,
      });
      const next = await runEngineTurn(BASE, dependencies(["What is your funding goal?"]));
      expect(next.response.reply).not.toContain(DISCLOSURE);
      expect(next.commands).toContainEqual({
        kind: "persist_agent_turn", body: "What is your funding goal?", disclosureConsumed: false,
      });
    },
  );

  it("gates held conversations before prompt or model work", async () => {
    const deps = dependencies(["should not run"]);
    const result = await runEngineTurn({
      ...BASE,
      conversation: { ...BASE.conversation, state: "human" },
    }, deps);
    expect(deps.model.generate).not.toHaveBeenCalled();
    expect(result.commands).toEqual([]);
    expect(result.trace.screen).toEqual({ verdict: "held", reason: "conversation_human" });
  });

  it("retrieves before generation, uses only exact published candidates, and stores the verified receipt", async () => {
    const events: string[] = [];
    const bundle = runtimeBundle();
    const retrieve = vi.fn(async () => {
      events.push("retrieve");
      return retrieved();
    });
    const deps = dependencies([JSON.stringify({
      reply: "A synthetic grounded reply.",
      citation_entry_id: "candidate-b",
    })]);
    deps.model.generate.mockImplementationOnce(async (messages) => {
      events.push("model");
      const system = messages[0].content;
      expect(system).toContain("[entry_id:candidate-a] Synthetic source A");
      expect(system).toContain("[entry_id:candidate-b] Synthetic source B");
      expect(system).not.toContain("candidate-dropped");
      expect(system).not.toContain(BRAIN.entries[0].answer);
      return {
        draft: JSON.stringify({ reply: "A synthetic grounded reply.", citation_entry_id: "candidate-b" }),
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        provider: { name: "mock", generationId: "generation-p2", latencyMs: 12, cost: 0 },
      };
    });

    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: bundle,
      brain: { ...BRAIN, version: 999 },
      offer: { ...OFFER, version: 999 },
      currentQuestion: { id: "credit", field: "credit", type: "credit_range" },
      extractionCandidate: { field: "credit", value: "700+" },
    }, { ...deps, retrieve });

    expect(events).toEqual(["retrieve", "model"]);
    expect(retrieve).toHaveBeenCalledWith({
      snapshotId: "snapshot-7",
      inboundMessage: BASE.leadMessage.body,
      categoryHint: null,
      offer: bundle.offer,
      renderSources: bundle.renderSources,
    });
    expect(Object.keys(result.response).sort()).toEqual(["booking", "reply", "state"]);
    expect(result.trace).toMatchObject({
      brainVersion: 7,
      offerVersion: 9,
      brainContentHash: "brain-hash-7",
      offerContentHash: "offer-hash-9",
      declaredEntryId: "candidate-b",
      declaredEntryVerified: true,
      droppedEntryIds: ["candidate-dropped"],
    });
    expect(result.trace.sources.map((source) => source.entryId)).toEqual(["candidate-a", "candidate-b"]);
    expect(result.trace.checks).toHaveLength(6);
  });

  it("advances runtime qualification from persisted facts using only a validated current answer", async () => {
    const bundle = runtimeBundle();
    bundle.qualification = [
      ...bundle.qualification,
      {
        id: "revenue-qualified",
        label: "640–680 with annual revenue",
        outcome: "BOOK",
        conditions: { minScore: 640, maxScore: 680, minAnnualRevenue: 50_000 },
      },
    ];
    const result = await runEngineTurn({
      ...BASE,
      leadMessage: { id: "lead-credit", body: "650" },
      history: [{ role: "user", content: "650" }],
      runtimeBundle: bundle,
      conversation: { ...BASE.conversation, currentStep: "qualification:credit", currentStepAsks: 1 },
    }, {
      ...dependencies([JSON.stringify({ reply: "What is your annual revenue?", citation_entry_id: "candidate-a" })]),
      retrieve: vi.fn(async () => retrieved()),
    });
    expect(result.commands.slice(0, 2)).toEqual([
      {
        kind: "persist_qualification",
        stepId: "qualification:credit",
        value: { field: "credit", value: "640–680" },
      },
      {
        kind: "advance_step",
        stepId: "qualification:credit",
        valuePersisted: true,
        nextAskCount: 0,
        nextStepId: "qualification:annualRevenue",
      },
    ]);
    expect(result.commands.some((command) => command.kind === "record_qualification_outcome"))
      .toBe(false);
  });

  it("closes runtime qualification on a published hard-DQ rule after validating the answer", async () => {
    const bundle = runtimeBundle();
    bundle.qualification = [
      ...bundle.qualification,
      { id: "low-credit", label: "Below 600", outcome: "HARD_DQ", conditions: { maxScore: 599 } },
    ];
    const result = await runEngineTurn({
      ...BASE,
      leadMessage: { id: "lead-credit", body: "580" },
      history: [{ role: "user", content: "580" }],
      runtimeBundle: bundle,
      conversation: { ...BASE.conversation, currentStep: "qualification:credit", currentStepAsks: 0 },
    }, {
      ...dependencies([JSON.stringify({ reply: "A call would not be useful yet.", citation_entry_id: "candidate-a" })]),
      retrieve: vi.fn(async () => retrieved()),
    });
    expect(result.response.state).toBe("closed");
    expect(result.commands).toContainEqual({
      kind: "record_hard_dq",
      reason: "published_qualification_rule:low-credit",
    });
  });

  it("hands a published BOOK outcome to composition without inventing an appointment", async () => {
    const result = await runEngineTurn({
      ...BASE,
      leadMessage: { id: "lead-credit", body: "720" },
      history: [{ role: "user", content: "720" }],
      runtimeBundle: runtimeBundle(),
      conversation: { ...BASE.conversation, currentStep: "qualification:credit", currentStepAsks: 0 },
    }, {
      ...dependencies([JSON.stringify({ reply: "Let’s find a time.", citation_entry_id: "candidate-a" })]),
      retrieve: vi.fn(async () => retrieved()),
    });
    expect(result.response).toMatchObject({ state: "agent", booking: null });
    expect(result.commands).toContainEqual({
      kind: "record_qualification_outcome",
      outcome: "BOOK",
      ruleId: "strong-credit",
    });
    expect(result.commands.some((command) => command.kind === "record_booking_intent")).toBe(false);
  });

  it("accepts only a composition-validated runtime booking and closes the confirmed turn", async () => {
    const booking = { id: "appointment-1", startAt: "2026-08-30T12:00:00.000Z", timezone: "UTC" };
    const deps = dependencies(["model must not run after the appointment exists"]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: runtimeBundle(),
      qualificationState: { ...BASE.qualificationState!, outcome: "BOOK" },
      bookingSelection: { kind: "booked", booking },
    }, {
      ...deps,
      retrieve: vi.fn(async () => retrieved()),
    });
    expect(result.response).toMatchObject({ state: "closed", booking });
    expect(result.response.reply).toContain("2026-08-30T12:00:00.000Z (UTC)");
    expect(result.commands).toContainEqual({ kind: "record_booking_intent", booking });
    expect(result.commands).toContainEqual(expect.objectContaining({ kind: "send", approvedInput: true }));
    expect(deps.model.generate).not.toHaveBeenCalled();
  });

  it("fails an ambiguous runtime slot selection closed to needs-human without model work", async () => {
    const deps = dependencies(["should not run"]);
    const result = await runEngineTurn({
      ...BASE,
      runtimeBundle: runtimeBundle(),
      qualificationState: { ...BASE.qualificationState!, outcome: "BOOK" },
      bookingSelection: { kind: "invalid" },
    }, { ...deps, retrieve: vi.fn(async () => retrieved()) });
    expect(deps.model.generate).not.toHaveBeenCalled();
    expect(result.response.state).toBe("needs_human");
    expect(result.commands).toContainEqual({
      kind: "transition",
      state: "needs_human",
      reason: "output_check_failed",
    });
  });

  it("uses the single regeneration then holds when both declarations miss the exact prompt set", async () => {
    const deps = dependencies([
      JSON.stringify({ reply: "A synthetic first reply.", citation_entry_id: "invented" }),
      JSON.stringify({ reply: "A synthetic second reply.", citation_entry_id: "candidate-dropped" }),
    ]);
    const result = await runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
      ...deps,
      retrieve: vi.fn(async () => retrieved()),
    });
    expect(result.response).toEqual({ reply: HELD.JUDGE, state: "needs_human", booking: null });
    expect(result.trace).toMatchObject({
      attempts: 2,
      declaredEntryId: "candidate-dropped",
      declaredEntryVerified: false,
      droppedEntryIds: ["candidate-dropped"],
    });
    expect(result.trace.rejectedDrafts).toEqual([
      "A synthetic first reply.",
      "A synthetic second reply.",
    ]);
  });

  it("fails retrieval before generator or moderator work", async () => {
    const deps = dependencies(["should not run"]);
    await expect(runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
      ...deps,
      retrieve: vi.fn(async () => { throw new Error("BRAIN_SNAPSHOT_STALE"); }),
    })).rejects.toThrow("BRAIN_SNAPSHOT_STALE");
    expect(deps.model.generate).not.toHaveBeenCalled();
    expect(deps.moderator.moderate).not.toHaveBeenCalled();
  });

  // Phase 10: the engine carries objection identity and nothing else. 10-02 changes what is
  // recorded about a turn, never what the turn says — the reply, the prompt and the citation path
  // are all untouched, and the deterministic held path for a hard gate is 10-03's deliverable.
  const OBJECTION_ID = "8a000000-0000-4000-8000-000000000101";

  const OBJECTION_ID_SECOND = "8a000000-0000-4000-8000-000000000102";
  const GATED_RESPONSE = "Here is exactly what the program costs.";
  const SECOND_RESPONSE = "We can hold a slot and start whenever you are ready.";

  function objectionCandidate({
    objectionId = OBJECTION_ID,
    hardGate = false,
    response = GATED_RESPONSE,
    label = "Too expensive",
  }: {
    objectionId?: string;
    hardGate?: boolean;
    response?: string;
    label?: string;
  } = {}) {
    return {
      objectionId,
      snapshotId: "snapshot-7",
      label,
      response,
      category: "pricing" as const,
      hardGate,
      matchedKeywords: ["budget", "cost"],
      keywordHits: 2,
    };
  }

  // `retrieveForTurn` sets `objection` to `objectionCandidates[0]`, so the fixture does too — a
  // matched objection that is absent from its own candidate list is not a state the runtime has.
  function retrievedWithObjections(candidates: readonly ReturnType<typeof objectionCandidate>[]) {
    return {
      ...retrieved(),
      objection: candidates[0] ?? null,
      objectionCandidates: candidates,
    };
  }

  function retrievedWithObjection(hardGate = false, response = GATED_RESPONSE) {
    return retrievedWithObjections([objectionCandidate({ hardGate, response })]);
  }

  it("carries the matched objection as identity only and leaks it into no knowledge field",
    async () => {
      const reply = JSON.stringify({ reply: "A synthetic reply.", citation_entry_id: "candidate-a" });
      const withObjection = await runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
        ...dependencies([reply]),
        retrieve: vi.fn(async () => retrievedWithObjection()),
      });
      expect(withObjection.trace.objection).toEqual({
        snapshotId: "snapshot-7",
        objectionId: OBJECTION_ID,
        hardGate: false,
      });

      // The objection uuid must not be reachable as a knowledge entry id anywhere downstream.
      expect(withObjection.trace.sources.map((source) => source.entryId)).not.toContain(OBJECTION_ID);
      expect(withObjection.trace.retrievalTopThree.map((source) => source.entryId))
        .not.toContain(OBJECTION_ID);
      expect(withObjection.trace.declaredEntryId).not.toBe(OBJECTION_ID);
      expect(withObjection.trace.droppedEntryIds).not.toContain(OBJECTION_ID);
      expect(JSON.stringify(withObjection.trace.numberAllowlist)).not.toContain(OBJECTION_ID);
      // Nor may the objection's response text arrive as if it were a retrieved knowledge answer.
      expect(JSON.stringify(withObjection.trace.sources))
        .not.toContain("Here is exactly what the program costs");

      const withoutObjection = await runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
        ...dependencies([reply]),
        retrieve: vi.fn(async () => retrieved()),
      });
      expect(withObjection.response).toEqual(withoutObjection.response);
      expect(withObjection.commands).toEqual(withoutObjection.commands);
    });

  it("leaves the objection null with no runtime bundle and with an unmatched retrieval", async () => {
    const noBundle = await runEngineTurn(BASE, dependencies(["A safe draft."]));
    expect(noBundle.trace.objection).toBeNull();

    const unmatched = await runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
      ...dependencies([JSON.stringify({ reply: "A synthetic reply.", citation_entry_id: "candidate-a" })]),
      retrieve: vi.fn(async () => ({ ...retrieved(), objection: null, objectionCandidates: [] })),
    });
    expect(unmatched.trace.objection).toBeNull();
  });

  // Phase 10-03: the hard gate stops being decorative. A matched gated objection answers from the
  // published snapshot, the model is never asked, and the same output floor and moderator still
  // stand over the admin-approved text.
  const LONG_GATED = "We walk through your actual file on the first call and map out the next steps "
    + "with you. Nothing is promised before we look at it, and you leave with a written plan you "
    + "can act on.";
  const LONG_GATED_FIRST_SENTENCE =
    "We walk through your actual file on the first call and map out the next steps with you.";

  async function gatedTurn(
    deps: ReturnType<typeof dependencies>,
    response = GATED_RESPONSE,
  ) {
    return runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
      ...deps,
      retrieve: vi.fn(async () => retrievedWithObjection(true, response)),
    });
  }

  it("sends the published hard-gate response verbatim and never asks the model", async () => {
    const deps = dependencies(["should not run"]);
    const result = await gatedTurn(deps);

    expect(deps.model.generate).toHaveBeenCalledTimes(0);
    expect(result.response).toEqual({ reply: GATED_RESPONSE, state: "agent", booking: null });
    const sendIndex = result.commands.findIndex((command) => command.kind === "send");
    expect(result.commands[sendIndex]).toEqual({
      kind: "send", body: GATED_RESPONSE, approvedInput: true,
    });
    expect(result.commands[sendIndex - 1]).toEqual({
      kind: "persist_agent_turn", body: GATED_RESPONSE, disclosureConsumed: false,
    });
  });

  it("runs the same six output checks and the moderator over the published response", async () => {
    const deps = dependencies(["should not run"]);
    const result = await gatedTurn(deps);

    expect(result.trace.checks.length).toBeGreaterThanOrEqual(6);
    expect(result.trace.checks.map((check) => check.class))
      .toEqual(expect.arrayContaining(["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN"]));
    expect(deps.moderator.moderate).toHaveBeenCalledTimes(1);
    expect(deps.moderator.moderate).toHaveBeenCalledWith(
      expect.objectContaining({ draft: GATED_RESPONSE }),
    );
  });

  it("holds a published hard-gate response when moderation is unavailable", async () => {
    const deps = dependencies(["should not run"], "error");
    const result = await gatedTurn(deps);

    expect(result.response).toEqual({ reply: HELD.JUDGE, state: "needs_human", booking: null });
    expect(result.commands).toContainEqual({
      kind: "transition", state: "needs_human", reason: "output_check_failed",
    });
    expect(result.commands).toContainEqual({
      kind: "increment_moderator_unavailable",
      counter: "model_configs.moderator_unavailable_count",
      by: 1,
    });
    expect(deps.model.generate).not.toHaveBeenCalled();
  });

  it("holds a hard-gate response carrying a number no grounded source can trace", async () => {
    const deps = dependencies(["should not run"]);
    const ungrounded = "The program is $4,995 today.";
    const result = await gatedTurn(deps, ungrounded);

    expect(result.response).toEqual({ reply: HELD.NUM, state: "needs_human", booking: null });
    expect(result.commands).toContainEqual({
      kind: "transition", state: "needs_human", reason: "output_check_failed",
    });
    expect(result.commands).toContainEqual({ kind: "alert", eventKey: "conversation.needs_human" });
    expect(result.commands).toContainEqual({ kind: "audit", actionKey: "conversation.escalated" });
    expect(result.trace.ruleFired).toBe("NUM-001");
    expect(result.trace.rejectedDrafts).toContain(ungrounded);
    // The mechanism is the omission: the published response is neither a number source nor an echo
    // exemption, so its own numbers cannot vouch for themselves.
    expect(JSON.stringify(result.trace.numberAllowlist)).not.toContain("4995");
    expect(deps.model.generate).not.toHaveBeenCalled();
  });

  it("escalates a gated compliance failure exactly as the model path does, without regenerating",
    async () => {
      const deps = dependencies(["should not run"]);
      const gated = await gatedTurn(deps, "I guarantee approval.");
      expect(gated.trace.attempts).toBe(0);
      expect(deps.model.generate).not.toHaveBeenCalled();

      const composed = await runEngineTurn(BASE, dependencies([
        "I guarantee approval.",
        "I guarantee approval.",
      ]));
      expect(gated.response).toEqual(composed.response);
      expect(gated.commands.filter((command) => command.kind !== "increment_step_asks"))
        .toEqual(composed.commands);
    });

  it("records null model identity, zero attempts, and no citation on a gated turn", async () => {
    const result = await gatedTurn(dependencies(["should not run"]));

    expect(result.trace.objection).toEqual({
      snapshotId: "snapshot-7", objectionId: OBJECTION_ID, hardGate: true,
    });
    expect(result.trace.model).toBeNull();
    expect(result.trace.paramsHash).toBeNull();
    expect(result.trace.usage).toBeNull();
    expect(result.trace.cost).toBeNull();
    expect(result.trace.latencyMs).toBeNull();
    expect(result.trace.attempts).toBe(0);
    expect(result.trace.declaredEntryId).toBeNull();
    expect(result.trace.declaredEntryVerified).toBe(false);
    expect(typeof result.trace.promptHash).toBe("string");
    expect(result.trace.screen).toEqual({ verdict: "continue", reason: null });
    expectCompleteTrace(result.trace);
  });

  it("still asks the model for a non-hard match, an unmatched turn, and a legacy turn", async () => {
    const declared = JSON.stringify({
      reply: "A synthetic reply.", citation_entry_id: "candidate-a",
    });

    const nonHard = dependencies([declared]);
    await runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
      ...nonHard, retrieve: vi.fn(async () => retrievedWithObjection(false)),
    });
    expect(nonHard.model.generate).toHaveBeenCalled();

    const unmatched = dependencies([declared]);
    await runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
      ...unmatched, retrieve: vi.fn(async () => retrieved()),
    });
    expect(unmatched.model.generate).toHaveBeenCalled();

    const legacy = dependencies(["A safe draft."]);
    await runEngineTurn(BASE, legacy);
    expect(legacy.model.generate).toHaveBeenCalled();
  });

  it("truncates a LEN-only gated response at a sentence boundary and escalates anything else",
    async () => {
      const deps = dependencies(["should not run"]);
      const truncated = await gatedTurn(deps, LONG_GATED);
      expect(truncated.response).toEqual({
        reply: LONG_GATED_FIRST_SENTENCE, state: "agent", booking: null,
      });
      expect(truncated.commands).toContainEqual({
        kind: "send", body: LONG_GATED_FIRST_SENTENCE, approvedInput: true,
      });
      expect(truncated.trace.checks.some((check) => check.class === "LEN" && !check.passed))
        .toBe(true);
      expect(deps.moderator.moderate).toHaveBeenCalledWith(
        expect.objectContaining({ draft: LONG_GATED_FIRST_SENTENCE }),
      );

      const withNumber = `The whole engagement is $4,995 and ${LONG_GATED}`;
      const held = await gatedTurn(dependencies(["should not run"]), withNumber);
      expect(held.response.reply).toBe(HELD.NUM);
      expect(held.commands.some((command) =>
        command.kind === "send" && command.body !== HELD.NUM)).toBe(false);
    });

  // An essay in an SMS is past the hard cap. Its first sentence is not the reply the lead was
  // owed, so neither the generator loop nor the gated path may truncate it into one.
  const ESSAY = "We look at your file first, then we map the next steps together. ".repeat(8).trim();

  it("truncates a soft-cap draft on the first attempt without a second generator call", async () => {
    const long = "We look at your file first, then we map the next steps together. ".repeat(3).trim();
    const deps = dependencies([long, "should not run"]);
    const result = await runEngineTurn(BASE, deps);

    expect(deps.model.generate).toHaveBeenCalledTimes(1);
    // Two of the three sentences fit the 160-character SMS soft cap; the third is dropped.
    expect(result.response.reply).toBe(
      "We look at your file first, then we map the next steps together. "
      + "We look at your file first, then we map the next steps together.",
    );
    expect(result.trace.ruleFired).toBe("LEN-001");
    expect(result.trace.screen.verdict).toBe("continue");
    expect(result.trace.checks.filter((check) => check.class === "LEN" && !check.passed)).toHaveLength(1);
  });

  it("holds an essay from the generator with class LEN instead of truncating it", async () => {
    const deps = dependencies([ESSAY, ESSAY]);
    const result = await runEngineTurn(BASE, deps);

    expect(deps.model.generate).toHaveBeenCalledTimes(2);
    expect(result.response).toEqual({ reply: HELD.LEN, state: "needs_human", booking: null });
    expect(result.commands.filter((command) => command.kind === "send"))
      .toEqual([{ kind: "send", body: HELD.LEN, approvedInput: true }]);
    expect(result.commands).toContainEqual({
      kind: "transition", state: "needs_human", reason: "output_check_failed",
    });
    expect(deps.moderator.moderate).not.toHaveBeenCalled();
    expect(result.trace.screen).toEqual({ verdict: "held", reason: "output_check_failed" });
    expect(result.trace.ruleFired).toBe("LEN-002");
    expect(result.trace.moderator).toBe("not_run");
    expect(result.trace.rejectedDrafts).toEqual([ESSAY, ESSAY]);
    expect(result.trace.violations).toContainEqual({
      class: "LEN", ruleId: "LEN-002", evidence: `sms reply length ${ESSAY.length} exceeds hard cap 320`,
    });
    expect(result.trace.checks.filter((check) => check.class === "LEN" && !check.passed)).toHaveLength(2);
    expectCompleteTrace(result.trace);
  });

  it("holds an essay-length published hard-gate response with class LEN", async () => {
    const deps = dependencies(["should not run"]);
    const result = await gatedTurn(deps, ESSAY);

    expect(deps.model.generate).not.toHaveBeenCalled();
    expect(deps.moderator.moderate).not.toHaveBeenCalled();
    expect(result.response.reply).toBe(HELD.LEN);
    expect(result.commands.some((command) => command.kind === "send" && command.body !== HELD.LEN))
      .toBe(false);
    expect(result.trace.screen.verdict).toBe("held");
    expect(result.trace.ruleFired).toBe("LEN-002");
    expect(result.trace.rejectedDrafts).toEqual([ESSAY]);
    expect(result.trace.checks.some((check) =>
      check.class === "LEN" && !check.passed && check.evidence[0]?.includes("hard cap"))).toBe(true);
  });

  it("verifies a declared objection id the same way it verifies a declared entry id", async () => {
    const deps = dependencies([JSON.stringify({
      reply: "A synthetic grounded reply.", citation_entry_id: OBJECTION_ID,
    })]);
    const result = await runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
      ...deps, retrieve: vi.fn(async () => retrievedWithObjection(false)),
    });

    expect(result.trace.declaredEntryId).toBe(OBJECTION_ID);
    expect(result.trace.declaredEntryVerified).toBe(true);
    expect(deps.model.generate).toHaveBeenCalledTimes(1);
    expect(result.commands).toContainEqual({
      kind: "send", body: "A synthetic grounded reply.", approvedInput: false,
    });
  });

  it("records the objection the model actually cited, not the top-ranked one", async () => {
    const deps = dependencies([JSON.stringify({
      reply: "A synthetic grounded reply.", citation_entry_id: OBJECTION_ID_SECOND,
    })]);
    const result = await runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
      ...deps,
      retrieve: vi.fn(async () => retrievedWithObjections([
        objectionCandidate(),
        objectionCandidate({
          objectionId: OBJECTION_ID_SECOND, response: SECOND_RESPONSE, label: "Not right now",
        }),
      ])),
    });

    expect(result.trace.objection).toEqual({
      snapshotId: "snapshot-7", objectionId: OBJECTION_ID_SECOND, hardGate: false,
    });
  });

  it("fails an objection id that is in no candidate set exactly as an unknown entry id does",
    async () => {
      const invented = "8a000000-0000-4000-8000-0000000009ff";
      const deps = dependencies([
        JSON.stringify({ reply: "A synthetic first reply.", citation_entry_id: invented }),
        JSON.stringify({ reply: "A synthetic second reply.", citation_entry_id: invented }),
      ]);
      const result = await runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
        ...deps, retrieve: vi.fn(async () => retrievedWithObjection(false)),
      });

      expect(deps.model.generate).toHaveBeenCalledTimes(2);
      expect(result.trace.declaredEntryVerified).toBe(false);
      expect(result.response).toEqual({ reply: HELD.JUDGE, state: "needs_human", booking: null });
    });

  it("never shows the model a hard-gated response, even beside a non-hard one", async () => {
    const deps = dependencies([JSON.stringify({
      reply: "A synthetic grounded reply.", citation_entry_id: OBJECTION_ID_SECOND,
    })]);
    await runEngineTurn({ ...BASE, runtimeBundle: runtimeBundle() }, {
      ...deps,
      retrieve: vi.fn(async () => retrievedWithObjections([
        objectionCandidate({
          objectionId: OBJECTION_ID_SECOND, response: SECOND_RESPONSE, label: "Not right now",
        }),
        objectionCandidate({ hardGate: true }),
      ])),
    });

    const system = deps.model.generate.mock.calls[0][0][0].content;
    expect(system).toContain(`[objection_id:${OBJECTION_ID_SECOND}]`);
    expect(system).toContain(SECOND_RESPONSE);
    expect(system).not.toContain(GATED_RESPONSE);
    expect(system).not.toContain(OBJECTION_ID);
  });
});
