import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COACH_METRIC_KEYS,
  metricDefinition,
  type MetricKey,
} from "@/lib/analytics/metric-definitions";
import { metricDescriptorText, withAsOfLabel } from "@/lib/analytics/metric-descriptor";
import { utcTimestampLabel } from "@/lib/format/datetime";
import type {
  CoachLeadComposition,
  CoachMeasurement,
  CoachTopObjections,
} from "@/lib/repositories/analytics";
import {
  COACH_COMPOSITION_COLUMNS,
  COACH_HOME_KPI_KEYS,
  COACH_KEYWORD_COLUMNS,
  COACH_PIPELINE_COLUMNS,
  COACH_STEP_COLUMNS,
  COACH_TOP_OBJECTION_COLUMNS,
  coachCompositionExportRows,
  coachCompositionView,
  coachMetricDisplay,
  coachMeasurementView,
  coachPipelineView,
  coachTopObjectionExportRows,
  coachTopObjectionsView,
} from "./measurement-view-models";

const WINDOW_START = "2026-08-01T04:00:00.000Z";
const WINDOW_END = "2026-08-19T04:00:00.000Z";

function metric(key: MetricKey) {
  const definition = metricDefinition(key);
  return {
    metricKey: key,
    numerator: 5,
    denominator: 10,
    value: definition.unit === "percent" ? 50 : 5,
    state: "available" as const,
    windowStart: key.startsWith("coach.allowance_") ? "2026-08-01T00:00:00.000Z" : WINDOW_START,
    windowEnd: key.startsWith("coach.allowance_") ? "2026-09-01T00:00:00.000Z" : WINDOW_END,
  };
}

function snapshot(): CoachMeasurement {
  return {
    tenantId: "tenant-synthetic",
    window: "1m",
    windowEnd: WINDOW_END,
    metrics: COACH_METRIC_KEYS.map(metric),
    funnel: [
      { stepKey: "entered", stepLabel: "Entered", enteredContacts: 10, completedContacts: 10 },
      { stepKey: "qualified", stepLabel: "Qualification complete", enteredContacts: 10, completedContacts: 6 },
      { stepKey: "booked", stepLabel: "Booked", enteredContacts: 10, completedContacts: 5 },
    ],
    responses: [
      { stepKey: "credit", stepLabel: "Credit range", askedContacts: 10, answeredContacts: 5 },
      { stepKey: "revenue", stepLabel: "Step 2", askedContacts: 0, answeredContacts: 0 },
    ],
    keywords: [{
      keyword: "No keyword",
      conversations: 5,
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
    isDemo: false,
    allowance: {
      used: 5,
      limit: 10,
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      state: "available",
    },
  };
}

describe("coachMeasurementView", () => {
  it("derives every rendered KPI descriptor from the closed definition register", () => {
    const view = coachMeasurementView(snapshot());
    expect(view.metrics.map((row) => row.key)).toEqual(COACH_HOME_KPI_KEYS);
    for (const row of view.metrics) {
      const definition = metricDefinition(row.key);
      expect(row.label).toBe(definition.label);
      expect(row.descriptor).toMatchObject({
        denominator: definition.denominator,
        window: definition.window,
        clock: definition.clock,
      });
      expect(row.descriptor.text).toContain(definition.denominator);
      expect(row.descriptor.text).toContain(definition.window);
      expect(row.descriptor.text).toContain(definition.clock);
    }
    expect(view.allowance.descriptor).toMatchObject({
      denominator: metricDefinition("coach.allowance_used").denominator,
      window: metricDefinition("coach.allowance_used").window,
      clock: metricDefinition("coach.allowance_used").clock,
    });
  });

  it("removes a rendered number when its evidence is missing instead of retaining zero or stale data", () => {
    const complete = coachMeasurementView(snapshot());
    const missingSnapshot = snapshot();
    missingSnapshot.metrics = missingSnapshot.metrics.filter((row) => row.metricKey !== "coach.conversion_rate");
    const missing = coachMeasurementView(missingSnapshot);
    const before = complete.metrics.find((row) => row.key === "coach.conversion_rate");
    const after = missing.metrics.find((row) => row.key === "coach.conversion_rate");

    expect(before?.value).toBe("50%");
    expect(after).toMatchObject({ value: null, absenceLabel: "Unavailable" });
    expect(after?.descriptor).toEqual(before?.descriptor);
    expect(coachMetricDisplay(before!)).toBe("50%");
    expect(coachMetricDisplay(after!)).toBe("Unavailable");
    expect(coachMetricDisplay(after!)).not.toMatch(/\d/u);
  });

  it("renders nonnumeric evidence states as named absence and keeps show rate self-reported", () => {
    const input = snapshot();
    input.metrics = input.metrics.map((row) => row.metricKey === "coach.active_leads"
      ? { ...row, numerator: null, denominator: null, value: null, state: "still_filling" }
      : row);
    const view = coachMeasurementView(input);
    expect(view.metrics.find((row) => row.key === "coach.active_leads"))
      .toMatchObject({ value: null, absenceLabel: "No completed events yet" });
    expect(view.metrics.find((row) => row.key === "coach.show_rate"))
      .toMatchObject({ label: "Show rate (self-reported)", selfReported: true });
  });

  it("uses stored question labels and leaves zero-denominator response rates unavailable", () => {
    const view = coachMeasurementView(snapshot());
    expect(view.steps.find((row) => row.stepKey === "credit"))
      .toMatchObject({ stepLabel: "Credit range", responseRate: 50 });
    expect(view.steps.find((row) => row.stepKey === "revenue"))
      .toMatchObject({ stepLabel: "Step 2", responseRate: null });
    expect(view.keywords.map((row) => row.keyword)).toContain("No keyword");
    expect(view.descriptors.keywords.denominator.toLowerCase()).toContain("conversation");
  });

  it("declares the exact rendered and exported column tuples", () => {
    expect(COACH_KEYWORD_COLUMNS).toEqual([
      "keyword", "conversations", "qualifiedContacts", "respondedConversations",
      "bookedContacts", "dataLabel",
    ]);
    expect(COACH_STEP_COLUMNS).toEqual([
      "stepKey", "stepLabel", "enteredContacts", "completedContacts", "askedContacts",
      "answeredContacts", "responseRate", "dataLabel",
    ]);
    expect(COACH_PIPELINE_COLUMNS).toEqual([
      "contactId", "displayName", "stage", "attributedToAgent", "latestAppointmentStatus",
      "changedAt", "dataLabel",
    ]);
  });
});

function composition(): CoachLeadComposition {
  return {
    bookedByPeriod: [],
    tenantId: "tenant-synthetic",
    timezone: "America/New_York",
    asOf: "2026-08-15T12:00:00.000Z",
    months: [
      { month: "2026-03-01", label: "Mar 2026", total: 0, qualified: 0, disqualified: 0, active: 0, partial: false },
      { month: "2026-04-01", label: "Apr 2026", total: 10, qualified: 4, disqualified: 3, active: 3, partial: false },
      { month: "2026-05-01", label: "May 2026", total: 6, qualified: 2, disqualified: 1, active: 3, partial: false },
      { month: "2026-06-01", label: "Jun 2026", total: 4, qualified: 4, disqualified: 0, active: 0, partial: false },
      { month: "2026-07-01", label: "Jul 2026", total: 0, qualified: 0, disqualified: 0, active: 0, partial: false },
      { month: "2026-08-01", label: "Aug 2026", total: 5, qualified: 3, disqualified: 1, active: 1, partial: true },
    ],
  };
}

describe("coachCompositionView", () => {
  it("scales every bar against the tallest month and labels each with its own total", () => {
    const view = coachCompositionView(composition());
    expect(view.months.map((row) => row.heightPercent)).toEqual([0, 100, 60, 40, 0, 50]);
    expect(view.months.map((row) => row.total)).toEqual([0, 10, 6, 4, 0, 5]);
    expect(view.months.map((row) => row.partial)).toEqual([false, false, false, false, false, true]);
    expect(view.rangeLabel).toBe("Mar 2026 – Aug 2026");
  });

  it("omits a zero-count segment entirely so no colour is painted for no leads", () => {
    const view = coachCompositionView(composition());
    expect(view.months[3].segments.map((segment) => segment.key)).toEqual(["qualified"]);
    expect(view.months[0].segments).toEqual([]);
    expect(view.months[1].segments.map((segment) => segment.count)).toEqual([3, 3, 4]);
  });

  it("emits segments top to bottom so qualified sits at the base of the flex column", () => {
    const view = coachCompositionView(composition());
    expect(view.months[1].segments.map((segment) => segment.key))
      .toEqual(["disqualified", "active", "qualified"]);
    expect(view.legend.map((segment) => segment.label))
      .toEqual(["Disqualified", "Active / no outcome yet", "Qualified"]);
    expect(view.months[1].segments.map((segment) => segment.flexGrow)).toEqual([3, 3, 4]);
  });

  it("plots no point for a month with no leads and carries counts on the ones it does", () => {
    const view = coachCompositionView(composition());
    expect(view.trend.available).toBe(true);
    if (!view.trend.available) throw new Error("TREND_EXPECTED_AVAILABLE");
    expect(view.trend.points.map((point) => point.label)).toEqual([
      "Apr 2026", "May 2026", "Jun 2026", "Aug 2026",
    ]);
    expect(view.trend.points.map((point) => point.value)).toEqual([40, 33.3, 100, 60]);
    expect(view.trend.points.at(-1)?.secondary).toBe("3 of 5 leads");
    expect(view.trend.currentValue).toBe("60%");
  });

  it("reports the trend unavailable rather than drawing a line through one month", () => {
    const sparse = composition();
    sparse.months = sparse.months.map((row, index) => index === 5
      ? row
      : { ...row, total: 0, qualified: 0, disqualified: 0, active: 0 });
    const view = coachCompositionView(sparse);
    expect(view.trend.available).toBe(false);
    if (view.trend.available) throw new Error("TREND_EXPECTED_UNAVAILABLE");
    expect(view.trend.reason).toContain("two months");
  });

  it("exports one flat row per month under the declared column tuple", () => {
    expect(COACH_COMPOSITION_COLUMNS).toEqual([
      "month", "label", "total", "qualified", "active", "disqualified", "partial", "dataLabel",
    ]);
    const rows = coachCompositionExportRows(composition());
    expect(rows).toHaveLength(6);
    expect(rows[1]).toEqual({
      month: "2026-04-01",
      label: "Apr 2026",
      total: 10,
      qualified: 4,
      active: 3,
      disqualified: 3,
      partial: false,
      dataLabel: "Database truth",
    });
    expect(rows.every((row) => Object.keys(row).length === COACH_COMPOSITION_COLUMNS.length)).toBe(true);
  });
});

describe("coachPipelineView", () => {
  it("renders all seven stored stages without creating a drag or save claim", () => {
    const view = coachPipelineView(snapshot());
    expect(view.stages.map((stage) => stage.key)).toEqual([
      "new_lead", "qualifying", "booked", "qualified_no_buy", "long_term_followup",
      "no_show", "disqualified",
    ]);
    expect(view.pipelineWin.label).toBe("Pipeline win rate");
    expect(view.agentWin.label).toBe("Agent-attributed win rate");
    expect(view.readOnlyReason).toContain("read-only");
    expect(JSON.stringify(view)).not.toMatch(/saved|drag/i);
  });
});

describe("the demo tenant's own dashboard says so on screen", () => {
  it("carries isDemo through the coach view model in both directions", () => {
    expect(coachMeasurementView({ ...snapshot(), isDemo: true }).isDemo).toBe(true);
    expect(coachMeasurementView({ ...snapshot(), isDemo: false }).isDemo).toBe(false);
  });

  it("adds a label and no economics field", () => {
    const view = coachMeasurementView({ ...snapshot(), isDemo: true });
    expect(JSON.stringify(view)).not.toMatch(/margin|cost|commission|mrr/i);
  });

  it("passes that flag to the page header provenance contract", () => {
    const surface = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/coach-measurement.tsx"),
      "utf8",
    );
    /*
     * `CoachPageHead` rather than the console's `PageHeader` since the canvas pass: the coach
     * surfaces take a 46px title with one sentence under it and no crumbs. What this line is
     * guarding is unchanged and is the reason it reads the source rather than the render -- the
     * demo flag has to reach a head that has a provenance contract, so that the label saying the
     * numbers are demo data cannot be dropped by a lane that only looks at the render.
     */
    expect(surface).toContain(
      'import { CoachPageHead } from "@/components/workspace/live/coach-page-head";',
    );
    expect(surface).toMatch(/provenance=\{measurement\.isDemo \? "demo" : "real"\}/);
    expect(surface).not.toMatch(/DemoBadge/);
  });
});

const OBJECTION_TIMING = "8a000000-0000-4000-8000-000000000102";

function objectionRollup(
  rows: Array<Partial<CoachTopObjections["rows"][number]>>,
  attributionState: CoachTopObjections["attributionState"] = "awaiting_definition",
): CoachTopObjections {
  return {
    tenantId: "tenant-synthetic",
    asOf: "2026-08-22T12:00:00.000Z",
    windowStart: "2026-07-23T12:00:00.000Z",
    windowEnd: "2026-08-22T12:00:00.000Z",
    attributionState,
    rows: rows.map((row) => ({
      objectionId: OBJECTION_TIMING,
      label: "Not right now",
      state: "awaiting_definition",
      bookedRate: null,
      conversationCount: 12,
      hardGate: false,
      ...row,
    })),
  };
}

describe("coach top objections view model", () => {
  it("renders each of the three display states in the words that ship", () => {
    const [awaiting, held, available] = coachTopObjectionsView(objectionRollup([
      { state: "awaiting_definition" },
      { state: "held_safely", hardGate: true },
      { state: "available", bookedRate: 0.41 },
    ], "defined"));

    expect(awaiting).toMatchObject({
      rateLabel: "Booked rate awaiting definition",
      rateTone: "pending",
    });
    expect(held).toMatchObject({ rateLabel: "Held safely", rateTone: "neutral" });
    // No producer today. It is the assertion that proves awaiting-definition is a switch rather
    // than a dead end, and it stays green the day the definition lands.
    expect(available).toMatchObject({ rateLabel: "41% booked", rateTone: "good" });
  });

  it("never manufactures a zero and singularizes a count of one", () => {
    const nulls = coachTopObjectionsView(objectionRollup([
      { state: "awaiting_definition", bookedRate: null, conversationCount: 1 },
      { state: "held_safely", bookedRate: null, conversationCount: 0 },
    ]));
    expect(nulls.map((row) => row.rateLabel)).toEqual([
      "Booked rate awaiting definition", "Held safely",
    ]);
    expect(nulls.every((row) => !row.rateLabel.includes("%"))).toBe(true);
    expect(nulls.map((row) => row.countLabel)).toEqual(["1 conversation", "0 conversations"]);

    // A literal zero rate on an available row is the only way `0% booked` may ever render.
    const [zero] = coachTopObjectionsView(
      objectionRollup([{ state: "available", bookedRate: 0 }], "defined"),
    );
    expect(zero.rateLabel).toBe("0% booked");
  });

  it("links each row to its own filtered conversation view with the id encoded", () => {
    const [row] = coachTopObjectionsView(objectionRollup([{ objectionId: "a b/c" }]));
    expect(row.conversationHref).toBe("/coach/conversations?objection=a%20b%2Fc");

    const [plain] = coachTopObjectionsView(objectionRollup([{}]));
    expect(plain.conversationHref).toBe(`/coach/conversations?objection=${OBJECTION_TIMING}`);
  });

  it("exports the rendered table at the exact seven-column tuple with raw values", () => {
    const rollup = objectionRollup([{ conversationCount: 4 }, { state: "held_safely", hardGate: true }]);
    const rows = coachTopObjectionExportRows(rollup);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([...COACH_TOP_OBJECTION_COLUMNS]);
      expect(row.bookedRate).toBeNull();
      expect(row.windowStart).toBe(rollup.windowStart);
      expect(row.windowEnd).toBe(rollup.windowEnd);
    }
    expect(rows.map((row) => row.state)).toEqual(["awaiting_definition", "held_safely"]);
    expect(rows.map((row) => row.conversationCount)).toEqual([4, 12]);
    // The raw state string, not the rendered label: the CSV is read by machines.
    expect(JSON.stringify(rows)).not.toContain("Booked rate awaiting definition");
  });
});

/**
 * The methodology sentence names an instant, never the RPC argument that carries it.
 *
 * `metric-definitions.ts` writes trailing windows as "ending at asOf", which is the right sentence
 * in the measurement vocabulary and a leaked identifier once it reaches a coach. The admin
 * projection substituted that token from the day the leak was found on `/admin/agent-performance`;
 * this projection never did, so a coach definition growing the token would have reached every
 * methodology note through `MethodologyNote`. Only `coach.objection.conversations` carries it
 * today and nothing renders its descriptor, so this is a guard rather than a live repair: both
 * projections now build descriptors through one function, and this pins the coach half so a
 * renderer cannot quietly drop the substitution again.
 */
describe("coach methodology descriptors", () => {
  function allDescriptors(source: CoachMeasurement) {
    const view = coachMeasurementView(source);
    const pipeline = coachPipelineView(source);
    return [
      ...view.metrics.map((metric) => metric.descriptor),
      view.allowance.descriptor,
      view.descriptors.funnel,
      view.descriptors.responses,
      view.descriptors.keywords,
      pipeline.pipelineWin.descriptor,
      pipeline.agentWin.descriptor,
    ];
  }

  it("never prints the parameter name in a descriptor a coach can read", () => {
    const descriptors = allDescriptors(snapshot());

    expect(descriptors.length).toBeGreaterThan(0);
    for (const descriptor of descriptors) {
      expect(descriptor.text).not.toContain("asOf");
      expect(descriptor.denominator).not.toContain("asOf");
      expect(descriptor.window).not.toContain("asOf");
      expect(descriptor.clock).not.toContain("asOf");
    }
  });

  it("anchors the substitution to the snapshot instant rather than the render clock", () => {
    const later = { ...snapshot(), windowEnd: "2026-09-02T09:30:00.000Z" };

    expect(metricDescriptorText("coach.objection.conversations", null).window)
      .toContain("asOf");
    expect(
      withAsOfLabel(
        metricDefinition("coach.objection.conversations").window,
        utcTimestampLabel(later.windowEnd),
      ),
    ).toContain("Sep 2, 2026, 9:30 AM UTC");
  });

  it("leaves the token in place rather than inventing a date when the instant will not parse", () => {
    expect(utcTimestampLabel("not-a-timestamp")).toBeNull();
    expect(metricDescriptorText("coach.objection.conversations", null).window)
      .not.toContain("Invalid Date");
  });
});
