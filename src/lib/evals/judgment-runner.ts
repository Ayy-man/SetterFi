/**
 * Executes the two judgement suites and turns each case into a recorded eval result.
 *
 * Both suites replay a promoted conversation through the arm's own generator and then score the
 * fresh reply with a judge, so an A/B comparison is measuring the two model configurations rather
 * than re-reading the same stored text twice. Every criterion the judge sees is built from
 * configuration this deployment already holds — the published qualification matrix for
 * `qualification_accuracy`, the coach's own offer-layer voice answers for `voice_tone` — so the
 * suites have no opinion of their own to smuggle in.
 *
 * Three honest states, and nothing in between:
 *   - no promoted cases, or no judge model configured -> `not_configured`, exactly as before.
 *   - the mock OpenRouter arm                         -> `skipped`, with the reason on every row.
 *   - the real arm                                    -> `scored`, or `errored` when the rubric
 *     cannot be built or the judgment cannot be read. An errored case is never a silent pass and
 *     never a fail charged to the agent.
 */

import type { PublishedCoachOffer, QualificationRule } from "@/lib/brain/contracts";
import { QUALIFICATION_OUTCOME_COPY } from "@/lib/copy/states";
import { resolveRuntimeQualification } from "@/lib/engine/pipeline";
import type { QualificationOutcome } from "@/lib/domain/qualification";
import {
  buildJudgeMessages,
  JUDGE_DEFAULT_PARAMS,
  JudgeVerdictError,
  parseJudgeVerdict,
  type JudgeCriterion,
  type JudgeRubric,
} from "@/lib/evals/judge";
import {
  JUDGMENT_SUITES,
  type JudgmentCase,
  type JudgmentSuite,
  type VoiceConstraintId,
} from "@/lib/evals/judgment-cases";
import type { ModelDriver } from "@/lib/integrations/types";
import type { EvalCaseResultInput, EvalSuiteResultInput } from "@/lib/repositories/eval-runs";

export const MOCK_ARM_SKIP_REASON =
  "SETTERFI_OPENROUTER_DRIVER is mock; a judged suite needs the real provider to produce a score.";

/**
 * How the engine actually treats each outcome at the end of a turn: `src/lib/engine/pipeline.ts`
 * closes a HARD_DQ conversation, moves a SOFT_DQ to nurture, and leaves a BOOK with the agent.
 * The criterion text quotes this mapping rather than restating anyone's idea of what should happen.
 */
export const OUTCOME_CONVERSATION_STATE: Record<QualificationOutcome, "closed" | "nurture" | "agent"> = {
  BOOK: "agent",
  SOFT_DQ: "nurture",
  HARD_DQ: "closed",
};

export type JudgeModelConfig = {
  id: string;
  model: string;
  params: Readonly<Record<string, unknown>>;
};

export type JudgmentOfferVoice = Pick<
  PublishedCoachOffer,
  "brandVoice" | "voiceStyleAnswer" | "voiceObjectionAnswer" | "voiceFollowupAnswer"
>;

export type JudgmentRubricSource = {
  tenantId: string;
  compiledPlatform: string;
  qualification: readonly QualificationRule[];
  qualificationApproved: boolean;
  offer: JudgmentOfferVoice;
};

export type JudgmentGenerate = ModelDriver["generate"];

export type JudgmentRunInput = {
  arm: "mock" | "real";
  cases: readonly JudgmentCase[];
  judgeConfig: JudgeModelConfig | null;
  /** The arm's generator; produces the reply under review. Required on the real arm. */
  generate?: JudgmentGenerate;
  /** The judge model; scores that reply. Required on the real arm. */
  judge?: JudgmentGenerate;
  loadRubricSource?: (tenantId: string) => Promise<JudgmentRubricSource | null>;
  generatorConfig?: JudgeModelConfig;
};

type RubricBuild =
  | { state: "ready"; criteria: readonly JudgeCriterion[]; evidence: Readonly<Record<string, unknown>> }
  | { state: "errored"; code: string; reason: string };

const VOICE_CONSTRAINT_FIELDS: Record<VoiceConstraintId, keyof JudgmentOfferVoice> = {
  brand_voice: "brandVoice",
  style: "voiceStyleAnswer",
  objection: "voiceObjectionAnswer",
  followup: "voiceFollowupAnswer",
};

const VOICE_CONSTRAINT_LEADS: Record<VoiceConstraintId, string> = {
  brand_voice: "the brand voice this coach configured",
  style: "the style this coach configured",
  objection: "the objection handling this coach configured",
  followup: "the follow-up approach this coach configured",
};

export function notConfiguredSuite(suite: JudgmentSuite): EvalSuiteResultInput {
  return {
    suite,
    cases: [{
      caseKey: `${suite}:not-configured`,
      passed: false,
      response: null,
      trace: { status: "not_configured", ruleIds: [] },
      latencyMs: null,
      costCents: null,
    }],
  };
}

function skippedCase(entry: JudgmentCase, arm: "mock" | "real"): EvalCaseResultInput {
  return {
    caseKey: entry.key,
    passed: false,
    response: null,
    trace: { status: "skipped", driverArm: arm, reason: MOCK_ARM_SKIP_REASON, ruleIds: [] },
    latencyMs: null,
    costCents: null,
  };
}

function erroredCase(
  entry: JudgmentCase,
  arm: "mock" | "real",
  code: string,
  reason: string,
  response: string | null = null,
): EvalCaseResultInput {
  return {
    caseKey: entry.key,
    passed: false,
    response,
    trace: { status: "errored", driverArm: arm, code, reason, ruleIds: [] },
    latencyMs: null,
    costCents: null,
  };
}

/** The turns the arm is asked to answer: everything up to and including the lead's last message. */
export function promptTurns(entry: JudgmentCase) {
  const lastLead = entry.turns.map((turn) => turn.role).lastIndexOf("user");
  return entry.turns.slice(0, lastLead + 1);
}

export function buildQualificationRubric(
  entry: JudgmentCase,
  source: JudgmentRubricSource,
): RubricBuild {
  if (entry.expectation.suite !== "qualification_accuracy") {
    return { state: "errored", code: "RUBRIC_SUITE_MISMATCH", reason: "Expectation is not a qualification expectation." };
  }
  if (!source.qualificationApproved || source.qualification.length === 0) {
    return {
      state: "errored",
      code: "QUALIFICATION_MATRIX_UNAPPROVED",
      reason: "No approved published qualification matrix; there is no criterion to judge against.",
    };
  }
  const disclosed = entry.expectation.disclosed;
  const resolved = resolveRuntimeQualification(source.qualification, {
    ...disclosed,
    outcome: null,
    dqReason: null,
  });
  if (!resolved.decision) {
    return {
      state: "errored",
      code: "EXPECTATION_UNRESOLVED",
      reason: "The published matrix returns no outcome for the facts this case records as disclosed.",
    };
  }
  if (resolved.decision.outcome !== entry.expectation.outcome) {
    return {
      state: "errored",
      code: "EXPECTATION_CONTRADICTS_MATRIX",
      reason: `The published matrix returns ${resolved.decision.outcome} for these facts; the case expects ${entry.expectation.outcome}.`,
    };
  }
  const outcome = entry.expectation.outcome;
  const label = QUALIFICATION_OUTCOME_COPY[outcome].label;
  const posture = OUTCOME_CONVERSATION_STATE[outcome];
  return {
    state: "ready",
    criteria: [
      {
        id: "outcome_applied",
        statement: `The reply treats this lead as "${label}" (${outcome}), which is the outcome the published qualification matrix below returns for the facts the lead disclosed.`,
      },
      {
        id: "conversation_posture",
        statement: `The reply leaves the conversation in the "${posture}" posture the engine uses for ${outcome}: "agent" keeps qualifying or moves toward booking, "nurture" stops short of booking and offers a later path, "closed" declines and does not offer a booking.`,
      },
      {
        id: "facts_grounded",
        statement: "Every qualifying fact the reply relies on appears in the disclosed facts below or in the transcript; the reply invents no credit, revenue, goal, or timeline the lead never gave.",
      },
    ],
    evidence: {
      qualification_matrix: source.qualification.map((rule) => ({
        id: rule.id,
        label: rule.label,
        outcome: rule.outcome,
        conditions: rule.conditions,
      })),
      disclosed_facts: disclosed,
      matrix_outcome: resolved.decision.outcome,
      matrix_rule_id: resolved.decision.ruleId,
    },
  };
}

export function buildVoiceRubric(
  entry: JudgmentCase,
  source: JudgmentRubricSource,
): RubricBuild {
  if (entry.expectation.suite !== "voice_tone") {
    return { state: "errored", code: "RUBRIC_SUITE_MISMATCH", reason: "Expectation is not a voice expectation." };
  }
  const configured: Record<string, string> = {};
  const criteria: JudgeCriterion[] = [];
  for (const constraint of entry.expectation.constraints) {
    const value = source.offer[VOICE_CONSTRAINT_FIELDS[constraint]];
    if (typeof value !== "string" || !value.trim()) {
      return {
        state: "errored",
        code: "VOICE_CONSTRAINT_UNCONFIGURED",
        reason: `This coach has not configured ${constraint}; there is no rubric text to judge against.`,
      };
    }
    configured[constraint] = value.trim();
    criteria.push({
      id: constraint,
      statement: `The reply matches ${VOICE_CONSTRAINT_LEADS[constraint]}: "${value.trim()}".`,
    });
  }
  return { state: "ready", criteria, evidence: { configured_voice: configured } };
}

function buildRubric(entry: JudgmentCase, source: JudgmentRubricSource): RubricBuild {
  return entry.suite === "qualification_accuracy"
    ? buildQualificationRubric(entry, source)
    : buildVoiceRubric(entry, source);
}

function sumCredits(left: number | null, right: number | null) {
  return left === null || right === null ? null : left + right;
}

async function runCase(
  entry: JudgmentCase,
  input: JudgmentRunInput & { generate: JudgmentGenerate; judge: JudgmentGenerate; judgeConfig: JudgeModelConfig },
): Promise<EvalCaseResultInput> {
  const source = await (input.loadRubricSource?.(entry.sourceTenantId) ?? Promise.resolve(null));
  if (!source || source.tenantId !== entry.sourceTenantId) {
    return erroredCase(entry, "real", "RUBRIC_SOURCE_UNAVAILABLE",
      "The source tenant has no published runtime bundle to build a rubric from.");
  }
  if (!source.compiledPlatform.trim()) {
    return erroredCase(entry, "real", "RUBRIC_SOURCE_UNAVAILABLE",
      "The source tenant's published snapshot carries no compiled platform prompt.");
  }
  const rubricBuild = buildRubric(entry, source);
  if (rubricBuild.state === "errored") {
    return erroredCase(entry, "real", rubricBuild.code, rubricBuild.reason);
  }
  const transcript = promptTurns(entry);

  let generated: Awaited<ReturnType<JudgmentGenerate>>;
  try {
    generated = await input.generate([
      { role: "system", content: source.compiledPlatform },
      ...transcript.map((turn) => ({ role: turn.role, content: turn.content })),
    ], {
      model: input.generatorConfig?.model ?? "",
      params: { ...(input.generatorConfig?.params ?? {}) },
    });
  } catch (error) {
    return erroredCase(entry, "real", "GENERATION_FAILED",
      error instanceof Error ? error.message : "The arm's generator did not answer.");
  }

  const rubric: JudgeRubric = {
    suite: entry.suite,
    caseKey: entry.key,
    criteria: rubricBuild.criteria,
    evidence: rubricBuild.evidence,
    transcript,
    reply: generated.draft,
  };
  let judged: Awaited<ReturnType<JudgmentGenerate>>;
  try {
    judged = await input.judge(buildJudgeMessages(rubric), {
      model: input.judgeConfig.model,
      params: { ...JUDGE_DEFAULT_PARAMS, ...input.judgeConfig.params },
    });
  } catch (error) {
    return erroredCase(entry, "real", "JUDGE_CALL_FAILED",
      error instanceof Error ? error.message : "The judge did not answer.", generated.draft);
  }

  const latencyMs = generated.provider.latencyMs + judged.provider.latencyMs;
  const providerCostCredits = sumCredits(generated.provider.cost, judged.provider.cost);
  try {
    const verdict = parseJudgeVerdict(
      judged.draft,
      rubricBuild.criteria.map((criterion) => criterion.id),
    );
    return {
      caseKey: entry.key,
      passed: verdict.criteria.every((criterion) => criterion.satisfied),
      response: generated.draft,
      trace: {
        status: "scored",
        driverArm: "real",
        suite: entry.suite,
        judgeModel: input.judgeConfig.model,
        judgeModelConfigId: input.judgeConfig.id,
        criteria: verdict.criteria,
        rubric: rubricBuild.criteria,
        evidence: rubricBuild.evidence,
        providerCostCredits,
        ruleIds: [],
      },
      latencyMs,
      // Provider credits have no approved cents conversion; the legacy cents column stays absent.
      costCents: null,
    };
  } catch (error) {
    const code = error instanceof JudgeVerdictError ? error.code : "JUDGE_VERDICT_UNREADABLE";
    return {
      ...erroredCase(entry, "real", code,
        error instanceof Error ? error.message : "The judgment could not be read.", generated.draft),
      latencyMs,
    };
  }
}

export async function runJudgmentSuites(
  input: JudgmentRunInput,
): Promise<readonly EvalSuiteResultInput[]> {
  const suites: EvalSuiteResultInput[] = [];
  for (const suite of JUDGMENT_SUITES) {
    const suiteCases = input.cases.filter((entry) => entry.suite === suite);
    if (suiteCases.length === 0 || !input.judgeConfig) {
      suites.push(notConfiguredSuite(suite));
      continue;
    }
    if (input.arm === "mock") {
      suites.push({ suite, cases: suiteCases.map((entry) => skippedCase(entry, "mock")) });
      continue;
    }
    if (!input.generate || !input.judge) {
      suites.push({
        suite,
        cases: suiteCases.map((entry) => erroredCase(entry, "real", "JUDGE_DRIVER_MISSING",
          "The real arm was selected without a generator and judge driver.")),
      });
      continue;
    }
    const cases: EvalCaseResultInput[] = [];
    for (const entry of suiteCases) {
      cases.push(await runCase(entry, {
        ...input,
        generate: input.generate,
        judge: input.judge,
        judgeConfig: input.judgeConfig,
      }));
    }
    suites.push({ suite, cases });
  }
  return suites;
}

/** The result keys both arms must produce, derived without running anything. */
export function judgmentResultKeys(input: {
  cases: readonly JudgmentCase[];
  judgeConfigured: boolean;
}) {
  return JUDGMENT_SUITES.flatMap((suite) => {
    const suiteCases = input.cases.filter((entry) => entry.suite === suite);
    if (suiteCases.length === 0 || !input.judgeConfigured) {
      return [`${suite}:${suite}:not-configured`];
    }
    return suiteCases.map((entry) => `${suite}:${entry.key}`);
  });
}
