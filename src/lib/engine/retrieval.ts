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

const GROUNDING_STOPWORDS = new Set([
  "that", "this", "with", "your", "yours", "have", "from", "they", "them", "their", "there", "will",
  "what", "when", "where", "which", "about", "would", "could", "should", "been", "were", "into",
  "than", "then", "also", "just", "does", "only", "some", "more", "very", "much", "well", "like",
  "want", "need", "know", "mean", "sure", "yeah", "okay", "thanks", "please", "here", "still",
  "really", "actually", "though", "thing", "things", "make", "made", "take", "give", "help",
]);
const GROUNDING_MIN_SHARED = 3;
const GROUNDING_MIN_CONTAINMENT = 0.5;
const GROUNDING_SPAN_LENGTH = 32;

function groundingNormalized(text: string) {
  return text.normalize("NFKC").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, " ").trim().toLowerCase();
}

function groundingTokens(normalized: string) {
  return new Set((normalized.match(/[a-z]{4,}|\d{3,}/g) ?? []).filter((token) => !GROUNDING_STOPWORDS.has(token)));
}

function sharesSpan(reply: string, entry: string) {
  for (let index = 0; index + GROUNDING_SPAN_LENGTH <= reply.length; index += 1) {
    if (entry.includes(reply.slice(index, index + GROUNDING_SPAN_LENGTH))) return true;
  }
  return false;
}

export type GroundingMatch = { entryId: string; evidence: string };

/**
 * Which rendered entry a reply is drawn from, judged on the reply's own wording: at least half of
 * its content words (and never fewer than three) appear in the entry, or a run of 32 characters
 * is shared verbatim. Deterministic and conservative on purpose — it corrects a citation the model
 * mis-declared, so it must never invent grounding a reviewer could not see. Two entries that
 * ground the reply equally well leave it ungrounded, because a corrected citation that could name
 * either is a guess.
 */
export function groundingEntryFor(
  reply: string,
  rendered: readonly { entryId: string; content: string }[],
): GroundingMatch | null {
  const normalizedReply = groundingNormalized(reply);
  const replyTokens = groundingTokens(normalizedReply);
  const scored = rendered.map((entry) => {
    const normalizedEntry = groundingNormalized(entry.content);
    const entryTokens = groundingTokens(normalizedEntry);
    const shared = [...replyTokens].filter((token) => entryTokens.has(token)).length;
    const containment = replyTokens.size ? shared / replyTokens.size : 0;
    const span = sharesSpan(normalizedReply, normalizedEntry);
    const grounded = span || (shared >= GROUNDING_MIN_SHARED && containment >= GROUNDING_MIN_CONTAINMENT);
    return { entryId: entry.entryId, shared, containment, span, grounded };
  }).filter((candidate) => candidate.grounded);
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.shared - a.shared || Number(b.span) - Number(a.span) || b.containment - a.containment);
  const [best, runnerUp] = scored;
  if (runnerUp && runnerUp.shared === best.shared && runnerUp.span === best.span) return null;
  return {
    entryId: best.entryId,
    evidence: `${best.shared} of ${replyTokens.size} content words shared` +
      `${best.span ? `, a ${GROUNDING_SPAN_LENGTH}-character run shared verbatim` : ""}`,
  };
}

export function answerFromCitation(citations: readonly RetrievalCitation[]) {
  const citation = sortRetrievalCitations(citations)[0];
  return citation ? { answer: citation.content, entryId: citation.entryId } : null;
}
