import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  COACH_METRIC_KEYS,
  metricDefinition,
  type MetricKey,
} from "@/lib/analytics/metric-definitions";

import {
  COACH_TOP_OBJECTION_LIMIT,
  HARD_GATED_ROWS_COACH_VISIBLE,
  loadCoachLeadComposition,
  loadCoachMeasurement,
  loadCoachTopObjections,
} from "./analytics";

const ACTOR = "72000000-0000-4000-8000-000000000004";
const WINDOW_START = "2026-08-01T04:00:00.000Z";
const WINDOW_END = "2026-08-19T04:00:00.000Z";
const ALLOWANCE_START = "2026-08-01T00:00:00.000Z";
const ALLOWANCE_END = "2026-09-01T00:00:00.000Z";

function metric(key: MetricKey) {
  const definition = metricDefinition(key);
  const numerator = 5;
  const denominator = 10;
  // The active-leads split must sum to coach.active_leads (value 5, the count-metric default
  // below) for the conservation check in `loadCoachMeasurement` to accept the fixture.
  if (key === "coach.active_leads_agent_handling") {
    return {
      metricKey: key, numerator: 3, denominator: 5, value: 3, state: "available",
      windowStart: WINDOW_START, windowEnd: WINDOW_END,
    };
  }
  if (key === "coach.active_leads_needs_you") {
    return {
      metricKey: key, numerator: 2, denominator: 5, value: 2, state: "available",
      windowStart: WINDOW_START, windowEnd: WINDOW_END,
    };
  }
  return {
    metricKey: key,
    numerator,
    denominator,
    value: definition.unit === "percent" ? 50 : numerator,
    state: "available",
    windowStart: key.startsWith("coach.allowance_") ? ALLOWANCE_START : WINDOW_START,
    windowEnd: key.startsWith("coach.allowance_") ? ALLOWANCE_END : WINDOW_END,
  };
}

function snapshot() {
  return {
    tenantId: "tenant-synthetic",
    window: "1m",
    timezone: "America/New_York",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    metrics: COACH_METRIC_KEYS.map(metric),
    funnel: [
      { stepKey: "entered", stepLabel: "Entered", enteredContacts: 10, completedContacts: 10 },
      { stepKey: "qualified", stepLabel: "Qualified", enteredContacts: 10, completedContacts: 6 },
      { stepKey: "booked", stepLabel: "Booked", enteredContacts: 10, completedContacts: 5 },
    ],
    responses: [{
      stepKey: "credit",
      stepLabel: "Credit range",
      askedContacts: 10,
      answeredContacts: 5,
    }],
    keywords: [{
      keyword: "FUNDING",
      conversations: 5,
      senderCount: 4,
      qualifiedContacts: 3,
      respondedConversations: 4,
      bookedContacts: 2,
      dataLabel: "Database truth",
    }],
    pipeline: [{
      contactId: "contact-synthetic",
      displayName: "Synthetic lead",
      stage: "booked",
      attributedToAgent: true,
      latestAppointmentStatus: "scheduled",
      changedAt: "2026-08-18T12:00:00.000Z",
      dataLabel: "Database truth",
    }],
    allowance: {
      used: 5,
      limit: 10,
      periodStart: ALLOWANCE_START,
      periodEnd: ALLOWANCE_END,
      state: "available",
    },
    isDemo: false,
  };
}

describe("coach measurement repository", () => {
  it("passes only picker state to the one tenant-scoped RPC source", async () => {
    const source = vi.fn(async () => snapshot());
    const result = await loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, source);

    expect(source).toHaveBeenCalledWith(ACTOR, "tenant-synthetic", {
      window: "1m",
      customFrom: null,
      customTo: null,
      asOf: "2026-08-18T12:00:00.000Z",
    });
    expect(Object.keys(result).sort()).toEqual([
      "allowance", "funnel", "isDemo", "keywords", "metrics", "pipeline", "responses",
      "tenantId", "window", "windowEnd",
    ]);
    // The instant the window closes at is admitted by name, like every other field here. The view
    // model prints it in place of the `asOf` parameter name that the metric definitions write
    // their windows against, so it has to survive the projection rather than be re-derived from a
    // render-time clock.
    expect(result.windowEnd).toBe(WINDOW_END);
    expect(result.isDemo).toBe(false);
    expect(result.metrics.map((row) => row.metricKey)).toEqual(COACH_METRIC_KEYS);
    expect(result.keywords).toEqual([expect.objectContaining({
      keyword: "FUNDING",
      conversations: 5,
      dataLabel: "Database truth",
    })]);
  });

  it("rejects caller tenant, timezone, or label overrides instead of trusting URL state", async () => {
    await expect(loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
      timezone: "UTC",
      metricLabel: "Invented",
    } as never, async () => snapshot())).rejects.toThrow("COACH_MEASUREMENT_OPTIONS_INVALID");
  });

  it("refuses every platform or economics key returned through a coach-scoped read", async () => {
    const widened = snapshot();
    widened.metrics[0] = {
      ...widened.metrics[0],
      metricKey: "platform.margin",
    } as never;
    await expect(loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, async () => widened)).rejects.toThrow("COACH_METRIC_SET_INVALID");
  });

  it("rejects zero denominators and mismatched database windows instead of filling a number", async () => {
    // A rate over nobody is still refused. The row moved off index 0 because a count of zero
    // over an empty window is now the database telling the truth, not malformed evidence.
    const zero = snapshot();
    const rate = zero.metrics.findIndex((row) => row.metricKey === "coach.conversion_rate");
    zero.metrics[rate] = { ...zero.metrics[rate], denominator: 0, numerator: 0, value: 0 };
    await expect(loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, async () => zero)).rejects.toThrow("MEASUREMENT_DENOMINATOR_REQUIRED");

    const drifted = snapshot();
    drifted.metrics[0] = {
      ...drifted.metrics[0],
      windowStart: "2026-08-02T04:00:00.000Z",
    };
    await expect(loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, async () => drifted)).rejects.toThrow("MEASUREMENT_WINDOW_MISMATCH");
  });

  it("accepts only attributed keyword rows while preserving conservation and pipeline stages", async () => {
    const attributed = snapshot();
    attributed.keywords[0] = { ...attributed.keywords[0], keyword: "campaign" };
    await expect(loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, async () => attributed)).resolves.toMatchObject({
      keywords: [{ keyword: "campaign", conversations: 5 }],
    });

    const manufacturedDenominator = snapshot();
    manufacturedDenominator.keywords[0] = {
      ...manufacturedDenominator.keywords[0], conversations: 6,
    };
    await expect(loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, async () => manufacturedDenominator))
      .rejects.toThrow("COACH_MEASUREMENT_KEYWORD_CONSERVATION_FAILED");

    const invalidStage = snapshot();
    invalidStage.pipeline[0] = { ...invalidStage.pipeline[0], stage: "won" };
    await expect(loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, async () => invalidStage)).rejects.toThrow("COACH_MEASUREMENT_PIPELINE_INVALID");
  });

  it("carries a distinct sender count per keyword row for honest rate suppression", async () => {
    const result = await loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, async () => snapshot());
    expect(result.keywords).toEqual([expect.objectContaining({
      keyword: "FUNDING", conversations: 5, senderCount: 4,
    })]);

    const oversized = snapshot();
    oversized.keywords[0] = { ...oversized.keywords[0], senderCount: 6 };
    await expect(loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, async () => oversized)).rejects.toThrow("COACH_MEASUREMENT_KEYWORDS_INVALID");
  });

  it("renders a window with no conversations instead of refusing it", async () => {
    /*
     * `20260823000001_phase7_measurement.sql:1376-1397` groups over the conversations in the
     * window, so a quiet window aggregates to no rows and coalesces to `[]`. There is no attributed
     * keyword bucket because there is nothing to bucket. Requiring a placeholder row there threw
     * COACH_MEASUREMENT_KEYWORD_CONSERVATION_FAILED and took the coach's whole home page down with
     * a 500 -- a real one, digest 211570165, on production.
     */
    const quiet = snapshot();
    quiet.keywords = [];
    const keywordIndex = quiet.metrics.findIndex(
      (row) => row.metricKey === "coach.keyword.conversations",
    );
    quiet.metrics[keywordIndex] = { ...quiet.metrics[keywordIndex], value: 0 };

    const result = await loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, async () => quiet);
    expect(result.keywords).toEqual([]);

    // Conservation still binds on the empty case: rows summing to something the metric does not
    // claim is corruption whether there is one row or none.
    const disagreeing = snapshot();
    disagreeing.keywords = [];
    await expect(loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, async () => disagreeing)).rejects.toThrow("COACH_MEASUREMENT_KEYWORD_CONSERVATION_FAILED");
  });

  it("refuses a missing or blank reader before it reaches the network", async () => {
    const source = vi.fn(async () => snapshot());
    for (const actor of [undefined, null, "", "   "]) {
      await expect(loadCoachMeasurement(actor as never, "tenant-synthetic", {
        window: "1m",
        asOf: "2026-08-18T12:00:00.000Z",
      }, source)).rejects.toThrow("MEASUREMENT_ACTOR_REQUIRED");
      await expect(loadCoachLeadComposition(actor as never, "tenant-synthetic", COMPOSITION_AS_OF,
        vi.fn(async () => composition()))).rejects.toThrow("MEASUREMENT_ACTOR_REQUIRED");
    }
    expect(source).not.toHaveBeenCalled();
  });

  it("contains no protected base, provider, or fixture read path", async () => {
    const source = await readFile(new URL("./analytics.ts", import.meta.url), "utf8");
    expect(source).toContain('client.rpc("read_coach_measurement_for_actor"');
    expect(source).toContain('client.rpc("read_coach_lead_composition_for_actor"');
    expect(source).toContain('client.rpc("read_coach_top_objections_for_actor"');
    expect(source).toContain("p_actor_id: actor");
    expect(source).not.toMatch(/\.from\s*\(/u);
    expect(source).not.toMatch(/fetch\s*\(/u);
    expect(source.toLowerCase()).not.toContain("stripe");
    expect(source).not.toMatch(/workspace-fixtures|admin-demo-feedback-fixtures/u);
  });
});

const COMPOSITION_AS_OF = "2026-08-15T12:00:00.000Z";

function composition() {
  return {
    tenantId: "tenant-synthetic",
    timezone: "America/New_York",
    asOf: COMPOSITION_AS_OF,
    months: [
      { month: "2026-03-01", label: "Mar 2026", total: 0, qualified: 0, disqualified: 0, active: 0, partial: false },
      { month: "2026-04-01", label: "Apr 2026", total: 10, qualified: 4, disqualified: 3, active: 3, partial: false },
      { month: "2026-05-01", label: "May 2026", total: 6, qualified: 2, disqualified: 1, active: 3, partial: false },
      { month: "2026-06-01", label: "Jun 2026", total: 4, qualified: 1, disqualified: 2, active: 1, partial: false },
      { month: "2026-07-01", label: "Jul 2026", total: 0, qualified: 0, disqualified: 0, active: 0, partial: false },
      { month: "2026-08-01", label: "Aug 2026", total: 5, qualified: 3, disqualified: 1, active: 1, partial: true },
    ],
    bookedByPeriod: [
      { month: "2026-03-01", booked: 0 },
      { month: "2026-04-01", booked: 2 },
      { month: "2026-05-01", booked: 1 },
      { month: "2026-06-01", booked: 0 },
      { month: "2026-07-01", booked: 0 },
      { month: "2026-08-01", booked: 3 },
    ],
  };
}

function loadComposition(snapshot: unknown) {
  return loadCoachLeadComposition(ACTOR, "tenant-synthetic", COMPOSITION_AS_OF, async () => snapshot);
}

describe("coach lead composition repository", () => {
  it("passes only the tenant and one clock reading to the window-independent RPC", async () => {
    const source = vi.fn(async () => composition());
    const result = await loadCoachLeadComposition(ACTOR, "tenant-synthetic", COMPOSITION_AS_OF, source);

    expect(source).toHaveBeenCalledWith(ACTOR, "tenant-synthetic", COMPOSITION_AS_OF);
    expect(Object.keys(result).sort()).toEqual(["asOf", "bookedByPeriod", "months", "tenantId", "timezone"]);
    expect(result.months.map((row) => row.month)).toEqual([
      "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01",
    ]);
    expect(result.months.map((row) => row.partial)).toEqual([false, false, false, false, false, true]);
    expect(result.months[1]).toEqual({
      month: "2026-04-01", label: "Apr 2026", total: 10, qualified: 4, disqualified: 3, active: 3,
      partial: false,
    });
    expect(result.bookedByPeriod).toEqual([
      { month: "2026-03-01", booked: 0 },
      { month: "2026-04-01", booked: 2 },
      { month: "2026-05-01", booked: 1 },
      { month: "2026-06-01", booked: 0 },
      { month: "2026-07-01", booked: 0 },
      { month: "2026-08-01", booked: 3 },
    ]);
  });

  it("refuses a payload that answers for a tenant other than the one asked for", async () => {
    const widened = composition();
    widened.tenantId = "tenant-other";
    await expect(loadComposition(widened)).rejects.toThrow("COACH_COMPOSITION_SCOPE_MISMATCH");
  });

  it("refuses a month whose segments do not add up to its own labelled total", async () => {
    const short = composition();
    short.months[1] = { ...short.months[1], active: 2 };
    await expect(loadComposition(short)).rejects.toThrow("COACH_COMPOSITION_CONSERVATION_FAILED");

    const over = composition();
    over.months[1] = { ...over.months[1], active: 4 };
    await expect(loadComposition(over)).rejects.toThrow("COACH_COMPOSITION_CONSERVATION_FAILED");
  });

  it("refuses a grid that is not six ascending months with at most one still filling", async () => {
    const short = composition();
    short.months = short.months.slice(0, 5);
    await expect(loadComposition(short)).rejects.toThrow("COACH_COMPOSITION_SNAPSHOT_INVALID");

    const unordered = composition();
    unordered.months = [unordered.months[1], unordered.months[0], ...unordered.months.slice(2)];
    await expect(loadComposition(unordered)).rejects.toThrow("COACH_COMPOSITION_SNAPSHOT_INVALID");

    const negative = composition();
    negative.months[1] = { ...negative.months[1], active: -3, total: 4 };
    await expect(loadComposition(negative)).rejects.toThrow("COACH_COMPOSITION_SNAPSHOT_INVALID");

    const twoPartial = composition();
    twoPartial.months[4] = { ...twoPartial.months[4], partial: true };
    await expect(loadComposition(twoPartial)).rejects.toThrow("COACH_COMPOSITION_SNAPSHOT_INVALID");

    const mismatchedBookedPeriods = composition();
    mismatchedBookedPeriods.bookedByPeriod[1] = { month: "2026-04-02", booked: 2 };
    await expect(loadComposition(mismatchedBookedPeriods))
      .rejects.toThrow("COACH_COMPOSITION_SNAPSHOT_INVALID");

    const invalidBookedCount = composition();
    invalidBookedCount.bookedByPeriod[3] = { month: "2026-06-01", booked: -1 };
    await expect(loadComposition(invalidBookedCount)).rejects.toThrow("COACH_COMPOSITION_SNAPSHOT_INVALID");
  });
});

// A tenant with no active billing subscription: the RPC has no period to report, so the two
// allowance metric rows lose their window along with their numbers.
function noSubscriptionSnapshot() {
  const raw = snapshot();
  raw.allowance = {
    used: null,
    limit: null,
    periodStart: null,
    periodEnd: null,
    state: "unavailable",
  } as never;
  raw.metrics = raw.metrics.map((row) => (row.metricKey.startsWith("coach.allowance_")
    ? {
      ...row,
      numerator: null,
      denominator: null,
      value: null,
      state: "unavailable",
      windowStart: null,
      windowEnd: null,
    }
    : row)) as never;
  return raw;
}

function loadCoach(raw: unknown) {
  return loadCoachMeasurement(ACTOR, "tenant-synthetic", {
    window: "1m",
    asOf: "2026-08-18T12:00:00.000Z",
  }, async () => raw);
}

describe("the coach dashboard states the crash was hiding", () => {
  it("renders a tenant with no active subscription instead of dying on its allowance", async () => {
    const result = await loadCoach(noSubscriptionSnapshot());
    expect(result.allowance).toEqual({
      used: null,
      limit: null,
      periodStart: null,
      periodEnd: null,
      state: "unavailable",
    });
    expect(result.metrics.find((row) => row.metricKey === "coach.allowance_limit"))
      .toMatchObject({ value: null, state: "unavailable", windowStart: null, windowEnd: null });
  });

  it("still refuses an allowance that claims a number it cannot support", async () => {
    const overspent = snapshot();
    overspent.allowance = { ...overspent.allowance, used: 11, limit: 10 };
    await expect(loadCoach(overspent)).rejects.toThrow("COACH_MEASUREMENT_ALLOWANCE_INVALID");

    const noPeriod = snapshot();
    noPeriod.allowance = { ...noPeriod.allowance, periodEnd: null } as never;
    await expect(loadCoach(noPeriod)).rejects.toThrow("COACH_MEASUREMENT_ALLOWANCE_INVALID");

    const unknownState = snapshot();
    unknownState.allowance = { ...unknownState.allowance, state: "still_filling" } as never;
    await expect(loadCoach(unknownState)).rejects.toThrow("COACH_MEASUREMENT_ALLOWANCE_INVALID");
  });

  it("renders a window that contains no leads at all rather than refusing the page", async () => {
    // Every coach rate is emitted still_filling with a null value when its denominator is zero,
    // which is any window a coach picks before their first lead - demo tenant or not.
    const empty = snapshot();
    empty.metrics = empty.metrics.map((row) => (metricDefinition(row.metricKey)
      .requiresPositiveDenominator
      ? { ...row, numerator: 0, denominator: 0, value: null, state: "still_filling" }
      : row)) as never;
    const result = await loadCoach(empty);
    expect(result.metrics.find((row) => row.metricKey === "coach.conversion_rate"))
      .toMatchObject({ value: null, state: "still_filling" });
  });

  it("requires the demo flag the surface labels itself with", async () => {
    const demo = snapshot();
    demo.isDemo = true;
    await expect(loadCoach(demo)).resolves.toMatchObject({ isDemo: true });

    const missing = snapshot() as Record<string, unknown>;
    delete missing.isDemo;
    await expect(loadCoach(missing)).rejects.toThrow("COACH_MEASUREMENT_SNAPSHOT_INVALID");

    const notBoolean = snapshot();
    notBoolean.isDemo = "true" as never;
    await expect(loadCoach(notBoolean)).rejects.toThrow("COACH_MEASUREMENT_SNAPSHOT_INVALID");
  });
});

const OBJECTION_AS_OF = "2026-08-22T12:00:00.000Z";
const OBJECTION_WINDOW_START = "2026-07-23T12:00:00.000Z";
const OBJECTION_TIMING = "8a000000-0000-4000-8000-000000000102";
const OBJECTION_PRICING = "8a000000-0000-4000-8000-000000000101";

function objectionRow(overrides: Record<string, unknown> = {}) {
  return {
    objectionId: OBJECTION_TIMING,
    label: "Not right now",
    state: "awaiting_definition",
    bookedRate: null,
    conversationCount: 12,
    hardGate: false,
    ...overrides,
  };
}

function rollup(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-synthetic",
    asOf: OBJECTION_AS_OF,
    windowStart: OBJECTION_WINDOW_START,
    windowEnd: OBJECTION_AS_OF,
    attributionState: "awaiting_definition",
    rows: [
      objectionRow(),
      objectionRow({ objectionId: OBJECTION_PRICING, label: "Too expensive", conversationCount: 3 }),
    ],
    ...overrides,
  };
}

function loadObjections(payload: unknown) {
  return loadCoachTopObjections(ACTOR, "tenant-synthetic", OBJECTION_AS_OF, async () => payload);
}

describe("coach top objections repository", () => {
  it("returns database-computed counts inside a half-open window with no rate at all", async () => {
    const result = await loadCoachTopObjections(
      ACTOR, "tenant-synthetic", OBJECTION_AS_OF, async () => rollup(),
    );
    expect(Object.keys(result).sort()).toEqual([
      "asOf", "attributionState", "rows", "tenantId", "windowEnd", "windowStart",
    ]);
    expect(result.attributionState).toBe("awaiting_definition");
    expect(Date.parse(result.windowEnd) - Date.parse(result.windowStart))
      .toBe(30 * 24 * 60 * 60 * 1_000);
    expect(result.rows).toEqual([
      {
        objectionId: OBJECTION_TIMING, label: "Not right now", state: "awaiting_definition",
        bookedRate: null, conversationCount: 12, hardGate: false,
      },
      {
        objectionId: OBJECTION_PRICING, label: "Too expensive", state: "awaiting_definition",
        bookedRate: null, conversationCount: 3, hardGate: false,
      },
    ]);
  });

  it("refuses a rate that arrives while the attribution rule is still unapproved", async () => {
    const early = rollup();
    early.rows = [objectionRow({ bookedRate: 0.41 })];
    await expect(loadObjections(early))
      .rejects.toThrow("COACH_OBJECTION_BOOKED_RATE_UNDEFINED");

    const stateOnly = rollup();
    stateOnly.rows = [objectionRow({ state: "available", bookedRate: 0.41 })];
    await expect(loadObjections(stateOnly))
      .rejects.toThrow("COACH_OBJECTION_BOOKED_RATE_UNDEFINED");
  });

  it("refuses an available row that carries no number to be available about", async () => {
    const mirror = rollup({ attributionState: "defined" });
    mirror.rows = [objectionRow({ state: "available", bookedRate: null })];
    await expect(loadObjections(mirror))
      .rejects.toThrow("COACH_OBJECTION_BOOKED_RATE_UNDEFINED");

    // The same envelope with the number present is accepted, so the refusal is about the
    // contradiction rather than about `defined` being unreachable.
    const defined = rollup({ attributionState: "defined" });
    defined.rows = [objectionRow({ state: "available", bookedRate: 0.41 })];
    await expect(loadObjections(defined)).resolves.toMatchObject({
      attributionState: "defined",
      rows: [expect.objectContaining({ state: "available", bookedRate: 0.41 })],
    });
  });

  it("refuses a widened tenant, an unsound count, and a row key nobody declared", async () => {
    await expect(loadObjections(rollup({ tenantId: "tenant-other" })))
      .rejects.toThrow("COACH_OBJECTION_SCOPE_MISMATCH");

    for (const count of [-1, 2.5, "12", null]) {
      const bad = rollup();
      bad.rows = [objectionRow({ conversationCount: count })];
      await expect(loadObjections(bad)).rejects.toThrow("COACH_OBJECTION_SNAPSHOT_INVALID");
    }

    const widened = rollup();
    widened.rows = [{ ...objectionRow(), bookedContacts: 4 } as never];
    await expect(loadObjections(widened)).rejects.toThrow("COACH_OBJECTION_SNAPSHOT_INVALID");

    const unknownState = rollup();
    unknownState.rows = [objectionRow({ state: "still_filling" })];
    await expect(loadObjections(unknownState)).rejects.toThrow("COACH_OBJECTION_SNAPSHOT_INVALID");

    const unknownAttribution = rollup({ attributionState: "estimated" });
    await expect(loadObjections(unknownAttribution))
      .rejects.toThrow("COACH_OBJECTION_SNAPSHOT_INVALID");
  });

  it("asks the source for the clamped limit and the hard-gate decision by its constant", async () => {
    const source = vi.fn(async () => rollup());
    await loadCoachTopObjections(ACTOR, "tenant-synthetic", OBJECTION_AS_OF, source);
    expect(source).toHaveBeenCalledWith(
      ACTOR, "tenant-synthetic", OBJECTION_AS_OF,
      COACH_TOP_OBJECTION_LIMIT, HARD_GATED_ROWS_COACH_VISIBLE,
    );
    // Read as the record of the decision, not as a magic number: hard-gated compliance labels stay
    // unfetched until Alec answers whether a coach may see them (10-SPEC:378).
    expect(HARD_GATED_ROWS_COACH_VISIBLE).toBe(false);
    expect(COACH_TOP_OBJECTION_LIMIT).toBe(5);

    for (const actor of [undefined, null, "", "   "]) {
      await expect(loadCoachTopObjections(
        actor as never, "tenant-synthetic", OBJECTION_AS_OF, vi.fn(async () => rollup()),
      )).rejects.toThrow("MEASUREMENT_ACTOR_REQUIRED");
    }
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("leaves the coach measurement set at the exact twenty-two rows the hosted RPC returns", () => {
    // New coverage rather than red. A 23rd expected key would crash every coach dashboard read on
    // hosted while `analytics.test.ts`'s fixture, which maps over the same array, stayed green.
    expect(COACH_METRIC_KEYS).toHaveLength(22);
    expect(COACH_METRIC_KEYS).not.toContain("coach.objection.conversations");
    expect(COACH_METRIC_KEYS).not.toContain("coach.objection.booked_rate");
  });

  it("rejects an active-leads split that does not sum to coach.active_leads", async () => {
    const broken = snapshot();
    broken.metrics = broken.metrics.map((row) => (
      row.metricKey === "coach.active_leads_needs_you" ? { ...row, value: 999 } : row
    ));
    const source = vi.fn(async () => broken);
    await expect(loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, source)).rejects.toThrow("COACH_MEASUREMENT_ACTIVE_LEADS_CONSERVATION_FAILED");
  });

  it("accepts an active-leads split that sums to coach.active_leads", async () => {
    const source = vi.fn(async () => snapshot());
    const result = await loadCoachMeasurement(ACTOR, "tenant-synthetic", {
      window: "1m",
      asOf: "2026-08-18T12:00:00.000Z",
    }, source);
    const activeLeads = result.metrics.find((row) => row.metricKey === "coach.active_leads");
    const agentHandling = result.metrics.find(
      (row) => row.metricKey === "coach.active_leads_agent_handling",
    );
    const needsYou = result.metrics.find((row) => row.metricKey === "coach.active_leads_needs_you");
    expect((agentHandling?.value ?? 0) + (needsYou?.value ?? 0)).toBe(activeLeads?.value);
  });
});
