/** Exact-version publish verdict; warning suites can inform a publish but cannot hard-block it. */

import { COMPLIANCE_RULE_IDS, type ComplianceRuleId } from "@/lib/brain/contracts";
import { SAFETY_SUITES, type SafetySuite } from "@/lib/evals/corpus";
import type { EvalRunReceipt, EvalSuiteName } from "@/lib/repositories/eval-runs";

const DEFAULT_RULE: Record<SafetySuite, ComplianceRuleId> = {
  compliance_guardrails: "CLAIM-001",
  pricing_discipline: "NUM-001",
  jailbreak_injection: "SCOPE-001",
  output_integrity: "ECHO-001",
};
const RULE_IDS = new Set<string>(COMPLIANCE_RULE_IDS);

export type PublishGateIssue = {
  suite: EvalSuiteName;
  caseKey: string;
  ruleId: ComplianceRuleId;
  reason: "failed" | "missing" | "incomplete";
};

export type PublishGateWarning = {
  suite: "qualification_accuracy" | "voice_tone";
  /**
   * A judged suite that was skipped or errored has produced no verdict on this draft. Saying
   * "failed" for either would charge a mock driver or an unreadable judgment to the agent.
   */
  status: "failed" | "not_configured" | "skipped" | "errored";
  caseKeys: string[];
};

function resultRuleIds(trace: Readonly<Record<string, unknown>>, fallback: ComplianceRuleId) {
  const ids = Array.isArray(trace.ruleIds) ? trace.ruleIds.filter((id): id is string => typeof id === "string") : [];
  const known = ids.find((id) => RULE_IDS.has(id));
  return (known ?? fallback) as ComplianceRuleId;
}

export function evaluatePublishGate(input: {
  expectedDraftId: string;
  expectedContentHash: string;
  expectedCorpusRevision: string;
  run: EvalRunReceipt | null;
}) {
  const run = input.run;
  if (!run || run.run.brainDraftVersionId !== input.expectedDraftId ||
    run.run.contentHash !== input.expectedContentHash ||
    run.run.corpusRevision !== input.expectedCorpusRevision) {
    return {
      status: "not_run_for_this_version" as const,
      canPublish: false,
      blockers: [] as PublishGateIssue[],
      warnings: [] as PublishGateWarning[],
    };
  }

  const blockers: PublishGateIssue[] = [];
  for (const suite of SAFETY_SUITES) {
    const results = run.results.filter((result) => result.suite === suite);
    if (results.length === 0) {
      blockers.push({
        suite,
        caseKey: `${suite}:missing`,
        ruleId: DEFAULT_RULE[suite],
        reason: "missing",
      });
      continue;
    }
    for (const result of results.filter((entry) => !entry.passed)) {
      blockers.push({
        suite,
        caseKey: result.caseKey,
        ruleId: resultRuleIds(result.trace, DEFAULT_RULE[suite]),
        reason: "failed",
      });
    }
  }
  if (!run.run.suitesComplete) {
    blockers.push({
      suite: "compliance_guardrails",
      caseKey: "run:suites-incomplete",
      ruleId: "CLAIM-001",
      reason: "incomplete",
    });
  }

  const warnings = (["qualification_accuracy", "voice_tone"] as const).flatMap<PublishGateWarning>((suite) => {
    const results = run.results.filter((result) => result.suite === suite);
    if (results.length === 0 || results.every((result) => result.trace.status === "not_configured")) {
      return [{ suite, status: "not_configured", caseKeys: results.map((result) => result.caseKey) }];
    }
    if (results.every((result) => result.trace.status === "skipped")) {
      return [{ suite, status: "skipped", caseKeys: results.map((result) => result.caseKey) }];
    }
    const errored = results.filter((result) => result.trace.status === "errored");
    if (errored.length) {
      return [{ suite, status: "errored", caseKeys: errored.map((result) => result.caseKey) }];
    }
    const failed = results.filter((result) => !result.passed);
    return failed.length ? [{ suite, status: "failed", caseKeys: failed.map((result) => result.caseKey) }] : [];
  });
  return {
    status: blockers.length ? "blocked" as const : "ready" as const,
    canPublish: blockers.length === 0,
    blockers,
    warnings,
  };
}
