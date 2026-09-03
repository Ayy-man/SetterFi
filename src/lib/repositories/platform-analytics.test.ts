import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_METRIC_KEYS,
  metricDefinition,
  type MetricKey,
} from "@/lib/analytics/metric-definitions";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: () => ({ rpc }),
}));

import {
  PlatformMeasurementUnavailableError,
  loadPlatformMeasurement,
  platformMeasurementSource,
} from "./platform-analytics";

const ACTOR = "72000000-0000-4000-8000-000000000001";
const AS_OF = "2026-08-18T12:00:00.000Z";

beforeEach(() => {
  rpc.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function metric(key: MetricKey) {
  const definition = metricDefinition(key);
  return {
    metricKey: key,
    numerator: 5,
    denominator: 10,
    value: definition.unit === "percent" ? 50 : 5,
    state: "available",
  };
}

function snapshot() {
  return {
    asOf: AS_OF,
    metrics: PLATFORM_METRIC_KEYS.map(metric),
    subscriptions: [{
      tenantId: "tenant-synthetic",
      subscriptionId: "subscription-synthetic",
      status: "active",
      stripePriceId: "price-synthetic",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
    }],
    tenantPerformance: [{
      tenantId: "tenant-synthetic",
      bookedAppointments: 5,
      grossMrrCents: 30_000,
      commissionCents: 3_000,
      marginCents: 20_000,
      marginState: "available",
    }],
    guardrailRules: [{
      ruleKey: "guarantee",
      label: "Guarantee",
      fires: 10,
      blocks: 4,
      holds: 2,
    }],
    followupPerformance: [{
      touchNo: 1,
      sent: 10,
      replied: 4,
      crossChannel: 2,
      exhausted: 1,
    }],
    provisioningPerformance: [{
      stepKey: "sms_live",
      state: "awaiting_provider",
      attempts: 2,
      failures: 0,
      medianDaysToClear: null,
    }],
    history: [{
      periodStart: "2026-06-19T12:00:00.000Z",
      periodEnd: "2026-07-19T12:00:00.000Z",
      value: 4,
      state: "available",
    }, {
      periodStart: "2026-07-19T12:00:00.000Z",
      periodEnd: AS_OF,
      value: 5,
      state: "available",
    }],
    activeSubscriptionsByPeriod: [{
      periodStart: "2026-06-19T12:00:00.000Z",
      periodEnd: "2026-07-19T12:00:00.000Z",
      value: 3,
      state: "available",
    }, {
      periodStart: "2026-07-19T12:00:00.000Z",
      periodEnd: AS_OF,
      value: 4,
      state: "available",
    }],
    revenueByPeriod: [{
      periodStart: "2026-06-19T12:00:00.000Z",
      periodEnd: "2026-07-19T12:00:00.000Z",
      value: 30_000,
      state: "available",
    }, {
      periodStart: "2026-07-19T12:00:00.000Z",
      periodEnd: AS_OF,
      value: 40_000,
      state: "available",
    }],
    deliveriesByDay: Array.from({ length: 30 }, (_, index) => ({
      day: new Date(Date.UTC(2026, 6, 20 + index)).toISOString().slice(0, 10),
      delivered: index === 29 ? 3 : 0,
      failed: index === 29 ? 2 : 0,
    })),
    textingRegistrationByTenant: [{
      tenantId: "tenant-synthetic",
      registrationState: "awaiting_provider",
      submittedAt: "2026-08-16T12:00:00.000Z",
      daysElapsed: 2,
    }],
  };
}

describe("platform measurement repository", () => {
  it("uses real analytics in production even when the demo preview flags are on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SETTERFI_PHASE7_LIVE", "true");
    vi.stubEnv("SETTERFI_PHASE7_ANALYTICS_LIVE", "true");
    vi.stubEnv("SETTERFI_DEMO_LOGINS", "true");
    vi.stubEnv("SETTERFI_PLATFORM_PREVIEW_DATA", "true");
    rpc.mockResolvedValue({ data: snapshot(), error: null });

    await expect(platformMeasurementSource(ACTOR, AS_OF)).resolves.toMatchObject({
      origin: "real_analytics",
      snapshot: expect.any(Object),
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("read_platform_measurement_for_actor", {
      p_actor_id: ACTOR,
      p_as_of: AS_OF,
      p_history_periods: 12,
    });
  });

  it("reports real analytics as unavailable instead of falling back to synthetic preview", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SETTERFI_PHASE7_LIVE", "true");
    vi.stubEnv("SETTERFI_PHASE7_ANALYTICS_LIVE", "true");
    vi.stubEnv("SETTERFI_DEMO_LOGINS", "true");
    vi.stubEnv("SETTERFI_PLATFORM_PREVIEW_DATA", "true");
    rpc.mockResolvedValue({ data: null, error: { message: "database unavailable" } });

    await expect(platformMeasurementSource(ACTOR, AS_OF)).rejects.toMatchObject({
      code: "PLATFORM_MEASUREMENT_UNAVAILABLE",
      state: "unavailable",
      source: "real_analytics",
    } satisfies Partial<PlatformMeasurementUnavailableError>);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("read_platform_measurement_for_actor", expect.any(Object));
  });

  it("uses and labels the synthetic preview only on a non-production review deployment", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("SETTERFI_PHASE7_LIVE", "true");
    vi.stubEnv("SETTERFI_PHASE7_ANALYTICS_LIVE", "true");
    vi.stubEnv("SETTERFI_DEMO_LOGINS", "true");
    vi.stubEnv("SETTERFI_PLATFORM_PREVIEW_DATA", "true");
    rpc.mockResolvedValue({ data: snapshot(), error: null });

    await expect(platformMeasurementSource(ACTOR, AS_OF)).resolves.toMatchObject({
      origin: "synthetic_preview",
      snapshot: { asOf: AS_OF },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("read_platform_measurement_preview_for_actor", {
      p_actor_id: ACTOR,
    });
  });

  it("accepts only the exact RPC snapshot and every exact row field", async () => {
    const source = vi.fn(async () => snapshot());
    const result = await loadPlatformMeasurement(ACTOR, AS_OF, source);

    expect(source).toHaveBeenCalledWith(ACTOR, AS_OF);
    expect(Object.keys(result).sort()).toEqual([
      "activeSubscriptionsByPeriod", "asOf", "deliveriesByDay", "followupPerformance",
      "guardrailRules", "history", "metrics", "origin", "provisioningPerformance",
      "revenueByPeriod", "subscriptions", "tenantPerformance", "textingRegistrationByTenant",
    ]);
    expect(result.origin).toBe("real_analytics");
    expect(result.metrics.map((row) => row.metricKey)).toEqual(PLATFORM_METRIC_KEYS);
    expect(Object.keys(result.subscriptions[0]).sort()).toEqual([
      "periodEnd", "periodStart", "status", "stripePriceId", "subscriptionId", "tenantId",
    ]);
    expect(Object.keys(result.tenantPerformance[0]).sort()).toEqual([
      "bookedAppointments", "commissionCents", "grossMrrCents", "marginCents", "marginState",
      "tenantId",
    ]);
    expect(Object.keys(result.guardrailRules[0]).sort()).toEqual([
      "blocks", "fires", "holds", "label", "ruleKey",
    ]);
    expect(Object.keys(result.followupPerformance[0]).sort()).toEqual([
      "crossChannel", "exhausted", "replied", "sent", "touchNo",
    ]);
    expect(Object.keys(result.provisioningPerformance[0]).sort()).toEqual([
      "attempts", "failures", "medianDaysToClear", "state", "stepKey",
    ]);
    expect(result.activeSubscriptionsByPeriod.map((row) => row.value)).toEqual([3, 4]);
    expect(result.revenueByPeriod.map((row) => row.value)).toEqual([30_000, 40_000]);
    expect(result.deliveriesByDay).toHaveLength(30);
    expect(result.deliveriesByDay.at(-1)).toEqual({ day: "2026-08-18", delivered: 3, failed: 2 });
    expect(result.textingRegistrationByTenant).toEqual([{
      tenantId: "tenant-synthetic",
      registrationState: "awaiting_provider",
      submittedAt: "2026-08-16T12:00:00.000Z",
      daysElapsed: 2,
    }]);
  });

  it("carries the database's test-excluded delivery series and UTC registration clock unchanged", async () => {
    const result = await loadPlatformMeasurement(ACTOR, AS_OF, async () => snapshot());

    // The SQL projection removes test notifications before emitting this series; this repository
    // accepts that closed evidence and never performs a second client-side filter or date clock.
    expect(result.deliveriesByDay.filter((row) => row.day === "2026-08-18")).toEqual([
      { day: "2026-08-18", delivered: 3, failed: 2 },
    ]);
    expect(result.textingRegistrationByTenant[0]?.daysElapsed).toBe(2);
  });

  it("accepts the same instant in Postgres spelling, and still rejects a different instant", async () => {
    // The RPC serializes timestamptz as +00:00 while the page requests with a trailing Z.
    // Same moment, different spelling - the honesty check is about the instant, not the string.
    const postgresSpelling = { ...snapshot(), asOf: "2026-08-18T12:00:00+00:00" };
    const result = await loadPlatformMeasurement(ACTOR, AS_OF, async () => postgresSpelling);
    expect(result.asOf).toBe(AS_OF);

    const differentInstant = { ...snapshot(), asOf: "2026-08-18T12:00:01.000Z" };
    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => differentInstant))
      .rejects.toThrow("PLATFORM_MEASUREMENT_AS_OF_MISMATCH");
  });

  it("preserves an explicitly labelled synthetic preview without changing plain RPC fixtures", async () => {
    const result = await loadPlatformMeasurement(ACTOR, AS_OF, async () => ({
      origin: "synthetic_preview",
      snapshot: snapshot(),
    }));
    expect(result.origin).toBe("synthetic_preview");

    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => ({
      origin: "unlabelled",
      snapshot: snapshot(),
    }))).rejects.toThrow("PLATFORM_MEASUREMENT_SOURCE_INVALID");
  });

  it("rejects missing arrays and unexpected metric keys before rendering", async () => {
    const missing = snapshot() as Record<string, unknown>;
    delete missing.guardrailRules;
    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => missing))
      .rejects.toThrow("PLATFORM_MEASUREMENT_SNAPSHOT_INVALID");

    const widened = snapshot();
    widened.metrics[0] = { ...widened.metrics[0], metricKey: "eval.suite_pass_rate" } as never;
    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => widened))
      .rejects.toThrow("PLATFORM_METRIC_SET_INVALID");
  });

  it("carries an unavailable margin through rather than taking the whole page down", async () => {
    // A margin projection only exists once Phase 6 has a complete cost rollup, so on a platform
    // that has never had one the row is honestly unavailable. The row is self-describing; a
    // second veto in the loader only turned an empty state into a crash.
    const metricAbsent = snapshot();
    const index = metricAbsent.metrics.findIndex((row) => row.metricKey === "platform.margin");
    metricAbsent.metrics[index] = {
      ...metricAbsent.metrics[index],
      numerator: null,
      denominator: 0,
      value: null,
      state: "unavailable",
    } as never;
    const result = await loadPlatformMeasurement(ACTOR, AS_OF, async () => metricAbsent);
    expect(result.metrics[index]).toMatchObject({
      metricKey: "platform.margin",
      value: null,
      state: "unavailable",
    });

    const claimed = snapshot();
    claimed.metrics[index] = { ...claimed.metrics[index], value: null } as never;
    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => claimed))
      .rejects.toThrow("MEASUREMENT_AVAILABLE_VALUE_REQUIRED");
  });

  it("renders a tenant with no margin projection instead of refusing the whole table", async () => {
    // The RPC emits this the moment a coach signs up before their first cost rollup, and the
    // surface already branches on marginState - only the repository type forced "available".
    const unavailable = snapshot();
    unavailable.tenantPerformance[0] = {
      ...unavailable.tenantPerformance[0],
      marginCents: null,
      marginState: "unavailable",
    } as never;
    const result = await loadPlatformMeasurement(ACTOR, AS_OF, async () => unavailable);
    expect(result.tenantPerformance[0]).toMatchObject({
      marginCents: null,
      marginState: "unavailable",
    });

    const incoherent = snapshot();
    incoherent.tenantPerformance[0] = {
      ...incoherent.tenantPerformance[0],
      marginCents: null,
    } as never;
    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => incoherent))
      .rejects.toThrow("PLATFORM_MARGIN_EVIDENCE_INCOMPLETE");

    const unknownState = snapshot();
    unknownState.tenantPerformance[0] = {
      ...unknownState.tenantPerformance[0],
      marginState: "still_filling",
    } as never;
    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => unknownState))
      .rejects.toThrow("PLATFORM_TENANT_PERFORMANCE_INVALID");
  });

  it("renders a tenant with no priced subscription rather than refusing the whole table", async () => {
    // grossMrrCents comes off a left join lateral against the subscription price, so it is null
    // for any tenant without an active priced subscription - the same day-one shape as the margin.
    const unpriced = snapshot();
    unpriced.tenantPerformance[0] = {
      ...unpriced.tenantPerformance[0],
      grossMrrCents: null,
    } as never;
    const result = await loadPlatformMeasurement(ACTOR, AS_OF, async () => unpriced);
    expect(result.tenantPerformance[0]).toMatchObject({ grossMrrCents: null });
  });

  it("accepts a signup series longer than two periods and keeps its order", async () => {
    // The RPC emits N contiguous 30-day periods (20260914000001). The repository used to refuse
    // any length but two, which is why the Overview could only ever draw two bars.
    const series = snapshot();
    series.history = [
      { periodStart: "2026-03-22T12:00:00.000Z", periodEnd: "2026-04-21T12:00:00.000Z", value: 0, state: "needs_more_history" },
      { periodStart: "2026-04-21T12:00:00.000Z", periodEnd: "2026-05-21T12:00:00.000Z", value: 1, state: "available" },
      { periodStart: "2026-05-21T12:00:00.000Z", periodEnd: "2026-06-19T12:00:00.000Z", value: 3, state: "available" },
      { periodStart: "2026-06-19T12:00:00.000Z", periodEnd: "2026-07-19T12:00:00.000Z", value: 4, state: "available" },
      { periodStart: "2026-07-19T12:00:00.000Z", periodEnd: AS_OF, value: 5, state: "available" },
    ];

    const result = await loadPlatformMeasurement(ACTOR, AS_OF, async () => series);
    expect(result.history.map((row) => row.value)).toEqual([0, 1, 3, 4, 5]);
  });

  it("refuses a series with a gap between two periods", async () => {
    const gapped = snapshot();
    gapped.history = [
      { periodStart: "2026-05-21T12:00:00.000Z", periodEnd: "2026-06-19T12:00:00.000Z", value: 3, state: "available" },
      // A day missing between the periods is a slope across time nobody measured.
      { periodStart: "2026-06-20T12:00:00.000Z", periodEnd: "2026-07-19T12:00:00.000Z", value: 4, state: "available" },
      { periodStart: "2026-07-19T12:00:00.000Z", periodEnd: AS_OF, value: 5, state: "available" },
    ];

    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => gapped))
      .rejects.toThrow("PLATFORM_HISTORY_INVALID");
  });

  it("still refuses a single-period history, because one point is not a trend", async () => {
    const single = snapshot();
    single.history = [
      { periodStart: "2026-07-19T12:00:00.000Z", periodEnd: AS_OF, value: 5, state: "available" },
    ];

    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => single))
      .rejects.toThrow("PLATFORM_HISTORY_INVALID");
  });

  it("rejects history with no count and zero metric denominators", async () => {
    // Rewritten, not weakened. This case used to assert that a `needs_more_history` row carrying
    // a value of 0 was refused - and the hosted RPC emits exactly that row for the previous
    // period whenever there were no signups in it (20260823000001:503-505), which is why
    // /admin/overview died on an empty platform even after the metric policy was fixed. The
    // state describes how much history stands behind the growth comparison; the count of zero
    // is a real count over a real period. What stays refused is a row that names a period and
    // then supplies no number for it, because the chart would draw a gap it cannot explain.
    const history = snapshot();
    history.history[0] = { ...history.history[0], state: "needs_more_history", value: null } as never;
    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => history))
      .rejects.toThrow("PLATFORM_HISTORY_INVALID");

    const unknown = snapshot();
    unknown.history[0] = { ...unknown.history[0], state: "unavailable", value: 0 } as never;
    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => unknown))
      .rejects.toThrow("PLATFORM_HISTORY_UNAVAILABLE");

    // A rate still cannot be rendered over nobody. The metric moved from index 0 to a percent
    // key because a count of zero over zero is now evidence the platform genuinely has none.
    const zero = snapshot();
    const rate = zero.metrics.findIndex((row) => row.metricKey === "platform.churn_rate");
    zero.metrics[rate] = { ...zero.metrics[rate], numerator: 0, denominator: 0, value: 0 };
    await expect(loadPlatformMeasurement(ACTOR, AS_OF, async () => zero))
      .rejects.toThrow("MEASUREMENT_DENOMINATOR_REQUIRED");
  });

  it("preserves an empty resolved-identity denominator as unavailable evidence", async () => {
    const empty = snapshot();
    const index = empty.metrics.findIndex(
      (row) => row.metricKey === "platform.cross_channel_continuation_rate",
    );
    empty.metrics[index] = {
      ...empty.metrics[index],
      numerator: 0,
      denominator: 0,
      value: null,
      state: "unavailable",
    } as never;

    const result = await loadPlatformMeasurement(ACTOR, AS_OF, async () => empty);
    expect(result.metrics[index]).toMatchObject({
      metricKey: "platform.cross_channel_continuation_rate",
      numerator: 0,
      denominator: 0,
      value: null,
      state: "unavailable",
    });
  });

  it("refuses a missing or blank reader before it reaches the network", async () => {
    const source = vi.fn(async () => snapshot());
    for (const actor of [undefined, null, "", "   "]) {
      await expect(loadPlatformMeasurement(actor as never, AS_OF, source))
        .rejects.toThrow("MEASUREMENT_ACTOR_REQUIRED");
    }
    expect(source).not.toHaveBeenCalled();
  });

  it("contains no protected base, provider, or fixture read path", async () => {
    const source = await readFile(new URL("./platform-analytics.ts", import.meta.url), "utf8");
    expect(source).toContain('client.rpc("read_platform_measurement_for_actor"');
    expect(source).toContain("p_actor_id: actor");
    expect(source).not.toMatch(/\.from\s*\(/u);
    expect(source).not.toMatch(/fetch\s*\(/u);
    expect(source).not.toMatch(/from\s+["']stripe["']/u);
    expect(source).not.toMatch(/workspace-fixtures|admin-demo-feedback-fixtures/u);
  });
});

// Exactly what the hosted RPC returns for a platform with no coaches: counts sourced at zero,
// rates with nobody to divide by, and the two money rows whose projection does not exist yet.
const NULL_NUMERATOR_METRICS = ["platform.gross_mrr", "platform.ltv", "platform.margin"];
const NEEDS_HISTORY_METRICS = [
  "platform.growth_rate",
  "platform.time_to_live",
  "platform.a2p_median_days_to_clear",
];

function emptyMetric(key: MetricKey) {
  const definition = metricDefinition(key);
  const numeratorIsNull = NULL_NUMERATOR_METRICS.includes(key);
  if (definition.requiresPositiveDenominator || numeratorIsNull) {
    return {
      metricKey: key,
      numerator: numeratorIsNull ? null : 0,
      denominator: 0,
      value: null,
      state: NEEDS_HISTORY_METRICS.includes(key) ? "needs_more_history" : "unavailable",
    };
  }
  return { metricKey: key, numerator: 0, denominator: 0, value: 0, state: "available" };
}

function emptyPlatform() {
  return {
    asOf: AS_OF,
    metrics: PLATFORM_METRIC_KEYS.map(emptyMetric),
    subscriptions: [],
    tenantPerformance: [],
    guardrailRules: [],
    followupPerformance: [],
    provisioningPerformance: [],
    // Verbatim from the hosted project on 2026-08-20: the previous period reads
    // needs_more_history because nothing signed up in it, and it still carries its real count.
    history: [{
      periodStart: "2026-06-19T12:00:00.000Z",
      periodEnd: "2026-07-19T12:00:00.000Z",
      value: 0,
      state: "needs_more_history",
    }, {
      periodStart: "2026-07-19T12:00:00.000Z",
      periodEnd: AS_OF,
      value: 0,
      state: "available",
    }],
    activeSubscriptionsByPeriod: [{
      periodStart: "2026-06-19T12:00:00.000Z",
      periodEnd: "2026-07-19T12:00:00.000Z",
      value: 0,
      state: "available",
    }, {
      periodStart: "2026-07-19T12:00:00.000Z",
      periodEnd: AS_OF,
      value: 0,
      state: "available",
    }],
    revenueByPeriod: [{
      periodStart: "2026-06-19T12:00:00.000Z",
      periodEnd: "2026-07-19T12:00:00.000Z",
      value: 0,
      state: "needs_more_history",
    }, {
      periodStart: "2026-07-19T12:00:00.000Z",
      periodEnd: AS_OF,
      value: 0,
      state: "needs_more_history",
    }],
    deliveriesByDay: Array.from({ length: 30 }, (_, index) => ({
      day: new Date(Date.UTC(2026, 6, 20 + index)).toISOString().slice(0, 10),
      delivered: 0,
      failed: 0,
    })),
    textingRegistrationByTenant: [],
  };
}

describe("the platform on the day it launches with no coaches", () => {
  it("parses the whole empty snapshot rather than refusing an honest zero", async () => {
    const result = await loadPlatformMeasurement(ACTOR, AS_OF, async () => emptyPlatform());

    expect(result.metrics).toHaveLength(PLATFORM_METRIC_KEYS.length);
    expect(result.metrics.find((row) => row.metricKey === "platform.new_signups"))
      .toMatchObject({ value: 0, state: "available" });
    expect(result.metrics.find((row) => row.metricKey === "platform.margin"))
      .toMatchObject({ value: null, numerator: null, state: "unavailable" });
    expect(result.metrics.find((row) => row.metricKey === "platform.churn_rate"))
      .toMatchObject({ value: null, state: "unavailable" });
    expect(result.subscriptions).toEqual([]);
    expect(result.tenantPerformance).toEqual([]);
    expect(result.history.map((row) => row.value)).toEqual([0, 0]);
    expect(result.history.map((row) => row.state)).toEqual(["needs_more_history", "available"]);
    expect(result.activeSubscriptionsByPeriod.map((row) => row.value)).toEqual([0, 0]);
    expect(result.revenueByPeriod.map((row) => row.state))
      .toEqual(["needs_more_history", "needs_more_history"]);
  });
});
