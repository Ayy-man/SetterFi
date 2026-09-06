import { describe, expect, it, vi } from "vitest";

import type { PublishedRuntimeBundle } from "@/lib/brain/contracts";
import type { EngineTurnResult, ModeratorClass } from "@/lib/engine/types";
import type { ModelDriver, ModeratorDriver } from "@/lib/integrations/types";
import type { ApprovedPlatformAgentContent } from "@/lib/webhooks/live-preview";

import type { RevisionRuntime } from "./brain-revision-runtime";
import {
  heldClassOf,
  knowledgeQuestions,
  runBrainTestTurn,
  type BrainTestTurnDependencies,
} from "./brain-test-turn";

const HELD = Object.fromEntries(
  ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN", "JUDGE", "REVOKE"].map((key) => [key, `Held for ${key}.`]),
) as Record<ModeratorClass, string>;

const CONTENT: ApprovedPlatformAgentContent = {
  approved: true,
  automatedExperienceDisclosure: "You're chatting with an automated assistant.",
  heldReplies: HELD,
  platformFrame: "frame",
  mission: "mission",
  qualification: "qualification",
  roleBoundary: "credit and funding qualification only",
};

function bundle(): PublishedRuntimeBundle {
  return {
    brain: {
      id: "snapshot-7",
      version: 7,
      contentHash: "a".repeat(64),
      sourceHash: "b".repeat(64),
      payload: {
        entities: [
          { id: "CLAIM-001", type: "compliance_rule", value: { phrase: "guarantee" } },
          { id: "candidate-a", type: "knowledge_entry", value: { inboundMessage: "Is this legitimate?", responseTemplate: "Synthetic source A" } },
        ],
      },
      compiledPlatform: "[A] PLATFORM FRAME\nSynthetic platform rules\n[B] THE BRAIN\nSynthetic Brain rules",
      platformTokens: 12,
      knowledgeMode: "retrieved",
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
    qualification: [{ id: "strong-credit", label: "Strong credit", outcome: "BOOK", conditions: { minScore: 700 } }],
    qualificationApproved: true,
    qualificationSource: "platform",
    renderSources: {
      bookingUrl: "https://book.example/summit",
      qualificationSummary: "Strong credit: BOOK",
      qualificationInputs: ["credit score"],
      assetUrlsBySlug: {},
    },
    snapshotId: "snapshot-7",
    brainVersion: 7,
    offerVersion: 9,
    contentHash: "a".repeat(64),
  };
}

function retrieved() {
  return {
    kind: "grounded" as const,
    included: [{
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
    }],
    dropped: [],
  };
}

function drivers(drafts: readonly string[], moderator: "allow" | "block" = "allow") {
  let index = 0;
  const model: ModelDriver = {
    generate: vi.fn(async () => ({
      draft: drafts[Math.min(index++, drafts.length - 1)],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      provider: { name: "mock", generationId: `generation-${index}`, latencyMs: 12, cost: 0 },
    })),
  };
  const moderatorDriver: ModeratorDriver = {
    moderate: vi.fn(async () => moderator === "allow"
      ? { verdict: "allow" as const, class: "JUDGE" as const, reason: "safe" }
      : { verdict: "block" as const, class: "CLAIM" as const, rule_id: "CLAIM-001", reason: "unsafe" }),
  };
  return { model, moderator: moderatorDriver };
}

function revision(kind: "draft" | "live" = "live"): RevisionRuntime {
  return {
    revision: kind,
    bundle: bundle(),
    retrievalMode: kind === "live" ? "published_snapshot" : "draft_in_process",
    retrieve: kind === "live" ? null : async () => retrieved(),
    draftId: kind === "live" ? null : "draft-1",
  };
}

function dependencies(overrides: Partial<BrainTestTurnDependencies> = {}, selected = drivers([
  JSON.stringify({ reply: "Yes, it is a real program.", citation_entry_id: "candidate-a" }),
])): BrainTestTurnDependencies {
  let tick = 0;
  return {
    loadRevision: vi.fn(async () => revision()),
    loadContent: vi.fn(async () => CONTENT),
    loadModelConfigs: async () => [
      { id: "g", role: "generator", openrouterModel: "anthropic/generator", params: {}, active: true },
      { id: "m", role: "moderator", openrouterModel: "openai/moderator", params: {}, active: true },
    ],
    selectDrivers: vi.fn(async () => selected),
    tagSecret: () => "test-secret",
    now: () => (tick += 7),
    ...overrides,
  };
}

const input = {
  coachTenantId: "tenant",
  revision: "live" as const,
  channel: "sms" as const,
  message: "Is this legitimate?",
  history: [{ role: "assistant" as const, content: "Hi, how can I help?" }],
};

describe("runBrainTestTurn", () => {
  it("runs the real engine over the revision bundle and returns the evidence shape", async () => {
    // The draft revision carries its own retriever; the live one would reach the published
    // snapshot RPC, which the spy test below covers without a database.
    const deps = dependencies({ loadRevision: async () => revision("draft") });
    const result = await runBrainTestTurn({ ...input, revision: "draft" }, deps);
    expect(result.reply).toBe("Yes, it is a real program.");
    expect(result.held).toBe(false);
    expect(result.heldClass).toBeUndefined();
    expect(result.heldReason).toBeNull();
    expect(result.conversationState).toBe("agent");
    expect(result.evidence.citations).toEqual([{ entryId: "candidate-a", question: "Is this legitimate?", cited: true }]);
    expect(result.evidence.qualification).toEqual({ step: 0, of: 1, nextStep: null });
    expect(result.evidence.safety.checks.map((check) => check.class).sort())
      .toEqual(["CLAIM", "ECHO", "LEN", "LINK", "NUM", "SCOPE"]);
    expect(result.evidence.safety.checks.every((check) => check.passed)).toBe(true);
    expect(result.evidence.safety.moderator).toMatchObject({ verdict: "allowed", class: "JUDGE", reason: "safe" });
    expect(result.evidence.safety.moderator.ms).toBe(7);
    expect(result.evidence.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.tokens).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(result.evidence.channelLength).toEqual({ chars: "Yes, it is a real program.".length, soft: 160, hard: 320 });
    expect(result.revision).toEqual({
      kind: "draft", snapshotId: "snapshot-7", brainVersion: 7, contentHash: "a".repeat(64),
      offerVersion: 9, draftId: "draft-1", retrievalMode: "draft_in_process",
    });
    expect(result.model).toBe("anthropic/generator");
    expect(result.attempts).toBe(1);
  });

  it("runs the live revision on the engine's own retriever and the draft on the injected one", async () => {
    const runTurn = vi.fn(async (_input, deps) => {
      // The real engine needs a retriever for a bundle turn; assert what it was handed instead.
      void deps;
      throw new Error("STOP");
    });
    const live = dependencies({ runTurn: runTurn as never });
    await expect(runBrainTestTurn(input, live)).rejects.toThrow("STOP");
    expect(runTurn.mock.calls[0][1]).not.toHaveProperty("retrieve");
    const draft = dependencies({ loadRevision: async () => revision("draft"), runTurn: runTurn as never });
    await expect(runBrainTestTurn({ ...input, revision: "draft" }, draft)).rejects.toThrow("STOP");
    expect(runTurn.mock.calls[1][1]).toHaveProperty("retrieve");
    expect(runTurn.mock.calls[1][0]).toMatchObject({ mode: "test", channel: "sms", leadMessage: { id: "admin-test:draft" } });
    expect(runTurn.mock.calls[1][0].history).toEqual([
      { role: "assistant", content: "Hi, how can I help?" },
      { role: "user", content: "Is this legitimate?" },
    ]);
  });

  it("reports a moderator hold with its class, reason and the time the moderator took", async () => {
    const result = await runBrainTestTurn(
      { ...input, revision: "draft" },
      dependencies({ loadRevision: async () => revision("draft") }, drivers([
        JSON.stringify({ reply: "Yes, it is a real program.", citation_entry_id: "candidate-a" }),
      ], "block")),
    );
    expect(result.held).toBe(true);
    expect(result.heldClass).toBe("CLAIM");
    expect(result.heldReason).toBe("output_check_failed");
    expect(result.reply).toBe(HELD.CLAIM);
    expect(result.conversationState).toBe("needs_human");
    expect(result.evidence.safety.moderator).toMatchObject({ verdict: "blocked", class: "CLAIM", ruleId: "CLAIM-001" });
    expect(result.evidence.safety.moderator.ms).toBe(14);
    expect(result.attempts).toBe(2);
    expect(result.revision.retrievalMode).toBe("draft_in_process");
  });

  it("maps a held outcome it has never seen from the trace alone", async () => {
    const synthetic: EngineTurnResult = {
      response: { reply: HELD.JUDGE, state: "needs_human", booking: null },
      commands: [],
      trace: {
        brainVersion: 7, offerVersion: 9, brainContentHash: null, offerContentHash: null, knowledgeMode: "retrieved",
        promptHash: "f".repeat(64), model: "anthropic/generator", paramsHash: null, ruleFired: null, sources: [],
        declaredEntryId: null, declaredEntryVerified: false, retrievalTopThree: [], droppedEntryIds: [], numberAllowlist: [],
        objection: null, checks: [], violations: [], rejectedDrafts: [], attempts: 1,
        screen: { verdict: "held", reason: "no_grounded_answer" }, latencyMs: 3, usage: null, cost: null,
        moderator: "not_run", moderatorReason: null, moderatorClass: null, moderatorRuleId: null, moderatorModelConfigId: null,
      },
    };
    const result = await runBrainTestTurn(input, dependencies({ runTurn: async () => synthetic }));
    expect(result.held).toBe(true);
    expect(result.heldReason).toBe("no_grounded_answer");
    expect(result.heldClass).toBe("JUDGE");
    expect(result.evidence.safety.moderator).toEqual({ verdict: "not_run", ms: null, class: null, ruleId: null, reason: null });
    expect(result.evidence.tokens).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it("refuses without a tag secret and never reaches the drivers", async () => {
    const deps = dependencies({ tagSecret: () => null });
    await expect(runBrainTestTurn(input, deps)).rejects.toThrow("SETTERFI_TAG_SECRET_REQUIRED");
    expect(deps.selectDrivers).not.toHaveBeenCalled();
    await expect(runBrainTestTurn({ ...input, message: "   " }, dependencies())).rejects.toThrow("TEST_TURN_MESSAGE_INVALID");
  });
});

describe("evidence helpers", () => {
  it("reads questions off knowledge entities only", () => {
    const questions = knowledgeQuestions(bundle());
    expect([...questions.entries()]).toEqual([["candidate-a", "Is this legitimate?"]]);
  });

  it("derives the held class from the rule, the violation, then the held reply text", () => {
    const base: EngineTurnResult = {
      response: { reply: `You're chatting with an automated assistant. ${HELD.LEN}`, state: "needs_human", booking: null },
      commands: [],
      trace: {
        brainVersion: 1, offerVersion: 1, brainContentHash: null, offerContentHash: null, knowledgeMode: "inline",
        promptHash: null, model: null, paramsHash: null, ruleFired: null, sources: [], declaredEntryId: null,
        declaredEntryVerified: false, retrievalTopThree: [], droppedEntryIds: [], numberAllowlist: [], objection: null,
        checks: [], violations: [], rejectedDrafts: [], attempts: 1, screen: { verdict: "held", reason: "x" },
        latencyMs: null, usage: null, cost: null, moderator: "not_run", moderatorReason: null, moderatorClass: null,
        moderatorRuleId: null, moderatorModelConfigId: null,
      },
    };
    expect(heldClassOf(base, HELD)).toBe("LEN");
    expect(heldClassOf({ ...base, trace: { ...base.trace, ruleFired: "NUM-001" } }, HELD)).toBe("NUM");
    expect(heldClassOf({
      ...base,
      trace: { ...base.trace, violations: [{ class: "ECHO", ruleId: "ECHO-001", evidence: "" }] },
    }, HELD)).toBe("ECHO");
    expect(heldClassOf({ ...base, trace: { ...base.trace, screen: { verdict: "continue", reason: null } } }, HELD)).toBeUndefined();
  });
});
