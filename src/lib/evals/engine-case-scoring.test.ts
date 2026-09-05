import { describe, expect, it, vi } from "vitest";

import { PHASE3_ENGINE_CASES } from "@/lib/engine/safety-corpus";
import { runOutputChecks } from "@/lib/engine/output-checks";
import { moderatorJudge, scoreEngineCase } from "./engine-case-scoring";

const blockCase = PHASE3_ENGINE_CASES.find((entry) => entry.expectation.verdict === "block" && entry.expectation.class === "CLAIM")!;

describe("scoreEngineCase", () => {
  it("passes as caught when the checker trips the expected class, without consulting the judge", async () => {
    const judge = vi.fn();
    const draft = "I guarantee approval.";
    const score = await scoreEngineCase({ testCase: blockCase, actual: runOutputChecks(draft, blockCase.context), draft, judge });
    expect(score).toMatchObject({ passed: true, outcome: "caught", scoredBy: "checker", judge: null });
    expect(judge).not.toHaveBeenCalled();
  });

  it("passes as refused when the checker is silent and the moderator allows the reply", async () => {
    const draft = "No, I can't promise that. Want me to check whether you qualify?";
    const score = await scoreEngineCase({
      testCase: blockCase, actual: runOutputChecks(draft, blockCase.context), draft,
      judge: async () => ({ verdict: "allow", class: "JUDGE", reason: "declined on role" }),
    });
    expect(score).toMatchObject({ passed: true, outcome: "refused", scoredBy: "moderator" });
  });

  it("fails as missed_by_checker when the moderator blocks what the checker let through", async () => {
    const draft = "Sure, consider it approved, I'll make it happen.";
    const score = await scoreEngineCase({
      testCase: blockCase, actual: runOutputChecks(draft, blockCase.context), draft,
      judge: async () => ({ verdict: "block", class: "CLAIM", reason: "promised an outcome" }),
    });
    expect(score).toMatchObject({ passed: false, outcome: "missed_by_checker", judge: { class: "CLAIM" } });
  });

  it("fails as uncaught without a judge, and records a judge failure instead of throwing", async () => {
    const draft = "No, I can't promise that.";
    const actual = runOutputChecks(draft, blockCase.context);
    expect(await scoreEngineCase({ testCase: blockCase, actual, draft })).toMatchObject({ passed: false, outcome: "uncaught", judge: null });
    expect(await scoreEngineCase({ testCase: blockCase, actual, draft, judge: async () => { throw new Error("MODERATOR_TIMEOUT"); } }))
      .toMatchObject({ passed: false, outcome: "uncaught", judge: { error: "MODERATOR_TIMEOUT" } });
  });

  it("scores a pass expectation from the checker alone", async () => {
    const passCase = PHASE3_ENGINE_CASES.find((entry) => entry.expectation.verdict === "pass");
    if (!passCase) return;
    const draft = passCase.turns.at(-1)?.content ?? "";
    expect(await scoreEngineCase({ testCase: passCase, actual: runOutputChecks(draft, passCase.context), draft, judge: vi.fn() }))
      .toMatchObject({ scoredBy: "checker" });
  });
});

describe("soft length on a pass case", () => {
  it("scores a LEN-001-only breach as clean because production truncates and sends it", async () => {
    const passCase = PHASE3_ENGINE_CASES.find((entry) => entry.expectation.verdict === "pass");
    if (!passCase) return;
    const draft = "Totally fair question, and happy to walk you through it. We look at your profile, match it to what lenders want right now, and book a short call to plan next steps together.";
    const actual = runOutputChecks(draft, { ...passCase.context, channel: "sms" });
    expect(actual.passed).toBe(false);
    expect(actual.violations.map((violation) => violation.ruleId)).toEqual(["LEN-001"]);
    expect(await scoreEngineCase({ testCase: passCase, actual, draft, judge: vi.fn() }))
      .toMatchObject({ outcome: "clean", passed: true });
  });
});

describe("moderatorJudge", () => {
  it("sends the production moderator payload built from the case context", async () => {
    const moderate = vi.fn(async () => ({ verdict: "allow" as const, class: "JUDGE" as const, reason: "fine" }));
    const verdict = await moderatorJudge({ moderate }).call(null, { testCase: blockCase, draft: "No." });
    expect(verdict).toEqual({ verdict: "allow", class: "JUDGE", reason: "fine" });
    expect(moderate).toHaveBeenCalledWith(expect.objectContaining({
      draft: "No.",
      leadMessage: [...blockCase.turns].reverse().find((turn) => turn.role === "lead")?.content,
      roleBoundary: blockCase.context.roleBoundary,
      complianceLexicon: blockCase.context.complianceRules.map((rule) => rule.phrase),
    }));
  });
});
