import { describe, expect, it } from "vitest";

import type { PublishedCoachOffer, RetrievalCandidate } from "@/lib/brain/contracts";
import { PLACEHOLDER_REGISTRY } from "@/lib/brain/placeholders";

import { renderCandidates } from "./render-placeholders";

function offer(overrides: Partial<PublishedCoachOffer> = {}): PublishedCoachOffer {
  return {
    id: "offer-1",
    tenantId: "tenant-1",
    status: "published",
    version: 3,
    contentHash: "a".repeat(64),
    programName: "Synthetic Funding Lab",
    programDescription: null,
    creditMin: 650,
    fundingGoalMinCents: 5_000_000,
    fundingGoalMaxCents: 15_000_000,
    monthlyRevenueMinCents: null,
    businessRevenueRequired: true,
    creditRepair: null,
    products: [],
    bookingHorizonDays: 14,
    bookingMode: "direct",
    brandVoice: "friendly",
    resultsTimelineMinDays: null,
    resultsTimelineMaxDays: null,
    refundPosture: null,
    voiceStyleAnswer: null,
    voiceObjectionAnswer: null,
    voiceFollowupAnswer: null,
    offerPrices: [],
    proof: [],
    assets: [],
    ...overrides,
  };
}

function candidate(entryId: string, responseTemplate: string): RetrievalCandidate {
  return {
    entryId,
    category: "General Questions",
    responseTemplate,
    similarity: 0.8,
    categoryBoost: 0,
    score: 0.8,
  };
}

const sources = {
  bookingUrl: "https://coach.example.test/book",
  qualificationSummary: "a published eligibility profile",
  qualificationInputs: ["What is your goal?", "What is your timeline?"],
  assetUrlsBySlug: { "free-course": "https://coach.example.test/course" },
};

describe("renderCandidates", () => {
  it("resolves offer, booking, qualification and stable assets from their owned sources", () => {
    const templates = [
      candidate("niche", "Built for {{niche}}."),
      candidate("funding", "Target {{target_funding_amount}}."),
      candidate("booking", "Book at {{booking_link}}."),
      candidate("requirements", "We review {{requirements}}."),
      candidate("questions", "We ask {{qualifying_questions}}."),
      candidate("income", "Clients are {{income_qualifiers}}."),
      candidate("asset", "Use {{asset.free-course}}."),
    ];

    const result = renderCandidates({
      candidates: templates,
      offer: offer(),
      registry: PLACEHOLDER_REGISTRY,
      renderSources: sources,
    });

    expect(result.dropped).toEqual([]);
    expect(result.included.map((item) => item.content)).toEqual([
      "Built for Synthetic Funding Lab.",
      "Target $50,000–$150,000.",
      "Book at https://coach.example.test/book.",
      "We review a published eligibility profile.",
      "We ask What is your goal?; What is your timeline?.",
      "Clients are already generating revenue.",
      "Use https://coach.example.test/course.",
    ]);
  });

  it("drops unknown, bare-X and unresolved required slots with entry ids and reasons", () => {
    const result = renderCandidates({
      candidates: [
        candidate("unknown", "Use {{invented_token}}."),
        candidate("booking", "Book at {{booking_link}}."),
        candidate("asset", "Download X."),
      ],
      offer: offer(),
      registry: PLACEHOLDER_REGISTRY,
      renderSources: { ...sources, bookingUrl: null },
    });

    expect(result.included).toEqual([]);
    expect(result.dropped).toEqual([
      { entryId: "unknown", dropped: true, reason: "unknown placeholder: invented_token" },
      { entryId: "booking", dropped: true, reason: "required placeholder unresolved: booking_link" },
      { entryId: "asset", dropped: true, reason: "unresolved bare placeholder: X" },
    ]);
  });

  it("uses registered grammatical fallbacks without mutating the immutable templates", () => {
    const input = candidate(
      "optional",
      "This can {{dream_outcome}} for clients who are {{income_qualifiers}}.",
    );
    const before = structuredClone(input);

    const result = renderCandidates({
      candidates: [input],
      offer: offer({ businessRevenueRequired: false }),
      registry: PLACEHOLDER_REGISTRY,
      renderSources: { ...sources, qualificationSummary: "", qualificationInputs: [] },
    });

    expect(result.included[0].content).toBe(
      "This can move toward your funding goals for clients who are already generating revenue.",
    );
    expect(input).toEqual(before);
  });
});
