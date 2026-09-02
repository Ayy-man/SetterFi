import { describe, expect, it } from "vitest";

import type { ComparisonArmMetrics, EvalComparisonResult } from "@/lib/evals/comparison";
import { evalComparisonView } from "@/components/workspace/live/eval-comparison-view-models";

const metrics: ComparisonArmMetrics = {
  passed: 3,
  total: 4,
  passRate: 75,
  falseBlocks: 1,
  negativeCases: 2,
  providerCostCredits: 0.4,
  costPerCaseCredits: 0.1,
  costPerThousandCredits: 100,
  latencyP50Ms: 20,
  latencyP95Ms: 40,
};

function result(overrides: Partial<EvalComparisonResult> = {}): EvalComparisonResult {
  return {
    comparisonId: "comparison-1",
    status: "completed",
    state: "non_comparable",
    stateReason: "voice_tone:not_configured",
    driverArm: "mock",
    brainDraftVersionId: "draft-1",
    contentHash: "a".repeat(64),
    brainVersion: null,
    offerVersion: null,
    rulesVersion: "rules-1",
    knowledgeMode: null,
    corpusRevision: "corpus-1",
    caseSetHash: "b".repeat(64),
    modelConfigAId: "config-a",
    modelConfigBId: "config-b",
    runAId: "run-a",
    runBId: "run-b",
    createdAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:01:00.000Z",
    suites: [
      { suite: "compliance_guardrails", state: "comparable", armA: metrics, armB: metrics },
      {
        suite: "voice_tone",
        state: "not_configured",
        armA: Object.fromEntries(Object.keys(metrics).map((key) => [key, null])) as ComparisonArmMetrics,
        armB: Object.fromEntries(Object.keys(metrics).map((key) => [key, null])) as ComparisonArmMetrics,
      },
    ],
    ...overrides,
  };
}

describe("eval comparison view model", () => {
  it("labels mock plumbing exactly and never promotes it to live evidence", () => {
    const view = evalComparisonView(result());
    expect(view.driverLabel).toBe("Mock engine (no provider key)");
    expect(JSON.stringify(view)).not.toMatch(/live engine|real engine/i);
  });

  it("renders configured suite metrics without creating one blended verdict", () => {
    const view = evalComparisonView(result());
    const suite = view.suites[0];
    expect(suite.armA).toMatchObject({
      passed: "3/4",
      passRate: "75%",
      falseBlocks: "1/2",
      costPerThousandCredits: "100",
      latencyP95Ms: "40 ms",
    });
    expect(view).not.toHaveProperty("passRate");
    expect(view.stateLabel).toBe("Non-comparable");
  });

  it.each(["not_configured", "skipped", "incomplete"] as const)(
    "renders %s with no percentage, partial count, or completion label",
    (state) => {
      const base = result();
      const view = evalComparisonView({
        ...base,
        state: "non_comparable",
        stateReason: `voice_tone:${state}`,
        suites: [{ ...base.suites[1], state }],
      });
      const serialized = JSON.stringify(view);
      expect(view.suites[0].stateLabel).toBe(
        state === "not_configured" ? "Not configured" : state === "skipped" ? "Skipped" : "Incomplete",
      );
      expect(serialized).not.toMatch(/\d+(?:\.\d+)?%|\d+\/\d+/);
    },
  );

  it("keeps missing provider cost visibly unavailable rather than zero", () => {
    const base = result();
    const view = evalComparisonView({
      ...base,
      suites: [{
        ...base.suites[0],
        armA: { ...metrics, providerCostCredits: null, costPerCaseCredits: null, costPerThousandCredits: null },
      }],
    });
    expect(view.suites[0].armA).toMatchObject({
      providerCostCredits: "Unavailable",
      costPerCaseCredits: "Unavailable",
      costPerThousandCredits: "Unavailable",
    });
  });
});
