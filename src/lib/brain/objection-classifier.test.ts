import { describe, expect, it, vi } from "vitest";

import {
  noopObjectionClassifier,
  suggestObjectionMatch,
  type ObjectionClassificationInput,
  type ObjectionClassifier,
} from "./objection-classifier";

const INPUT: ObjectionClassificationInput = {
  tenantId: "tenant-1",
  conversationId: "conversation-1",
  unmatchedObjectionId: "objection-1",
  body: "I already tried a program like this and it didn't work",
};

describe("noopObjectionClassifier", () => {
  it("always declines", async () => {
    await expect(noopObjectionClassifier.classify(INPUT)).resolves.toBeNull();
  });
});

describe("suggestObjectionMatch", () => {
  it("declines without writing when the classifier declines", async () => {
    const client = { rpc: vi.fn() };
    const result = await suggestObjectionMatch(INPUT, noopObjectionClassifier, client);
    expect(result).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("writes a suggestion through the RPC when the classifier matches", async () => {
    const classifier: ObjectionClassifier = {
      async classify() {
        return { brainObjectionId: "brain-objection-1", confidence: 0.82, modelVersion: "stub-v1" };
      },
    };
    const client = { rpc: vi.fn(async () => ({ data: [{}], error: null })) };
    const result = await suggestObjectionMatch(INPUT, classifier, client);
    expect(result).toEqual({
      brainObjectionId: "brain-objection-1", confidence: 0.82, modelVersion: "stub-v1",
    });
    expect(client.rpc).toHaveBeenCalledWith("write_unmatched_objection_suggestion", {
      p_expected_tenant: "tenant-1",
      p_unmatched_objection_id: "objection-1",
      p_brain_objection_id: "brain-objection-1",
      p_confidence: 0.82,
      p_model_version: "stub-v1",
    });
  });

  it("rejects a suggestion with confidence outside 0..1 before writing", async () => {
    const classifier: ObjectionClassifier = {
      async classify() {
        return { brainObjectionId: "brain-objection-1", confidence: 1.4, modelVersion: "stub-v1" };
      },
    };
    const client = { rpc: vi.fn() };
    await expect(suggestObjectionMatch(INPUT, classifier, client))
      .rejects.toThrow("OBJECTION_SUGGESTION_SHAPE_INVALID");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("surfaces a write failure from the RPC", async () => {
    const classifier: ObjectionClassifier = {
      async classify() {
        return { brainObjectionId: "brain-objection-1", confidence: 0.5, modelVersion: "stub-v1" };
      },
    };
    const client = { rpc: vi.fn(async () => ({ data: null, error: { message: "boom" } })) };
    await expect(suggestObjectionMatch(INPUT, classifier, client))
      .rejects.toThrow("OBJECTION_SUGGESTION_WRITE_FAILED");
  });

  it("rejects a missing tenant or unmatched objection id before calling the classifier", async () => {
    const classifier: ObjectionClassifier = { classify: vi.fn() };
    const client = { rpc: vi.fn() };
    await expect(suggestObjectionMatch(
      { ...INPUT, tenantId: "" }, classifier, client,
    )).rejects.toThrow("OBJECTION_SUGGESTION_INPUT_INVALID");
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});
