import { describe, expect, it, vi } from "vitest";

import { DEMO_QUALIFICATION_RULES } from "@/lib/domain/qualification";
import {
  buildJudgeMessages,
  JUDGE_SYSTEM_PROMPT,
  JudgeVerdictError,
  parseJudgeVerdict,
} from "@/lib/evals/judge";
import {
  judgmentCaseSetHash,
  parseJudgmentCase,
  parseJudgmentCases,
  type JudgmentCase,
} from "@/lib/evals/judgment-cases";
import {
  judgmentResultKeys,
  MOCK_ARM_SKIP_REASON,
  runJudgmentSuites,
  type JudgmentRubricSource,
} from "@/lib/evals/judgment-runner";

const TENANT = "tenant-1";

function qualificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-q1",
    suite: "qualification_accuracy",
    kind: "engine",
    source_tenant_id: TENANT,
    turns: [
      { role: "user", content: "My score is 720 and I want $100K." },
      { role: "assistant", content: "Great — let's get you on the calendar." },
    ],
    expectation: {
      suite: "qualification_accuracy",
      outcome: "BOOK",
      disclosed: {
        credit: "700+",
        goal: "$50K–100K",
        timeline: "ASAP–30d",
        businessStage: "operating",
        annualRevenueCents: 5_000_000,
      },
    },
    ...overrides,
  };
}

function voiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-v1",
    suite: "voice_tone",
    kind: "engine",
    source_tenant_id: TENANT,
    turns: [{ role: "user", content: "Is this actually going to work for me?" }],
    expectation: { suite: "voice_tone", constraints: ["brand_voice", "style"] },
    ...overrides,
  };
}

function rubricSource(overrides: Partial<JudgmentRubricSource> = {}): JudgmentRubricSource {
  return {
    tenantId: TENANT,
    compiledPlatform: "You are the setter for Acme Funding.",
    qualification: DEMO_QUALIFICATION_RULES,
    qualificationApproved: true,
    offer: {
      brandVoice: "friendly",
      voiceStyleAnswer: "Warm, short sentences, no hype.",
      voiceObjectionAnswer: "Acknowledge, then ask one question.",
      voiceFollowupAnswer: "One nudge, then leave the door open.",
    },
    ...overrides,
  };
}

function generation(draft: string, latencyMs = 10, cost: number | null = 0.5) {
  return {
    draft,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    provider: { name: "test", generationId: "gen-1", latencyMs, cost },
  };
}

function judgeReply(satisfied: boolean, ids: readonly string[]) {
  return JSON.stringify({
    criteria: ids.map((id) => ({ id, satisfied, reason: `because ${id}` })),
  });
}

const QUALIFICATION_CRITERIA = ["outcome_applied", "conversation_posture", "facts_grounded"];

function realRun(input: {
  cases: readonly JudgmentCase[];
  judge: (messages: unknown) => string;
  source?: JudgmentRubricSource | null;
}) {
  const generate = vi.fn(async () => generation("Fresh reply from the arm."));
  const judge = vi.fn(async (messages: unknown) => generation(input.judge(messages), 5, 0.25));
  return {
    generate,
    judge,
    run: () => runJudgmentSuites({
      arm: "real",
      cases: input.cases,
      judgeConfig: { id: "moderator-1", model: "vendor/judge", params: {} },
      generatorConfig: { id: "config-a", model: "vendor/model-a", params: {} },
      generate: generate as never,
      judge: judge as never,
      loadRubricSource: async () => (input.source === undefined ? rubricSource() : input.source),
    }),
  };
}

describe("judgment case definitions", () => {
  it("parses a promoted qualification case and keys it by suite and row id", () => {
    const parsed = parseJudgmentCase(qualificationRow());
    expect(parsed.key).toBe("qualification_accuracy:case-q1");
    expect(parsed.sourceTenantId).toBe(TENANT);
    expect(parsed.expectation).toEqual({
      suite: "qualification_accuracy",
      outcome: "BOOK",
      disclosed: {
        credit: "700+",
        goal: "$50K–100K",
        timeline: "ASAP–30d",
        businessStage: "operating",
        annualRevenueCents: 5_000_000,
      },
    });
  });

  it("names the row and refuses an expectation the suite does not define", () => {
    expect(() => parseJudgmentCase(qualificationRow({
      expectation: {
        suite: "qualification_accuracy",
        outcome: "MAYBE",
        disclosed: qualificationRow().expectation.disclosed,
      },
    }))).toThrow("JUDGMENT_CASE_INVALID:case-q1:expectation.outcome");
    expect(() => parseJudgmentCase(qualificationRow({
      expectation: { suite: "qualification_accuracy", outcome: "BOOK", disclosed: { credit: "700+" } },
    }))).toThrow("JUDGMENT_CASE_INVALID:case-q1:expectation.disclosed_keys");
    expect(() => parseJudgmentCase(voiceRow({
      expectation: { suite: "voice_tone", constraints: ["charisma"] },
    }))).toThrow("JUDGMENT_CASE_INVALID:case-v1:expectation.constraints:charisma");
    expect(() => parseJudgmentCase(voiceRow({ expectation: { suite: "voice_tone", constraints: [] } })))
      .toThrow("JUDGMENT_CASE_INVALID:case-v1:expectation.constraints");
    expect(() => parseJudgmentCase(qualificationRow({ suite: "pricing_discipline" })))
      .toThrow("JUDGMENT_CASE_INVALID:case-q1:suite");
    expect(() => parseJudgmentCase(qualificationRow({ source_tenant_id: "  " })))
      .toThrow("JUDGMENT_CASE_INVALID:case-q1:source_tenant_id");
    expect(() => parseJudgmentCase(qualificationRow({
      turns: [{ role: "assistant", content: "No lead turn here." }],
    }))).toThrow("JUDGMENT_CASE_INVALID:case-q1:turns_no_lead_turn");
  });

  it("refuses two rows that would record under the same result key", () => {
    expect(() => parseJudgmentCases([qualificationRow(), qualificationRow()]))
      .toThrow("JUDGMENT_CASE_INVALID:case-q1:duplicate_case_key");
  });

  it("moves the case-set hash when a promoted body changes", () => {
    const base = parseJudgmentCases([qualificationRow(), voiceRow()]);
    const moved = parseJudgmentCases([
      qualificationRow({ turns: [{ role: "user", content: "My score is 640." }] }),
      voiceRow(),
    ]);
    expect(judgmentCaseSetHash(base)).toBe(judgmentCaseSetHash([...base].reverse()));
    expect(judgmentCaseSetHash(base)).not.toBe(judgmentCaseSetHash(moved));
  });
});

describe("judge prompt and verdict envelope", () => {
  it("puts every criterion id, the evidence and the reply in the prompt", () => {
    const messages = buildJudgeMessages({
      suite: "voice_tone",
      caseKey: "voice_tone:case-v1",
      criteria: [{ id: "brand_voice", statement: 'matches "friendly"' }],
      evidence: { configured_voice: { brand_voice: "friendly" } },
      transcript: [{ role: "user", content: "Will this work?" }],
      reply: "It can — tell me your score.",
    });
    expect(messages[0]).toEqual({ role: "system", content: JUDGE_SYSTEM_PROMPT });
    const body = JSON.parse(messages[1].content);
    expect(body.criteria).toEqual([{ id: "brand_voice", statement: 'matches "friendly"' }]);
    expect(body.evidence).toEqual({ configured_voice: { brand_voice: "friendly" } });
    expect(body.reply_under_review).toBe("It can — tell me your score.");
  });

  it("reads a well-formed per-criterion verdict", () => {
    expect(parseJudgeVerdict(judgeReply(true, ["a", "b"]), ["b", "a"])).toEqual({
      criteria: [
        { id: "a", satisfied: true, reason: "because a" },
        { id: "b", satisfied: true, reason: "because b" },
      ],
    });
  });

  it("errors rather than guessing on malformed JSON, a bad envelope, or a refusal", () => {
    expect(() => parseJudgeVerdict("not json", ["a"]))
      .toThrow(new JudgeVerdictError("JUDGE_VERDICT_JSON_INVALID"));
    expect(() => parseJudgeVerdict("[]", ["a"]))
      .toThrow(new JudgeVerdictError("JUDGE_VERDICT_ENVELOPE_INVALID"));
    expect(() => parseJudgeVerdict('{"criteria":"yes"}', ["a"]))
      .toThrow(new JudgeVerdictError("JUDGE_VERDICT_ENVELOPE_INVALID"));
    expect(() => parseJudgeVerdict('{"criteria":[{"id":"a","satisfied":"true","reason":"r"}]}', ["a"]))
      .toThrow(new JudgeVerdictError("JUDGE_VERDICT_ENVELOPE_INVALID"));
    expect(() => parseJudgeVerdict('{"criteria":[{"id":"a","satisfied":true,"reason":"  "}]}', ["a"]))
      .toThrow(new JudgeVerdictError("JUDGE_VERDICT_ENVELOPE_INVALID"));
    expect(() => parseJudgeVerdict('{"refused":true,"reason":"insufficient evidence"}', ["a"]))
      .toThrow("JUDGE_VERDICT_REFUSED:insufficient evidence");
  });

  it("refuses a verdict that answered a different criterion set", () => {
    expect(() => parseJudgeVerdict(judgeReply(true, ["a"]), ["a", "b"]))
      .toThrow("JUDGE_VERDICT_CRITERIA_MISMATCH:a");
    expect(() => parseJudgeVerdict(judgeReply(true, ["a", "c"]), ["a", "b"]))
      .toThrow("JUDGE_VERDICT_CRITERIA_MISMATCH:a,c");
  });
});

describe("judgment suite execution", () => {
  const cases = parseJudgmentCases([qualificationRow(), voiceRow()]);

  it("reads not-configured while no case is promoted or no judge row is active", async () => {
    const empty = await runJudgmentSuites({
      arm: "real",
      cases: [],
      judgeConfig: { id: "moderator-1", model: "vendor/judge", params: {} },
    });
    expect(empty.map((suite) => suite.cases[0].trace.status)).toEqual(["not_configured", "not_configured"]);
    const unjudged = await runJudgmentSuites({ arm: "real", cases, judgeConfig: null });
    expect(unjudged.map((suite) => suite.cases[0].caseKey)).toEqual([
      "qualification_accuracy:not-configured",
      "voice_tone:not-configured",
    ]);
  });

  it("skips with a stated reason on the mock driver and never invents a score", async () => {
    const generate = vi.fn();
    const suites = await runJudgmentSuites({
      arm: "mock",
      cases,
      judgeConfig: { id: "moderator-1", model: "vendor/judge", params: {} },
      generate: generate as never,
      judge: generate as never,
    });
    expect(generate).not.toHaveBeenCalled();
    for (const suite of suites) {
      expect(suite.cases).toHaveLength(1);
      expect(suite.cases[0].passed).toBe(false);
      expect(suite.cases[0].trace).toMatchObject({ status: "skipped", reason: MOCK_ARM_SKIP_REASON });
      expect(suite.cases[0].latencyMs).toBeNull();
    }
  });

  it("scores the real arm and passes only when every criterion holds", async () => {
    const passing = realRun({
      cases,
      judge: (messages) => {
        const body = JSON.parse((messages as { content: string }[])[1].content);
        return judgeReply(true, body.criteria.map((criterion: { id: string }) => criterion.id));
      },
    });
    const suites = await passing.run();
    expect(passing.generate).toHaveBeenCalledTimes(2);
    const qualification = suites[0].cases[0];
    expect(qualification.passed).toBe(true);
    expect(qualification.response).toBe("Fresh reply from the arm.");
    expect(qualification.latencyMs).toBe(15);
    expect(qualification.trace).toMatchObject({
      status: "scored",
      driverArm: "real",
      judgeModel: "vendor/judge",
      providerCostCredits: 0.75,
    });
    expect((qualification.trace.criteria as { id: string }[]).map((entry) => entry.id))
      .toEqual(QUALIFICATION_CRITERIA);
    expect((qualification.trace.rubric as { statement: string }[])[0].statement)
      .toContain("Ready to book");

    const failing = realRun({
      cases,
      judge: (messages) => {
        const body = JSON.parse((messages as { content: string }[])[1].content);
        return JSON.stringify({
          criteria: body.criteria.map((criterion: { id: string }, index: number) => ({
            id: criterion.id,
            satisfied: index !== 0,
            reason: "r",
          })),
        });
      },
    });
    expect((await failing.run())[0].cases[0].passed).toBe(false);
  });

  it("quotes the coach's configured voice answers rather than an opinion of its own", async () => {
    const run = realRun({
      cases,
      judge: (messages) => {
        const body = JSON.parse((messages as { content: string }[])[1].content);
        return judgeReply(true, body.criteria.map((criterion: { id: string }) => criterion.id));
      },
    });
    const voice = (await run.run())[1].cases[0];
    const rubric = voice.trace.rubric as { id: string; statement: string }[];
    expect(rubric.map((entry) => entry.id)).toEqual(["brand_voice", "style"]);
    expect(rubric[0].statement).toContain("friendly");
    expect(rubric[1].statement).toContain("Warm, short sentences, no hype.");
    expect(voice.trace.evidence).toEqual({
      configured_voice: { brand_voice: "friendly", style: "Warm, short sentences, no hype." },
    });
  });

  it("errors instead of scoring when the rubric cannot be built from configuration", async () => {
    const unapproved = await realRun({
      cases,
      judge: () => judgeReply(true, QUALIFICATION_CRITERIA),
      source: rubricSource({ qualificationApproved: false }),
    }).run();
    expect(unapproved[0].cases[0].trace).toMatchObject({
      status: "errored",
      code: "QUALIFICATION_MATRIX_UNAPPROVED",
    });

    const contradicting = parseJudgmentCases([qualificationRow({
      expectation: {
        suite: "qualification_accuracy",
        outcome: "HARD_DQ",
        disclosed: qualificationRow().expectation.disclosed,
      },
    })]);
    const mismatch = await realRun({
      cases: contradicting,
      judge: () => judgeReply(true, QUALIFICATION_CRITERIA),
    }).run();
    expect(mismatch[0].cases[0].trace).toMatchObject({ code: "EXPECTATION_CONTRADICTS_MATRIX" });

    const unknownFacts = parseJudgmentCases([qualificationRow({
      expectation: {
        suite: "qualification_accuracy",
        outcome: "BOOK",
        disclosed: { ...qualificationRow().expectation.disclosed, credit: null },
      },
    })]);
    const unresolved = await realRun({
      cases: unknownFacts,
      judge: () => judgeReply(true, QUALIFICATION_CRITERIA),
    }).run();
    expect(unresolved[0].cases[0].trace).toMatchObject({ code: "EXPECTATION_UNRESOLVED" });

    const unconfigured = await realRun({
      cases,
      judge: () => judgeReply(true, QUALIFICATION_CRITERIA),
      source: rubricSource({
        offer: {
          brandVoice: "friendly",
          voiceStyleAnswer: null,
          voiceObjectionAnswer: null,
          voiceFollowupAnswer: null,
        },
      }),
    }).run();
    expect(unconfigured[1].cases[0].trace).toMatchObject({ code: "VOICE_CONSTRAINT_UNCONFIGURED" });

    const noBundle = await realRun({
      cases,
      judge: () => judgeReply(true, QUALIFICATION_CRITERIA),
      source: null,
    }).run();
    expect(noBundle[0].cases[0].trace).toMatchObject({ code: "RUBRIC_SOURCE_UNAVAILABLE" });
  });

  it("records an unreadable or refused judgment as errored, never as a pass or a fail", async () => {
    const malformed = await realRun({ cases, judge: () => "not json" }).run();
    expect(malformed[0].cases[0].passed).toBe(false);
    expect(malformed[0].cases[0].trace).toMatchObject({
      status: "errored",
      code: "JUDGE_VERDICT_JSON_INVALID",
    });
    expect(malformed[0].cases[0].response).toBe("Fresh reply from the arm.");

    const refused = await realRun({
      cases,
      judge: () => JSON.stringify({ refused: true, reason: "no evidence" }),
    }).run();
    expect(refused[0].cases[0].trace).toMatchObject({ code: "JUDGE_VERDICT_REFUSED" });

    const wrongSet = await realRun({ cases, judge: () => judgeReply(true, ["outcome_applied"]) }).run();
    expect(wrongSet[0].cases[0].trace).toMatchObject({ code: "JUDGE_VERDICT_CRITERIA_MISMATCH" });
  });

  it("derives the result keys both arms must produce without running anything", () => {
    expect(judgmentResultKeys({ cases, judgeConfigured: true })).toEqual([
      "qualification_accuracy:qualification_accuracy:case-q1",
      "voice_tone:voice_tone:case-v1",
    ]);
    expect(judgmentResultKeys({ cases, judgeConfigured: false })).toEqual([
      "qualification_accuracy:qualification_accuracy:not-configured",
      "voice_tone:voice_tone:not-configured",
    ]);
  });
});
