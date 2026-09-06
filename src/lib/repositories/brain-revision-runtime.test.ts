import { describe, expect, it, vi } from "vitest";

import type { PublishedCoachOffer } from "@/lib/brain/contracts";
import type { EmbeddingsDriver } from "@/lib/integrations/embeddings/types";

import type { BrainDraftRevision } from "./brain-publish";
import {
  createDraftRetriever,
  draftSnapshotRow,
  loadRevisionRuntime,
  rankDraftCandidates,
  type BrainRevisionDependencies,
  type DraftKnowledgeRow,
} from "./brain-revision-runtime";
import type { BrainRuntimeDependencies } from "./brain-runtime";

const TENANT = "11111111-1111-4111-8111-111111111111";
const DRAFT: BrainDraftRevision = {
  id: "22222222-2222-4222-8222-222222222222",
  contentHash: "d".repeat(64),
  createdBy: "owner",
  payload: {
    entities: [{ id: "candidate-a", type: "knowledge_entry", value: { inboundMessage: "q", responseTemplate: "a", status: "draft" } }],
    compiledPlatform: "Draft platform text",
    platformTokens: 5,
    knowledgeMode: "retrieved",
  },
};

function offer(): PublishedCoachOffer {
  return {
    id: "offer-1", tenantId: TENANT, status: "published", version: 3, contentHash: "c".repeat(64),
    programName: "Summit", programDescription: null, creditMin: 640, fundingGoalMinCents: 5_000_000,
    fundingGoalMaxCents: null, monthlyRevenueMinCents: null, businessRevenueRequired: false, creditRepair: null,
    products: [], bookingHorizonDays: 30, bookingMode: "direct", brandVoice: null, resultsTimelineMinDays: null,
    resultsTimelineMaxDays: null, refundPosture: null, voiceStyleAnswer: null, voiceObjectionAnswer: null,
    voiceFollowupAnswer: null, qualificationRules: [], voiceGuidelines: null, offerPrices: [], proof: [], assets: [],
  };
}

function snapshotRow(version: number) {
  return {
    id: `33333333-3333-4333-8333-33333333333${version}`,
    version,
    content_hash: "a".repeat(64),
    source_hash: "b".repeat(64),
    payload: { entities: [] },
    compiled_platform: "Live platform text",
    platform_tokens: 4,
    knowledge_mode: "retrieved",
  };
}

function runtime(overrides: Partial<BrainRuntimeDependencies> = {}): BrainRuntimeDependencies {
  return {
    phase2Enabled: () => true,
    loadTenant: async () => ({ id: TENANT, isDemo: true }),
    loadCurrentSnapshot: async () => snapshotRow(7),
    loadPublishedOffer: async () => offer(),
    loadPrimaryCalendar: async () => ({ bookingUrl: "https://book.example/x" }),
    loadDemoQualification: async () => [{
      ruleKey: "strong-credit", label: "Strong", outcome: "BOOK", minScore: 700, maxScore: null,
      businessStage: null, minAnnualRevenueCents: null, fundingGoals: null, timelines: null,
    }],
    ...overrides,
  };
}

const vectorOf = (values: number[]) => [...values, ...new Array(1536 - values.length).fill(0)];
const embeddings: EmbeddingsDriver = {
  model: "mock-hash-1536",
  dimensions: 1536,
  embed: async (input) => input.map((row) => ({ id: row.id, vector: vectorOf([1, 0, 0]) })),
};

function dependencies(overrides: Partial<BrainRevisionDependencies> = {}): BrainRevisionDependencies {
  return {
    runtime: runtime(),
    loadLatestDraft: async () => DRAFT,
    loadDraftKnowledge: async () => [],
    embeddings: () => embeddings,
    ...overrides,
  };
}

describe("draftSnapshotRow", () => {
  it("presents the draft as the version a publish would mint and keeps its hashes", () => {
    expect(draftSnapshotRow(DRAFT, 7)).toEqual({
      id: DRAFT.id,
      version: 8,
      content_hash: DRAFT.contentHash,
      source_hash: DRAFT.contentHash,
      payload: DRAFT.payload,
      compiled_platform: "Draft platform text",
      platform_tokens: 5,
      knowledge_mode: "retrieved",
    });
    const withSource = { ...DRAFT, payload: { ...DRAFT.payload, sourceHash: "e".repeat(64) } };
    expect(draftSnapshotRow(withSource, 0).source_hash).toBe("e".repeat(64));
    expect(draftSnapshotRow({ ...DRAFT, payload: { ...DRAFT.payload, sourceHash: "not-a-hash" } }, 0).source_hash)
      .toBe(DRAFT.contentHash);
  });
});

describe("loadRevisionRuntime", () => {
  it("loads the live revision through the production bundle loader unchanged", async () => {
    const deps = dependencies();
    const result = await loadRevisionRuntime({ tenantId: TENANT, revision: "live" }, deps);
    expect(result).toMatchObject({ revision: "live", retrievalMode: "published_snapshot", retrieve: null, draftId: null });
    expect(result.bundle.brainVersion).toBe(7);
    expect(result.bundle.brain.compiledPlatform).toBe("Live platform text");
    expect(result.bundle.offer.tenantId).toBe(TENANT);
  });

  it("builds the draft revision from the current draft over the same offer, calendar and qualification reads", async () => {
    const loadPublishedOffer = vi.fn(async () => offer());
    const deps = dependencies({ runtime: runtime({ loadPublishedOffer }) });
    const result = await loadRevisionRuntime({ tenantId: TENANT, revision: "draft" }, deps);
    expect(result).toMatchObject({ revision: "draft", retrievalMode: "draft_in_process", draftId: DRAFT.id });
    expect(result.retrieve).toBeTypeOf("function");
    expect(result.bundle.snapshotId).toBe(DRAFT.id);
    expect(result.bundle.brainVersion).toBe(8);
    expect(result.bundle.contentHash).toBe(DRAFT.contentHash);
    expect(result.bundle.brain.compiledPlatform).toBe("Draft platform text");
    expect(result.bundle.renderSources.bookingUrl).toBe("https://book.example/x");
    expect(result.bundle.qualificationSource).toBe("demo_seed");
    expect(loadPublishedOffer).toHaveBeenCalledWith(TENANT);
  });

  it("refuses a draft revision when no draft exists, and a live one when nothing is published", async () => {
    await expect(loadRevisionRuntime({ tenantId: TENANT, revision: "draft" }, dependencies({ loadLatestDraft: async () => null })))
      .rejects.toThrow("BRAIN_DRAFT_NOT_FOUND");
    await expect(loadRevisionRuntime(
      { tenantId: TENANT, revision: "live" },
      dependencies({ runtime: runtime({ loadCurrentSnapshot: async () => null }) }),
    )).rejects.toThrow("RUNTIME_BRAIN_NOT_PUBLISHED");
  });

  it("starts the draft version at one when nothing has ever been published", async () => {
    const result = await loadRevisionRuntime(
      { tenantId: TENANT, revision: "draft" },
      dependencies({ runtime: runtime({ loadCurrentSnapshot: async () => null }) }),
    );
    expect(result.bundle.brainVersion).toBe(1);
  });
});

describe("draft retrieval", () => {
  const rows: DraftKnowledgeRow[] = [
    { id: "b", category: "trust", responseTemplate: "Answer B", embedding: vectorOf([0.6, 0.8, 0]), numberBindings: [], rewriteHash: null },
    { id: "a", category: "pricing", responseTemplate: "Answer A", embedding: vectorOf([0.6, 0.8, 0]), numberBindings: [], rewriteHash: null },
    { id: "c", category: "trust", responseTemplate: "Answer C", embedding: vectorOf([1, 0, 0]), numberBindings: [], rewriteHash: null },
  ];

  it("ranks by cosine similarity plus the exact 0.05 category boost, ties broken by entry id", () => {
    const ranked = rankDraftCandidates({ queryEmbedding: vectorOf([1, 0, 0]), rows, categoryHint: null });
    expect(ranked.map((candidate) => candidate.entryId)).toEqual(["c", "a", "b"]);
    expect(ranked[0].similarity).toBeCloseTo(1, 10);
    expect(ranked[1].similarity).toBeCloseTo(0.6, 10);
    for (const candidate of ranked) expect(candidate.score).toBe(candidate.similarity + candidate.categoryBoost);
    const boosted = rankDraftCandidates({ queryEmbedding: vectorOf([1, 0, 0]), rows, categoryHint: "Trust" });
    expect(boosted.map((candidate) => [candidate.entryId, candidate.categoryBoost])).toEqual([["c", 0.05], ["b", 0.05], ["a", 0]]);
  });

  it("renders the ranked rows against the tenant offer and drops what it cannot resolve", async () => {
    const retrieve = createDraftRetriever({
      loadDraftKnowledge: async () => [
        { id: "r1", category: "trust", responseTemplate: "The {{niche}} program starts with a review.", embedding: vectorOf([1, 0, 0]), numberBindings: [], rewriteHash: null },
        { id: "r2", category: "trust", responseTemplate: "Book here: {{booking_link}}", embedding: vectorOf([0.9, 0.1, 0]), numberBindings: [], rewriteHash: null },
      ],
      embeddings: () => embeddings,
    });
    const result = await retrieve({
      snapshotId: DRAFT.id,
      inboundMessage: "Is this legitimate?",
      offer: offer(),
      renderSources: { bookingUrl: null, qualificationSummary: "", qualificationInputs: [], assetUrlsBySlug: {} },
    });
    expect(result.included.map((candidate) => [candidate.entryId, candidate.content]))
      .toEqual([["r1", "The Summit program starts with a review."]]);
    expect(result.dropped.map((entry) => entry.entryId)).toEqual(["r2"]);
    expect(result).not.toHaveProperty("objection");
    expect(result).not.toHaveProperty("objectionCandidates");
  });

  it("fails closed on a blank message or when nothing renders", async () => {
    const retrieve = createDraftRetriever({ loadDraftKnowledge: async () => [], embeddings: () => embeddings });
    const base = { snapshotId: DRAFT.id, offer: offer(), renderSources: { bookingUrl: null, qualificationSummary: "", qualificationInputs: [], assetUrlsBySlug: {} } };
    await expect(retrieve({ ...base, inboundMessage: "  " })).rejects.toThrow("BRAIN_RETRIEVAL_INBOUND_REQUIRED");
    // Nothing renderable is a typed miss, the same shape the published path returns, so the
    // pipeline holds the turn on SCOPE instead of surfacing a thrown string.
    await expect(retrieve({ ...base, inboundMessage: "hello" })).resolves.toMatchObject({
      kind: "no_grounded_answer",
      reason: "nothing_renderable",
      included: [],
    });
  });
});
