import { describe, expect, it } from "vitest";

import { COMPLIANCE_RULE_IDS } from "@/lib/brain/contracts";
import { evaluatePublishGate } from "@/lib/evals/publish-gate";
import { loadSafetyCorpus, SAFETY_SUITES } from "@/lib/evals/corpus";
import { runAndRecordEval, runCheckerCorpus } from "@/lib/evals/runner";
import type { EvalRunReceipt, EvalSuiteResultInput } from "@/lib/repositories/eval-runs";

const HASH = "a".repeat(64);

function receipt(suites: readonly EvalSuiteResultInput[], overrides: Partial<EvalRunReceipt["run"]> = {}): EvalRunReceipt {
  return {
    run: {
      id: "run-1",
      brainDraftVersionId: "draft-1",
      contentHash: HASH,
      kind: "checker",
      modelConfigId: null,
      corpusRevision: "corpus-1",
      suitesComplete: true,
      ...overrides,
    },
    results: suites.flatMap((suite, suiteIndex) => suite.cases.map((result, caseIndex) => ({
      id: `result-${suiteIndex}-${caseIndex}`,
      runId: "run-1",
      caseId: null,
      suite: suite.suite,
      ...result,
    }))),
  };
}

describe("safety corpus loader", () => {
  it("loads all four files deterministically with only known compliance rule ids", () => {
    const first = loadSafetyCorpus();
    const second = loadSafetyCorpus();
    expect(first.revision).toBe(second.revision);
    expect(first.revision).toBe("253823b467adf1d803fe2ca09dbd49007b1318f49ed47016c3a07245550ce512");
    expect(first.cases).toHaveLength(41);
    expect(first.cases.filter((testCase) => testCase.kind === "checker")).toHaveLength(31);
    expect(first.cases.filter((testCase) => testCase.kind === "engine")).toHaveLength(10);
    expect([...new Set(first.cases.map((testCase) => testCase.suite))]).toEqual(SAFETY_SUITES);
    const ids = first.cases.flatMap((testCase) => testCase.expectation.ruleIds);
    expect(ids.every((id) => COMPLIANCE_RULE_IDS.includes(id))).toBe(true);
  });

  it("names the case and refuses an unknown rule id before a run can look green", () => {
    const malformed = {
      suite: "compliance_guardrails",
      context: loadSafetyCorpus().cases[0].context,
      cases: [{
        key: "synthetic:unknown-rule",
        kind: "checker",
        turns: [{ role: "agent", content: "Synthetic" }],
        expectation: { verdict: "block", class: "CLAIM", ruleIds: ["CLAIM-999"] },
      }],
    };
    expect(() => loadSafetyCorpus([malformed], { requireAllSuites: false }))
      .toThrow("SAFETY_CORPUS_INVALID:synthetic:unknown-rule:unknown_rule_id:CLAIM-999");
  });

  it("refuses duplicate keys and malformed expectations for the named case", () => {
    const base = {
      suite: "output_integrity",
      context: loadSafetyCorpus().cases[0].context,
      cases: [
        { key: "synthetic:duplicate", kind: "checker", turns: [{ role: "agent", content: "One" }],
        expectation: { verdict: "pass", class: "ECHO", ruleIds: [] } },
        { key: "synthetic:duplicate", kind: "checker", turns: [{ role: "agent", content: "Two" }],
        expectation: { verdict: "pass", class: "ECHO", ruleIds: [] } },
      ],
    };
    expect(() => loadSafetyCorpus([base], { requireAllSuites: false }))
      .toThrow("SAFETY_CORPUS_INVALID:synthetic:duplicate:duplicate_case_key");
    const malformed = structuredClone(base);
    malformed.cases = [{ key: "synthetic:bad-expectation", kind: "checker",
      turns: [{ role: "agent", content: "Synthetic" }],
      expectation: { verdict: "block", class: "CLAIM", ruleIds: [] } }];
    expect(() => loadSafetyCorpus([malformed], { requireAllSuites: false }))
      .toThrow("SAFETY_CORPUS_INVALID:synthetic:bad-expectation:expectation.block");
  });

  it("keeps one blocking and one negative checker case for every output class", () => {
    const checker = loadSafetyCorpus().cases.filter((testCase) => testCase.kind === "checker");
    for (const checkClass of ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN"] as const) {
      expect(checker.some((testCase) => testCase.expectation.class === checkClass &&
        testCase.expectation.verdict === "block")).toBe(true);
      expect(checker.some((testCase) => testCase.expectation.class === checkClass &&
        testCase.expectation.verdict === "pass")).toBe(true);
    }
  });
});

describe("network-free checker runner", () => {
  it("passes every reviewed checker case and retains all required negative cases", () => {
    const results = runCheckerCorpus();
    expect(results.every((suite) => suite.cases.every((testCase) => testCase.passed))).toBe(true);
    const keys = results.flatMap((suite) => suite.cases.map((testCase) => testCase.caseKey));
    expect(keys).toEqual(expect.arrayContaining([
      "pricing:lead-number-allowed",
      "output:coach-link-allowed",
      "compliance:negated-guarantee-allowed",
      "output:brain-quote-allowed",
    ]));
  });

  it("persists the exact immutable draft hash and complete case count", async () => {
    const calls: Parameters<NonNullable<Parameters<typeof runAndRecordEval>[0]["persist"]>>[0][] = [];
    await runAndRecordEval({
      draftId: "draft-1",
      contentHash: HASH,
      kind: "checker",
      persist: async (input) => {
        calls.push(input);
        const results = input.suites.flatMap((suite, suiteIndex) => suite.cases.map((result, resultIndex) => ({
          id: `result-${suiteIndex}-${resultIndex}`,
          runId: "run-1",
          caseId: null,
          suite: suite.suite,
          ...result,
        })));
        return { run: { id: "run-1", brainDraftVersionId: input.expectedDraftId,
          contentHash: input.expectedContentHash, kind: input.kind, modelConfigId: null,
          corpusRevision: input.corpusRevision, suitesComplete: true }, results };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ expectedDraftId: "draft-1", expectedContentHash: HASH, kind: "checker" });
    expect(calls[0].suites).toHaveLength(6);
    expect(calls[0].suites.flatMap((suite) => suite.cases).length).toBeGreaterThan(10);
  });

  it("routes engine-kind cases through the injected existing engine arm", async () => {
    const seen: string[] = [];
    const persisted = await runAndRecordEval({
      draftId: "draft-1",
      contentHash: HASH,
      kind: "engine",
      modelConfigId: "model-config-1",
      engineExecutor: async (testCase) => {
        seen.push(testCase.key);
        return {
          passed: true,
          ruleIds: testCase.expectation.ruleIds,
          trace: { expected: testCase.expectation },
        };
      },
      persist: async (input) => ({
        run: {
          id: "run-engine",
          brainDraftVersionId: input.expectedDraftId,
          contentHash: input.expectedContentHash,
          kind: "engine",
          modelConfigId: input.modelConfigId,
          corpusRevision: input.corpusRevision,
          suitesComplete: true,
        },
        results: input.suites.flatMap((suite, suiteIndex) => suite.cases.map((result, resultIndex) => ({
          id: `engine-result-${suiteIndex}-${resultIndex}`,
          runId: "run-engine",
          caseId: null,
          suite: suite.suite,
          ...result,
        }))),
      }),
    });
    expect(seen).toEqual([
      "compliance:engine-guarantee",
      "phase3:compliance:engine-stop-idempotency",
      "phase3:compliance:engine-cross-class-tripwire",
      "pricing:engine-invented-price",
      "phase3:pricing:engine-outcome-pressure",
      "jailbreak:engine-role-attack",
      "phase3:jailbreak:engine-three-turn-scope-cap",
      "phase3:jailbreak:engine-missing-caller-history",
      "output:engine-system-extraction",
      "phase3:output:engine-nested-sanitizer",
    ]);
    expect(persisted.run).toMatchObject({ kind: "engine", modelConfigId: "model-config-1" });
  });
});

describe("exact-version publish gate", () => {
  const complete = [
    ...runCheckerCorpus(),
    { suite: "qualification_accuracy" as const, cases: [{ caseKey: "qualification:not-configured",
      passed: false, response: null, trace: { status: "not_configured", ruleIds: [] }, latencyMs: null, costCents: null }] },
    { suite: "voice_tone" as const, cases: [{ caseKey: "voice:not-configured",
      passed: false, response: null, trace: { status: "not_configured", ruleIds: [] }, latencyMs: null, costCents: null }] },
  ];

  it("blocks a one-character content-hash mismatch as not run for this version", () => {
    const gate = evaluatePublishGate({
      expectedDraftId: "draft-1",
      expectedContentHash: `${HASH.slice(0, -1)}b`,
      expectedCorpusRevision: "corpus-1",
      run: receipt(complete),
    });
    expect(gate).toMatchObject({ status: "not_run_for_this_version", canPublish: false });
  });

  it("names suite, case key, and rule id for each hard failure", () => {
    const failing = complete.map((suite) => suite.suite === "output_integrity"
      ? { ...suite, cases: [{ ...suite.cases[0], passed: false,
          trace: { ruleIds: ["ECHO-001"] } }] }
      : suite);
    const gate = evaluatePublishGate({
      expectedDraftId: "draft-1",
      expectedContentHash: HASH,
      expectedCorpusRevision: "corpus-1",
      run: receipt(failing),
    });
    expect(gate.blockers).toEqual([{
      suite: "output_integrity",
      caseKey: "output:system-echo-blocked",
      ruleId: "ECHO-001",
      reason: "failed",
    }]);
  });

  it("hard-blocks publish when a Phase 3 checker projection fails for the exact draft hash", () => {
    const failing = complete.map((suite) => suite.suite === "compliance_guardrails"
      ? {
          ...suite,
          cases: suite.cases.map((testCase) =>
            testCase.caseKey === "phase3:compliance:stop-control-projection"
              ? { ...testCase, passed: false, trace: { ruleIds: ["CLAIM-001"] } }
              : testCase,
          ),
        }
      : suite);
    const gate = evaluatePublishGate({
      expectedDraftId: "draft-1",
      expectedContentHash: HASH,
      expectedCorpusRevision: "corpus-1",
      run: receipt(failing),
    });
    expect(gate).toMatchObject({ status: "blocked", canPublish: false });
    expect(gate.blockers).toContainEqual({
      suite: "compliance_guardrails",
      caseKey: "phase3:compliance:stop-control-projection",
      ruleId: "CLAIM-001",
      reason: "failed",
    });
  });

  it("keeps qualification and voice warnings from changing canPublish to false", () => {
    const gate = evaluatePublishGate({
      expectedDraftId: "draft-1",
      expectedContentHash: HASH,
      expectedCorpusRevision: "corpus-1",
      run: receipt(complete),
    });
    expect(gate).toMatchObject({ status: "ready", canPublish: true });
    expect(gate.warnings).toEqual([
      { suite: "qualification_accuracy", status: "not_configured", caseKeys: ["qualification:not-configured"] },
      { suite: "voice_tone", status: "not_configured", caseKeys: ["voice:not-configured"] },
    ]);
  });

  it("keeps a skipped or errored judged suite out of the failed column", () => {
    const judged = (status: string) => complete.map((suite) => suite.suite === "voice_tone"
      ? { ...suite, cases: [
          { ...suite.cases[0], caseKey: "voice_tone:case-v1", trace: { status, ruleIds: [] } },
        ] }
      : suite);
    const skipped = evaluatePublishGate({
      expectedDraftId: "draft-1",
      expectedContentHash: HASH,
      expectedCorpusRevision: "corpus-1",
      run: receipt(judged("skipped")),
    });
    expect(skipped.canPublish).toBe(true);
    expect(skipped.warnings).toContainEqual(
      { suite: "voice_tone", status: "skipped", caseKeys: ["voice_tone:case-v1"] },
    );
    const errored = evaluatePublishGate({
      expectedDraftId: "draft-1",
      expectedContentHash: HASH,
      expectedCorpusRevision: "corpus-1",
      run: receipt(judged("errored")),
    });
    expect(errored.warnings).toContainEqual(
      { suite: "voice_tone", status: "errored", caseKeys: ["voice_tone:case-v1"] },
    );
  });
});
