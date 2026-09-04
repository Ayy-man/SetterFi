import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { PublishedCoachOffer, QualificationRule } from "@/lib/brain/contracts";
import {
  BrainRuntimeReadinessError,
  loadPublishedRuntimeBundle,
  type BrainRuntimeDependencies,
} from "@/lib/repositories/brain-runtime";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const TENANT = "tenant-a";

const qualification: readonly QualificationRule[] = [{
  id: "revenue-qualified",
  label: "Synthetic qualified rule",
  outcome: "BOOK",
  conditions: {
    minScore: 640,
    businessStage: "operating",
    minAnnualRevenue: 50_000,
    fundingGoals: ["$50K–100K"],
    timelines: ["1–3mo"],
  },
}];

function snapshot(options: { version?: number; hash?: string; rules?: unknown } = {}) {
  const version = options.version ?? 3;
  const hash = options.hash ?? HASH_A;
  const payload = {
    ...(Object.hasOwn(options, "rules") ? { qualification: options.rules } : { qualification }),
    compliance: [{ id: "CLAIM-001" }],
  };
  return {
    id: `snapshot-${version}`,
    version,
    content_hash: hash,
    source_hash: HASH_B,
    payload,
    compiled_platform: "Synthetic compiled platform block",
    platform_tokens: 42,
    knowledge_mode: "retrieved",
  };
}

function offer({ version = 4, hash = HASH_C } = {}): PublishedCoachOffer {
  return {
    id: `offer-${version}`,
    tenantId: TENANT,
    status: "published",
    version,
    contentHash: hash,
    programName: "Synthetic program",
    programDescription: null,
    creditMin: 640,
    fundingGoalMinCents: 5_000_000,
    fundingGoalMaxCents: 10_000_000,
    monthlyRevenueMinCents: 500_000,
    businessRevenueRequired: true,
    creditRepair: null,
    products: ["biz CC"],
    bookingHorizonDays: 21,
    bookingMode: "direct",
    brandVoice: "professional",
    resultsTimelineMinDays: 30,
    resultsTimelineMaxDays: 90,
    refundPosture: null,
    voiceStyleAnswer: null,
    voiceObjectionAnswer: null,
    voiceFollowupAnswer: null,
    qualificationRules: [],
    voiceGuidelines: null,
    offerPrices: [],
    proof: [],
    assets: [{ id: "asset-1", slug: "readiness-guide", label: "Guide", url: "https://example.invalid/guide" }],
  };
}

function dependencies(overrides: Partial<BrainRuntimeDependencies> = {}): BrainRuntimeDependencies {
  return {
    phase2Enabled: () => true,
    loadTenant: async (tenantId) => ({ id: tenantId, isDemo: false }),
    loadCurrentSnapshot: async () => snapshot(),
    loadPublishedOffer: async () => offer(),
    loadPrimaryCalendar: async () => ({ bookingUrl: "https://example.invalid/book" }),
    loadDemoQualification: async () => [],
    ...overrides,
  };
}

describe("loadPublishedRuntimeBundle", () => {
  it("returns exact persisted versions, platform qualification, and complete render sources", async () => {
    const bundle = await loadPublishedRuntimeBundle(TENANT, dependencies());
    expect(bundle).toMatchObject({
      snapshotId: "snapshot-3",
      brainVersion: 3,
      offerVersion: 4,
      contentHash: HASH_A,
      qualificationApproved: true,
      qualificationSource: "platform",
      renderSources: {
        bookingUrl: "https://example.invalid/book",
        qualificationSummary: "Synthetic qualified rule: BOOK",
        qualificationInputs: [
          "credit score",
          "business stage",
          "annual revenue",
          "funding goal",
          "funding timeline",
        ],
        assetUrlsBySlug: { "readiness-guide": "https://example.invalid/guide" },
      },
    });
    expect(bundle.brain.payload).toEqual({
      qualification,
      compliance: [{ id: "CLAIM-001" }],
    });
  });

  it("reloads the current publication on every call so an in-flight conversation sees republish", async () => {
    let currentOffer = offer();
    let calls = 0;
    const deps = dependencies({
      loadPublishedOffer: async () => {
        calls += 1;
        return currentOffer;
      },
    });
    const first = await loadPublishedRuntimeBundle(TENANT, deps);
    const draftOnly = offer({ version: 5, hash: "d".repeat(64) });
    const unchanged = await loadPublishedRuntimeBundle(TENANT, deps);
    currentOffer = draftOnly;
    const republished = await loadPublishedRuntimeBundle(TENANT, deps);
    expect([first.offerVersion, unchanged.offerVersion, republished.offerVersion]).toEqual([4, 4, 5]);
    expect(calls).toBe(3);
  });

  it("never exposes a draft knowledge entry even when its synthetic similarity is perfect", async () => {
    const draftEntry = {
      id: "draft-perfect-match",
      status: "draft",
      similarity: 1,
      responseTemplate: "Synthetic draft answer",
    };
    const bundle = await loadPublishedRuntimeBundle(TENANT, dependencies({
      loadCurrentSnapshot: async () => snapshot({ rules: qualification }),
    }));
    const source = readFileSync(new URL("./brain-runtime.ts", import.meta.url), "utf8");
    expect(source).not.toContain('.from("brain_knowledge_entries")');
    expect(JSON.stringify(bundle)).not.toContain(draftEntry.id);
    expect(JSON.stringify(bundle)).not.toContain(draftEntry.responseTemplate);
  });

  it("uses only the demo tenant's seeded draft matrix and labels it unapproved", async () => {
    let demoLoads = 0;
    const bundle = await loadPublishedRuntimeBundle(TENANT, dependencies({
      loadTenant: async () => ({ id: TENANT, isDemo: true }),
      loadCurrentSnapshot: async () => snapshot({ rules: undefined }),
      loadDemoQualification: async () => {
        demoLoads += 1;
        return [{
          ruleKey: "strong-credit",
          label: "Synthetic demo rule",
          outcome: "BOOK",
          minScore: 700,
          maxScore: null,
          businessStage: null,
          minAnnualRevenueCents: null,
          fundingGoals: null,
          timelines: null,
        }];
      },
    }));
    expect(bundle.qualification).toEqual([{
      id: "strong-credit",
      label: "Synthetic demo rule",
      outcome: "BOOK",
      conditions: {
        minScore: 700,
        maxScore: undefined,
        businessStage: undefined,
        minAnnualRevenue: undefined,
        fundingGoals: undefined,
        timelines: undefined,
      },
    }]);
    expect(bundle).toMatchObject({ qualificationApproved: false, qualificationSource: "demo_seed" });
    expect(demoLoads).toBe(1);
  });

  it("does not query the demo draft when the immutable snapshot carries qualification", async () => {
    let demoLoads = 0;
    const bundle = await loadPublishedRuntimeBundle(TENANT, dependencies({
      loadTenant: async () => ({ id: TENANT, isDemo: true }),
      loadDemoQualification: async () => {
        demoLoads += 1;
        return [];
      },
    }));
    expect(bundle.qualificationSource).toBe("platform");
    expect(demoLoads).toBe(0);
  });

  it.each([
    ["RUNTIME_BRAIN_NOT_PUBLISHED", { loadCurrentSnapshot: async () => null }],
    ["RUNTIME_OFFER_NOT_PUBLISHED", { loadPublishedOffer: async () => null }],
    ["RUNTIME_TENANT_NOT_READY", { loadTenant: async () => null }],
    ["RUNTIME_QUALIFICATION_NOT_PUBLISHED", {
      loadCurrentSnapshot: async () => snapshot({ rules: undefined }),
    }],
    ["RUNTIME_PUBLISHED_OFFER_INVALID", {
      loadPublishedOffer: async () => ({ ...offer(), status: "draft" }),
    }],
    ["RUNTIME_BRAIN_HASH_INVALID", {
      loadCurrentSnapshot: async () => ({ ...snapshot(), content_hash: "mixed" }),
    }],
  ])("fails closed with named readiness error %s", async (code, override) => {
    await expect(loadPublishedRuntimeBundle(TENANT, dependencies(override)))
      .rejects.toEqual(new BrainRuntimeReadinessError(code));
  });

  it("stays disabled with an empty environment instead of activating the backend path", async () => {
    const deps = dependencies({ phase2Enabled: () => false });
    await expect(loadPublishedRuntimeBundle(TENANT, deps)).rejects.toThrow("PHASE2_RUNTIME_DISABLED");
  });

  it("has no caller qualification or offer override in its public input contract", () => {
    expect(loadPublishedRuntimeBundle.length).toBe(1);
  });
});
