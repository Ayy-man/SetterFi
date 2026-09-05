import { describe, expect, it } from "vitest";

import {
  acceptBrainImportItem,
  createBrainImportRepository,
  rejectBrainImportItem,
  type BrainImportPersistenceDependencies,
} from "@/lib/repositories/brain-import";

const TENANT = "30000000-0000-4000-8000-000000000010";

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
      tenantId: null,
      status: "draft",
      auditId: 17,
      action: "brain.import.accepted",
      entityId: "item-1",
    }),
    callReject: async () => ({ audit_id: 18 }),
    readRejection: async () => ({
      itemId: "item-1",
      decision: "rejected",
      auditId: 18,
      action: "brain.import.rejected",
      entityId: "item-1",
      reason: "Coach-specific copy with no shared equivalent.",
    }),
    ...overrides,
  };
}

const acceptedPayload = {
  category: "Credit",
  inboundMessage: "Synthetic inbound",
  responseTemplate: "Synthetic response",
  matchKeywords: [],
};

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
      p_tenant_id: null,
      p_number_bindings: [],
      p_embedding: expect.any(Array),
      p_actor_id: "actor-1",
    }]);
    expect(receipt).toEqual({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      disposition: "shared",
      tenantId: null,
      draftEntryId: "entry-1",
      auditId: 17,
      auditAction: "brain.import.accepted",
    });
  });

  it("refuses tenant_specific without a tenant, and a tenant on any other disposition, before any write", async () => {
    let saved = false;
    const untouched = dependencies({
      persistAcceptanceReview: async (input) => {
        saved = true;
        return { id: input.itemId };
      },
    });
    const base = {
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      afterPayload: acceptedPayload,
      flags: [],
      numberBindings: [],
      embedding: Array.from({ length: 1_536 }, () => 0),
      actorId: "actor-1",
    };
    await expect(acceptBrainImportItem({ ...base, disposition: "tenant_specific", tenantId: null }, untouched))
      .rejects.toThrow("BRAIN_IMPORT_TENANT_REQUIRED");
    await expect(acceptBrainImportItem({ ...base, disposition: "shared", tenantId: TENANT }, untouched))
      .rejects.toThrow("BRAIN_IMPORT_TENANT_NOT_ALLOWED");
    expect(saved).toBe(false);
  });

  it("routes a tenant_specific row to its tenant and verifies the tenant on the written entry", async () => {
    const calls: Record<string, unknown>[] = [];
    const receipt = await acceptBrainImportItem({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      disposition: "tenant_specific",
      tenantId: TENANT,
      afterPayload: acceptedPayload,
      flags: [],
      numberBindings: [],
      embedding: Array.from({ length: 1_536 }, () => 0),
      actorId: "actor-1",
    }, dependencies({
      callAccept: async (args) => {
        calls.push(args);
        return { knowledge_entry_id: "entry-1", audit_id: 17 };
      },
      readAcceptance: async () => ({
        entryId: "entry-1",
        sourceRef: "source-1",
        disposition: "tenant_specific",
        tenantId: TENANT,
        status: "draft",
        auditId: 17,
        action: "brain.import.accepted",
        entityId: "item-1",
      }),
    }));
    expect(calls[0]).toMatchObject({ p_disposition: "tenant_specific", p_tenant_id: TENANT });
    expect(receipt).toMatchObject({ disposition: "tenant_specific", tenantId: TENANT });

    await expect(acceptBrainImportItem({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      disposition: "tenant_specific",
      tenantId: TENANT,
      afterPayload: acceptedPayload,
      flags: [],
      numberBindings: [],
      embedding: Array.from({ length: 1_536 }, () => 0),
      actorId: "actor-1",
    }, dependencies({
      readAcceptance: async () => ({
        entryId: "entry-1",
        sourceRef: "source-1",
        disposition: "tenant_specific",
        tenantId: null,
        status: "draft",
        auditId: 17,
        action: "brain.import.accepted",
        entityId: "item-1",
      }),
    }))).rejects.toThrow("BRAIN_IMPORT_ACCEPT_READBACK_MISMATCH");
  });

  it("refuses a shared acceptance whose persisted content flag was not resolved by an edit", async () => {
    let called = false;
    await expect(acceptBrainImportItem({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      disposition: "shared",
      afterPayload: acceptedPayload,
      flags: [{
        id: "proof_claim:responseTemplate:0",
        code: "proof_claim",
        severity: "blocking",
        field: "responseTemplate",
        offset: 0,
        resolved: true,
        resolution: { kind: "admin_review", value: "shared" },
      }],
      numberBindings: [],
      embedding: Array.from({ length: 1_536 }, () => 0),
      actorId: "actor-1",
    }, dependencies({
      callAccept: async () => {
        called = true;
        return { knowledge_entry_id: "entry-1", audit_id: 17 };
      },
    }))).rejects.toThrow("BRAIN_IMPORT_CONTENT_FLAG_NOT_EDITED");
    expect(called).toBe(false);
  });

  it("records the batch brand list when a batch opens", async () => {
    const inserted: Record<string, unknown>[] = [];
    const repository = createBrainImportRepository(dependencies({
      insertBatch: async (row) => {
        inserted.push(row);
        return { id: "batch-1" };
      },
    }));
    await repository.createBatch({
      source: "mock",
      collectionRef: "synthetic",
      actorId: "actor-1",
      brandNames: ["Northwind Coaching"],
    });
    expect(inserted[0]).toMatchObject({ brand_names: ["Northwind Coaching"] });
  });
});

describe("Brain import rejection", () => {
  it("requires a reason and never calls the RPC without one", async () => {
    let called = false;
    await expect(rejectBrainImportItem({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      reason: "   ",
      actorId: "actor-1",
    }, dependencies({
      callReject: async () => {
        called = true;
        return { audit_id: 18 };
      },
    }))).rejects.toThrow("BRAIN_IMPORT_REJECT_REASON_REQUIRED");
    expect(called).toBe(false);
  });

  it("passes replay guards and the reason to the RPC and returns only the persisted receipt", async () => {
    const calls: Record<string, unknown>[] = [];
    const receipt = await rejectBrainImportItem({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      reason: "Coach-specific copy with no shared equivalent.",
      actorId: "actor-1",
    }, dependencies({
      callReject: async (args) => {
        calls.push(args);
        return { audit_id: 18 };
      },
    }));
    expect(calls).toEqual([{
      p_expected_batch_id: "batch-1",
      p_expected_source_ref: "source-1",
      p_item_id: "item-1",
      p_reason: "Coach-specific copy with no shared equivalent.",
      p_actor_id: "actor-1",
    }]);
    expect(receipt).toEqual({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      decision: "rejected",
      auditId: 18,
      auditAction: "brain.import.rejected",
    });
  });

  it("refuses to report a rejection the readback does not confirm", async () => {
    await expect(rejectBrainImportItem({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      reason: "Duplicate of an existing row.",
      actorId: "actor-1",
    }, dependencies({
      readRejection: async () => ({
        itemId: "item-1",
        decision: "pending",
        auditId: 18,
        action: "brain.import.rejected",
        entityId: "item-1",
        reason: "Duplicate of an existing row.",
      }),
    }))).rejects.toThrow("BRAIN_IMPORT_REJECT_READBACK_MISMATCH");
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
