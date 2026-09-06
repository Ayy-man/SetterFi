import { describe, expect, it, vi } from "vitest";

import { loadRetrievalCorpus, RETRIEVAL_SUITE } from "./retrieval-corpus";
import {
  classifyRetrievalResult,
  createFakeRetrievalArm,
  FAKE_ARM_SNAPSHOT_ID,
  lexicalTokens,
  RETRIEVAL_CASE_OUTCOMES,
  runRetrievalCorpus,
  summarizeRetrievalReports,
  type RetrievalArm,
  type RetrievalCaseReport,
} from "./retrieval-executor";

function report(overrides: Partial<RetrievalCaseReport>): RetrievalCaseReport {
  return {
    key: "synthetic", channel: null, expected: { kind: "entry", entryQuestion: "q" },
    outcome: "hit_at_1", passed: true, expectedRank: 1, includedEntryIds: ["e1"], invalidCitations: [],
    droppedCount: 0, error: null, latencyMs: 0, ...overrides,
  };
}

const CONTEXT = { suite: RETRIEVAL_SUITE, arm: "synthetic", snapshotId: "snapshot", corpusRevision: "r" } as const;

describe("retrieval integration executor", () => {
  it("runs the checked-in corpus through the real pipeline on the fake arm and scores every case", async () => {
    const corpus = loadRetrievalCorpus();
    const run = await runRetrievalCorpus(createFakeRetrievalArm(corpus), corpus);
    expect(run.summary.arm).toBe("fake-lexical");
    expect(run.summary.cases).toBe(corpus.cases.length);
    expect(run.summary.expectedEntryCases + run.summary.expectedNoMatchCases).toBe(corpus.cases.length);
    expect(run.summary.outcomes.unresolvable).toBe(0);
    expect(run.summary.outcomes.error).toBe(0);
    // The fake is lexical; these are the cases it must get right for the suite to mean anything.
    const byKey = new Map(run.reports.map((entry) => [entry.key, entry]));
    expect(byKey.get("retrieval:program:cost")?.outcome).toBe("hit_at_1");
    expect(byKey.get("retrieval:booking:how-to-book")?.outcome).toBe("hit_at_1");
    expect(byKey.get("retrieval:nomatch:gibberish")?.outcome).toBe("no_match_correct");
    expect(byKey.get("retrieval:nomatch:emoji")?.outcome).toBe("no_match_correct");
    expect(run.summary.citationValidity).toEqual({
      numerator: run.summary.citationValidity.denominator, denominator: run.summary.citationValidity.denominator, value: 1,
    });
    expect(run.summary.precisionAt1.value).toBeGreaterThanOrEqual(0.9);
    expect(run.summary.noMatchPrecision.value).toBe(1);
  });

  it("renders the booking placeholder from the fixture so the booking entry is a valid citation", async () => {
    const corpus = loadRetrievalCorpus();
    const arm = createFakeRetrievalArm(corpus);
    const run = await runRetrievalCorpus(arm, corpus, { filter: (testCase) => testCase.key === "retrieval:booking:how-to-book" });
    expect(run.reports).toHaveLength(1);
    // The real "can I call you" row answers with the bare booking link the importer registers.
    expect(run.reports[0].includedEntryIds[0]).toBe(arm.entryIdFor("\"Can I call you?\" / \"Can we talk now?”"));
    expect(run.reports[0].invalidCitations).toEqual([]);
  });

  it("reports an expected entry the snapshot does not carry as unresolvable and keeps it in the denominator", async () => {
    const corpus = loadRetrievalCorpus();
    const fake = createFakeRetrievalArm(corpus);
    const arm: RetrievalArm = { ...fake, entryIdFor: () => null };
    const run = await runRetrievalCorpus(arm, corpus);
    expect(run.summary.outcomes.unresolvable).toBe(run.summary.expectedEntryCases);
    expect(run.summary.precisionAt1).toEqual({ numerator: 0, denominator: run.summary.expectedEntryCases, value: 0 });
    expect(run.summary.recallAt5.value).toBe(0);
    // No-match cases still ran and still count on their own axis.
    expect(run.summary.noMatchPrecision.denominator).toBeGreaterThan(0);
  });

  it("counts a candidate the snapshot does not contain against citation validity", async () => {
    const corpus = loadRetrievalCorpus();
    const fake = createFakeRetrievalArm(corpus);
    const costEntryId = fake.entryIdFor("Cost of funding program?") as string;
    const arm: RetrievalArm = { ...fake, knownEntry: (entryId) => entryId !== costEntryId };
    const run = await runRetrievalCorpus(arm, corpus, { filter: (testCase) => testCase.key === "retrieval:program:cost" });
    expect(run.reports[0].outcome).toBe("hit_at_1");
    expect(run.reports[0].invalidCitations).toEqual([costEntryId]);
    expect(run.summary.citationValidity.value).toBeLessThan(1);
  });

  it("scores a stale-snapshot refusal as an error, never as a no-match", async () => {
    const corpus = loadRetrievalCorpus();
    const arm: RetrievalArm = { ...createFakeRetrievalArm(corpus), snapshotId: "somebody-else" };
    const run = await runRetrievalCorpus(arm, corpus, { filter: (testCase) => testCase.key === "retrieval:nomatch:weather" });
    expect(run.reports[0]).toMatchObject({ outcome: "error", passed: false, error: "BRAIN_SNAPSHOT_NOT_CURRENT" });
    expect(run.summary.noMatchPrecision.denominator).toBe(0);
    expect(run.summary.noMatchPrecision.value).toBeNull();
  });

  it("passes the fixture offer and the prompt limit to the pipeline and never enables objections", async () => {
    const corpus = loadRetrievalCorpus();
    const fake = createFakeRetrievalArm(corpus);
    const matchPublished = vi.fn(fake.repository.matchPublished);
    const matchObjections = vi.fn(async () => []);
    const arm: RetrievalArm = { ...fake, repository: { matchPublished, matchObjections } };
    await runRetrievalCorpus(arm, corpus, { filter: (testCase) => testCase.key === "retrieval:program:cost" });
    expect(matchPublished).toHaveBeenCalledTimes(1);
    expect(matchPublished.mock.calls[0][0]).toMatchObject({ expectedSnapshotId: FAKE_ARM_SNAPSHOT_ID, categoryHint: null });
    expect(matchObjections).not.toHaveBeenCalled();
  });

  describe("classifyRetrievalResult", () => {
    it("treats today's thrown nothing-renderable and a future typed no-match identically", () => {
      expect(classifyRetrievalResult(new Error("BRAIN_RETRIEVAL_NO_RENDERABLE_CANDIDATES"))).toEqual({ kind: "no_match" });
      expect(classifyRetrievalResult(new Error("BRAIN_RETRIEVAL_NO_MATCH"))).toEqual({ kind: "no_match" });
      expect(classifyRetrievalResult({ included: [], dropped: [] })).toEqual({ kind: "no_match" });
      expect(classifyRetrievalResult({ noMatch: true, reason: "below_floor" })).toEqual({ kind: "no_match" });
      expect(classifyRetrievalResult({ outcome: "no_match" })).toEqual({ kind: "no_match" });
      expect(classifyRetrievalResult({ kind: "no_match" })).toEqual({ kind: "no_match" });
    });

    it("keeps every other failure an error", () => {
      expect(classifyRetrievalResult(new Error("BRAIN_RETRIEVAL_RPC_FAILED:timeout"))).toEqual({ kind: "error", message: "BRAIN_RETRIEVAL_RPC_FAILED:timeout" });
      expect(classifyRetrievalResult(null)).toEqual({ kind: "error", message: "RETRIEVAL_RESULT_UNREADABLE" });
      expect(classifyRetrievalResult({ included: "x" })).toEqual({ kind: "error", message: "RETRIEVAL_RESULT_UNREADABLE" });
    });

    it("reads included candidates and the dropped count", () => {
      expect(classifyRetrievalResult({
        included: [{ entryId: "e1", content: "Rendered." }],
        dropped: [{ entryId: "e2", dropped: true, reason: "x" }],
      })).toEqual({ kind: "matched", included: [{ entryId: "e1", content: "Rendered." }], dropped: 1 });
    });
  });

  describe("summarizeRetrievalReports", () => {
    it("renders empty denominators as null rather than as a perfect score", () => {
      const summary = summarizeRetrievalReports([], CONTEXT);
      expect(summary.precisionAt1).toEqual({ numerator: 0, denominator: 0, value: null });
      expect(summary.recallAt5.value).toBeNull();
      expect(summary.noMatchPrecision.value).toBeNull();
      expect(summary.citationValidity.value).toBeNull();
      expect(Object.keys(summary.outcomes)).toEqual([...RETRIEVAL_CASE_OUTCOMES]);
    });

    it("computes the four figures from the outcome mix", () => {
      const summary = summarizeRetrievalReports([
        report({ outcome: "hit_at_1", expectedRank: 1, includedEntryIds: ["a", "b"] }),
        report({ outcome: "hit_at_5", passed: false, expectedRank: 3, includedEntryIds: ["b", "c", "a"] }),
        report({ outcome: "miss", passed: false, expectedRank: null, includedEntryIds: ["c", "zz"], invalidCitations: ["zz"] }),
        report({ outcome: "false_no_match", passed: false, expectedRank: null, includedEntryIds: [] }),
        report({ expected: { kind: "no_match" }, outcome: "no_match_correct", expectedRank: null, includedEntryIds: [] }),
        report({ expected: { kind: "no_match" }, outcome: "no_match_correct", expectedRank: null, includedEntryIds: [] }),
        report({ expected: { kind: "no_match" }, outcome: "no_match_missed", passed: false, expectedRank: null, includedEntryIds: ["a"] }),
      ], CONTEXT);
      expect(summary).toMatchObject({
        cases: 7, passed: 3, expectedEntryCases: 4, expectedNoMatchCases: 3,
        precisionAt1: { numerator: 1, denominator: 4, value: 0.25 },
        recallAt5: { numerator: 2, denominator: 4, value: 0.5 },
        noMatchPrecision: { numerator: 2, denominator: 3, value: 2 / 3 },
        citationValidity: { numerator: 7, denominator: 8, value: 7 / 8 },
      });
    });
  });

  it("stems paraphrase variants of the same word to one token and drops stopwords", () => {
    expect([...lexicalTokens("Can approval be guaranteed?")].sort()).toEqual([...lexicalTokens("can you guarantee I get approved")].sort());
    expect(lexicalTokens("the and of it")).toEqual([]);
  });
});
