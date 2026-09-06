import { describe, expect, it } from "vitest";

import {
  answerFromCitation,
  groundingEntryFor,
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

describe("groundingEntryFor", () => {
  const RENDERED = [
    { entryId: "entry-fee", content: "The readiness review is $297 and a 640 score is the usual starting point." },
    { entryId: "entry-timing", content: "Most files fund within the target range in about 45 days once the paperwork is complete." },
    { entryId: "entry-link", content: "The application link is on the booking page; open it from the confirmation email." },
  ];

  it("names the rendered entry whose wording the reply is drawn from", () => {
    expect(groundingEntryFor("Yes, there is a readiness review fee of $297, and that is the usual starting point.", RENDERED))
      .toMatchObject({ entryId: "entry-fee" });
    expect(groundingEntryFor("The application link is on the booking page, in your confirmation email.", RENDERED))
      .toMatchObject({ entryId: "entry-link" });
  });

  it("answers null when no rendered entry grounds the reply, or two ground it equally", () => {
    expect(groundingEntryFor("Happy to help with whatever you need today, what are you thinking?", RENDERED)).toBeNull();
    expect(groundingEntryFor("Sure.", RENDERED)).toBeNull();
    expect(groundingEntryFor("Readiness review, paperwork complete.", [
      { entryId: "one", content: "Readiness review paperwork complete." },
      { entryId: "two", content: "Readiness review paperwork complete." },
    ])).toBeNull();
    expect(groundingEntryFor("Anything at all.", [])).toBeNull();
  });
});
