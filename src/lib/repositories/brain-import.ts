/**
 * Persistence boundary for Brain import batches and item acceptance.
 *
 * Service-role table writes only stage review data. The existing SQL RPC remains the sole path
 * that accepts an item, writes a draft entry, and records the audit row in one transaction.
 */

import type { ImportDisposition } from "@/lib/brain/contracts";
import type {
  ImportCounts,
  NormalizedImportPayload,
} from "@/lib/brain/import/normalize";
import type {
  ImportFlag,
  NumberBinding,
} from "@/lib/brain/import/flags";
import { allBlockingFlagsResolved } from "@/lib/brain/import/flags";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type BrainImportSource = "notion" | "offline" | "mock";
export type BrainImportOperation = "new" | "changed" | "unchanged" | "removed";

export type ExistingBrainEntry = {
  id: string;
  sourceRef: string;
  payload: NormalizedImportPayload;
};

export type BrainImportBatchItem = {
  sourceRef: string;
  operation: BrainImportOperation;
  beforePayload: NormalizedImportPayload | null;
  afterPayload: NormalizedImportPayload | null;
  flags: readonly ImportFlag[];
  embedding: readonly number[] | null;
};

export type BrainImportBatchReceipt = {
  batchId: string;
  completedAt: string;
  counts: ImportCounts;
  itemCount: number;
};

export type BrainImportAcceptanceReceipt = {
  batchId: string;
  itemId: string;
  sourceRef: string;
  disposition: ImportDisposition;
  draftEntryId: string;
  auditId: number;
  auditAction: "brain.import.accepted";
};

export type BrainImportRepository = {
  createBatch(input: {
    source: BrainImportSource;
    collectionRef: string;
    actorId: string;
  }): Promise<{ batchId: string }>;
  loadExisting(source: BrainImportSource): Promise<readonly ExistingBrainEntry[]>;
  completeBatch(input: {
    batchId: string;
    sourceHash: string;
    sourceEditedAt: string | null;
    counts: ImportCounts;
    items: readonly BrainImportBatchItem[];
  }): Promise<BrainImportBatchReceipt>;
  failBatch(input: {
    batchId: string;
    errorCode: string;
    receivedCount: number;
  }): Promise<void>;
};

type AcceptanceRpcRow = { knowledge_entry_id: string; audit_id: number };
type AcceptanceReadback = {
  entryId: string;
  sourceRef: string;
  disposition: ImportDisposition;
  status: string;
  auditId: number;
  action: string;
  entityId: string;
};

export type BrainImportPersistenceDependencies = {
  insertBatch(row: Record<string, unknown>): Promise<{ id: string }>;
  selectExisting(source: BrainImportSource): Promise<readonly ExistingBrainEntry[]>;
  insertItems(rows: readonly Record<string, unknown>[]): Promise<void>;
  updateBatch(
    batchId: string,
    expectedStatus: "open",
    patch: Record<string, unknown>,
  ): Promise<{ id: string; completed_at: string | null }>;
  persistAcceptanceReview(input: {
    batchId: string;
    itemId: string;
    sourceRef: string;
    disposition: ImportDisposition;
    afterPayload: NormalizedImportPayload;
    flags: readonly ImportFlag[];
    numberBindings: readonly NumberBinding[];
    embedding: readonly number[];
  }): Promise<{ id: string }>;
  callAccept(args: Record<string, unknown>): Promise<AcceptanceRpcRow>;
  readAcceptance(entryId: string, auditId: number): Promise<AcceptanceReadback>;
};

async function liveDependencies(): Promise<BrainImportPersistenceDependencies> {
  const client = createSupabaseServiceClient();
  return {
    insertBatch: async (row) => {
      const { data, error } = await client.from("brain_import_batches").insert(row).select("id").single();
      if (error || !data) throw new Error("BRAIN_IMPORT_BATCH_CREATE_FAILED");
      return { id: data.id };
    },
    selectExisting: async (source) => {
      const { data, error } = await client
        .from("brain_knowledge_entries")
        .select("id, source_ref, category, question, response_template, match_keywords")
        .eq("source", source)
        .not("source_ref", "is", null);
      if (error) throw new Error("BRAIN_IMPORT_EXISTING_READ_FAILED");
      return (data ?? []).map((row) => ({
        id: row.id,
        sourceRef: row.source_ref as string,
        payload: {
          category: row.category,
          inboundMessage: row.question,
          responseTemplate: row.response_template,
          matchKeywords: row.match_keywords,
        },
      }));
    },
    insertItems: async (rows) => {
      if (rows.length === 0) return;
      const { error } = await client.from("brain_import_items").insert(rows);
      if (error) throw new Error("BRAIN_IMPORT_ITEMS_WRITE_FAILED");
    },
    updateBatch: async (batchId, expectedStatus, patch) => {
      const { data, error } = await client
        .from("brain_import_batches")
        .update(patch)
        .eq("id", batchId)
        .eq("status", expectedStatus)
        .select("id, completed_at")
        .single();
      if (error || !data) throw new Error("BRAIN_IMPORT_BATCH_UPDATE_FAILED");
      return data;
    },
    persistAcceptanceReview: async (input) => {
      const { data, error } = await client
        .from("brain_import_items")
        .update({
          disposition: input.disposition,
          after_payload: { ...input.afterPayload, embedding: input.embedding },
          flags: input.flags,
          number_bindings: input.numberBindings,
        })
        .eq("id", input.itemId)
        .eq("batch_id", input.batchId)
        .eq("source_ref", input.sourceRef)
        .eq("decision", "pending")
        .select("id")
        .single();
      if (error || !data) throw new Error("BRAIN_IMPORT_REVIEW_SAVE_FAILED");
      return { id: data.id };
    },
    callAccept: async (args) => {
      const { data, error } = await client.rpc("accept_brain_import_item", args);
      const row = Array.isArray(data) ? data[0] : null;
      if (error || !row) throw new Error("BRAIN_IMPORT_ACCEPT_FAILED");
      return row as AcceptanceRpcRow;
    },
    readAcceptance: async (entryId, auditId) => {
      const [{ data: entry, error: entryError }, { data: audit, error: auditError }] = await Promise.all([
        client
          .from("brain_knowledge_entries")
          .select("id, source_ref, disposition, status")
          .eq("id", entryId)
          .single(),
        client
          .from("audit_log")
          .select("id, action, entity_id")
          .eq("id", auditId)
          .single(),
      ]);
      if (entryError || auditError || !entry || !audit) {
        throw new Error("BRAIN_IMPORT_ACCEPT_READBACK_FAILED");
      }
      return {
        entryId: entry.id,
        sourceRef: entry.source_ref as string,
        disposition: entry.disposition as ImportDisposition,
        status: entry.status,
        auditId: Number(audit.id),
        action: audit.action,
        entityId: audit.entity_id,
      };
    },
  };
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function batchItemRow(batchId: string, item: BrainImportBatchItem) {
  return {
    batch_id: batchId,
    source_ref: item.sourceRef,
    operation: item.operation,
    before_payload: item.beforePayload,
    after_payload: item.afterPayload
      ? { ...item.afterPayload, embedding: item.embedding }
      : null,
    flags: item.flags,
    disposition: null,
    number_bindings: [],
    decision: "pending",
  };
}

export function createBrainImportRepository(
  provided?: BrainImportPersistenceDependencies,
): BrainImportRepository {
  const dependencies = async () => provided ?? (await liveDependencies());
  return {
    createBatch: async (input) => {
      const deps = await dependencies();
      const created = await deps.insertBatch({
        source: input.source,
        collection_ref: required(input.collectionRef, "BRAIN_IMPORT_COLLECTION_REQUIRED"),
        source_hash: "0".repeat(64),
        source_edited_at: null,
        received_count: 0,
        normalized_count: 0,
        flagged_count: 0,
        unchanged_count: 0,
        status: "open",
        created_by: required(input.actorId, "BRAIN_IMPORT_ACTOR_REQUIRED"),
      });
      return { batchId: created.id };
    },
    loadExisting: async (source) => (await dependencies()).selectExisting(source),
    completeBatch: async (input) => {
      const deps = await dependencies();
      await deps.insertItems(input.items.map((item) => batchItemRow(input.batchId, item)));
      const completedAt = new Date().toISOString();
      const row = await deps.updateBatch(input.batchId, "open", {
        source_hash: input.sourceHash,
        source_edited_at: input.sourceEditedAt,
        received_count: input.counts.received,
        normalized_count: input.counts.normalized,
        flagged_count: input.counts.flagged,
        unchanged_count: input.counts.unchanged,
        completed_at: completedAt,
      });
      if (row.id !== input.batchId || !row.completed_at) {
        throw new Error("BRAIN_IMPORT_BATCH_READBACK_MISMATCH");
      }
      return {
        batchId: row.id,
        completedAt: row.completed_at,
        counts: input.counts,
        itemCount: input.items.length,
      };
    },
    failBatch: async (input) => {
      const deps = await dependencies();
      await deps.updateBatch(input.batchId, "open", {
        received_count: Math.max(0, input.receivedCount),
        normalized_count: 0,
        flagged_count: 0,
        unchanged_count: 0,
        status: "failed",
        completed_at: new Date().toISOString(),
        // The schema has no error text column. Keep the code in the caller result rather than
        // adding provider bodies or source text to a review row.
        source_hash: "0".repeat(64),
      });
    },
  };
}

export async function acceptBrainImportItem(
  input: {
    batchId: string;
    itemId: string;
    sourceRef: string;
    disposition: ImportDisposition;
    afterPayload: NormalizedImportPayload;
    flags: readonly ImportFlag[];
    numberBindings: readonly NumberBinding[];
    embedding: readonly number[];
    actorId: string;
  },
  provided?: BrainImportPersistenceDependencies,
): Promise<BrainImportAcceptanceReceipt> {
  const deps = provided ?? (await liveDependencies());
  if (input.embedding.length !== 1_536 || input.embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("BRAIN_IMPORT_EMBEDDING_INVALID");
  }
  if (!allBlockingFlagsResolved(input.flags)) {
    throw new Error("BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED");
  }
  const batchId = required(input.batchId, "BRAIN_IMPORT_BATCH_REQUIRED");
  const itemId = required(input.itemId, "BRAIN_IMPORT_ITEM_REQUIRED");
  const sourceRef = required(input.sourceRef, "BRAIN_IMPORT_SOURCE_REF_REQUIRED");
  const review = await deps.persistAcceptanceReview({
    batchId,
    itemId,
    sourceRef,
    disposition: input.disposition,
    afterPayload: input.afterPayload,
    flags: input.flags,
    numberBindings: input.numberBindings,
    embedding: input.embedding,
  });
  if (review.id !== itemId) throw new Error("BRAIN_IMPORT_REVIEW_READBACK_MISMATCH");
  const rpc = await deps.callAccept({
    p_expected_batch_id: batchId,
    p_expected_source_ref: sourceRef,
    p_item_id: itemId,
    p_disposition: input.disposition,
    p_number_bindings: input.numberBindings,
    p_embedding: input.embedding,
    p_actor_id: required(input.actorId, "BRAIN_IMPORT_ACTOR_REQUIRED"),
  });
  const readback = await deps.readAcceptance(rpc.knowledge_entry_id, rpc.audit_id);
  if (
    readback.entryId !== rpc.knowledge_entry_id
    || readback.sourceRef !== sourceRef
    || readback.disposition !== input.disposition
    || readback.status !== "draft"
    || readback.auditId !== rpc.audit_id
    || readback.action !== "brain.import.accepted"
    || readback.entityId !== itemId
  ) {
    throw new Error("BRAIN_IMPORT_ACCEPT_READBACK_MISMATCH");
  }
  return {
    batchId,
    itemId,
    sourceRef,
    disposition: input.disposition,
    draftEntryId: readback.entryId,
    auditId: readback.auditId,
    auditAction: "brain.import.accepted",
  };
}
