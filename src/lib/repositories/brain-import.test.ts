import { describe, expect, it } from "vitest";

import {
  acceptBrainImportItem,
  createBrainImportRepository,
  type BrainImportPersistenceDependencies,
} from "@/lib/repositories/brain-import";

function dependencies(overrides: Partial<BrainImportPersistenceDependencies> = {}): BrainImportPersistenceDependencies {
  return {
    insertBatch: async () => ({ id: "batch-1" }),
    selectExisting: async () => [],
    insertItems: async () => undefined,
    updateBatch: async (batchId, _status, patch) => ({
      id: batchId,
      completed_at: typeof patch.completed_at === "string" ? patch.completed_at : null,
    }),
    persistAcceptanceReview: async (input) => ({ id: input.itemId }),
    callAccept: async () => ({ knowledge_entry_id: "entry-1", audit_id: 17 }),
    readAcceptance: async () => ({
      entryId: "entry-1",
      sourceRef: "source-1",
      disposition: "shared",
      status: "draft",
      auditId: 17,
      action: "brain.import.accepted",
      entityId: "item-1",
    }),
    ...overrides,
  };
}

describe("Brain import repository", () => {
  it("persists one reconciled review batch before returning a completion receipt", async () => {
    const inserted: Record<string, unknown>[] = [];
    const updates: Array<Record<string, unknown>> = [];
    const repository = createBrainImportRepository(dependencies({
      insertItems: async (rows) => void inserted.push(...rows),
      updateBatch: async (batchId, expectedStatus, patch) => {
        expect(expectedStatus).toBe("open");
        updates.push(patch);
        return { id: batchId, completed_at: patch.completed_at as string };
      },
    }));

    const receipt = await repository.completeBatch({
      batchId: "batch-1",
      sourceHash: "a".repeat(64),
      sourceEditedAt: "2026-08-17T01:00:00.000Z",
      counts: { received: 1, normalized: 1, flagged: 0, unchanged: 0 },
      items: [{
        sourceRef: "source-1",
        operation: "new",
        beforePayload: null,
        afterPayload: {
          category: "Credit",
          inboundMessage: "Synthetic inbound",
          responseTemplate: "Synthetic response",
          matchKeywords: [],
        },
        flags: [],
        embedding: Array.from({ length: 1_536 }, () => 0),
      }],
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ batch_id: "batch-1", source_ref: "source-1", operation: "new" });
    expect(updates[0]).toMatchObject({ received_count: 1, normalized_count: 1, completed_at: expect.any(String) });
    expect(receipt).toMatchObject({ batchId: "batch-1", itemCount: 1, counts: { received: 1 } });
  });

  it("passes replay guards to the RPC and returns only the persisted audit receipt", async () => {
    const calls: Record<string, unknown>[] = [];
    const reviews: Array<Record<string, unknown>> = [];
    const receipt = await acceptBrainImportItem({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      disposition: "shared",
      afterPayload: {
        category: "Credit",
        inboundMessage: "Synthetic inbound",
        responseTemplate: "Synthetic response",
        matchKeywords: [],
      },
      flags: [],
      numberBindings: [],
      embedding: Array.from({ length: 1_536 }, () => 0),
      actorId: "actor-1",
    }, dependencies({
      persistAcceptanceReview: async (input) => {
        reviews.push(input);
        return { id: input.itemId };
      },
      callAccept: async (args) => {
        calls.push(args);
        return { knowledge_entry_id: "entry-1", audit_id: 17 };
      },
    }));

    expect(reviews).toEqual([expect.objectContaining({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      disposition: "shared",
      afterPayload: expect.objectContaining({ responseTemplate: "Synthetic response" }),
      flags: [],
      numberBindings: [],
      embedding: expect.any(Array),
    })]);
    expect(calls).toEqual([{
      p_expected_batch_id: "batch-1",
      p_expected_source_ref: "source-1",
      p_item_id: "item-1",
      p_disposition: "shared",
      p_number_bindings: [],
      p_embedding: expect.any(Array),
      p_actor_id: "actor-1",
    }]);
    expect(receipt).toEqual({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      disposition: "shared",
      draftEntryId: "entry-1",
      auditId: 17,
      auditAction: "brain.import.accepted",
    });
  });

  it("refuses an invalid embedding before the acceptance RPC", async () => {
    let called = false;
    await expect(acceptBrainImportItem({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      disposition: "shared",
      afterPayload: {
        category: "Credit",
        inboundMessage: "Synthetic inbound",
        responseTemplate: "Synthetic response",
        matchKeywords: [],
      },
      flags: [],
      numberBindings: [],
      embedding: [1],
      actorId: "actor-1",
    }, dependencies({ callAccept: async () => {
      called = true;
      return { knowledge_entry_id: "entry-1", audit_id: 17 };
    } }))).rejects.toThrow("BRAIN_IMPORT_EMBEDDING_INVALID");
    expect(called).toBe(false);
  });

  it("refuses unresolved flags before saving review state or calling the RPC", async () => {
    let saved = false;
    let called = false;
    await expect(acceptBrainImportItem({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      disposition: "shared",
      afterPayload: {
        category: "Credit",
        inboundMessage: "Synthetic inbound",
        responseTemplate: "Synthetic response",
        matchKeywords: [],
      },
      flags: [{
        id: "bare_x:responseTemplate:10",
        code: "bare_x",
        severity: "blocking",
        field: "responseTemplate",
        offset: 10,
        resolved: false,
        resolution: null,
      }],
      numberBindings: [],
      embedding: Array.from({ length: 1_536 }, () => 0),
      actorId: "actor-1",
    }, dependencies({
      persistAcceptanceReview: async (input) => {
        saved = true;
        return { id: input.itemId };
      },
      callAccept: async () => {
        called = true;
        return { knowledge_entry_id: "entry-1", audit_id: 17 };
      },
    }))).rejects.toThrow("BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED");
    expect({ saved, called }).toEqual({ saved: false, called: false });
  });
});
