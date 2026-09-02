/**
 * Deterministic carrier-content screening for a website and the published offer.
 *
 * This intentionally favors recall over precision: a match pauses filing for recorded human
 * review, while an input hash change makes every prior acknowledgement stale by construction.
 */

import { createHash } from "node:crypto";

import type { ContentScreenMatch, ContentScreenResult } from "./contracts";

export type ContentScreenSource = {
  page: string;
  text: string;
};

export type ContentVocabularyEntry = {
  code: "credit_repair" | "direct_loan_marketing" | "debt_reduction" | "guaranteed_outcome";
  pattern: RegExp;
};

export const A2P_REFUSAL_VOCABULARY: readonly ContentVocabularyEntry[] = [
  { code: "credit_repair", pattern: /\b(?:credit repair|repair your credit|remove negative items?)\b/gi },
  { code: "direct_loan_marketing", pattern: /\b(?:loan approval|pre-approved loan|direct lending offer)\b/gi },
  { code: "debt_reduction", pattern: /\b(?:debt reduction|debt relief|debt consolidation)\b/gi },
  {
    code: "guaranteed_outcome",
    pattern: /\b(?:guarantee(?:d)? approval|guarantee(?:d)? funding|guarantee(?:d)? results?)\b/gi,
  },
] as const;

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizedPage(value: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error("A2P_CONTENT_PAGE_REQUIRED");
  return normalized;
}

export function contentScreenInputHash(sources: readonly ContentScreenSource[]) {
  if (sources.length === 0) throw new Error("A2P_CONTENT_SOURCE_REQUIRED");
  const normalized = sources.map((source) => ({
    page: normalizedPage(source.page),
    text: normalizedText(source.text),
  })).sort((left, right) => left.page.localeCompare(right.page));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function screenA2pContent(
  sources: readonly ContentScreenSource[],
  vocabulary: readonly ContentVocabularyEntry[] = A2P_REFUSAL_VOCABULARY,
): Pick<ContentScreenResult, "inputHash" | "state" | "matches"> {
  const matches: ContentScreenMatch[] = [];
  for (const source of sources) {
    const text = normalizedText(source.text);
    for (const entry of vocabulary) {
      const pattern = new RegExp(entry.pattern.source, entry.pattern.flags);
      for (const match of text.matchAll(pattern)) {
        matches.push({ phrase: match[0], page: normalizedPage(source.page) });
      }
    }
  }
  matches.sort((left, right) => left.page.localeCompare(right.page)
    || left.phrase.localeCompare(right.phrase));
  return {
    inputHash: contentScreenInputHash(sources),
    state: matches.length === 0 ? "clean" : "flagged",
    matches,
  };
}

export function contentScreenFilingGate(
  screen: ContentScreenResult,
  currentInputHash: string,
): { ready: true } | { ready: false; code: string } {
  if (screen.inputHash !== currentInputHash) return { ready: false, code: "A2P_CONTENT_SCREEN_STALE" };
  if (screen.state === "clean") return { ready: true };
  if (!screen.coachAcknowledgedAt) {
    return { ready: false, code: "A2P_CONTENT_ACKNOWLEDGEMENT_REQUIRED" };
  }
  if (!screen.adminConfirmedAt) {
    return { ready: false, code: "A2P_CONTENT_ADMIN_CONFIRMATION_REQUIRED" };
  }
  return { ready: true };
}
