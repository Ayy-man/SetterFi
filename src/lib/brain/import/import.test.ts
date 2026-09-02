import { describe, expect, it } from "vitest";

import { PLACEHOLDER_REGISTRY } from "@/lib/brain/placeholders";
import type {
  BrainImportBatchItem,
  BrainImportRepository,
  ExistingBrainEntry,
} from "@/lib/repositories/brain-import";

import { FAQ_CATEGORIES, type NumberBinding } from "./flags";
import {
  buildAcceptancePayload,
  embeddingRequests,
  normalizeImport,
} from "./normalize";
import { runBrainImport, type FaqSourceDriver } from "./pipeline";

function sourceRow({
  id,
  category,
  inbound,
  response,
}: {
  id: string;
  category: readonly string[];
  inbound: string;
  response: string;
}) {
  return {
    id,
    last_edited_time: "2026-08-17T00:00:00.000Z",
    properties: {
      Category: { type: "multi_select", multi_select: category.map((name) => ({ name })) },
      "Inbound Message": { type: "title", title: [{ plain_text: inbound }] },
      Response: { type: "rich_text", rich_text: [{ plain_text: response }] },
    },
  };
}

describe("Brain import normalization", () => {
  it("preserves all six categories and a source category that text alone could misfile", () => {
    const rows = FAQ_CATEGORIES.map((category, index) => sourceRow({
      id: `synthetic-${index}`,
      category: [category],
      inbound: index === 0 ? "Can I schedule a call?" : `Synthetic question ${index}`,
      response: "A synthetic answer for {{niche}}.",
    }));

    const result = normalizeImport(rows, PLACEHOLDER_REGISTRY);

    expect(result.items.map((item) => item.category)).toEqual(FAQ_CATEGORIES);
    expect(result.items[0].category).toBe("Credit");
    expect(result.counts).toEqual({ received: 6, normalized: 6, flagged: 0, unchanged: 0 });
  });

  it("normalizes every core token and the target-funding alias without changing source identity", () => {
    const tokens = [
      "[niche]",
      "[target funding]",
      "[booking link]",
      "[requirements]",
      "[qualifying questions]",
      "[dream outcome]",
      "[income qualifiers]",
      "[asset.free-course]",
    ];
    const [item] = normalizeImport([
      sourceRow({
        id: "stable-source",
        category: ["General Questions"],
        inbound: "What can this do?",
        response: tokens.join(" "),
      }),
    ]).items;

    expect(item.sourceRef).toBe("stable-source");
    expect(item.responseTemplate).toBe(
      "{{niche}} {{target_funding_amount}} {{booking_link}} {{requirements}} "
      + "{{qualifying_questions}} {{dream_outcome}} {{income_qualifiers}} {{asset.free-course}}",
    );
    expect(item.flags).toEqual([]);
  });

  it("flags unsafe shapes with locations and no copied excerpts", () => {
    const result = normalizeImport([
      sourceRow({
        id: "unsafe-row",
        category: ["Business", "Funding Qs"],
        inbound: "Tell me about the offer",
        response: "I live nearby; email person@example.test about $400 and [invented slot], then visit X.",
      }),
      { id: "prose-row", kind: "prose", content: "Synthetic prose instead of typed properties." },
      sourceRow({
        id: "unknown-category",
        category: ["Invented Category"],
        inbound: "Synthetic category question",
        response: "Synthetic category response",
      }),
    ]);

    expect(result.items[0].flags.map((item) => item.code)).toEqual(expect.arrayContaining([
      "multi_category",
      "first_person_pii",
      "unbound_figure",
      "unknown_placeholder",
      "bare_x",
    ]));
    expect(result.items[1].flags.map((item) => item.code)).toEqual(expect.arrayContaining([
      "source_shape",
      "prose_shape",
    ]));
    expect(result.items[2].flags.map((item) => item.code)).toContain("source_shape");
    expect(result.items.flatMap((item) => item.flags)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "responseTemplate", offset: expect.any(Number), resolution: null }),
    ]));
    expect(JSON.stringify(result.items.flatMap((item) => item.flags))).not.toContain("person@example.test");
  });

  it("never creates acceptance data without disposition and resolved blocking flags", () => {
    const [item] = normalizeImport([
      sourceRow({
        id: "review-row",
        category: ["Funding Qs"],
        inbound: "What is the range?",
        response: "The synthetic range starts at $400.",
      }),
    ]).items;
    const figure = item.figures[0];
    const binding: NumberBinding = { ...figure, binding: "offer_prices" };

    expect(buildAcceptancePayload(item, {})).toBeNull();
    expect(buildAcceptancePayload(item, { disposition: "shared" })).toBeNull();
    expect(buildAcceptancePayload(item, {
      disposition: "shared",
      numberBindings: [binding],
    })).toMatchObject({
      sourceRef: "review-row",
      disposition: "shared",
      platformDraftEligible: true,
      embeddingText: "What is the range?",
      numberBindings: [binding],
    });
  });

  it("resolves bare X only to booking or stable asset placeholders", () => {
    const [item] = normalizeImport([
      sourceRow({
        id: "bare-x-row",
        category: ["Application/Booking"],
        inbound: "Where should I go?",
        response: "Book at X or read X.",
      }),
    ]).items;
    const offsets = item.flags.filter((flag) => flag.code === "bare_x").map((flag) => flag.offset);

    expect(buildAcceptancePayload(item, {
      disposition: "shared",
      bareXResolutions: [
        { offset: offsets[0], token: "booking_link" },
        { offset: offsets[1], token: "asset.free-course" },
      ],
    })?.afterPayload.responseTemplate).toBe(
      "Book at {{booking_link}} or read {{asset.free-course}}.",
    );
    expect(buildAcceptancePayload(item, {
      disposition: "shared",
      resolvedFlagIds: item.flags.map((flag) => flag.id),
    })).toBeNull();
  });

  it("builds embedding inputs from inbound messages and never response templates", async () => {
    const [item] = normalizeImport([
      sourceRow({
        id: "embedding-row",
        category: ["General Questions"],
        inbound: "Synthetic inbound wording",
        response: "Synthetic response wording",
      }),
    ]).items;
    const observed: Array<{ id: string; text: string }> = [];
    const embed = async (input: readonly { id: string; text: string }[]) => {
      observed.push(...input);
      return input.map(({ id }) => ({ id, vector: [1] }));
    };

    await embed(embeddingRequests([item]));

    expect(observed).toEqual([{ id: "embedding-row", text: "Synthetic inbound wording" }]);
    expect(JSON.stringify(observed)).not.toContain("Synthetic response wording");
  });
});

function importRepository(existing: readonly ExistingBrainEntry[] = []) {
  const completed: Array<{
    counts: { received: number; normalized: number; flagged: number; unchanged: number };
    items: readonly BrainImportBatchItem[];
  }> = [];
  const failed: Array<{ errorCode: string; receivedCount: number }> = [];
  const repository: BrainImportRepository = {
    createBatch: async () => ({ batchId: "batch-1" }),
    loadExisting: async () => existing,
    completeBatch: async (input) => {
      completed.push({ counts: input.counts, items: input.items });
      return {
        batchId: input.batchId,
        completedAt: "2026-08-17T02:00:00.000Z",
        counts: input.counts,
        itemCount: input.items.length,
      };
    },
    failBatch: async ({ errorCode, receivedCount }) => void failed.push({ errorCode, receivedCount }),
  };
  return { repository, completed, failed };
}

const embeddings = {
  model: "synthetic-1536",
  dimensions: 1_536 as const,
  embed: async (input: readonly { id: string; text: string }[]) => input.map(({ id }) => ({
    id,
    vector: Array.from({ length: 1_536 }, () => 0),
  })),
};

describe("runBrainImport", () => {
  it("persists a cursor-complete two-page batch with reconciled counts and inbound-only embeddings", async () => {
    const observed: Array<{ id: string; text: string }> = [];
    const pages = [
      {
        rows: [sourceRow({
          id: "source-1",
          category: ["Credit"],
          inbound: "First inbound",
          response: "First response",
        })],
        nextCursor: "page-2",
        sourceEditedAt: "2026-08-17T01:00:00.000Z",
      },
      {
        rows: [sourceRow({
          id: "source-2",
          category: ["Business"],
          inbound: "Second inbound",
          response: "Second response",
        })],
        nextCursor: null,
        sourceEditedAt: "2026-08-17T02:00:00.000Z",
      },
    ];
    let page = 0;
    const source: FaqSourceDriver = {
      source: "mock",
      fetchFaqRows: async () => pages[page++],
    };
    const storage = importRepository();

    const result = await runBrainImport({ collectionRef: "synthetic-root", actorId: "actor-1" }, {
      source,
      embeddings: {
        ...embeddings,
        embed: async (input) => {
          observed.push(...input);
          return embeddings.embed(input);
        },
      },
      repository: storage.repository,
    });

    expect(result).toMatchObject({
      status: "complete",
      importedCount: 2,
      counts: { received: 2, normalized: 2, flagged: 0, unchanged: 0 },
    });
    expect(storage.completed).toHaveLength(1);
    expect(storage.completed[0].items.map((item) => item.operation)).toEqual(["new", "new"]);
    expect(observed).toEqual([
      { id: "source-1", text: "First inbound" },
      { id: "source-2", text: "Second inbound" },
    ]);
    expect(JSON.stringify(observed)).not.toContain("response");
  });

  it("leaves a page-two provider failure incomplete instead of returning an imported count", async () => {
    let page = 0;
    const source: FaqSourceDriver = {
      source: "mock",
      fetchFaqRows: async () => {
        page += 1;
        if (page === 2) throw new Error("provider body must not escape");
        return {
          rows: [sourceRow({
            id: "source-1",
            category: ["Credit"],
            inbound: "First inbound",
            response: "First response",
          })],
          nextCursor: "page-2",
          sourceEditedAt: null,
        };
      },
    };
    const storage = importRepository();

    const result = await runBrainImport({ collectionRef: "synthetic-root", actorId: "actor-1" }, {
      source,
      embeddings,
      repository: storage.repository,
    });

    expect(result).toEqual({
      status: "failed",
      batchId: "batch-1",
      errorCode: "IMPORT_PROVIDER_FETCH_FAILED",
      receivedCount: 1,
    });
    expect(storage.completed).toEqual([]);
    expect(storage.failed).toEqual([{ errorCode: "IMPORT_PROVIDER_FETCH_FAILED", receivedCount: 1 }]);
    expect(JSON.stringify(result)).not.toContain("provider body");
    expect("importedCount" in result).toBe(false);
  });

  it("diffs by source ref so re-import changes, unchanged rows and removals stay explicit", async () => {
    const prior = (sourceRef: string, responseTemplate: string): ExistingBrainEntry => ({
      id: `entry-${sourceRef}`,
      sourceRef,
      payload: {
        category: "Credit",
        inboundMessage: `${sourceRef} inbound`,
        responseTemplate,
        matchKeywords: [],
      },
    });
    const storage = importRepository([
      prior("unchanged", "Same response"),
      prior("changed", "Old response"),
      prior("removed", "Removed response"),
    ]);
    const source: FaqSourceDriver = {
      source: "mock",
      fetchFaqRows: async () => ({
        rows: [
          sourceRow({ id: "unchanged", category: ["Credit"], inbound: "unchanged inbound", response: "Same response" }),
          sourceRow({ id: "changed", category: ["Credit"], inbound: "changed inbound", response: "New response" }),
          sourceRow({ id: "new", category: ["Credit"], inbound: "new inbound", response: "New row" }),
        ],
        nextCursor: null,
        sourceEditedAt: null,
      }),
    };

    const result = await runBrainImport({ collectionRef: "synthetic-root", actorId: "actor-1" }, {
      source,
      embeddings,
      repository: storage.repository,
    });

    expect(result).toMatchObject({ status: "complete", counts: { unchanged: 1 } });
    expect(storage.completed[0].items.map(({ sourceRef, operation, afterPayload }) => ({
      sourceRef,
      operation,
      hasAfter: afterPayload !== null,
    }))).toEqual([
      { sourceRef: "unchanged", operation: "unchanged", hasAfter: true },
      { sourceRef: "changed", operation: "changed", hasAfter: true },
      { sourceRef: "new", operation: "new", hasAfter: true },
      { sourceRef: "removed", operation: "removed", hasAfter: false },
    ]);
  });
});
