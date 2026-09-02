/**
 * Published-snapshot retrieval for one inbound lead turn.
 *
 * Only the inbound body crosses the embedding boundary. The database owns similarity, category
 * boost, current-snapshot enforcement and stable ordering; tenant placeholders resolve afterward.
 */

import {
  PLACEHOLDER_REGISTRY,
} from "@/lib/brain/placeholders";
import { renderCandidates } from "@/lib/brain/render-placeholders";
import {
  BRAIN_OBJECTION_CATEGORIES,
  type BrainObjectionCategory,
  type DroppedCandidate,
  type ObjectionCandidate,
  type PublishedCoachOffer,
  type PublishedRuntimeBundle,
  type RenderedCandidate,
  type RetrievalCandidate,
} from "@/lib/brain/contracts";
import { brainObjectionsLive } from "@/lib/env-contract";
import { resolveEmbeddingsDriver } from "@/lib/integrations/embeddings/selector";
import type { EmbeddingsDriver } from "@/lib/integrations/embeddings/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const PROMPT_CANDIDATE_LIMIT = 5;
const RETRIEVAL_CANDIDATE_LIMIT = 50;
export const OBJECTION_CANDIDATE_LIMIT = 3;

export type BrainRetrievalRepository = {
  matchPublished(input: {
    expectedSnapshotId: string;
    queryEmbedding: readonly number[];
    categoryHint: string | null;
    limit: number;
  }): Promise<readonly unknown[]>;
  /**
   * Optional so a caller that will never turn the objection flag on — every pre-Phase-10 test
   * fixture — still satisfies the contract. When the flag is on and this is absent,
   * `retrieveForTurn` fails closed rather than silently reporting "no objection matched", which
   * would be indistinguishable from a real miss in the 10-04 rollup.
   */
  matchObjections?(input: {
    expectedSnapshotId: string;
    inboundMessage: string;
    limit: number;
  }): Promise<readonly unknown[]>;
};

export type RetrieveForTurnInput = {
  snapshotId: string;
  inboundMessage: string;
  categoryHint?: string | null;
  offer: PublishedCoachOffer;
  renderSources: PublishedRuntimeBundle["renderSources"];
  registry?: unknown;
  limit?: number;
};

export type TurnRetrievalResult = {
  included: RenderedCandidate[];
  dropped: DroppedCandidate[];
  /**
   * Both keys are absent, not null, when the objection flag is off — the returned literal does not
   * grow them at all, so "flag off is byte-identical" is checkable on the shape rather than on a
   * value that happens to be null.
   */
  objection?: ObjectionCandidate | null;
  objectionCandidates?: readonly ObjectionCandidate[];
};

type CandidateRow = {
  entry_id?: unknown;
  category?: unknown;
  response_template?: unknown;
  similarity?: unknown;
  category_boost?: unknown;
  score?: unknown;
};

function finiteNumber(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(code);
  return value;
}

function candidateRow(value: unknown): RetrievalCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BRAIN_RETRIEVAL_ROW_INVALID");
  }
  const row = value as CandidateRow;
  if (
    typeof row.entry_id !== "string" || !row.entry_id.trim() ||
    typeof row.category !== "string" || !row.category.trim() ||
    typeof row.response_template !== "string" || !row.response_template.trim()
  ) throw new Error("BRAIN_RETRIEVAL_ROW_INVALID");
  const similarity = finiteNumber(row.similarity, "BRAIN_RETRIEVAL_SIMILARITY_INVALID");
  const categoryBoost = finiteNumber(row.category_boost, "BRAIN_RETRIEVAL_BOOST_INVALID");
  const score = finiteNumber(row.score, "BRAIN_RETRIEVAL_SCORE_INVALID");
  if (categoryBoost !== 0 && categoryBoost !== 0.05) {
    throw new Error("BRAIN_RETRIEVAL_BOOST_INVALID");
  }
  if (Math.abs(similarity + categoryBoost - score) > 1e-12) {
    throw new Error("BRAIN_RETRIEVAL_SCORE_INVALID");
  }
  return {
    entryId: row.entry_id,
    category: row.category,
    responseTemplate: row.response_template,
    similarity,
    categoryBoost,
    score,
  };
}

type ObjectionRow = {
  snapshot_id?: unknown;
  objection_id?: unknown;
  label?: unknown;
  response?: unknown;
  category?: unknown;
  hard_gate?: unknown;
  matched_keywords?: unknown;
  keyword_hits?: unknown;
};

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Same fail-closed posture as `candidateRow`: a malformed row is refused, never passed on. */
function objectionRow(value: unknown): ObjectionCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BRAIN_OBJECTION_ROW_INVALID");
  }
  const row = value as ObjectionRow;
  if (
    !nonEmptyString(row.snapshot_id) || !nonEmptyString(row.objection_id) ||
    !nonEmptyString(row.label) || !nonEmptyString(row.response) ||
    typeof row.hard_gate !== "boolean" ||
    !Array.isArray(row.matched_keywords) ||
    !row.matched_keywords.every((keyword) => typeof keyword === "string")
  ) throw new Error("BRAIN_OBJECTION_ROW_INVALID");
  if (
    typeof row.category !== "string" ||
    !BRAIN_OBJECTION_CATEGORIES.includes(row.category as BrainObjectionCategory)
  ) throw new Error("BRAIN_OBJECTION_ROW_INVALID");
  const keywordHits = row.keyword_hits;
  if (
    typeof keywordHits !== "number" || !Number.isInteger(keywordHits) || keywordHits < 1
  ) throw new Error("BRAIN_OBJECTION_ROW_INVALID");
  return {
    objectionId: row.objection_id as string,
    snapshotId: row.snapshot_id as string,
    label: row.label as string,
    response: row.response as string,
    category: row.category as BrainObjectionCategory,
    hardGate: row.hard_gate,
    matchedKeywords: row.matched_keywords as string[],
    keywordHits,
  };
}

function assertStableOrder(candidates: readonly RetrievalCandidate[]) {
  const ids = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (ids.has(candidate.entryId)) throw new Error("BRAIN_RETRIEVAL_ENTRY_DUPLICATE");
    ids.add(candidate.entryId);
    const previous = candidates[index - 1];
    if (
      previous &&
      (candidate.score > previous.score ||
        (candidate.score === previous.score && candidate.entryId.localeCompare(previous.entryId) < 0))
    ) throw new Error("BRAIN_RETRIEVAL_ORDER_INVALID");
  }
}

function liveRepository(): BrainRetrievalRepository {
  const client = createSupabaseServiceClient();
  return {
    matchPublished: async ({ expectedSnapshotId, queryEmbedding, categoryHint, limit }) => {
      const vector = `[${queryEmbedding.join(",")}]`;
      const { data, error } = await client.rpc("match_published_brain_entries", {
        p_expected_snapshot_id: expectedSnapshotId,
        p_query_embedding: vector,
        p_category_hint: categoryHint,
        p_limit: limit,
      });
      if (error) throw new Error(`BRAIN_RETRIEVAL_RPC_FAILED:${error.message}`);
      return data ?? [];
    },
    matchObjections: async ({ expectedSnapshotId, inboundMessage, limit }) => {
      const { data, error } = await client.rpc("match_published_brain_objections", {
        p_expected_snapshot_id: expectedSnapshotId,
        p_inbound_message: inboundMessage,
        p_limit: limit,
      });
      if (error) throw new Error(`BRAIN_OBJECTION_RPC_FAILED:${error.message}`);
      return data ?? [];
    },
  };
}

/** Retrieves and tenant-renders the prompt candidates for exactly one inbound body. */
export async function retrieveForTurn(
  input: RetrieveForTurnInput,
  dependencies: {
    embeddings?: EmbeddingsDriver;
    repository?: BrainRetrievalRepository;
    objectionsEnabled?: () => boolean;
  } = {},
): Promise<TurnRetrievalResult> {
  const snapshotId = input.snapshotId.trim();
  const inboundMessage = input.inboundMessage.trim();
  const limit = input.limit ?? PROMPT_CANDIDATE_LIMIT;
  if (!snapshotId) throw new Error("BRAIN_RETRIEVAL_SNAPSHOT_REQUIRED");
  if (!inboundMessage) throw new Error("BRAIN_RETRIEVAL_INBOUND_REQUIRED");
  if (!Number.isInteger(limit) || limit < 1 || limit > PROMPT_CANDIDATE_LIMIT) {
    throw new Error("BRAIN_RETRIEVAL_PROMPT_LIMIT_INVALID");
  }
  const embeddings = dependencies.embeddings ?? resolveEmbeddingsDriver();
  const embedded = await embeddings.embed([{ id: "current-inbound", text: inboundMessage }]);
  if (embedded.length !== 1 || embedded[0].id !== "current-inbound") {
    throw new Error("BRAIN_RETRIEVAL_EMBEDDING_INVALID");
  }
  const repository = dependencies.repository ?? liveRepository();
  const objectionsOn = (dependencies.objectionsEnabled ?? brainObjectionsLive)();
  if (objectionsOn && !repository.matchObjections) {
    throw new Error("BRAIN_OBJECTION_REPOSITORY_MISSING");
  }
  // One round trip of latency on a live turn instead of two. Both calls refuse a stale snapshot
  // identically, so which rejection wins the race does not change the observable error.
  const [rows, objectionRows] = await Promise.all([
    repository.matchPublished({
      expectedSnapshotId: snapshotId,
      queryEmbedding: embedded[0].vector,
      categoryHint: input.categoryHint?.trim() || null,
      // Pull the RPC's bounded maximum so required-placeholder drops can still refill the top five.
      limit: RETRIEVAL_CANDIDATE_LIMIT,
    }),
    objectionsOn && repository.matchObjections
      ? repository.matchObjections({
          expectedSnapshotId: snapshotId,
          inboundMessage,
          limit: OBJECTION_CANDIDATE_LIMIT,
        })
      : Promise.resolve(null),
  ]);
  // Validated before anything is composed, so a malformed row cannot reach a caller as undefined.
  // The database owns the ordering; re-ranking here would mint a second definition of "strongest
  // match" that could silently disagree with the one 10-04's rollup reads.
  const objectionCandidates = objectionRows ? objectionRows.map(objectionRow) : null;
  const candidates = rows.map(candidateRow);
  assertStableOrder(candidates);
  const rendered = renderCandidates({
    candidates,
    offer: input.offer,
    registry: input.registry ?? PLACEHOLDER_REGISTRY,
    renderSources: input.renderSources,
  });
  const included = rendered.included.slice(0, limit);
  if (included.length === 0) throw new Error("BRAIN_RETRIEVAL_NO_RENDERABLE_CANDIDATES");
  if (!objectionCandidates) return { included, dropped: rendered.dropped };
  return {
    included,
    dropped: rendered.dropped,
    objection: objectionCandidates[0] ?? null,
    objectionCandidates,
  };
}
