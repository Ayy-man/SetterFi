/**
 * Cursor-complete orchestration for Brain FAQ imports.
 *
 * A batch opens before the first provider call and becomes reviewable only after every cursor,
 * normalized count, inbound-only embedding, source diff, and persisted item reconciles.
 */

import { createHash } from "node:crypto";

import { PLACEHOLDER_REGISTRY } from "@/lib/brain/placeholders";
import type {
  BrainImportBatchItem,
  BrainImportRepository,
  BrainImportSource,
  ExistingBrainEntry,
} from "@/lib/repositories/brain-import";

import {
  embeddingRequests,
  normalizeImport,
  type NormalizedImportItem,
  type NormalizedImportPayload,
  type PlaceholderRegistry,
} from "./normalize";

export type FaqSourceDriver = {
  source: BrainImportSource;
  fetchFaqRows(input: { rootId: string; cursor?: string }): Promise<{
    rows: readonly unknown[];
    nextCursor: string | null;
    sourceEditedAt: string | null;
  }>;
};

export type ImportEmbeddingsDriver = {
  model: string;
  dimensions: 1_536;
  embed(input: readonly { id: string; text: string }[]): Promise<readonly {
    id: string;
    vector: readonly number[];
  }[]>;
};

export type BrainImportResult =
  | {
      status: "complete";
      batchId: string;
      importedCount: number;
      counts: { received: number; normalized: number; flagged: number; unchanged: number };
      sourceHash: string;
    }
  | {
      status: "failed";
      batchId: string;
      errorCode: string;
      receivedCount: number;
    };

const MAX_IMPORT_PAGES = 1_000;

function payload(item: NormalizedImportItem): NormalizedImportPayload {
  return {
    category: item.category,
    inboundMessage: item.inboundMessage,
    responseTemplate: item.responseTemplate,
    matchKeywords: item.matchKeywords,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function samePayload(left: NormalizedImportPayload, right: NormalizedImportPayload) {
  return canonical(left) === canonical(right);
}

function sourceHash(items: readonly NormalizedImportItem[]) {
  const current = [...items]
    .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef))
    .map((item) => ({ sourceRef: item.sourceRef, payload: payload(item) }));
  return createHash("sha256").update(canonical(current)).digest("hex");
}

function latestEditedAt(values: readonly (string | null)[]) {
  return values.filter((value): value is string => value !== null).sort().at(-1) ?? null;
}

function diffItems(
  normalized: readonly NormalizedImportItem[],
  existing: readonly ExistingBrainEntry[],
) {
  const existingByRef = new Map(existing.map((entry) => [entry.sourceRef, entry]));
  const currentRefs = new Set(normalized.map((item) => item.sourceRef));
  const items: BrainImportBatchItem[] = normalized.map((item) => {
    const prior = existingByRef.get(item.sourceRef);
    const afterPayload = payload(item);
    return {
      sourceRef: item.sourceRef,
      operation: !prior ? "new" as const : samePayload(prior.payload, afterPayload) ? "unchanged" as const : "changed" as const,
      beforePayload: prior?.payload ?? null,
      afterPayload,
      flags: item.flags,
      embedding: null,
    };
  });
  for (const prior of existing) {
    if (currentRefs.has(prior.sourceRef)) continue;
    items.push({
      sourceRef: prior.sourceRef,
      operation: "removed",
      beforePayload: prior.payload,
      afterPayload: null,
      flags: [],
      embedding: null,
    });
  }
  return items;
}

function embeddingMap(results: readonly { id: string; vector: readonly number[] }[]) {
  const vectors = new Map<string, readonly number[]>();
  for (const result of results) {
    if (vectors.has(result.id) || result.vector.length !== 1_536 || result.vector.some((value) => !Number.isFinite(value))) {
      throw new Error("IMPORT_EMBEDDING_RESULT_INVALID");
    }
    vectors.set(result.id, result.vector);
  }
  return vectors;
}

function errorCode(stage: string, error: unknown) {
  if (error instanceof Error && /^IMPORT_[A-Z0-9_]+$/.test(error.message)) return error.message;
  return stage;
}

export async function runBrainImport(
  input: { collectionRef: string; actorId: string },
  dependencies: {
    source: FaqSourceDriver;
    embeddings: ImportEmbeddingsDriver;
    repository: BrainImportRepository;
    registry?: PlaceholderRegistry;
  },
): Promise<BrainImportResult> {
  const { batchId } = await dependencies.repository.createBatch({
    source: dependencies.source.source,
    collectionRef: input.collectionRef,
    actorId: input.actorId,
  });
  const rows: unknown[] = [];
  const editedAt: Array<string | null> = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  let stage = "IMPORT_PROVIDER_FETCH_FAILED";

  try {
    do {
      pageCount += 1;
      if (pageCount > MAX_IMPORT_PAGES) throw new Error("IMPORT_PAGE_LIMIT_EXCEEDED");
      const page = await dependencies.source.fetchFaqRows({ rootId: input.collectionRef, cursor });
      rows.push(...page.rows);
      editedAt.push(page.sourceEditedAt);
      if (page.nextCursor === null) {
        cursor = undefined;
        break;
      }
      if (cursors.has(page.nextCursor)) throw new Error("IMPORT_CURSOR_LOOP");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    stage = "IMPORT_NORMALIZATION_FAILED";
    const normalized = normalizeImport(rows, dependencies.registry ?? PLACEHOLDER_REGISTRY);
    const refs = normalized.items.map((item) => item.sourceRef);
    if (new Set(refs).size !== refs.length) throw new Error("IMPORT_DUPLICATE_SOURCE_REF");

    stage = "IMPORT_EXISTING_READ_FAILED";
    const existing = await dependencies.repository.loadExisting(dependencies.source.source);
    const items = diffItems(normalized.items, existing);
    const embeddableIds = new Set(items
      .filter((item) => item.operation === "new" || item.operation === "changed")
      .map((item) => item.sourceRef));
    const requests = embeddingRequests(normalized.items).filter((request) => embeddableIds.has(request.id));

    stage = "IMPORT_EMBEDDING_FAILED";
    const vectors = embeddingMap(requests.length > 0 ? await dependencies.embeddings.embed(requests) : []);
    if (requests.some((request) => !vectors.has(request.id))) {
      throw new Error("IMPORT_EMBEDDING_RESULT_MISSING");
    }
    const persistedItems = items.map((item) => ({
      ...item,
      embedding: item.operation === "new" || item.operation === "changed"
        ? vectors.get(item.sourceRef) ?? null
        : null,
    }));
    const counts = {
      ...normalized.counts,
      unchanged: persistedItems.filter((item) => item.operation === "unchanged").length,
    };

    stage = "IMPORT_BATCH_PERSIST_FAILED";
    const hash = sourceHash(normalized.items);
    await dependencies.repository.completeBatch({
      batchId,
      sourceHash: hash,
      sourceEditedAt: latestEditedAt(editedAt),
      counts,
      items: persistedItems,
    });
    return {
      status: "complete",
      batchId,
      importedCount: counts.received,
      counts,
      sourceHash: hash,
    };
  } catch (error) {
    const code = errorCode(stage, error);
    await dependencies.repository.failBatch({ batchId, errorCode: code, receivedCount: rows.length });
    return { status: "failed", batchId, errorCode: code, receivedCount: rows.length };
  }
}
