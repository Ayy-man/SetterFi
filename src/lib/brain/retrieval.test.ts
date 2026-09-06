import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RETRIEVAL_SIMILARITY_FLOOR,
  retrieveForTurn,
  type TurnRetrievalResult,
} from "@/lib/brain/retrieval";
import { rewriteHash } from "@/lib/brain/provenance";
import type {
  ObjectionCandidate,
  PublishedCoachOffer,
  RetrievalCandidate,
} from "@/lib/brain/contracts";
import type {
  EmbeddingInput,
  EmbeddingsDriver,
} from "@/lib/integrations/embeddings/types";

const OFFER: PublishedCoachOffer = {
  id: "offer-1",
  tenantId: "tenant-1",
  status: "published",
  version: 2,
  contentHash: "a".repeat(64),
  programName: "Synthetic Funding",
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
  brandVoice: "neutral",
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

const RENDER_SOURCES = {
  bookingUrl: null,
  qualificationSummary: "Published synthetic qualification",
  qualificationInputs: ["credit score"],
  assetUrlsBySlug: {},
};

type EmbeddingSpy = ReturnType<typeof vi.fn<EmbeddingsDriver["embed"]>>;

function embeddingSpy(): EmbeddingSpy {
  return vi.fn(async (input: readonly EmbeddingInput[]) => [{ id: input[0].id, vector: [1, 0] }]);
}

function embeddings(spy: EmbeddingSpy): EmbeddingsDriver {
  return {
    model: "mock-hash-1536",
    dimensions: 1536,
    embed: spy,
  };
}

function row(
  entryId: string,
  score: number,
  responseTemplate = "A synthetic published answer.",
  categoryBoost: 0 | 0.05 = 0,
) {
  return {
    entry_id: entryId,
    category: categoryBoost ? "pricing" : "misfiled",
    response_template: responseTemplate,
    number_bindings: [],
    rewrite_hash: null,
    matched_variant: null,
    similarity: score - categoryBoost,
    category_boost: categoryBoost,
    score,
  };
}

function grounded(result: TurnRetrievalResult) {
  if (result.kind !== "grounded") throw new Error(`expected grounded, got ${result.kind}`);
  return result;
}

describe("retrieveForTurn", () => {
  it("embeds only the inbound body and keeps a high-similarity misfiled row reachable", async () => {
    const embed = embeddingSpy();
    const matchPublished = vi.fn(async () => [
      row("misfiled-high", 0.91),
      row("category-match", 0.89, "A second synthetic answer.", 0.05),
    ]);
    const result = await retrieveForTurn({
      snapshotId: "snapshot-current",
      inboundMessage: "What could help this synthetic lead?",
      categoryHint: "pricing",
      offer: OFFER,
      renderSources: RENDER_SOURCES,
    }, { embeddings: embeddings(embed), repository: { matchPublished } });

    expect(embed).toHaveBeenCalledWith([{
      id: "current-inbound",
      text: "What could help this synthetic lead?",
    }]);
    expect(JSON.stringify(embed.mock.calls)).not.toContain("synthetic published answer");
    expect(result.included.map((candidate) => candidate.entryId)).toEqual([
      "misfiled-high",
      "category-match",
    ]);
    expect(result.included.map((candidate) => candidate.categoryBoost)).toEqual([0, 0.05]);
    expect(matchPublished).toHaveBeenCalledWith({
      expectedSnapshotId: "snapshot-current",
      queryEmbedding: [1, 0],
      categoryHint: "pricing",
      limit: 50,
    });
  });

  it("refills five prompt candidates after required placeholders drop", async () => {
    const embed = embeddingSpy();
    const rows = [
      row("dropped-booking", 0.99, "Book here: {{booking_link}}"),
      ...Array.from({ length: 5 }, (_, index) => row(`included-${index + 1}`, 0.9 - index / 100)),
    ];
    const result = await retrieveForTurn({
      snapshotId: "snapshot-current",
      inboundMessage: "Synthetic question",
      offer: OFFER,
      renderSources: RENDER_SOURCES,
    }, {
      embeddings: embeddings(embed),
      repository: { matchPublished: vi.fn(async () => rows) },
    });
    expect(result.included).toHaveLength(5);
    expect(result.dropped).toEqual([{
      entryId: "dropped-booking",
      dropped: true,
      reason: "required placeholder unresolved: booking_link",
    }]);
  });

  it("propagates current-snapshot refusal before any mutable row can become a candidate", async () => {
    const generator = vi.fn();
    await expect(retrieveForTurn({
      snapshotId: "stale-snapshot",
      inboundMessage: "Synthetic question",
      offer: OFFER,
      renderSources: RENDER_SOURCES,
    }, {
      embeddings: embeddings(embeddingSpy()),
      repository: {
        matchPublished: vi.fn(async ({ expectedSnapshotId }) => {
          expect(expectedSnapshotId).toBe("stale-snapshot");
          throw new Error("BRAIN_SNAPSHOT_STALE");
        }),
      },
    })).rejects.toThrow("BRAIN_SNAPSHOT_STALE");
    expect(generator).not.toHaveBeenCalled();
  });

  it("refuses a boost outside the database-owned zero-or-0.05 contract", async () => {
    await expect(retrieveForTurn({
      snapshotId: "snapshot-current",
      inboundMessage: "Synthetic question",
      offer: OFFER,
      renderSources: RENDER_SOURCES,
    }, {
      embeddings: embeddings(embeddingSpy()),
      repository: {
        matchPublished: vi.fn(async () => [{
          ...row("invalid-boost", 0.95),
          similarity: 0.7,
          category_boost: 0.25,
        }]),
      },
    })).rejects.toThrow("BRAIN_RETRIEVAL_BOOST_INVALID");
  });
});

// Phase 10: objection matching rides the same turn as knowledge retrieval, behind
// SETTERFI_BRAIN_OBJECTIONS_LIVE. The flag is taken through an injectable override so nothing here
// mutates process.env and a stray environment on a developer machine cannot change what is tested.
function objectionRow(
  objectionId: string,
  keywordHits: number,
  matchedKeywords: readonly string[],
  hardGate = false,
) {
  return {
    snapshot_id: "snapshot-current",
    objection_id: objectionId,
    label: "Too expensive",
    response: "Here is exactly what the program costs.",
    category: "pricing",
    hard_gate: hardGate,
    matched_keywords: matchedKeywords,
    keyword_hits: keywordHits,
  };
}

const KNOWLEDGE_ROWS = [row("entry-one", 0.9), row("entry-two", 0.8)];

describe("retrieveForTurn objection matching", () => {
  it("returns the rank-1 objection as a typed candidate beside untouched knowledge retrieval",
    async () => {
      const matchObjections = vi.fn(async () => [
        objectionRow("objection-a", 3, ["budget", "cost", "price"], true),
        objectionRow("objection-b", 1, ["cost"]),
      ]);
      const result = await retrieveForTurn({
        snapshotId: "snapshot-current",
        inboundMessage: "The price and the cost are too high for my budget",
        offer: OFFER,
        renderSources: RENDER_SOURCES,
      }, {
        embeddings: embeddings(embeddingSpy()),
        repository: {
          matchPublished: vi.fn(async () => KNOWLEDGE_ROWS),
          matchObjections,
        },
        objectionsEnabled: () => true,
      });

      expect(matchObjections).toHaveBeenCalledWith({
        expectedSnapshotId: "snapshot-current",
        inboundMessage: "The price and the cost are too high for my budget",
        limit: 3,
      });
      expect(result.objection).toEqual({
        objectionId: "objection-a",
        snapshotId: "snapshot-current",
        label: "Too expensive",
        response: "Here is exactly what the program costs.",
        category: "pricing",
        hardGate: true,
        matchedKeywords: ["budget", "cost", "price"],
        keywordHits: 3,
      });
      // The full ranked set, in the repository's order — 10-03 verifies a model-declared objection
      // id against this, and re-sorting here would mint a second ranking definition.
      expect(result.objectionCandidates?.map((candidate) => candidate.objectionId))
        .toEqual(["objection-a", "objection-b"]);

      // Knowledge retrieval is untouched: the same rows produce the same included set with the
      // flag off, so an objection match cannot change which knowledge answers reach the prompt.
      const withoutObjections = await retrieveForTurn({
        snapshotId: "snapshot-current",
        inboundMessage: "The price and the cost are too high for my budget",
        offer: OFFER,
        renderSources: RENDER_SOURCES,
      }, {
        embeddings: embeddings(embeddingSpy()),
        repository: { matchPublished: vi.fn(async () => KNOWLEDGE_ROWS) },
        objectionsEnabled: () => false,
      });
      expect(result.included).toEqual(withoutObjections.included);
      expect(result.dropped).toEqual(withoutObjections.dropped);
    });

  it("reports no objection rather than a low-ranked everything when nothing matched", async () => {
    const result = await retrieveForTurn({
      snapshotId: "snapshot-current",
      inboundMessage: "Where do I sign",
      offer: OFFER,
      renderSources: RENDER_SOURCES,
    }, {
      embeddings: embeddings(embeddingSpy()),
      repository: {
        matchPublished: vi.fn(async () => KNOWLEDGE_ROWS),
        matchObjections: vi.fn(async () => []),
      },
      objectionsEnabled: () => true,
    });
    expect(result.objection).toBeNull();
    expect(result.objectionCandidates).toEqual([]);
    expect(result.included.map((candidate) => candidate.entryId)).toEqual([
      "entry-one",
      "entry-two",
    ]);
  });

  it("lets either repository's stale refusal out, so neither call can mask the other", async () => {
    await expect(retrieveForTurn({
      snapshotId: "stale-snapshot",
      inboundMessage: "The cost",
      offer: OFFER,
      renderSources: RENDER_SOURCES,
    }, {
      embeddings: embeddings(embeddingSpy()),
      repository: {
        matchPublished: vi.fn(async () => KNOWLEDGE_ROWS),
        matchObjections: vi.fn(async () => {
          throw new Error("BRAIN_SNAPSHOT_STALE");
        }),
      },
      objectionsEnabled: () => true,
    })).rejects.toThrow("BRAIN_SNAPSHOT_STALE");

    await expect(retrieveForTurn({
      snapshotId: "stale-snapshot",
      inboundMessage: "The cost",
      offer: OFFER,
      renderSources: RENDER_SOURCES,
    }, {
      embeddings: embeddings(embeddingSpy()),
      repository: {
        matchPublished: vi.fn(async () => {
          throw new Error("BRAIN_SNAPSHOT_STALE");
        }),
        matchObjections: vi.fn(async () => [objectionRow("objection-a", 1, ["cost"])]),
      },
      objectionsEnabled: () => true,
    })).rejects.toThrow("BRAIN_SNAPSHOT_STALE");
  });

  it("fails closed on a malformed objection row instead of handing a caller undefined", async () => {
    async function withRows(rows: readonly unknown[]) {
      return retrieveForTurn({
        snapshotId: "snapshot-current",
        inboundMessage: "The cost",
        offer: OFFER,
        renderSources: RENDER_SOURCES,
      }, {
        embeddings: embeddings(embeddingSpy()),
        repository: {
          matchPublished: vi.fn(async () => KNOWLEDGE_ROWS),
          matchObjections: vi.fn(async () => rows),
        },
        objectionsEnabled: () => true,
      });
    }
    const missingId = { ...objectionRow("objection-a", 1, ["cost"]), objection_id: undefined };
    await expect(withRows([missingId])).rejects.toThrow("BRAIN_OBJECTION_ROW_INVALID");
    const badHits = { ...objectionRow("objection-a", 1, ["cost"]), keyword_hits: Number.NaN };
    await expect(withRows([badHits])).rejects.toThrow("BRAIN_OBJECTION_ROW_INVALID");
  });

  // Guard, green before this plan and green after it. With the flag off the RPC is never called
  // and the returned object does not grow the two keys, so "flag off is byte-identical" is a real
  // assertion about the shape rather than a claim about a value that happens to be null.
  it("never calls the objection RPC and returns today's exact shape with the flag off", async () => {
    const matchObjections = vi.fn(async () => [objectionRow("objection-a", 3, ["cost"])]);
    const result = await retrieveForTurn({
      snapshotId: "snapshot-current",
      inboundMessage: "The price and the cost are too high for my budget",
      offer: OFFER,
      renderSources: RENDER_SOURCES,
    }, {
      embeddings: embeddings(embeddingSpy()),
      repository: { matchPublished: vi.fn(async () => KNOWLEDGE_ROWS), matchObjections },
      objectionsEnabled: () => false,
    });
    expect(matchObjections).not.toHaveBeenCalled();
    expect(Object.keys(result).sort()).toEqual(["dropped", "included", "kind"]);
  });

  it("keeps an objection structurally unassignable to a knowledge candidate", () => {
    const objection: ObjectionCandidate = {
      objectionId: "objection-a",
      snapshotId: "snapshot-current",
      label: "Too expensive",
      response: "Here is exactly what the program costs.",
      category: "pricing",
      hardGate: false,
      matchedKeywords: ["cost"],
      keywordHits: 1,
    };
    // If this line ever stops erroring, an objection can be passed into renderCandidates, the
    // number allowlist or the citation path, and the two identities have become confusable.
    // @ts-expect-error an ObjectionCandidate has no entryId and is not a RetrievalCandidate
    const asKnowledge: RetrievalCandidate = objection;
    expect(asKnowledge).toBe(objection);
  });
});

// The relevance floor and the typed miss. A miss is a result, not an exception: the pipeline turns
// it into a held reply, and the trace still shows the closest rows and how far short they fell.
describe("retrieveForTurn relevance floor", () => {
  const base = {
    snapshotId: "snapshot-current",
    inboundMessage: "Can you write me a poem about credit?",
    offer: OFFER,
    renderSources: RENDER_SOURCES,
  };

  it("reports a typed miss with the closest evidence when every row sits below the default floor", async () => {
    const result = await retrieveForTurn(base, {
      embeddings: embeddings(embeddingSpy()),
      repository: {
        matchPublished: vi.fn(async () => [row("weak-a", 0.21), row("weak-b", 0.12)]),
      },
    });
    expect(result).toMatchObject({
      kind: "no_grounded_answer",
      reason: "below_floor",
      floor: DEFAULT_RETRIEVAL_SIMILARITY_FLOOR,
      bestSimilarity: 0.21,
      included: [],
    });
    if (result.kind !== "no_grounded_answer") throw new Error("unreachable");
    expect(result.ranked.map((candidate) => candidate.entryId)).toEqual(["weak-a", "weak-b"]);
  });

  it("floors on similarity, so the category boost cannot lift an unrelated entry over it", async () => {
    // similarity 0.23 + boost 0.05 = score 0.28, above the floor as a score and below it as
    // similarity. The floor reads similarity.
    const result = await retrieveForTurn({ ...base, categoryHint: "pricing" }, {
      embeddings: embeddings(embeddingSpy()),
      repository: { matchPublished: vi.fn(async () => [row("boosted", 0.28, "Answer.", 0.05)]) },
    });
    expect(result.kind).toBe("no_grounded_answer");
  });

  it("takes a per-snapshot floor override and refuses one outside [0, 1]", async () => {
    const rows = [row("mid", 0.4)];
    const strict = await retrieveForTurn({ ...base, similarityFloor: 0.6 }, {
      embeddings: embeddings(embeddingSpy()),
      repository: { matchPublished: vi.fn(async () => rows) },
    });
    expect(strict.kind).toBe("no_grounded_answer");
    const lenient = await retrieveForTurn({ ...base, similarityFloor: 0.1 }, {
      embeddings: embeddings(embeddingSpy()),
      repository: { matchPublished: vi.fn(async () => rows) },
    });
    expect(grounded(lenient).included.map((candidate) => candidate.entryId)).toEqual(["mid"]);
    await expect(retrieveForTurn({ ...base, similarityFloor: 1.5 }, {
      embeddings: embeddings(embeddingSpy()),
      repository: { matchPublished: vi.fn(async () => rows) },
    })).rejects.toThrow("BRAIN_RETRIEVAL_FLOOR_INVALID");
  });

  it("keeps rows above the floor and drops the rest before the prompt limit is applied", async () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, index) => row(`strong-${index}`, 0.9 - index / 100)),
      row("weak", 0.1),
    ];
    const result = grounded(await retrieveForTurn(base, {
      embeddings: embeddings(embeddingSpy()),
      repository: { matchPublished: vi.fn(async () => rows) },
    }));
    expect(result.included.map((candidate) => candidate.entryId))
      .toEqual(["strong-0", "strong-1", "strong-2"]);
  });

  it("returns a miss rather than throwing when nothing renders for this tenant", async () => {
    const result = await retrieveForTurn(base, {
      embeddings: embeddings(embeddingSpy()),
      repository: {
        matchPublished: vi.fn(async () => [row("needs-link", 0.95, "Book here: {{booking_link}}")]),
      },
    });
    expect(result).toMatchObject({
      kind: "no_grounded_answer",
      reason: "nothing_renderable",
      bestSimilarity: null,
      dropped: [{ entryId: "needs-link", dropped: true }],
    });
  });

  it("still carries a matched objection through a knowledge miss", async () => {
    const result = await retrieveForTurn(base, {
      embeddings: embeddings(embeddingSpy()),
      repository: {
        matchPublished: vi.fn(async () => [row("weak", 0.05)]),
        matchObjections: vi.fn(async () => [objectionRow("objection-a", 1, ["cost"], true)]),
      },
      objectionsEnabled: () => true,
    });
    expect(result.kind).toBe("no_grounded_answer");
    expect(result.objection?.objectionId).toBe("objection-a");
  });
});

describe("retrieveForTurn provenance columns", () => {
  it("carries reviewed number bindings, the rewrite hash and the winning variant on each candidate", async () => {
    const template = "The program costs $297 and needs a 640 score.";
    const result = grounded(await retrieveForTurn({
      snapshotId: "snapshot-current",
      inboundMessage: "how much is it",
      offer: OFFER,
      renderSources: RENDER_SOURCES,
    }, {
      embeddings: embeddings(embeddingSpy()),
      repository: {
        matchPublished: vi.fn(async () => [{
          ...row("bound", 0.9, template),
          number_bindings: [
            { kind: "currency", value: 297, field: "responseTemplate", offset: 18, binding: "offer_prices" },
            { kind: "score", value: 640, field: "responseTemplate", offset: 39, binding: "credit_min" },
          ],
          rewrite_hash: rewriteHash(template),
          matched_variant: "what is the price",
        }]),
      },
    }));
    expect(result.included[0]).toMatchObject({
      entryId: "bound",
      rewriteHash: rewriteHash(template),
      matchedVariant: "what is the price",
      numberBindings: [
        { kind: "currency", value: 297, binding: "offer_prices", offset: 18 },
        { kind: "score", value: 640, binding: "credit_min", offset: 39 },
      ],
    });
  });

  it("refuses a row whose provenance columns are missing or malformed", async () => {
    async function withRow(overrides: Record<string, unknown>) {
      return retrieveForTurn({
        snapshotId: "snapshot-current",
        inboundMessage: "how much is it",
        offer: OFFER,
        renderSources: RENDER_SOURCES,
      }, {
        embeddings: embeddings(embeddingSpy()),
        repository: { matchPublished: vi.fn(async () => [{ ...row("bound", 0.9), ...overrides }]) },
      });
    }
    await expect(withRow({ number_bindings: undefined })).rejects.toThrow("BRAIN_NUMBER_BINDINGS_INVALID");
    await expect(withRow({ number_bindings: [{ kind: "currency", value: "297", binding: "offer_prices" }] }))
      .rejects.toThrow("BRAIN_NUMBER_BINDINGS_INVALID");
    await expect(withRow({ number_bindings: [{ kind: "currency", value: 297, binding: "made_up" }] }))
      .rejects.toThrow("BRAIN_NUMBER_BINDINGS_INVALID");
    await expect(withRow({ rewrite_hash: undefined })).rejects.toThrow("BRAIN_RETRIEVAL_ROW_INVALID");
    await expect(withRow({ matched_variant: 4 })).rejects.toThrow("BRAIN_RETRIEVAL_ROW_INVALID");
  });
});
