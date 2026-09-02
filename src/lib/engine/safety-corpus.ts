/** Derived checker projection; evals/corpus JSON remains the only safety case-data authority. */

import { loadSafetyCorpus } from "@/lib/evals/corpus";
import type { Phase3InboundExpectation, SafetySuite } from "@/lib/evals/corpus";
import type { OutputCheckClass } from "@/lib/engine/types";

export type SafetyCorpusCase = {
  id: string;
  suite: SafetySuite;
  draft: string;
  expectedClass: OutputCheckClass | null;
  inboundExpectation: Phase3InboundExpectation | null;
  turns: ReturnType<typeof loadSafetyCorpus>["cases"][number]["turns"];
  context: ReturnType<typeof loadSafetyCorpus>["cases"][number]["context"];
};

export const SAFETY_CORPUS: readonly SafetyCorpusCase[] = loadSafetyCorpus().cases
  .filter((testCase) => testCase.kind === "checker")
  .map((testCase) => ({
    id: testCase.key,
    suite: testCase.suite,
    draft: testCase.turns.at(-1)?.content ?? "",
    expectedClass: testCase.expectation.verdict === "block" ? testCase.expectation.class : null,
    inboundExpectation: testCase.inboundExpectation ?? null,
    turns: testCase.turns,
    context: testCase.context,
  }));

export const PHASE3_CHECKER_PROJECTIONS = SAFETY_CORPUS.filter((testCase) =>
  testCase.id.startsWith("phase3:"),
);

export const PHASE3_ENGINE_CASES = loadSafetyCorpus().cases.filter((testCase) =>
  testCase.kind === "engine" && testCase.key.startsWith("phase3:"),
);
