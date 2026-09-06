/**
 * A `PublishedRuntimeBundle` for either the live Brain snapshot or the current unpublished draft.
 *
 * The live revision is exactly what every production turn loads. The draft revision reuses the
 * same loader with one reader swapped: the current draft row is presented as the snapshot the
 * bundle parser expects, so the offer, tenant, calendar and qualification reads stay the
 * production ones and a draft cannot be tested against anything but the coach's published offer.
 *
 * Retrieval is the one place a draft cannot ride the production path. `match_published_brain_entries`
 * refuses any snapshot id but the current one, so the draft revision ranks, in process, the very
 * rows `publish_brain_draft` would copy into a snapshot (shared, staged, embedded), with the same
 * scoring, ordering and tenant rendering. Objections are not evaluated for a draft: their runtime
 * rows exist only on published snapshots, and reporting "no objection matched" for a draft would
 * be indistinguishable from a miss.
 */

import type { KnowledgeNumberBinding, PublishedRuntimeBundle, RetrievalCandidate } from "@/lib/brain/contracts";
import { PLACEHOLDER_REGISTRY } from "@/lib/brain/placeholders";
import { knowledgeNumberBindings, rewriteHash } from "@/lib/brain/provenance";
import { renderCandidates } from "@/lib/brain/render-placeholders";
import {
  DEFAULT_RETRIEVAL_SIMILARITY_FLOOR,
  type RetrieveForTurnInput,
  type TurnRetrievalResult,
} from "@/lib/brain/retrieval";
import { resolveEmbeddingsDriver } from "@/lib/integrations/embeddings/selector";
import type { EmbeddingsDriver } from "@/lib/integrations/embeddings/types";
import type { BrainDraftRevision } from "@/lib/repositories/brain-publish";
import {
  liveBrainRuntimeDependencies,
  loadPublishedRuntimeBundle,
  type BrainRuntimeDependencies,
} from "@/lib/repositories/brain-runtime";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const BRAIN_REVISIONS = ["draft", "live"] as const;
export type BrainRevision = (typeof BRAIN_REVISIONS)[number];

export type RetrieveForTurn = (input: RetrieveForTurnInput) => Promise<TurnRetrievalResult>;

export type RevisionRuntime = {
  revision: BrainRevision;
  bundle: PublishedRuntimeBundle;
  /** How this revision's candidates are found; the draft path is explained in the module header. */
  retrievalMode: "published_snapshot" | "draft_in_process";
  /** Set for the draft revision; the live revision leaves the engine on its default retriever. */
  retrieve: RetrieveForTurn | null;
  draftId: string | null;
};

export type DraftKnowledgeRow = {
  id: string;
  category: string;
  responseTemplate: string;
  embedding: readonly number[];
  /** Reviewed figure bindings, as the accept step recorded them; empty for a legacy row. */
  numberBindings: readonly KnowledgeNumberBinding[];
  /** sha256 of the reviewed text, or null when the row predates provenance. */
  rewriteHash: string | null;
};

export type BrainRevisionDependencies = {
  runtime: BrainRuntimeDependencies;
  loadLatestDraft(): Promise<BrainDraftRevision | null>;
  loadDraftKnowledge(): Promise<readonly DraftKnowledgeRow[]>;
  embeddings(): EmbeddingsDriver;
};

const PROMPT_CANDIDATE_LIMIT = 5;
const RETRIEVAL_CANDIDATE_LIMIT = 50;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The draft row in the shape `loadPublishedRuntimeBundle` parses. The version is the one a
 * publish would mint, so a trace from a draft turn reads "version 8" beside a live "version 7"
 * rather than colliding with it.
 */
export function draftSnapshotRow(draft: BrainDraftRevision, currentVersion: number) {
  const payload = draft.payload;
  const sourceHash = typeof payload.sourceHash === "string" && HASH_PATTERN.test(payload.sourceHash)
    ? payload.sourceHash
    : draft.contentHash;
  return {
    id: draft.id,
    version: currentVersion + 1,
    content_hash: draft.contentHash,
    source_hash: sourceHash,
    payload,
    compiled_platform: payload.compiledPlatform,
    platform_tokens: payload.platformTokens,
    knowledge_mode: payload.knowledgeMode,
  };
}

function cosineSimilarity(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length || left.length === 0) throw new Error("BRAIN_DRAFT_EMBEDDING_DIMENSIONS");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** Mirrors `match_published_brain_entries`: similarity plus a 0.05 category boost, stable order. */
export function rankDraftCandidates(input: {
  queryEmbedding: readonly number[];
  rows: readonly DraftKnowledgeRow[];
  categoryHint: string | null;
  limit?: number;
}): RetrievalCandidate[] {
  const hint = input.categoryHint?.trim().toLowerCase() || null;
  const ranked = input.rows.map((row) => {
    const similarity = cosineSimilarity(input.queryEmbedding, row.embedding);
    const categoryBoost = hint && row.category.trim().toLowerCase() === hint ? 0.05 : 0;
    return {
      entryId: row.id,
      category: row.category,
      responseTemplate: row.responseTemplate,
      numberBindings: row.numberBindings,
      rewriteHash: row.rewriteHash,
      // Draft rows are ranked on their own question only; variants are copied at publish.
      matchedVariant: null,
      similarity,
      categoryBoost,
      score: similarity + categoryBoost,
    };
  });
  ranked.sort((left, right) => right.score - left.score || left.entryId.localeCompare(right.entryId));
  return ranked.slice(0, input.limit ?? RETRIEVAL_CANDIDATE_LIMIT);
}

export function createDraftRetriever(dependencies: {
  loadDraftKnowledge(): Promise<readonly DraftKnowledgeRow[]>;
  embeddings(): EmbeddingsDriver;
}): RetrieveForTurn {
  return async (input) => {
    const inboundMessage = input.inboundMessage.trim();
    if (!inboundMessage) throw new Error("BRAIN_RETRIEVAL_INBOUND_REQUIRED");
    const limit = input.limit ?? PROMPT_CANDIDATE_LIMIT;
    const [embedded, rows] = await Promise.all([
      dependencies.embeddings().embed([{ id: "current-inbound", text: inboundMessage }]),
      dependencies.loadDraftKnowledge(),
    ]);
    if (embedded.length !== 1 || embedded[0].id !== "current-inbound") {
      throw new Error("BRAIN_RETRIEVAL_EMBEDDING_INVALID");
    }
    const candidates = rankDraftCandidates({
      queryEmbedding: embedded[0].vector,
      rows,
      categoryHint: input.categoryHint ?? null,
    });
    const rendered = renderCandidates({
      candidates,
      offer: input.offer,
      registry: input.registry ?? PLACEHOLDER_REGISTRY,
      renderSources: input.renderSources,
    });
    // The same floor and the same typed miss as the published path, so a draft test turn holds
    // on a no-match exactly where a live turn would.
    const floor = input.similarityFloor ?? DEFAULT_RETRIEVAL_SIMILARITY_FLOOR;
    if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0 || floor > 1) {
      throw new Error("BRAIN_RETRIEVAL_FLOOR_INVALID");
    }
    const included = rendered.included.filter((candidate) => candidate.similarity >= floor).slice(0, limit);
    if (included.length === 0) {
      const ranked = rendered.included.slice(0, limit);
      return {
        kind: "no_grounded_answer",
        reason: ranked.length === 0 ? "nothing_renderable" : "below_floor",
        floor,
        bestSimilarity: ranked[0]?.similarity ?? null,
        ranked,
        included: [],
        dropped: rendered.dropped,
      };
    }
    return { kind: "grounded", included, dropped: rendered.dropped };
  };
}

export async function loadRevisionRuntime(
  input: { tenantId: string; revision: BrainRevision },
  dependencies: BrainRevisionDependencies = liveBrainRevisionDependencies(),
): Promise<RevisionRuntime> {
  if (input.revision === "live") {
    const bundle = await loadPublishedRuntimeBundle(input.tenantId, dependencies.runtime);
    return { revision: "live", bundle, retrievalMode: "published_snapshot", retrieve: null, draftId: null };
  }
  const [draft, current] = await Promise.all([
    dependencies.loadLatestDraft(),
    dependencies.runtime.loadCurrentSnapshot(),
  ]);
  if (!draft) throw new Error("BRAIN_DRAFT_NOT_FOUND");
  const currentVersion = isRecord(current) && Number.isInteger(current.version) ? Number(current.version) : 0;
  const bundle = await loadPublishedRuntimeBundle(input.tenantId, {
    ...dependencies.runtime,
    loadCurrentSnapshot: async () => draftSnapshotRow(draft, currentVersion),
  });
  return {
    revision: "draft",
    bundle,
    retrievalMode: "draft_in_process",
    retrieve: createDraftRetriever(dependencies),
    draftId: draft.id,
  };
}

function parseEmbedding(value: unknown): readonly number[] | null {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    return null;
  }
  return parsed as number[];
}

export function liveBrainRevisionDependencies(): BrainRevisionDependencies {
  const client = createSupabaseServiceClient();
  return {
    runtime: liveBrainRuntimeDependencies(),
    loadLatestDraft: async () => {
      const { data, error } = await client.from("brain_draft_versions")
        .select("id,content_hash,payload,created_by")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`BRAIN_DRAFT_READ_FAILED:${error.message}`);
      if (!data) return null;
      return {
        id: data.id,
        contentHash: data.content_hash,
        payload: data.payload as Readonly<Record<string, unknown>>,
        createdBy: data.created_by,
      };
    },
    // The same predicate `publish_brain_draft` uses to fill `brain_snapshot_entries`.
    loadDraftKnowledge: async () => {
      const { data, error } = await client.from("brain_knowledge_entries")
        .select("id,category,response_template,embedding,number_bindings,rewrite_hash")
        .eq("disposition", "shared")
        .eq("status", "draft")
        .not("embedding", "is", null)
        .order("id", { ascending: true });
      if (error) throw new Error(`BRAIN_DRAFT_KNOWLEDGE_READ_FAILED:${error.message}`);
      return (data ?? []).flatMap((row) => {
        const embedding = parseEmbedding(row.embedding);
        return embedding && typeof row.response_template === "string" && row.response_template.trim()
          ? [{
              id: String(row.id),
              category: String(row.category),
              responseTemplate: row.response_template,
              embedding,
              numberBindings: knowledgeNumberBindings(row.number_bindings),
              rewriteHash: typeof row.rewrite_hash === "string" ? row.rewrite_hash : rewriteHash(row.response_template),
            }]
          : [];
      });
    },
    embeddings: () => resolveEmbeddingsDriver(),
  };
}
