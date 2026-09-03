/**
 * Coach-scoped measurement projection over the single Phase 7 aggregate RPC.
 *
 * Tenant, timezone, labels, windows, and values remain server/database-owned. This repository
 * accepts only picker state and rejects any widened or cross-audience payload before rendering.
 */

import {
  COACH_METRIC_KEYS,
  metricDefinition,
  type MetricEvidence,
} from "@/lib/analytics/metric-definitions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import {
  assertHalfOpenWindow,
  evidenceArray,
  evidenceIso,
  evidenceNonnegativeInteger,
  evidenceNullableString,
  evidenceNumber,
  evidenceObject,
  evidenceString,
  MeasurementEvidenceError,
  parseMetricEvidenceRows,
} from "./measurement-evidence";

export const COACH_MEASUREMENT_WINDOWS = ["1d", "1w", "1m", "3m", "all", "custom"] as const;
export type CoachMeasurementWindow = (typeof COACH_MEASUREMENT_WINDOWS)[number];

export type CoachMeasurementOptions = {
  window: CoachMeasurementWindow;
  customFrom?: string | null;
  customTo?: string | null;
  asOf: string;
};

export type CoachFunnelRow = {
  stepKey: string;
  stepLabel: string;
  enteredContacts: number;
  completedContacts: number;
};

export type CoachResponseRow = {
  stepKey: string;
  stepLabel: string;
  askedContacts: number;
  answeredContacts: number;
};

export type CoachKeywordRow = {
  keyword: string;
  conversations: number;
  qualifiedContacts: number;
  respondedConversations: number;
  bookedContacts: number;
  dataLabel: string;
};

export type CoachPipelineRow = {
  contactId: string;
  displayName: string;
  stage: "new_lead" | "qualifying" | "booked" | "qualified_no_buy"
    | "long_term_followup" | "no_show" | "disqualified";
  attributedToAgent: boolean;
  latestAppointmentStatus: string | null;
  changedAt: string;
  dataLabel: string;
};

export type CoachMeasurement = {
  tenantId: string;
  window: CoachMeasurementWindow;
  /**
   * The instant the measured window closes at, which for a trailing window is the `asOf` the RPC
   * was asked for. Carried onto the snapshot so the view model can print the moment the numbers
   * were read at instead of leaking the parameter name into a methodology sentence.
   */
  windowEnd: string;
  metrics: readonly MetricEvidence[];
  funnel: readonly CoachFunnelRow[];
  responses: readonly CoachResponseRow[];
  keywords: readonly CoachKeywordRow[];
  pipeline: readonly CoachPipelineRow[];
  allowance: CoachAllowance;
  isDemo: boolean;
};

/**
 * A tenant with no active billing subscription has no period to count an allowance against, so
 * the RPC reports the absence rather than a zero of zero. The union is what stops the surface
 * from printing "null of null" and what stopped the loader from refusing the whole dashboard.
 */
export type CoachAllowance =
  | {
    used: number;
    limit: number;
    periodStart: string;
    periodEnd: string;
    state: "available";
  }
  | {
    used: null;
    limit: null;
    periodStart: null;
    periodEnd: null;
    state: "unavailable";
  };

export type CoachMeasurementSource = (
  actorId: string,
  expectedTenant: string,
  options: Required<CoachMeasurementOptions>,
) => Promise<unknown>;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const PIPELINE_STAGES = [
  "new_lead", "qualifying", "booked", "qualified_no_buy", "long_term_followup", "no_show",
  "disqualified",
] as const;

function dateOnly(value: unknown, code: string): string {
  const parsed = evidenceString(value, code);
  if (!DATE_ONLY.test(parsed) || !Number.isFinite(Date.parse(`${parsed}T00:00:00.000Z`))) {
    throw new MeasurementEvidenceError(code);
  }
  return parsed;
}

function validateOptions(options: CoachMeasurementOptions): Required<CoachMeasurementOptions> {
  const candidate = evidenceObject(
    options,
    Object.keys(options),
    "COACH_MEASUREMENT_OPTIONS_INVALID",
  );
  if (Object.keys(candidate).some((key) => !["window", "customFrom", "customTo", "asOf"].includes(key))) {
    throw new MeasurementEvidenceError("COACH_MEASUREMENT_OPTIONS_INVALID");
  }
  if (!COACH_MEASUREMENT_WINDOWS.includes(candidate.window as CoachMeasurementWindow)) {
    throw new MeasurementEvidenceError("COACH_MEASUREMENT_WINDOW_INVALID");
  }
  const window = candidate.window as CoachMeasurementWindow;
  const asOf = evidenceIso(candidate.asOf, "COACH_MEASUREMENT_AS_OF_INVALID");
  const customFrom = candidate.customFrom === undefined || candidate.customFrom === null
    ? null
    : dateOnly(candidate.customFrom, "COACH_MEASUREMENT_CUSTOM_WINDOW_INVALID");
  const customTo = candidate.customTo === undefined || candidate.customTo === null
    ? null
    : dateOnly(candidate.customTo, "COACH_MEASUREMENT_CUSTOM_WINDOW_INVALID");
  if (
    (window === "custom" && (!customFrom || !customTo || customFrom > customTo))
    || (window !== "custom" && (customFrom !== null || customTo !== null))
  ) {
    throw new MeasurementEvidenceError("COACH_MEASUREMENT_CUSTOM_WINDOW_INVALID");
  }
  return { window, customFrom, customTo, asOf };
}

async function coachMeasurementSource(
  actorId: string,
  expectedTenant: string,
  options: Required<CoachMeasurementOptions>,
) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("read_coach_measurement_for_actor", {
    p_actor_id: actorId,
    p_expected_tenant: expectedTenant,
    p_window: options.window,
    p_custom_from: options.customFrom,
    p_custom_to: options.customTo,
    p_as_of: options.asOf,
  });
  if (error) throw new MeasurementEvidenceError("COACH_MEASUREMENT_READ_FAILED");
  return data;
}

function coachCount(value: unknown, code = "COACH_MEASUREMENT_SNAPSHOT_INVALID") {
  return evidenceNonnegativeInteger(value, code);
}

function coachAllowance(row: Record<string, unknown>): CoachAllowance {
  // Absence is reported whole: an unavailable allowance carries no used, no limit and no period,
  // and anything half-filled is the RPC contradicting itself rather than a state to render.
  if (row.state === "unavailable") {
    if (row.used !== null || row.limit !== null || row.periodStart !== null
      || row.periodEnd !== null) {
      throw new MeasurementEvidenceError("COACH_MEASUREMENT_ALLOWANCE_INVALID");
    }
    return { used: null, limit: null, periodStart: null, periodEnd: null, state: "unavailable" };
  }
  if (row.state !== "available") {
    throw new MeasurementEvidenceError("COACH_MEASUREMENT_ALLOWANCE_INVALID");
  }
  const used = coachCount(row.used, "COACH_MEASUREMENT_ALLOWANCE_INVALID");
  const limit = coachCount(row.limit, "COACH_MEASUREMENT_ALLOWANCE_INVALID");
  const periodStart = evidenceIso(row.periodStart, "COACH_MEASUREMENT_ALLOWANCE_INVALID");
  const periodEnd = evidenceIso(row.periodEnd, "COACH_MEASUREMENT_ALLOWANCE_INVALID");
  if (used > limit) throw new MeasurementEvidenceError("COACH_MEASUREMENT_ALLOWANCE_INVALID");
  assertHalfOpenWindow(periodStart, periodEnd, "COACH_MEASUREMENT_ALLOWANCE_INVALID");
  return { used, limit, periodStart, periodEnd, state: "available" };
}

export async function loadCoachMeasurement(
  actorId: string,
  expectedTenant: string,
  options: CoachMeasurementOptions,
  source: CoachMeasurementSource = coachMeasurementSource,
): Promise<CoachMeasurement> {
  const actor = evidenceString(actorId, "MEASUREMENT_ACTOR_REQUIRED");
  const tenantId = evidenceString(expectedTenant, "EXPECTED_TENANT_REQUIRED");
  const input = validateOptions(options);
  const raw = evidenceObject(await source(actor, tenantId, input), [
    "tenantId", "window", "timezone", "windowStart", "windowEnd", "metrics", "funnel",
    "responses", "keywords", "pipeline", "allowance", "isDemo",
  ], "COACH_MEASUREMENT_SNAPSHOT_INVALID");
  if (typeof raw.isDemo !== "boolean") {
    throw new MeasurementEvidenceError("COACH_MEASUREMENT_SNAPSHOT_INVALID");
  }
  if (raw.tenantId !== tenantId || raw.window !== input.window) {
    throw new MeasurementEvidenceError("COACH_MEASUREMENT_SCOPE_MISMATCH");
  }
  evidenceString(raw.timezone, "COACH_MEASUREMENT_SNAPSHOT_INVALID");
  const windowStart = evidenceIso(raw.windowStart, "COACH_MEASUREMENT_SNAPSHOT_INVALID");
  const windowEnd = evidenceIso(raw.windowEnd, "COACH_MEASUREMENT_SNAPSHOT_INVALID");
  assertHalfOpenWindow(windowStart, windowEnd, "MEASUREMENT_WINDOW_INVALID");

  const allowanceRow = evidenceObject(raw.allowance, [
    "used", "limit", "periodStart", "periodEnd", "state",
  ], "COACH_MEASUREMENT_ALLOWANCE_INVALID");
  const allowance = coachAllowance(allowanceRow);

  const metrics = parseMetricEvidenceRows(raw.metrics, COACH_METRIC_KEYS, {
    code: "COACH_METRIC_SET_INVALID",
    window: { start: windowStart, end: windowEnd },
    allowanceWindow: allowance.state === "available"
      ? { start: allowance.periodStart, end: allowance.periodEnd }
      : null,
  });
  if (metrics.some((metric) => {
    const definition = metricDefinition(metric.metricKey);
    return metric.metricKey.startsWith("platform.")
      || definition.audience !== "coach"
      || definition.economics !== "none";
  })) {
    throw new MeasurementEvidenceError("COACH_RESTRICTED_METRIC_RETURNED");
  }

  const funnel = evidenceArray(raw.funnel, "COACH_MEASUREMENT_FUNNEL_INVALID").map((value) => {
    const row = evidenceObject(value, [
      "stepKey", "stepLabel", "enteredContacts", "completedContacts",
    ], "COACH_MEASUREMENT_FUNNEL_INVALID");
    const enteredContacts = coachCount(row.enteredContacts, "COACH_MEASUREMENT_FUNNEL_INVALID");
    const completedContacts = coachCount(row.completedContacts, "COACH_MEASUREMENT_FUNNEL_INVALID");
    if (completedContacts > enteredContacts) {
      throw new MeasurementEvidenceError("COACH_MEASUREMENT_FUNNEL_INVALID");
    }
    return {
      stepKey: evidenceString(row.stepKey, "COACH_MEASUREMENT_FUNNEL_INVALID"),
      stepLabel: evidenceString(row.stepLabel, "COACH_MEASUREMENT_FUNNEL_INVALID"),
      enteredContacts,
      completedContacts,
    };
  });
  if (funnel.map((row) => row.stepKey).join(",") !== "entered,qualified,booked") {
    throw new MeasurementEvidenceError("COACH_MEASUREMENT_FUNNEL_INVALID");
  }

  const responses = evidenceArray(raw.responses, "COACH_MEASUREMENT_RESPONSES_INVALID").map((value) => {
    const row = evidenceObject(value, [
      "stepKey", "stepLabel", "askedContacts", "answeredContacts",
    ], "COACH_MEASUREMENT_RESPONSES_INVALID");
    const askedContacts = coachCount(row.askedContacts, "COACH_MEASUREMENT_RESPONSES_INVALID");
    const answeredContacts = coachCount(row.answeredContacts, "COACH_MEASUREMENT_RESPONSES_INVALID");
    if (answeredContacts > askedContacts) {
      throw new MeasurementEvidenceError("COACH_MEASUREMENT_RESPONSES_INVALID");
    }
    return {
      stepKey: evidenceString(row.stepKey, "COACH_MEASUREMENT_RESPONSES_INVALID"),
      stepLabel: evidenceString(row.stepLabel, "COACH_MEASUREMENT_RESPONSES_INVALID"),
      askedContacts,
      answeredContacts,
    };
  });

  const keywords = evidenceArray(raw.keywords, "COACH_MEASUREMENT_KEYWORDS_INVALID").map((value) => {
    const row = evidenceObject(value, [
      "keyword", "conversations", "qualifiedContacts", "respondedConversations",
      "bookedContacts", "dataLabel",
    ], "COACH_MEASUREMENT_KEYWORDS_INVALID");
    const conversations = coachCount(row.conversations, "COACH_MEASUREMENT_KEYWORDS_INVALID");
    const qualifiedContacts = coachCount(row.qualifiedContacts, "COACH_MEASUREMENT_KEYWORDS_INVALID");
    const respondedConversations = coachCount(
      row.respondedConversations,
      "COACH_MEASUREMENT_KEYWORDS_INVALID",
    );
    const bookedContacts = coachCount(row.bookedContacts, "COACH_MEASUREMENT_KEYWORDS_INVALID");
    if ([qualifiedContacts, respondedConversations, bookedContacts].some((count) => count > conversations)) {
      throw new MeasurementEvidenceError("COACH_MEASUREMENT_KEYWORDS_INVALID");
    }
    return {
      keyword: evidenceString(row.keyword, "COACH_MEASUREMENT_KEYWORDS_INVALID"),
      conversations,
      qualifiedContacts,
      respondedConversations,
      bookedContacts,
      dataLabel: evidenceString(row.dataLabel, "COACH_MEASUREMENT_KEYWORDS_INVALID"),
    };
  });
  const keywordMetric = metrics.find((metric) => metric.metricKey === "coach.keyword.conversations");
  /*
   * Conservation remains the invariant: the attributed keyword rows must sum to the metric the
   * page prints beside them. Unattributed conversations are intentionally absent now, because
   * adding a `No keyword` row would manufacture opt-ins and inflate every percent denominator.
   */
  const keywordTotal = keywords.reduce((total, row) => total + row.conversations, 0);
  if (keywordTotal !== keywordMetric?.value) {
    throw new MeasurementEvidenceError("COACH_MEASUREMENT_KEYWORD_CONSERVATION_FAILED");
  }

  const pipeline = evidenceArray(raw.pipeline, "COACH_MEASUREMENT_PIPELINE_INVALID").map((value) => {
    const row = evidenceObject(value, [
      "contactId", "displayName", "stage", "attributedToAgent", "latestAppointmentStatus",
      "changedAt", "dataLabel",
    ], "COACH_MEASUREMENT_PIPELINE_INVALID");
    if (!PIPELINE_STAGES.includes(row.stage as CoachPipelineRow["stage"])) {
      throw new MeasurementEvidenceError("COACH_MEASUREMENT_PIPELINE_INVALID");
    }
    if (typeof row.attributedToAgent !== "boolean") {
      throw new MeasurementEvidenceError("COACH_MEASUREMENT_PIPELINE_INVALID");
    }
    return {
      contactId: evidenceString(row.contactId, "COACH_MEASUREMENT_PIPELINE_INVALID"),
      displayName: evidenceString(row.displayName, "COACH_MEASUREMENT_PIPELINE_INVALID"),
      stage: row.stage as CoachPipelineRow["stage"],
      attributedToAgent: row.attributedToAgent,
      latestAppointmentStatus: evidenceNullableString(
        row.latestAppointmentStatus,
        "COACH_MEASUREMENT_PIPELINE_INVALID",
      ),
      changedAt: evidenceIso(row.changedAt, "COACH_MEASUREMENT_PIPELINE_INVALID"),
      dataLabel: evidenceString(row.dataLabel, "COACH_MEASUREMENT_PIPELINE_INVALID"),
    };
  });

  return {
    tenantId,
    window: input.window,
    windowEnd,
    metrics,
    funnel,
    responses,
    keywords,
    pipeline,
    allowance,
    isDemo: raw.isDemo,
  };
}

export type CoachCompositionMonth = {
  month: string;
  label: string;
  total: number;
  qualified: number;
  disqualified: number;
  active: number;
  partial: boolean;
};

export type CoachCompositionBookedPeriod = {
  month: string;
  booked: number;
};

export type CoachLeadComposition = {
  tenantId: string;
  timezone: string;
  asOf: string;
  months: readonly CoachCompositionMonth[];
  bookedByPeriod: readonly CoachCompositionBookedPeriod[];
};

export type CoachLeadCompositionSource = (
  actorId: string,
  expectedTenant: string,
  asOf: string,
) => Promise<unknown>;

const COMPOSITION_MONTHS = 6;

async function coachLeadCompositionSource(actorId: string, expectedTenant: string, asOf: string) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("read_coach_lead_composition_for_actor", {
    p_actor_id: actorId,
    p_expected_tenant: expectedTenant,
    p_as_of: asOf,
  });
  if (error) throw new MeasurementEvidenceError("COACH_COMPOSITION_READ_FAILED");
  return data;
}

/**
 * Six calendar months of lead composition, validated the same way the aggregate is.
 *
 * The conservation check is deliberately a second copy of a guarantee the SQL already makes:
 * the bars are drawn against their own labelled total, so a month whose segments stop short
 * would render an unexplained gap rather than fail, and SQL has drifted from its own
 * definition twice on this project.
 */
export async function loadCoachLeadComposition(
  actorId: string,
  expectedTenant: string,
  asOf: string,
  source: CoachLeadCompositionSource = coachLeadCompositionSource,
): Promise<CoachLeadComposition> {
  const actor = evidenceString(actorId, "MEASUREMENT_ACTOR_REQUIRED");
  const tenantId = evidenceString(expectedTenant, "EXPECTED_TENANT_REQUIRED");
  const requestedAsOf = evidenceIso(asOf, "COACH_COMPOSITION_AS_OF_INVALID");
  const raw = evidenceObject(
    await source(actor, tenantId, requestedAsOf),
    ["tenantId", "timezone", "asOf", "months", "bookedByPeriod"],
    "COACH_COMPOSITION_SNAPSHOT_INVALID",
  );
  if (raw.tenantId !== tenantId) {
    throw new MeasurementEvidenceError("COACH_COMPOSITION_SCOPE_MISMATCH");
  }
  const timezone = evidenceString(raw.timezone, "COACH_COMPOSITION_SNAPSHOT_INVALID");
  const asOfValue = evidenceIso(raw.asOf, "COACH_COMPOSITION_SNAPSHOT_INVALID");

  const months = evidenceArray(raw.months, "COACH_COMPOSITION_SNAPSHOT_INVALID").map((value) => {
    const row = evidenceObject(value, [
      "month", "label", "total", "qualified", "disqualified", "active", "partial",
    ], "COACH_COMPOSITION_SNAPSHOT_INVALID");
    if (typeof row.partial !== "boolean") {
      throw new MeasurementEvidenceError("COACH_COMPOSITION_SNAPSHOT_INVALID");
    }
    const total = coachCount(row.total, "COACH_COMPOSITION_SNAPSHOT_INVALID");
    const qualified = coachCount(row.qualified, "COACH_COMPOSITION_SNAPSHOT_INVALID");
    const disqualified = coachCount(row.disqualified, "COACH_COMPOSITION_SNAPSHOT_INVALID");
    const active = coachCount(row.active, "COACH_COMPOSITION_SNAPSHOT_INVALID");
    if (qualified + disqualified + active !== total) {
      throw new MeasurementEvidenceError("COACH_COMPOSITION_CONSERVATION_FAILED");
    }
    return {
      month: dateOnly(row.month, "COACH_COMPOSITION_SNAPSHOT_INVALID"),
      label: evidenceString(row.label, "COACH_COMPOSITION_SNAPSHOT_INVALID"),
      total,
      qualified,
      disqualified,
      active,
      partial: row.partial,
    };
  });

  if (months.length !== COMPOSITION_MONTHS) {
    throw new MeasurementEvidenceError("COACH_COMPOSITION_SNAPSHOT_INVALID");
  }
  if (months.some((row, index) => index > 0 && row.month <= months[index - 1].month)) {
    throw new MeasurementEvidenceError("COACH_COMPOSITION_SNAPSHOT_INVALID");
  }
  const partials = months.filter((row) => row.partial);
  if (partials.length > 1 || (partials.length === 1 && !months[months.length - 1].partial)) {
    throw new MeasurementEvidenceError("COACH_COMPOSITION_SNAPSHOT_INVALID");
  }

  const bookedByPeriod = evidenceArray(raw.bookedByPeriod, "COACH_COMPOSITION_SNAPSHOT_INVALID")
    .map((value) => {
      const row = evidenceObject(value, ["month", "booked"], "COACH_COMPOSITION_SNAPSHOT_INVALID");
      return {
        month: dateOnly(row.month, "COACH_COMPOSITION_SNAPSHOT_INVALID"),
        booked: coachCount(row.booked, "COACH_COMPOSITION_SNAPSHOT_INVALID"),
      };
    });
  if (bookedByPeriod.length !== COMPOSITION_MONTHS
    || bookedByPeriod.some((row, index) => row.month !== months[index]?.month)) {
    throw new MeasurementEvidenceError("COACH_COMPOSITION_SNAPSHOT_INVALID");
  }

  return { tenantId, timezone, asOf: asOfValue, months, bookedByPeriod };
}

export const COACH_TOP_OBJECTION_LIMIT = 5;

/**
 * Whether a hard-gated objection's label may appear on a coach's screen is Alec's call
 * (10-SPEC:378). Until he answers, those rows are not fetched — excluded at the RPC rather than
 * filtered in the component, so the export cannot disagree with the panel. Flipping this constant
 * is the whole change.
 */
export const HARD_GATED_ROWS_COACH_VISIBLE = false;

export type CoachObjectionRowState = "awaiting_definition" | "held_safely" | "available";
export type CoachObjectionAttributionState = "awaiting_definition" | "defined";

const COACH_OBJECTION_ROW_STATES = [
  "awaiting_definition", "held_safely", "available",
] as const satisfies readonly CoachObjectionRowState[];
const COACH_OBJECTION_ATTRIBUTION_STATES = [
  "awaiting_definition", "defined",
] as const satisfies readonly CoachObjectionAttributionState[];

export type CoachObjectionRow = {
  objectionId: string;
  label: string;
  state: CoachObjectionRowState;
  bookedRate: number | null;
  conversationCount: number;
  hardGate: boolean;
};

export type CoachTopObjections = {
  tenantId: string;
  asOf: string;
  windowStart: string;
  windowEnd: string;
  attributionState: CoachObjectionAttributionState;
  rows: readonly CoachObjectionRow[];
};

export type CoachTopObjectionsSource = (
  actorId: string,
  expectedTenant: string,
  asOf: string,
  limit: number,
  includeHardGated: boolean,
) => Promise<unknown>;

async function coachTopObjectionsSource(
  actorId: string,
  expectedTenant: string,
  asOf: string,
  limit: number,
  includeHardGated: boolean,
) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("read_coach_top_objections_for_actor", {
    p_actor_id: actorId,
    p_expected_tenant: expectedTenant,
    p_as_of: asOf,
    p_limit: limit,
    p_include_hard_gated: includeHardGated,
  });
  if (error) throw new MeasurementEvidenceError("COACH_OBJECTION_READ_FAILED");
  return data;
}

/**
 * The coach Top objections rollup, validated the same way every other coach read is.
 *
 * The two refusals below are the point of this repository. A percentage on a client's screen has
 * to be traceable to a definition somebody approved, and this is where an unapproved one gets
 * stopped: a rate cannot arrive while the attribution state says the rule is undecided, and a row
 * cannot claim to be available with no number to be available about. A later migration that
 * starts returning numerators without also flipping the state is refused here rather than
 * rendered.
 */
export async function loadCoachTopObjections(
  actorId: string,
  expectedTenant: string,
  asOf: string,
  source: CoachTopObjectionsSource = coachTopObjectionsSource,
): Promise<CoachTopObjections> {
  const actor = evidenceString(actorId, "MEASUREMENT_ACTOR_REQUIRED");
  const tenantId = evidenceString(expectedTenant, "EXPECTED_TENANT_REQUIRED");
  const requestedAsOf = evidenceIso(asOf, "COACH_OBJECTION_AS_OF_INVALID");
  const raw = evidenceObject(
    await source(
      actor, tenantId, requestedAsOf, COACH_TOP_OBJECTION_LIMIT, HARD_GATED_ROWS_COACH_VISIBLE,
    ),
    ["tenantId", "asOf", "windowStart", "windowEnd", "attributionState", "rows"],
    "COACH_OBJECTION_SNAPSHOT_INVALID",
  );
  if (raw.tenantId !== tenantId) {
    throw new MeasurementEvidenceError("COACH_OBJECTION_SCOPE_MISMATCH");
  }
  const asOfValue = evidenceIso(raw.asOf, "COACH_OBJECTION_SNAPSHOT_INVALID");
  const windowStart = evidenceIso(raw.windowStart, "COACH_OBJECTION_SNAPSHOT_INVALID");
  const windowEnd = evidenceIso(raw.windowEnd, "COACH_OBJECTION_SNAPSHOT_INVALID");
  assertHalfOpenWindow(windowStart, windowEnd, "COACH_OBJECTION_SNAPSHOT_INVALID");
  if (!COACH_OBJECTION_ATTRIBUTION_STATES.includes(
    raw.attributionState as CoachObjectionAttributionState,
  )) {
    throw new MeasurementEvidenceError("COACH_OBJECTION_SNAPSHOT_INVALID");
  }
  const attributionState = raw.attributionState as CoachObjectionAttributionState;

  const rows = evidenceArray(raw.rows, "COACH_OBJECTION_SNAPSHOT_INVALID").map((value) => {
    const row = evidenceObject(value, [
      "objectionId", "label", "state", "bookedRate", "conversationCount", "hardGate",
    ], "COACH_OBJECTION_SNAPSHOT_INVALID");
    if (typeof row.hardGate !== "boolean") {
      throw new MeasurementEvidenceError("COACH_OBJECTION_SNAPSHOT_INVALID");
    }
    if (!COACH_OBJECTION_ROW_STATES.includes(row.state as CoachObjectionRowState)) {
      throw new MeasurementEvidenceError("COACH_OBJECTION_SNAPSHOT_INVALID");
    }
    const state = row.state as CoachObjectionRowState;
    const bookedRate = row.bookedRate === null
      ? null
      : evidenceNumber(row.bookedRate, "COACH_OBJECTION_SNAPSHOT_INVALID");

    if (bookedRate !== null && attributionState === "awaiting_definition") {
      throw new MeasurementEvidenceError("COACH_OBJECTION_BOOKED_RATE_UNDEFINED");
    }
    if (state === "available" && bookedRate === null) {
      throw new MeasurementEvidenceError("COACH_OBJECTION_BOOKED_RATE_UNDEFINED");
    }

    return {
      objectionId: evidenceString(row.objectionId, "COACH_OBJECTION_SNAPSHOT_INVALID"),
      label: evidenceString(row.label, "COACH_OBJECTION_SNAPSHOT_INVALID"),
      state,
      bookedRate,
      conversationCount: evidenceNonnegativeInteger(
        row.conversationCount, "COACH_OBJECTION_SNAPSHOT_INVALID",
      ),
      hardGate: row.hardGate,
    };
  });

  return { tenantId, asOf: asOfValue, windowStart, windowEnd, attributionState, rows };
}
