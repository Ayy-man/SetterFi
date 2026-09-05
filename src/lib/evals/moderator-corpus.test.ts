import { describe, expect, it } from "vitest";

import {
  loadModeratorCorpus,
  MODERATOR_CASE_CATEGORIES,
  parseNumberAllowlistEntry,
} from "./moderator-corpus";

const SHARED_CONTEXT = {
  numberAllowlist: ["currency:297:offer_price:synthetic-price-1", "score:650:qualification_threshold:credit_min"],
  complianceLexicon: ["guarantee approval"],
  linkWhitelist: ["book.example-coaching.test"],
  roleBoundary: "credit and funding qualification only",
};

function syntheticCase(overrides: Record<string, unknown> = {}) {
  return {
    key: "synthetic:moderator:1",
    category: "qualification",
    leadMessage: "hey, saw your post",
    draft: "Thanks for reaching out. What's your credit score range?",
    expectation: { verdict: "allow" },
    ...overrides,
  };
}

function file(cases: unknown[], context: unknown = SHARED_CONTEXT) {
  return [{ suite: "moderator", context, cases }];
}

describe("moderator corpus (checked-in file)", () => {
  it("loads at least 40 cases with both verdicts in every covered category", () => {
    const { cases, revision } = loadModeratorCorpus();
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(revision).toMatch(/^[0-9a-f]{64}$/);

    const mixedCategories = MODERATOR_CASE_CATEGORIES.filter((category) =>
      !["lead_currency_echo", "length", "qualification", "unapproved_link"].includes(category));
    // unapproved_link and length are allow-only: both checks run deterministically before moderation.
    for (const category of mixedCategories) {
      const rows = cases.filter((testCase) => testCase.category === category);
      expect(rows.some((row) => row.expectation.verdict === "allow"), `${category} allow`).toBe(true);
      expect(rows.some((row) => row.expectation.verdict === "block"), `${category} block`).toBe(true);
    }
    expect(cases.filter((row) => row.category === "lead_currency_echo")
      .every((row) => row.expectation.verdict === "block")).toBe(true);
    expect(cases.filter((row) => row.category === "qualification")
      .every((row) => row.expectation.verdict === "allow")).toBe(true);
  });

  it("gives every case the production payload shape with allowlist entries in the pipeline format", () => {
    for (const testCase of loadModeratorCorpus().cases) {
      expect(Object.keys(testCase.payload).sort()).toEqual([
        "complianceLexicon", "draft", "leadMessage", "linkWhitelist", "numberAllowlist", "roleBoundary",
      ]);
      expect(testCase.payload.roleBoundary).toBe("credit and funding qualification only");
      for (const entry of testCase.payload.numberAllowlist) {
        expect(parseNumberAllowlistEntry(entry), entry).not.toBeNull();
      }
    }
  });

  it("keeps drafts SMS-shaped except the deliberate length case", () => {
    for (const testCase of loadModeratorCorpus().cases) {
      if (testCase.category === "length") continue;
      expect(testCase.payload.draft.length, testCase.key).toBeLessThanOrEqual(200);
    }
  });
});

describe("loadModeratorCorpus strict parsing", () => {
  it("accepts a valid entry and merges a per-case context over the shared one", () => {
    const loaded = loadModeratorCorpus(file([
      syntheticCase(),
      syntheticCase({
        key: "synthetic:moderator:2",
        category: "lead_score_reflection",
        expectation: { verdict: "block", class: "NUM" },
        context: { numberAllowlist: ["score:612:lead_message:synthetic-lead-1"] },
      }),
    ]));
    expect(loaded.cases).toHaveLength(2);
    expect(loaded.cases[0].payload.numberAllowlist).toEqual(SHARED_CONTEXT.numberAllowlist);
    expect(loaded.cases[1].payload.numberAllowlist).toEqual(["score:612:lead_message:synthetic-lead-1"]);
    expect(loaded.cases[1].payload.complianceLexicon).toEqual(["guarantee approval"]);
    expect(loaded.cases[1].expectation).toEqual({ verdict: "block", class: "NUM" });
  });

  it.each([
    ["missing key", syntheticCase({ key: "" }), "MODERATOR_CORPUS_INVALID:moderator:0:key"],
    ["unknown category", syntheticCase({ category: "vibes" }), "synthetic:moderator:1:category"],
    ["empty draft", syntheticCase({ draft: "  " }), "synthetic:moderator:1:draft"],
    ["missing lead message", syntheticCase({ leadMessage: undefined }), "synthetic:moderator:1:leadMessage"],
    ["invalid verdict", syntheticCase({ expectation: { verdict: "maybe" } }), "expectation.verdict"],
    ["block without class", syntheticCase({ expectation: { verdict: "block" } }), "expectation.class"],
    ["block with moderator-only class", syntheticCase({ expectation: { verdict: "block", class: "JUDGE" } }), "expectation.class"],
    ["allow with class", syntheticCase({ expectation: { verdict: "allow", class: "NUM" } }), "expectation.allow_has_class"],
    ["malformed allowlist entry", syntheticCase({ context: { numberAllowlist: ["297"] } }), "context.numberAllowlist[0]"],
    ["unknown source type", syntheticCase({ context: { numberAllowlist: ["currency:297:coach_note:x"] } }), "context.numberAllowlist[0]"],
    ["lead currency allowlisted", syntheticCase({ context: { numberAllowlist: ["currency:5000:lead_message:l1"] } }), "context.numberAllowlist[0]:lead_currency"],
    ["empty lexicon phrase", syntheticCase({ context: { complianceLexicon: [""] } }), "context.complianceLexicon"],
    ["blank note", syntheticCase({ note: " " }), "synthetic:moderator:1:note"],
  ])("refuses %s", (_label, entry, expected) => {
    expect(() => loadModeratorCorpus(file([entry]))).toThrow(expected);
  });

  it("refuses a missing context field when neither the case nor the file supplies it", () => {
    expect(() => loadModeratorCorpus(file([syntheticCase()], {
      numberAllowlist: [], complianceLexicon: [], linkWhitelist: [],
    }))).toThrow("synthetic:moderator:1:context.roleBoundary");
  });

  it("refuses duplicate keys, an empty file and a foreign suite", () => {
    expect(() => loadModeratorCorpus(file([syntheticCase(), syntheticCase()])))
      .toThrow("MODERATOR_CORPUS_INVALID:synthetic:moderator:1:duplicate_case_key");
    expect(() => loadModeratorCorpus(file([]))).toThrow("MODERATOR_CORPUS_INVALID:file:empty");
    expect(() => loadModeratorCorpus([{ suite: "pricing_discipline", cases: [syntheticCase()] }]))
      .toThrow("MODERATOR_CORPUS_INVALID:file:shape");
  });
});
