/** Render-only projection for persisted comparison evidence; no view may derive missing numbers. */

import type {
  ComparisonArmMetrics,
  ComparisonSuiteState,
  EvalComparisonResult,
} from "@/lib/evals/comparison";
import type { EvalSuiteName } from "@/lib/repositories/eval-runs";

export type EvalComparisonConfigOption = {
  id: string;
  label: string;
  model: string;
  active: boolean;
};

export type EvalComparisonDraftOption = {
  id: string;
  contentHash: string;
};

export type EvalComparisonArmView = {
  passed: string;
  passRate: string;
  falseBlocks: string;
  providerCostCredits: string;
  costPerCaseCredits: string;
  costPerThousandCredits: string;
  latencyP50Ms: string;
  latencyP95Ms: string;
};

export type EvalComparisonSuiteView = {
  suite: EvalSuiteName;
  label: string;
  state: ComparisonSuiteState;
  stateLabel: string;
  armA: EvalComparisonArmView;
  armB: EvalComparisonArmView;
};

export type EvalComparisonView = {
  comparisonId: string;
  state: "comparable" | "non_comparable";
  stateLabel: "Comparable" | "Non-comparable";
  stateReason: string | null;
  driverArm: "mock" | "real";
  driverLabel: "Mock engine (no provider key)" | "Real engine evidence";
  suites: readonly EvalComparisonSuiteView[];
};

const SUITE_LABELS: Readonly<Record<EvalSuiteName, string>> = {
  compliance_guardrails: "Compliance guardrails",
  pricing_discipline: "Pricing discipline",
  jailbreak_injection: "Jailbreak and injection",
  output_integrity: "Output integrity",
  qualification_accuracy: "Qualification accuracy",
  voice_tone: "Voice and tone",
};

const STATE_LABELS: Readonly<Record<ComparisonSuiteState, string>> = {
  comparable: "Comparable",
  not_configured: "Not configured",
  skipped: "Skipped",
  incomplete: "Incomplete",
};

function number(value: number | null, suffix = "") {
  return value === null ? "Unavailable" : `${new Intl.NumberFormat("en", {
    maximumFractionDigits: 4,
  }).format(value)}${suffix}`;
}

function armView(metrics: ComparisonArmMetrics, state: ComparisonSuiteState): EvalComparisonArmView {
  if (state !== "comparable") {
    return {
      passed: STATE_LABELS[state],
      passRate: STATE_LABELS[state],
      falseBlocks: STATE_LABELS[state],
      providerCostCredits: STATE_LABELS[state],
      costPerCaseCredits: STATE_LABELS[state],
      costPerThousandCredits: STATE_LABELS[state],
      latencyP50Ms: STATE_LABELS[state],
      latencyP95Ms: STATE_LABELS[state],
    };
  }
  return {
    passed: metrics.passed === null || metrics.total === null
      ? "Unavailable"
      : `${metrics.passed}/${metrics.total}`,
    passRate: number(metrics.passRate, "%"),
    falseBlocks: metrics.falseBlocks === null || metrics.negativeCases === null
      ? "Unavailable"
      : `${metrics.falseBlocks}/${metrics.negativeCases}`,
    providerCostCredits: number(metrics.providerCostCredits),
    costPerCaseCredits: number(metrics.costPerCaseCredits),
    costPerThousandCredits: number(metrics.costPerThousandCredits),
    latencyP50Ms: number(metrics.latencyP50Ms, " ms"),
    latencyP95Ms: number(metrics.latencyP95Ms, " ms"),
  };
}

export function evalComparisonView(result: EvalComparisonResult): EvalComparisonView {
  return {
    comparisonId: result.comparisonId,
    state: result.state,
    stateLabel: result.state === "comparable" ? "Comparable" : "Non-comparable",
    stateReason: result.stateReason,
    driverArm: result.driverArm,
    driverLabel: result.driverArm === "mock"
      ? "Mock engine (no provider key)"
      : "Real engine evidence",
    suites: result.suites.map((suite) => ({
      suite: suite.suite,
      label: SUITE_LABELS[suite.suite],
      state: suite.state,
      stateLabel: STATE_LABELS[suite.state],
      armA: armView(suite.armA, suite.state),
      armB: armView(suite.armB, suite.state),
    })),
  };
}
