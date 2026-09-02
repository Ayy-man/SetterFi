/**
 * The LLM judge boundary for the two judgement suites.
 *
 * The judge never gets to invent a standard: every criterion it sees is a sentence built from
 * configuration — the published qualification matrix, or the coach's own offer-layer voice
 * answers — and it must answer each one by id with a boolean and a reason. A refusal, a malformed
 * envelope, or a criterion set that does not match what was asked is an error, not a verdict, so
 * an unreadable judgment can never be recorded as a pass or as a fail on the agent.
 */

export type JudgeCriterion = {
  id: string;
  statement: string;
};

export type JudgeRubric = {
  suite: "qualification_accuracy" | "voice_tone";
  caseKey: string;
  criteria: readonly JudgeCriterion[];
  /** Everything the judge is allowed to reason from, quoted into the prompt verbatim. */
  evidence: Readonly<Record<string, unknown>>;
  transcript: readonly { role: "user" | "assistant"; content: string }[];
  reply: string;
};

export type JudgeCriterionVerdict = {
  id: string;
  satisfied: boolean;
  reason: string;
};

export type JudgeVerdict = {
  criteria: readonly JudgeCriterionVerdict[];
};

export const JUDGE_VERDICT_CODES = [
  "JUDGE_VERDICT_JSON_INVALID",
  "JUDGE_VERDICT_ENVELOPE_INVALID",
  "JUDGE_VERDICT_REFUSED",
  "JUDGE_VERDICT_CRITERIA_MISMATCH",
] as const;
export type JudgeVerdictCode = (typeof JUDGE_VERDICT_CODES)[number];

export class JudgeVerdictError extends Error {
  constructor(readonly code: JudgeVerdictCode, readonly detail: string | null = null) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "JudgeVerdictError";
  }
}

export const JUDGE_SYSTEM_PROMPT = [
  "You grade one agent reply against a fixed list of criteria. You are not the agent and you never",
  "rewrite the reply.",
  "",
  "Judge only against the criteria you are given, using only the evidence and transcript in the",
  "message. Never apply a standard that is not written in a criterion. Never assume a fact the",
  "transcript does not contain.",
  "",
  'Return a single JSON object with exactly one key, "criteria": an array holding one entry per',
  'criterion id you were given, in any order. Each entry has exactly three keys: "id" (one of the',
  'given ids), "satisfied" (true or false), and "reason" (one short sentence quoting what in the',
  "reply decided it).",
  "",
  'If you cannot grade — the evidence is insufficient, or a criterion is unanswerable — return',
  '{"refused": true, "reason": "<why>"} instead. Do not guess, and do not return a partial list.',
].join("\n");

/**
 * Deterministic by default. A moderator `model_configs` row's own params still win, the same way
 * they do for the moderator ladder in the OpenRouter driver.
 */
export const JUDGE_DEFAULT_PARAMS = {
  temperature: 0,
  response_format: { type: "json_object" },
} as const;

export function buildJudgeMessages(rubric: JudgeRubric) {
  if (rubric.criteria.length === 0) throw new JudgeVerdictError("JUDGE_VERDICT_CRITERIA_MISMATCH", "empty");
  const ids = rubric.criteria.map((criterion) => criterion.id);
  if (new Set(ids).size !== ids.length) {
    throw new JudgeVerdictError("JUDGE_VERDICT_CRITERIA_MISMATCH", "duplicate_criterion_id");
  }
  return [
    { role: "system" as const, content: JUDGE_SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: JSON.stringify({
        suite: rubric.suite,
        case_key: rubric.caseKey,
        criteria: rubric.criteria.map((criterion) => ({
          id: criterion.id,
          statement: criterion.statement,
        })),
        evidence: rubric.evidence,
        transcript: rubric.transcript,
        reply_under_review: rubric.reply,
      }),
    },
  ];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseJudgeVerdict(
  content: string,
  criterionIds: readonly string[],
): JudgeVerdict {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    throw new JudgeVerdictError("JUDGE_VERDICT_JSON_INVALID");
  }
  const row = object(payload);
  if (!row) throw new JudgeVerdictError("JUDGE_VERDICT_ENVELOPE_INVALID");
  if (row.refused === true) {
    const reason = typeof row.reason === "string" && row.reason.trim() ? row.reason.trim() : null;
    throw new JudgeVerdictError("JUDGE_VERDICT_REFUSED", reason);
  }
  if (!Array.isArray(row.criteria)) throw new JudgeVerdictError("JUDGE_VERDICT_ENVELOPE_INVALID");
  const expected = new Set(criterionIds);
  const criteria = row.criteria.map((entry) => {
    const candidate = object(entry);
    if (!candidate || Object.keys(candidate).sort().join(",") !== "id,reason,satisfied" ||
      typeof candidate.id !== "string" || typeof candidate.satisfied !== "boolean" ||
      typeof candidate.reason !== "string" || !candidate.reason.trim()) {
      throw new JudgeVerdictError("JUDGE_VERDICT_ENVELOPE_INVALID");
    }
    return {
      id: candidate.id,
      satisfied: candidate.satisfied,
      reason: candidate.reason.trim(),
    };
  });
  const answered = criteria.map((criterion) => criterion.id);
  if (new Set(answered).size !== answered.length ||
    answered.length !== expected.size ||
    answered.some((id) => !expected.has(id))) {
    throw new JudgeVerdictError("JUDGE_VERDICT_CRITERIA_MISMATCH", answered.sort().join(","));
  }
  return { criteria };
}
