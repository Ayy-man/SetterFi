import { describe, expect, it } from "vitest";

import {
  answerFromCitation,
  sortRetrievalCitations,
  verifyCitationDeclaration,
} from "@/lib/engine/retrieval";
import type { RetrievalCitation } from "@/lib/engine/types";

const CITATIONS: RetrievalCitation[] = [
  {
    entryId: "entry-b",
    content: "Second stable entry.",
    similarity: 0.8,
    categoryBoost: 0,
    score: 0.8,
    categoryAgreement: false,
  },
  {
    entryId: "entry-a",
    content: "First stable entry.",
    similarity: 0.75,
    categoryBoost: 0.05,
    score: 0.8,
    categoryAgreement: true,
  },
];

describe("retrieval receipt helpers", () => {
  it("uses stable entry id as the tie-break without re-scoring database results", () => {
    expect(sortRetrievalCitations(CITATIONS).map((entry) => entry.entryId)).toEqual([
      "entry-a",
      "entry-b",
    ]);
    expect(answerFromCitation(CITATIONS)).toEqual({
      answer: "First stable entry.",
      entryId: "entry-a",
    });
  });

  it("verifies only declarations in the exact prompt candidate set", () => {
    expect(verifyCitationDeclaration("entry-a", ["entry-a", "entry-b"])).toBe(true);
    expect(verifyCitationDeclaration("invented", ["entry-a", "entry-b"])).toBe(false);
    expect(verifyCitationDeclaration("dropped-entry", ["entry-a", "entry-b"])).toBe(false);
    expect(verifyCitationDeclaration(null, ["entry-a", "entry-b"])).toBe(false);
  });
});
