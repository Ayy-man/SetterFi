/**
 * Case definitions for the two judgement suites.
 *
 * The safety suites read reviewed JSON under `evals/corpus`. The judgement suites have a different
 * authority: `public.eval_cases`, written only by `promote_eval_case` from a real conversation an
 * admin redacted and confirmed. Nothing here invents a case, a qualifying criterion, or a tone —
 * this module only states the shape an admin-authored expectation has to have, and refuses the
 * whole run when a row does not have it, so a malformed expectation can never read as a score.
 */

import { createHash } from "node:crypto";

import { serializeCanonicalJson, type CanonicalJson } from "@/lib/brain/snapshot/canonicalize";
import {
  CREDIT_RANGES,
  FUNDING_GOALS,
  FUNDING_TIMELINES,
  QUALIFICATION_OUTCOMES,
  type CreditRange,
  type FundingGoal,
  type FundingTimeline,
  type QualificationOutcome,
} from "@/lib/domain/qualification";
import {
  EVAL_PROMOTION_SUITES,
  type EvalPromotionSuite,
  type RedactedEvalTurn,
} from "@/lib/evals/redaction";

export const JUDGMENT_SUITES = EVAL_PROMOTION_SUITES;
export type JudgmentSuite = EvalPromotionSuite;

/**
 * The four coach-owned voice fields on the published offer, named so a promoted case can say
 * which of them its conversation is evidence for. The rubric text for each one is the coach's
 * configured value, read at run time — never a sentence written here.
 */
export const VOICE_CONSTRAINT_IDS = ["brand_voice", "style", "objection", "followup"] as const;
export type VoiceConstraintId = (typeof VOICE_CONSTRAINT_IDS)[number];

/** Exactly the facts the published qualification matrix reads, so the expectation is checkable. */
export type DisclosedQualificationFacts = {
  credit: CreditRange | null;
  goal: FundingGoal | null;
  timeline: FundingTimeline | null;
  businessStage: "startup" | "operating" | "unknown" | null;
  annualRevenueCents: number | null;
};

export type QualificationExpectation = {
  suite: "qualification_accuracy";
  outcome: QualificationOutcome;
  disclosed: DisclosedQualificationFacts;
};

export type VoiceExpectation = {
  suite: "voice_tone";
  constraints: readonly VoiceConstraintId[];
};

export type JudgmentExpectation = QualificationExpectation | VoiceExpectation;

export type JudgmentCase = {
  id: string;
  key: string;
  suite: JudgmentSuite;
  sourceTenantId: string;
  turns: readonly RedactedEvalTurn[];
  expectation: JudgmentExpectation;
};

const BUSINESS_STAGES = new Set(["startup", "operating", "unknown"]);
const CREDIT = new Set<string>(CREDIT_RANGES);
const GOALS = new Set<string>(FUNDING_GOALS);
const TIMELINES = new Set<string>(FUNDING_TIMELINES);
const OUTCOMES = new Set<string>(QUALIFICATION_OUTCOMES);
const CONSTRAINTS = new Set<string>(VOICE_CONSTRAINT_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refuse(caseId: string, reason: string): never {
  throw new Error(`JUDGMENT_CASE_INVALID:${caseId}:${reason}`);
}

export function judgmentCaseKey(suite: JudgmentSuite, id: string) {
  return `${suite}:${id}`;
}

function parseTurns(value: unknown, caseId: string): readonly RedactedEvalTurn[] {
  if (!Array.isArray(value) || value.length === 0) refuse(caseId, "turns");
  const turns = value.map((entry, index) => {
    if (!isRecord(entry) || (entry.role !== "user" && entry.role !== "assistant") ||
      typeof entry.content !== "string" || !entry.content.trim()) {
      refuse(caseId, `turns[${index}]`);
    }
    return { role: entry.role, content: entry.content.trim() } as const;
  });
  // A judgement case is evidence about a reply to a lead, so the arm has something to answer.
  if (!turns.some((turn) => turn.role === "user")) refuse(caseId, "turns_no_lead_turn");
  return turns;
}

function parseDisclosed(value: unknown, caseId: string): DisclosedQualificationFacts {
  if (!isRecord(value)) refuse(caseId, "expectation.disclosed");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "annualRevenueCents,businessStage,credit,goal,timeline") {
    refuse(caseId, "expectation.disclosed_keys");
  }
  const named = (field: string, allowed: ReadonlySet<string>) => {
    const entry = value[field];
    if (entry === null) return null;
    if (typeof entry !== "string" || !allowed.has(entry)) refuse(caseId, `expectation.disclosed.${field}`);
    return entry;
  };
  const revenue = value.annualRevenueCents;
  if (revenue !== null &&
    (typeof revenue !== "number" || !Number.isSafeInteger(revenue) || revenue < 0)) {
    refuse(caseId, "expectation.disclosed.annualRevenueCents");
  }
  return {
    credit: named("credit", CREDIT) as CreditRange | null,
    goal: named("goal", GOALS) as FundingGoal | null,
    timeline: named("timeline", TIMELINES) as FundingTimeline | null,
    businessStage: named("businessStage", BUSINESS_STAGES) as
      DisclosedQualificationFacts["businessStage"],
    annualRevenueCents: revenue as number | null,
  };
}

function parseExpectation(
  value: unknown,
  suite: JudgmentSuite,
  caseId: string,
): JudgmentExpectation {
  if (!isRecord(value) || value.suite !== suite) refuse(caseId, "expectation.suite");
  if (suite === "qualification_accuracy") {
    if (Object.keys(value).sort().join(",") !== "disclosed,outcome,suite") {
      refuse(caseId, "expectation.keys");
    }
    if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) {
      refuse(caseId, "expectation.outcome");
    }
    return {
      suite,
      outcome: value.outcome as QualificationOutcome,
      disclosed: parseDisclosed(value.disclosed, caseId),
    };
  }
  if (Object.keys(value).sort().join(",") !== "constraints,suite") refuse(caseId, "expectation.keys");
  const constraints = value.constraints;
  if (!Array.isArray(constraints) || constraints.length === 0) refuse(caseId, "expectation.constraints");
  const parsed = constraints.map((entry) => {
    if (typeof entry !== "string" || !CONSTRAINTS.has(entry)) {
      refuse(caseId, `expectation.constraints:${String(entry)}`);
    }
    return entry as VoiceConstraintId;
  });
  if (new Set(parsed).size !== parsed.length) refuse(caseId, "expectation.constraints_duplicate");
  return { suite, constraints: parsed };
}

/** Parses one `eval_cases` row. Anything unexpected refuses rather than degrading to a guess. */
export function parseJudgmentCase(row: Record<string, unknown>): JudgmentCase {
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : "";
  if (!id) refuse("unknown", "id");
  const suite = row.suite;
  if (typeof suite !== "string" || !JUDGMENT_SUITES.includes(suite as JudgmentSuite)) {
    refuse(id, "suite");
  }
  if (row.kind !== "engine") refuse(id, "kind");
  const sourceTenantId = typeof row.source_tenant_id === "string" ? row.source_tenant_id.trim() : "";
  if (!sourceTenantId) refuse(id, "source_tenant_id");
  return {
    id,
    key: judgmentCaseKey(suite as JudgmentSuite, id),
    suite: suite as JudgmentSuite,
    sourceTenantId,
    turns: parseTurns(row.turns, id),
    expectation: parseExpectation(row.expectation, suite as JudgmentSuite, id),
  };
}

export function parseJudgmentCases(rows: readonly Record<string, unknown>[]): readonly JudgmentCase[] {
  const cases = rows.map(parseJudgmentCase);
  const seen = new Set<string>();
  for (const entry of cases) {
    if (seen.has(entry.key)) refuse(entry.id, "duplicate_case_key");
    seen.add(entry.key);
  }
  return [...cases].sort((left, right) => left.key.localeCompare(right.key));
}

/** Binds a comparison to the exact judgement case bodies both arms answered. */
export function judgmentCaseSetHash(cases: readonly JudgmentCase[]) {
  const hash = createHash("sha256");
  for (const entry of [...cases].sort((left, right) => left.key.localeCompare(right.key))) {
    hash.update(entry.key);
    hash.update("\0");
    hash.update(serializeCanonicalJson({
      turns: entry.turns,
      expectation: entry.expectation,
    } as unknown as CanonicalJson));
    hash.update("\0");
  }
  return hash.digest("hex");
}
