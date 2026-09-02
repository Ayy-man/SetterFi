import { describe, expect, it } from "vitest";

import {
  COACH_METRIC_KEYS,
  COACH_OBJECTION_METRIC_KEYS,
  EVAL_METRIC_KEYS,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  PLATFORM_METRIC_KEYS,
  availableMetric,
  metricDefinition,
  metricLabel,
  type MetricEvidence,
  type MetricKey,
} from "./metric-definitions";

const EXPECTED_COACH_KEYS = [
  "coach.new_leads", "coach.active_leads", "coach.qualified_leads",
  "coach.disqualified_leads", "coach.booked_contacts", "coach.conversion_rate",
  "coach.average_time_to_book", "coach.pipeline_win_rate", "coach.agent_win_rate",
  "coach.show_rate", "coach.allowance_used", "coach.allowance_limit",
  "coach.funnel.entered", "coach.funnel.qualified", "coach.funnel.booked",
  "coach.step.response_rate", "coach.keyword.conversations",
  "coach.keyword.qualified_rate", "coach.keyword.response_rate", "coach.keyword.booked_rate",
] as const;

const EXPECTED_PLATFORM_KEYS = [
  "platform.new_signups", "platform.active_subscriptions", "platform.gross_mrr",
  "platform.affiliate_commission", "platform.booked_appointments", "platform.churn_rate",
  "platform.ltv", "platform.average_retention", "platform.growth_rate",
  "platform.guardrail_block_rate", "platform.guardrail_rule_fire_rate",
  "platform.holding_reply_rate", "platform.escalation_rate", "platform.scope_block_rate",
  "platform.no_show_rate", "platform.reschedule_rate", "platform.cadence_completion_rate",
  "platform.followup_reply_rate", "platform.cross_channel_continuation_rate",
  "platform.time_to_live", "platform.provisioning_step_failure_rate",
  "platform.a2p_approval_rate", "platform.a2p_median_days_to_clear",
  "platform.meta_live_sms_registering_share", "platform.eval_case_count",
  "platform.knowledge_usage_count", "platform.margin",
] as const;

const EXPECTED_EVAL_KEYS = [
  "eval.suite_pass_rate", "eval.false_block_rate", "eval.cost_per_case",
  "eval.cost_per_thousand", "eval.latency_p50", "eval.latency_p95",
] as const;

// The objection rollup's two keys are coach-audience but deliberately sit outside
// COACH_METRIC_KEYS: that array is the exact expected row set of `read_coach_measurement`, which
// returns 20 rows on hosted, and `parseMetricEvidenceRows` refuses any count that disagrees.
const EXPECTED_OBJECTION_KEYS = [
  "coach.objection.conversations", "coach.objection.booked_rate",
] as const;

function evidence(
  metricKey: MetricKey,
  overrides: Partial<MetricEvidence> = {},
): MetricEvidence {
  return {
    metricKey,
    numerator: 1,
    denominator: 2,
    value: 50,
    state: "available",
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("measurement vocabulary", () => {
  it("keeps the exact ordered 20 coach, 27 platform, 6 eval, and 2 objection subsets", () => {
    expect(COACH_METRIC_KEYS).toEqual(EXPECTED_COACH_KEYS);
    expect(PLATFORM_METRIC_KEYS).toEqual(EXPECTED_PLATFORM_KEYS);
    expect(EVAL_METRIC_KEYS).toEqual(EXPECTED_EVAL_KEYS);
    expect(COACH_OBJECTION_METRIC_KEYS).toEqual(EXPECTED_OBJECTION_KEYS);
    expect(METRIC_KEYS).toEqual([
      ...EXPECTED_COACH_KEYS,
      ...EXPECTED_PLATFORM_KEYS,
      ...EXPECTED_EVAL_KEYS,
      ...EXPECTED_OBJECTION_KEYS,
    ]);
    // The objection keys are registered in the vocabulary and absent from the measurement set,
    // which is what keeps a 21st expected row off `read_coach_measurement`.
    for (const key of EXPECTED_OBJECTION_KEYS) {
      expect(COACH_METRIC_KEYS).not.toContain(key);
    }
  });

  it("keeps all 55 keys disjoint, duplicate-free, and backed by one definition", () => {
    expect(COACH_METRIC_KEYS).toHaveLength(20);
    expect(PLATFORM_METRIC_KEYS).toHaveLength(27);
    expect(EVAL_METRIC_KEYS).toHaveLength(6);
    expect(COACH_OBJECTION_METRIC_KEYS).toHaveLength(2);
    expect(METRIC_KEYS).toHaveLength(55);
    expect(new Set(METRIC_KEYS).size).toBe(55);
    expect(Object.keys(METRIC_DEFINITIONS)).toEqual([...METRIC_KEYS]);
    expect(METRIC_KEYS.map((key) => metricDefinition(key).key)).toEqual([...METRIC_KEYS]);
  });

  it("requires every definition to name database sources, population, and exclusion behavior", () => {
    for (const key of METRIC_KEYS) {
      const definition = metricDefinition(key);
      for (const field of [
        definition.name,
        definition.label,
        definition.denominator,
        definition.window,
        definition.clock,
        definition.cohortRule,
        definition.history,
        definition.population,
        definition.demoDisposition,
        definition.testDisposition,
      ]) {
        expect(field.trim(), `${key} has a blank contract field`).not.toBe("");
      }
      expect(definition.sources.length, `${key} has no database source`).toBeGreaterThan(0);
      for (const source of definition.sources) {
        expect(source.table).toMatch(/^public\.[a-z0-9_]+$/);
        expect(source.columns.length, `${key}:${source.table} has no source column`).toBeGreaterThan(0);
        expect(source.columns.every((column) => column.trim().length > 0)).toBe(true);
      }
      expect(definition.demoDisposition).toContain("Excluded");
      expect(definition.demoDisposition).toContain("explicitly labelled");
      expect(definition.testDisposition).toContain("Excluded");
      expect(definition.testDisposition).toContain("explicitly labelled");
      expect(definition.unavailableRendering).toBe("ABSENT");
    }
  });

  it("requires every rate and share to define its denominator, window, clock, and cohort", () => {
    const rateKeys = METRIC_KEYS.filter((key) =>
      key.endsWith("_rate") || key.endsWith("_share"));
    expect(rateKeys.length).toBeGreaterThan(0);
    for (const key of rateKeys) {
      const definition = metricDefinition(key);
      expect(definition.unit).toBe("percent");
      expect(definition.requiresPositiveDenominator).toBe(true);
      expect(definition.denominator.trim()).not.toBe("");
      expect(definition.window.trim()).not.toBe("");
      expect(definition.clock.trim()).not.toBe("");
      expect(definition.cohortRule.trim()).not.toBe("");
    }
  });

  it("pins the two booked populations and tenant-cohort conversion instead of conflating them", () => {
    expect(metricDefinition("coach.conversion_rate")).toMatchObject({
      denominator: "Distinct contacts created in the selected window.",
      clock: "Tenant IANA timezone for contact cohort boundaries.",
    });
    expect(metricDefinition("coach.conversion_rate").cohortRule)
      .toContain("those same distinct contacts");
    expect(metricDefinition("coach.pipeline_win_rate").cohortRule)
      .toContain("booked plus qualified_no_buy plus disqualified");
    expect(metricDefinition("coach.agent_win_rate").cohortRule)
      .toContain("attributed_to_agent=true");
    expect(metricDefinition("coach.agent_win_rate").population)
      .toContain("same terminal population");
  });

  it("pins billing-period allowance, trailing-30-day operations, and seven-day touch attribution", () => {
    expect(metricDefinition("coach.allowance_used").window).toContain("picker never changes it");
    expect(metricDefinition("coach.allowance_limit").clock).toContain("current_period_start");
    expect(metricDefinition("coach.allowance_limit").sources).toContainEqual({
      table: "public.tiers",
      columns: ["id", "call_allowance"],
    });
    expect(metricDefinition("platform.guardrail_block_rate").window).toContain("Trailing 30 days");
    expect(metricDefinition("platform.followup_reply_rate").window).toContain("seven days");
    expect(metricDefinition("platform.followup_reply_rate").cohortRule).toContain("next touch");
    expect(metricDefinition("platform.margin").sources).toEqual([{
      table: "public.platform_margin_projection",
      columns: [
        "tenant_id",
        "window_start",
        "window_end",
        "recognized_subscription_cents",
        "total_cost_cents",
        "margin_cents",
      ],
    }]);
  });

  it("records the objection booked rate as proposed and unapproved rather than as a shipped rule", () => {
    const conversations = metricDefinition("coach.objection.conversations");
    expect(conversations.unit).toBe("count");
    expect(conversations.audience).toBe("coach");
    expect(conversations.economics).toBe("none");
    expect(conversations.sources.map((source) => source.table))
      .toContain("public.analytics_brain_objection_usage_events");
    expect(conversations.cohortRule).toContain("once per objection");

    const bookedRate = metricDefinition("coach.objection.booked_rate");
    // The rate test at :115 forces both of these for any `_rate` key, and neither is weakened to
    // make an awaiting-definition row easier to build. Absence is carried by evidence state.
    expect(bookedRate.unit).toBe("percent");
    expect(bookedRate.requiresPositiveDenominator).toBe(true);
    for (const field of [
      bookedRate.history, bookedRate.denominator, bookedRate.window, bookedRate.cohortRule,
    ]) {
      expect(field.toLowerCase()).toContain("unapproved");
    }
    expect(bookedRate.history.toLowerCase()).toContain("never as zero");
  });

  it("makes every cost, revenue, commission, and margin value admin-only in the vocabulary", () => {
    const economics = METRIC_KEYS.filter((key) => metricDefinition(key).economics !== "none");
    expect(economics).toEqual([
      "platform.gross_mrr",
      "platform.affiliate_commission",
      "platform.ltv",
      "platform.margin",
      "eval.cost_per_case",
      "eval.cost_per_thousand",
    ]);
    for (const key of economics) expect(metricDefinition(key).audience).toBe("admin_only");
    expect(COACH_METRIC_KEYS.every((key) => metricDefinition(key).economics === "none")).toBe(true);
  });

  it("renders unavailable and insufficient-history evidence as absence rather than zero", () => {
    for (const state of ["needs_more_history", "unavailable"] as const) {
      expect(availableMetric(evidence("coach.new_leads", { state, value: 0 }))).toBeNull();
    }
    // An open window is a reading with a caveat, not an absence: the RPC marks every preset
    // window `still_filling` until local midnight, so refusing the state refused every count a
    // coach can see. The number it carries is real; a null under it is still nothing.
    expect(availableMetric(evidence("coach.new_leads", { state: "still_filling", value: 37 }))).toBe(37);
    expect(availableMetric(evidence("coach.new_leads", { state: "still_filling", value: 0 }))).toBe(0);
    expect(availableMetric(evidence("coach.new_leads", { state: "still_filling", value: null }))).toBeNull();
    expect(availableMetric(evidence("coach.conversion_rate", {
      numerator: 0,
      denominator: 0,
      value: 0,
    }))).toBeNull();
    expect(availableMetric(evidence("coach.conversion_rate", {
      numerator: null,
      denominator: 10,
      value: 0,
    }))).toBeNull();
    expect(availableMetric(evidence("coach.new_leads", {
      numerator: 0,
      denominator: null,
      value: 0,
    }))).toBe(0);
  });

  it("refuses unknown keys and returns labels only from the closed register", () => {
    expect(metricLabel("coach.new_leads")).toBe("New leads");
    expect(() => metricDefinition("coach.invented_metric")).toThrow("METRIC_DEFINITION_MISSING");
  });
});
