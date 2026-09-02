export const CREDIT_RANGES = [
  "below 600",
  "600–640",
  "640–680",
  "680–700",
  "700+",
  "unknown",
] as const;

export const FUNDING_GOALS = [
  "<$50K",
  "$50K–100K",
  "$100K–150K",
  "$150K+",
] as const;

export const FUNDING_TIMELINES = [
  "ASAP–30d",
  "1–3mo",
  "3–6mo",
  "exploring",
] as const;

export const QUALIFICATION_OUTCOMES = ["BOOK", "SOFT_DQ", "HARD_DQ"] as const;

export type CreditRange = (typeof CREDIT_RANGES)[number];
export type FundingGoal = (typeof FUNDING_GOALS)[number];
export type FundingTimeline = (typeof FUNDING_TIMELINES)[number];
export type QualificationOutcome = (typeof QUALIFICATION_OUTCOMES)[number];

/**
 * The Brain draft is platform-scoped, not tenant-scoped: one admin edits it and
 * every coach inherits the published result, so it must never be filed under a
 * tenant namespace where a second tenant would silently get a different matrix.
 */
export const BRAIN_PREVIEW_SCOPE = "platform" as const;

export type QualificationContext = {
  score: number;
  businessStage: "startup" | "operating" | "unknown";
  annualRevenue: number | null;
  fundingGoal: FundingGoal | null;
  timeline: FundingTimeline | null;
};

export type QualificationRule = {
  id: "strong-credit" | "low-credit" | "startup-nurture" | "revenue-qualified";
  label: string;
  outcome: QualificationOutcome;
  conditions: {
    minScore?: number;
    maxScore?: number;
    businessStage?: QualificationContext["businessStage"];
    minAnnualRevenue?: number;
    fundingGoals?: readonly FundingGoal[];
    timelines?: readonly FundingTimeline[];
  };
};

export type QualificationRuleId = QualificationRule["id"];
export type BrainOutcomeOverrides = Partial<Record<QualificationRuleId, QualificationOutcome>>;

// Demo fixture for the isolated preview. Production rules come from the versioned Brain matrix.
export const DEMO_QUALIFICATION_RULES: readonly QualificationRule[] = [
  {
    id: "strong-credit",
    label: "700+ · any stage · any goal",
    outcome: "BOOK",
    conditions: { minScore: 700 },
  },
  {
    id: "low-credit",
    label: "Below 600",
    outcome: "HARD_DQ",
    conditions: { maxScore: 599 },
  },
  {
    id: "startup-nurture",
    label: "600–640 · startup",
    outcome: "SOFT_DQ",
    conditions: { minScore: 600, maxScore: 639, businessStage: "startup" },
  },
  {
    id: "revenue-qualified",
    label: "640–680 · $50K+ revenue · $50K+ goal · committed timeline",
    outcome: "BOOK",
    conditions: {
      minScore: 640,
      maxScore: 680,
      minAnnualRevenue: 50_000,
      fundingGoals: [FUNDING_GOALS[1], FUNDING_GOALS[2], FUNDING_GOALS[3]],
      timelines: [FUNDING_TIMELINES[0], FUNDING_TIMELINES[1], FUNDING_TIMELINES[2]],
    },
  },
];

export function normalizeBrainOutcomeOverrides(value: unknown): BrainOutcomeOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(([id, outcome]) =>
    DEMO_QUALIFICATION_RULES.some((rule) => rule.id === id) &&
    QUALIFICATION_OUTCOMES.includes(outcome as QualificationOutcome),
  );
  return Object.fromEntries(entries) as BrainOutcomeOverrides;
}

export function resolveDemoQualification(
  context: QualificationContext,
  overrides: BrainOutcomeOverrides = {},
) {
  const rule = DEMO_QUALIFICATION_RULES.find((candidate) => {
    const { conditions } = candidate;

    if (conditions.minScore !== undefined && context.score < conditions.minScore) return false;
    if (conditions.maxScore !== undefined && context.score > conditions.maxScore) return false;
    if (conditions.businessStage && context.businessStage !== conditions.businessStage) return false;
    if (
      conditions.minAnnualRevenue !== undefined &&
      (context.annualRevenue === null || context.annualRevenue < conditions.minAnnualRevenue)
    ) return false;
    if (
      conditions.fundingGoals &&
      (context.fundingGoal === null || !conditions.fundingGoals.includes(context.fundingGoal))
    ) return false;
    if (
      conditions.timelines &&
      (context.timeline === null || !conditions.timelines.includes(context.timeline))
    ) return false;

    return true;
  });

  return rule ? { ...rule, outcome: overrides[rule.id] ?? rule.outcome } : null;
}
