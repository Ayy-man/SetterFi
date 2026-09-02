/**
 * Pure ordering and citation-membership rules for already-ranked Brain candidates.
 *
 * Similarity and category boost belong to the published-snapshot RPC. This module deliberately
 * cannot score text, so the application cannot drift from the database's exact cosine contract.
 */

import type {
  PublishedBrainEntry,
  RetrievalCitation,
} from "@/lib/engine/types";

const LEGACY_TOKEN_PATTERN = /[a-z0-9]+/g;
const LEGACY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "does", "i", "is", "it", "the", "this", "to", "what",
]);

function legacyTokens(value: string) {
  return new Set(
    (value.toLowerCase().match(LEGACY_TOKEN_PATTERN) ?? [])
      .filter((token) => !LEGACY_STOP_WORDS.has(token)),
  );
}

/** Phase 1 OFF-arm compatibility; the Phase 2 path never calls this scorer. */
export function retrievePublishedEntries({
  query,
  entries,
  category,
  limit = 3,
}: {
  query: string;
  entries: readonly PublishedBrainEntry[];
  category?: string | null;
  limit?: number;
}): RetrievalCitation[] {
  const queryTokens = legacyTokens(query);
  return entries
    .filter((entry) => entry.published)
    .map((entry) => {
      const candidateTokens = legacyTokens(`${entry.question} ${entry.answer}`);
      let similarity = 0;
      for (const token of queryTokens) if (candidateTokens.has(token)) similarity += 1;
      const categoryAgreement = Boolean(category && entry.category === category);
      const categoryBoost = categoryAgreement ? 0.05 as const : 0 as const;
      return {
        entryId: entry.id,
        content: entry.answer,
        similarity,
        categoryBoost,
        // Preserve Phase 1's 0.25 scorer until Task 2 moves it wholly behind the OFF arm.
        score: similarity + (categoryAgreement ? 0.25 : 0),
        categoryAgreement,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort(compareRetrievalCitations)
    .slice(0, limit);
}

export function compareRetrievalCitations(
  left: Pick<RetrievalCitation, "entryId" | "score">,
  right: Pick<RetrievalCitation, "entryId" | "score">,
) {
  return right.score - left.score || left.entryId.localeCompare(right.entryId);
}

export function sortRetrievalCitations(citations: readonly RetrievalCitation[]) {
  return [...citations].sort(compareRetrievalCitations);
}

export function verifyCitationDeclaration(
  declaredEntryId: string | null,
  promptCandidateIds: readonly string[],
) {
  if (!declaredEntryId) return false;
  return new Set(promptCandidateIds).has(declaredEntryId);
}

export function answerFromCitation(citations: readonly RetrievalCitation[]) {
  const citation = sortRetrievalCitations(citations)[0];
  return citation ? { answer: citation.content, entryId: citation.entryId } : null;
}
