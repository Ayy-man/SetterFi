import { describe, expect, it } from "vitest";

import {
  loadBrainKnowledgePublishCounts,
  type BrainKnowledgeCountDependencies,
} from "@/lib/repositories/brain-knowledge-counts";

const entry = (id: string, responseTemplate = `Answer ${id}`) => ({
  id,
  disposition: "shared",
  status: "draft",
  hasEmbedding: true,
  category: "Credit",
  inboundMessage: `Question ${id}`,
  responseTemplate,
  matchKeywords: [],
});

describe("Brain knowledge publish counts", () => {
  it("reads the current snapshot's entries and compares them with the rows a publish would copy", async () => {
    const requested: string[] = [];
    const deps: BrainKnowledgeCountDependencies = {
      loadEligibleEntries: async () => [entry("a"), entry("b", "Edited since publish"), entry("c")],
      loadCurrentSnapshot: async () => ({ id: "snapshot-7", version: 7 }),
      loadSnapshotEntries: async (snapshotId) => {
        requested.push(snapshotId);
        return [
          { entryId: "a", category: "Credit", inboundMessage: "Question a", responseTemplate: "Answer a", matchKeywords: [] },
          { entryId: "b", category: "Credit", inboundMessage: "Question b", responseTemplate: "Answer b", matchKeywords: [] },
        ];
      },
    };
    await expect(loadBrainKnowledgePublishCounts(deps)).resolves.toEqual({
      inLiveSnapshot: 2,
      draftAwaitingPublish: 2,
      snapshotVersion: 7,
    });
    expect(requested).toEqual(["snapshot-7"]);
  });

  it("never asks for snapshot entries when nothing has been published", async () => {
    let asked = false;
    await expect(loadBrainKnowledgePublishCounts({
      loadEligibleEntries: async () => [entry("a")],
      loadCurrentSnapshot: async () => null,
      loadSnapshotEntries: async () => {
        asked = true;
        return [];
      },
    })).resolves.toEqual({ inLiveSnapshot: 0, draftAwaitingPublish: 1, snapshotVersion: null });
    expect(asked).toBe(false);
  });
});
