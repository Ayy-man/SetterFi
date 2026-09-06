// The runtime bundle's knowledge section: inline snapshots carry every entry, retrieved ones carry
// none, and the per-snapshot retrieval floor is narrowed like every other payload field.
import { describe, expect, it, vi } from "vitest";

import type { PublishedCoachOffer } from "@/lib/brain/contracts";
import {
  BrainRuntimeReadinessError,
  loadPublishedRuntimeBundle,
  type BrainRuntimeDependencies,
} from "@/lib/repositories/brain-runtime";

const TENANT = "tenant-a";

function snapshot(options: { knowledgeMode?: string; payload?: Record<string, unknown> } = {}) {
  return {
    id: "snapshot-3",
    version: 3,
    content_hash: "a".repeat(64),
    source_hash: "b".repeat(64),
    payload: {
      qualification: [{ id: "strong-credit", label: "Strong", outcome: "BOOK", conditions: { minScore: 700 } }],
      ...options.payload,
    },
    compiled_platform: "Synthetic compiled platform block",
    platform_tokens: 42,
    knowledge_mode: options.knowledgeMode ?? "inline",
  };
}

function offer(): PublishedCoachOffer {
  return {
    id: "offer-4",
    tenantId: TENANT,
    status: "published",
    version: 4,
    contentHash: "c".repeat(64),
    programName: "Synthetic program",
    programDescription: null,
    creditMin: 640,
    fundingGoalMinCents: null,
    fundingGoalMaxCents: null,
    monthlyRevenueMinCents: null,
    businessRevenueRequired: false,
    creditRepair: null,
    products: [],
    bookingHorizonDays: 21,
    bookingMode: "direct",
    brandVoice: null,
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
  };
}

const ENTRY_ROW = {
  entry_id: "entry-1",
  category: "Funding Qs",
  inbound_message: "How long does funding take?",
  response_template: "Usually a few weeks.",
  number_bindings: [{ kind: "currency", value: 297, field: "responseTemplate", offset: 4, binding: "offer_prices" }],
  rewrite_hash: "d".repeat(64),
  source_ref: "notion:1",
};

function dependencies(overrides: Partial<BrainRuntimeDependencies> = {}): BrainRuntimeDependencies {
  return {
    phase2Enabled: () => true,
    loadTenant: async (tenantId) => ({ id: tenantId, isDemo: false }),
    loadCurrentSnapshot: async () => snapshot(),
    loadPublishedOffer: async () => offer(),
    loadPrimaryCalendar: async () => null,
    loadDemoQualification: async () => [],
    loadSnapshotEntries: vi.fn(async () => [ENTRY_ROW]),
    ...overrides,
  };
}

describe("loadPublishedRuntimeBundle knowledge", () => {
  it("loads every entry of an inline snapshot from that snapshot's id", async () => {
    const deps = dependencies();
    const bundle = await loadPublishedRuntimeBundle(TENANT, deps);
    expect(deps.loadSnapshotEntries).toHaveBeenCalledWith("snapshot-3");
    expect(bundle.knowledgeEntries).toEqual([{
      entryId: "entry-1",
      category: "Funding Qs",
      question: "How long does funding take?",
      responseTemplate: "Usually a few weeks.",
      numberBindings: [{ kind: "currency", value: 297, binding: "offer_prices", offset: 4 }],
      rewriteHash: "d".repeat(64),
      sourceRef: "notion:1",
    }]);
  });

  it("reads no entries for a retrieved snapshot and leaves the key off the bundle", async () => {
    const deps = dependencies({ loadCurrentSnapshot: async () => snapshot({ knowledgeMode: "retrieved" }) });
    const bundle = await loadPublishedRuntimeBundle(TENANT, deps);
    expect(deps.loadSnapshotEntries).not.toHaveBeenCalled();
    expect("knowledgeEntries" in bundle).toBe(false);
  });

  it("degrades an inline snapshot to retrieval when the loader has no entry reader", async () => {
    const deps = dependencies();
    delete deps.loadSnapshotEntries;
    const bundle = await loadPublishedRuntimeBundle(TENANT, deps);
    expect(bundle.brain.knowledgeMode).toBe("inline");
    expect("knowledgeEntries" in bundle).toBe(false);
  });

  it("refuses a malformed entry row rather than passing it on", async () => {
    await expect(loadPublishedRuntimeBundle(TENANT, dependencies({
      loadSnapshotEntries: async () => [{ ...ENTRY_ROW, number_bindings: "not-an-array" }],
    }))).rejects.toMatchObject({ code: "RUNTIME_BRAIN_ENTRY_INVALID" });
    await expect(loadPublishedRuntimeBundle(TENANT, dependencies({
      loadSnapshotEntries: async () => [{ ...ENTRY_ROW, response_template: "" }],
    }))).rejects.toBeInstanceOf(BrainRuntimeReadinessError);
  });

  it("carries a valid payload retrieval floor and refuses one outside [0, 1]", async () => {
    const bundle = await loadPublishedRuntimeBundle(TENANT, dependencies({
      loadCurrentSnapshot: async () => snapshot({ payload: { retrievalFloor: 0.4 } }),
    }));
    expect(bundle.brain.retrievalFloor).toBe(0.4);
    const plain = await loadPublishedRuntimeBundle(TENANT, dependencies());
    expect("retrievalFloor" in plain.brain).toBe(false);
    await expect(loadPublishedRuntimeBundle(TENANT, dependencies({
      loadCurrentSnapshot: async () => snapshot({ payload: { retrievalFloor: 2 } }),
    }))).rejects.toMatchObject({ code: "RUNTIME_BRAIN_RETRIEVAL_FLOOR_INVALID" });
  });
});
