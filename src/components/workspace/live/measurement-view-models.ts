/**
 * Pure coach measurement reducers over the validated Phase 7 repository snapshot.
 *
 * Formatting stays downstream of evidence validation, but absence remains structural: a missing
 * or nonnumeric metric can produce honest status copy and can never retain a previous value.
 */

import {
  availableMetric,
  metricDefinition,
  type MetricEvidence,
  type MetricKey,
  type MetricState,
} from "@/lib/analytics/metric-definitions";
import type {
  CoachLeadComposition,
  CoachMeasurement,
  CoachPipelineRow,
  CoachTopObjections,
} from "@/lib/repositories/analytics";

export const COACH_HOME_KPI_KEYS = [
  "coach.new_leads",
  "coach.active_leads",
  "coach.qualified_leads",
  "coach.disqualified_leads",
  "coach.booked_contacts",
  "coach.conversion_rate",
  "coach.average_time_to_book",
  "coach.pipeline_win_rate",
  "coach.agent_win_rate",
  "coach.show_rate",
] as const satisfies readonly MetricKey[];

export const COACH_KEYWORD_COLUMNS = [
  "keyword",
  "conversations",
  "qualifiedContacts",
  "respondedConversations",
  "bookedContacts",
  "dataLabel",
] as const;

export const COACH_STEP_COLUMNS = [
  "stepKey",
  "stepLabel",
  "enteredContacts",
  "completedContacts",
  "askedContacts",
  "answeredContacts",
  "responseRate",
  "dataLabel",
] as const;

export const COACH_PIPELINE_COLUMNS = [
  "contactId",
  "displayName",
  "stage",
  "attributedToAgent",
  "latestAppointmentStatus",
  "changedAt",
  "dataLabel",
] as const;

export const COACH_PIPELINE_STAGES = [
  { key: "new_lead", label: "New lead" },
  { key: "qualifying", label: "Qualifying" },
  { key: "booked", label: "Booked" },
  { key: "qualified_no_buy", label: "Qualified, no buy" },
  { key: "long_term_followup", label: "Long-term follow-up" },
  { key: "no_show", label: "No show" },
  { key: "disqualified", label: "Disqualified" },
] as const satisfies ReadonlyArray<{ key: CoachPipelineRow["stage"]; label: string }>;

export type MetricDescriptorView = {
  denominator: string;
  window: string;
  clock: string;
  text: string;
};

export type CoachMetricView = {
  key: (typeof COACH_HOME_KPI_KEYS)[number];
  label: string;
  value: string | null;
  absenceLabel: "Unavailable" | "No completed events yet" | "Needs more history" | null;
  descriptor: MetricDescriptorView;
  selfReported: boolean;
};

export type CoachStepView = {
  stepKey: string;
  stepLabel: string;
  enteredContacts: number | null;
  completedContacts: number | null;
  askedContacts: number | null;
  answeredContacts: number | null;
  responseRate: number | null;
  dataLabel: string;
};

export type CoachMeasurementView = {
  metrics: readonly CoachMetricView[];
  isDemo: boolean;
  allowance: CoachMeasurement["allowance"] & { descriptor: MetricDescriptorView };
  funnel: CoachMeasurement["funnel"];
  responses: CoachMeasurement["responses"];
  steps: readonly CoachStepView[];
  keywords: CoachMeasurement["keywords"];
  descriptors: {
    funnel: MetricDescriptorView;
    responses: MetricDescriptorView;
    keywords: MetricDescriptorView;
  };
};

export type CoachPipelineView = {
  stages: ReadonlyArray<{
    key: CoachPipelineRow["stage"];
    label: string;
    rows: readonly CoachPipelineRow[];
  }>;
  pipelineWin: CoachMetricView;
  agentWin: CoachMetricView;
  readOnlyReason: "Pipeline changes are read-only because no persisted mutation is available.";
};

export function coachMetricDisplay(
  view: Pick<CoachMetricView, "value" | "absenceLabel">,
) {
  return view.value ?? view.absenceLabel ?? "Unavailable";
}

function descriptorFor(key: MetricKey): MetricDescriptorView {
  const definition = metricDefinition(key);
  return {
    denominator: definition.denominator,
    window: definition.window,
    clock: definition.clock,
    text: `Denominator: ${definition.denominator} Window: ${definition.window} Clock: ${definition.clock}`,
  };
}

function absenceLabel(state: MetricState | "missing") {
  if (state === "still_filling") return "No completed events yet" as const;
  if (state === "needs_more_history") return "Needs more history" as const;
  return "Unavailable" as const;
}

function formatMetric(evidence: MetricEvidence, value: number) {
  const definition = metricDefinition(evidence.metricKey);
  if (definition.unit === "percent") return `${value}%`;
  if (definition.unit === "seconds") {
    if (value < 60) return `${Math.round(value)} sec`;
    if (value < 3_600) return `${Math.round(value / 60)} min`;
    return `${Math.round((value / 3_600) * 10) / 10} hr`;
  }
  if (definition.unit === "days") return `${Math.round(value * 10) / 10} days`;
  return new Intl.NumberFormat("en").format(value);
}

function metricView(
  snapshot: CoachMeasurement,
  key: (typeof COACH_HOME_KPI_KEYS)[number],
): CoachMetricView {
  const definition = metricDefinition(key);
  const evidence = snapshot.metrics.find((row) => row.metricKey === key);
  const numeric = evidence ? availableMetric(evidence) : null;
  return {
    key,
    label: definition.label,
    value: evidence && numeric !== null ? formatMetric(evidence, numeric) : null,
    absenceLabel: evidence && numeric !== null ? null : absenceLabel(evidence?.state ?? "missing"),
    descriptor: descriptorFor(key),
    selfReported: key === "coach.show_rate",
  };
}

function stepViews(snapshot: CoachMeasurement): CoachStepView[] {
  const keys = [...new Set([
    ...snapshot.funnel.map((row) => row.stepKey),
    ...snapshot.responses.map((row) => row.stepKey),
  ])];
  return keys.map((stepKey) => {
    const funnel = snapshot.funnel.find((row) => row.stepKey === stepKey);
    const response = snapshot.responses.find((row) => row.stepKey === stepKey);
    const asked = response?.askedContacts ?? null;
    const answered = response?.answeredContacts ?? null;
    return {
      stepKey,
      stepLabel: funnel?.stepLabel ?? response?.stepLabel ?? "Step",
      enteredContacts: funnel?.enteredContacts ?? null,
      completedContacts: funnel?.completedContacts ?? null,
      askedContacts: asked,
      answeredContacts: answered,
      responseRate: asked && answered !== null ? Math.round((answered / asked) * 1_000) / 10 : null,
      dataLabel: "Database truth",
    };
  });
}

export function coachMeasurementView(snapshot: CoachMeasurement): CoachMeasurementView {
  return {
    metrics: COACH_HOME_KPI_KEYS.map((key) => metricView(snapshot, key)),
    isDemo: snapshot.isDemo,
    allowance: {
      ...snapshot.allowance,
      descriptor: descriptorFor("coach.allowance_used"),
    },
    funnel: snapshot.funnel,
    responses: snapshot.responses,
    steps: stepViews(snapshot),
    keywords: snapshot.keywords,
    descriptors: {
      funnel: descriptorFor("coach.funnel.entered"),
      responses: descriptorFor("coach.step.response_rate"),
      keywords: descriptorFor("coach.keyword.conversations"),
    },
  };
}

/**
 * Render order is DOM order, and `.ws-composition-chart__bar` is a flex column, so the first
 * entry paints at the top of the bar and qualified ends up at its base.
 */
export const COACH_COMPOSITION_SEGMENTS = [
  { key: "disqualified", label: "Disqualified" },
  { key: "active", label: "Active / no outcome yet" },
  { key: "qualified", label: "Qualified" },
] as const;

export const COACH_COMPOSITION_COLUMNS = [
  "month",
  "label",
  "total",
  "qualified",
  "active",
  "disqualified",
  "partial",
  "dataLabel",
] as const;

export type CoachCompositionSegmentKey = (typeof COACH_COMPOSITION_SEGMENTS)[number]["key"];

export type CoachCompositionSegmentView = {
  key: CoachCompositionSegmentKey;
  label: string;
  count: number;
  flexGrow: number;
};

export type CoachCompositionBarView = {
  month: string;
  label: string;
  total: number;
  partial: boolean;
  heightPercent: number;
  segments: readonly CoachCompositionSegmentView[];
};

export type CoachCompositionPoint = { label: string; value: number; secondary: string };

export type CoachCompositionTrendView =
  | { available: true; points: readonly CoachCompositionPoint[]; currentValue: string }
  | { available: false; reason: string };

export type CoachCompositionView = {
  months: readonly CoachCompositionBarView[];
  legend: typeof COACH_COMPOSITION_SEGMENTS;
  rangeLabel: string;
  timezone: string;
  trend: CoachCompositionTrendView;
};

function compositionSegments(month: CoachLeadComposition["months"][number]) {
  return COACH_COMPOSITION_SEGMENTS
    .map((segment) => ({
      key: segment.key,
      label: segment.label,
      count: month[segment.key],
      flexGrow: month[segment.key],
    }))
    // A zero segment would still paint, because `.ws-composition-chart__bar > span` carries
    // min-height: 20px. Colour for no leads is a false reading, so the span never renders.
    .filter((segment) => segment.count > 0);
}

export function coachCompositionView(composition: CoachLeadComposition): CoachCompositionView {
  const tallest = Math.max(0, ...composition.months.map((row) => row.total));
  const months = composition.months.map((row) => ({
    month: row.month,
    label: row.label,
    total: row.total,
    partial: row.partial,
    heightPercent: tallest === 0 ? 0 : Math.round((row.total / tallest) * 1_000) / 10,
    segments: compositionSegments(row),
  }));
  const withLeads = composition.months.filter((row) => row.total > 0);
  const points = withLeads.map((row) => ({
    label: row.label,
    value: Math.round((row.qualified / row.total) * 1_000) / 10,
    secondary: `${row.qualified} of ${row.total} leads`,
  }));
  const trend: CoachCompositionTrendView = points.length < 2
    ? {
        available: false,
        reason: "A qualification-rate line needs at least two months carrying leads.",
      }
    : { available: true, points, currentValue: `${points[points.length - 1].value}%` };

  return {
    months,
    legend: COACH_COMPOSITION_SEGMENTS,
    rangeLabel: composition.months.length
      ? `${composition.months[0].label} – ${composition.months[composition.months.length - 1].label}`
      : "Unavailable",
    timezone: composition.timezone,
    trend,
  };
}

export function coachCompositionExportRows(composition: CoachLeadComposition) {
  return composition.months.map((row) => ({
    month: row.month,
    label: row.label,
    total: row.total,
    qualified: row.qualified,
    active: row.active,
    disqualified: row.disqualified,
    partial: row.partial,
    dataLabel: "Database truth",
  }));
}

export function coachPipelineView(snapshot: CoachMeasurement): CoachPipelineView {
  return {
    stages: COACH_PIPELINE_STAGES.map((stage) => ({
      ...stage,
      rows: snapshot.pipeline.filter((row) => row.stage === stage.key),
    })),
    pipelineWin: metricView(snapshot, "coach.pipeline_win_rate"),
    agentWin: metricView(snapshot, "coach.agent_win_rate"),
    readOnlyReason: "Pipeline changes are read-only because no persisted mutation is available.",
  };
}

export const COACH_TOP_OBJECTION_COLUMNS = [
  "objectionId",
  "label",
  "state",
  "bookedRate",
  "conversationCount",
  "windowStart",
  "windowEnd",
] as const;

export type CoachObjectionView = {
  objectionId: string;
  label: string;
  countLabel: string;
  rateLabel: string;
  rateTone: "neutral" | "good" | "pending";
  conversationHref: string;
};

/**
 * Absence is rendered as words, never as a zero.
 *
 * The `available` branch has no producer today, because the rollup returns a null rate for every row
 * while its attribution state reads `awaiting_definition`. It is written and tested anyway,
 * because that is what makes the awaiting-definition state a switch rather than a dead end: when
 * Alec approves the attribution rule, one migration flips the state and this branch starts
 * rendering with nothing else moving.
 */
export function coachTopObjectionsView(
  rollup: CoachTopObjections,
): readonly CoachObjectionView[] {
  return rollup.rows.map((row) => {
    const available = row.state === "available" && row.bookedRate !== null;
    return {
      objectionId: row.objectionId,
      label: row.label,
      countLabel: row.conversationCount === 1
        ? "1 conversation"
        : `${new Intl.NumberFormat("en").format(row.conversationCount)} conversations`,
      rateLabel: available
        ? `${Math.round(row.bookedRate! * 100)}% booked`
        : row.state === "held_safely"
          ? "Held safely"
          : "Booked rate awaiting definition",
      rateTone: available ? "good" : row.state === "held_safely" ? "neutral" : "pending",
      conversationHref: `/coach/conversations?objection=${encodeURIComponent(row.objectionId)}`,
    };
  });
}

/**
 * The CSV tells the truth in machine terms while the panel tells it in the coach's: the raw
 * state string and a null rate, not the rendered label. The window repeats on every row because
 * it belongs to the envelope and a row read on its own would otherwise carry no window at all.
 */
export function coachTopObjectionExportRows(rollup: CoachTopObjections) {
  return rollup.rows.map((row) => ({
    objectionId: row.objectionId,
    label: row.label,
    state: row.state,
    bookedRate: row.bookedRate,
    conversationCount: row.conversationCount,
    windowStart: rollup.windowStart,
    windowEnd: rollup.windowEnd,
  }));
}
