import { describe, expect, it } from "vitest";

import {
  PLATFORM_METRIC_KEYS,
  metricDefinition,
  type MetricEvidence,
} from "@/lib/analytics/metric-definitions";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";

import {
  ADMIN_MEASUREMENT_KPI_KEYS,
  SUCCESS_RESTRICTED_METRIC_KEYS,
  adminMeasurementView,
  platformMetricDisplay,
  provisioningStateLabel,
} from "./admin-measurement-view-models";

function metric(key: (typeof PLATFORM_METRIC_KEYS)[number]): MetricEvidence {
  const definition = metricDefinition(key);
  return {
    metricKey: key,
    numerator: 5,
    denominator: definition.requiresPositiveDenominator ? 10 : null,
    value: definition.unit === "cents" ? 30_000 : definition.unit === "percent" ? 50 : 5,
    state: "available",
    windowStart: "2026-07-19T12:00:00.000Z",
    windowEnd: "2026-08-18T12:00:00.000Z",
  };
}

function snapshot() {
  return {
    asOf: "2026-08-18T12:00:00.000Z",
    metrics: PLATFORM_METRIC_KEYS.map(metric),
    subscriptions: [{
      tenantId: "tenant-other",
      subscriptionId: "subscription-synthetic",
      status: "active",
      stripePriceId: "price-synthetic",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
    }],
    tenantPerformance: [{
      tenantId: "tenant-other",
      bookedAppointments: 5,
      grossMrrCents: 30_000,
      commissionCents: 3_000,
      marginCents: 20_000,
      marginState: "available",
    }],
    guardrailRules: [{ ruleKey: "guarantee", label: "Guarantee", fires: 10, blocks: 4, holds: 2 }],
    followupPerformance: [{ touchNo: 1, sent: 10, replied: 4, crossChannel: 2, exhausted: 1 }],
    provisioningPerformance: [{
      stepKey: "a2p_campaign",
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
      periodEnd: "2026-08-18T12:00:00.000Z",
      value: 5,
      state: "available",
    }],
    activeSubscriptionsByPeriod: [],
    revenueByPeriod: [],
    deliveriesByDay: [],
    textingRegistrationByTenant: [],
  } satisfies PlatformMeasurement;
}

function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...nestedKeys(child)]);
}

/**
 * The snapshot instant as a descriptor prints it: the fixture's `asOf` in UTC, which is the clock
 * every definition carrying the token declares beside it.
 */
const AS_OF_LABEL = "Aug 18, 2026, 12:00 PM UTC";

/** The definition's own sentence with the parameter name resolved, which is what a reader gets. */
function resolved(text: string) {
  return text.replaceAll(/\basOf\b/gu, AS_OF_LABEL);
}

describe("admin measurement view", () => {
  it("renders the exact platform KPI set with register-derived descriptors", () => {
    const view = adminMeasurementView(snapshot(), "owner");
    expect(view.metrics.map((row) => row.key)).toEqual(ADMIN_MEASUREMENT_KPI_KEYS);
    expect(ADMIN_MEASUREMENT_KPI_KEYS).toEqual(PLATFORM_METRIC_KEYS);
    for (const row of view.metrics) {
      const definition = metricDefinition(row.key);
      expect(row.label).toBe(definition.label);
      const denominator = resolved(definition.denominator);
      const window = resolved(definition.window);
      const clock = resolved(definition.clock);
      expect(row.descriptor).toEqual({
        denominator,
        window,
        clock,
        text: `Denominator: ${denominator} Window: ${window} Clock: ${clock}`,
      });
    }
  });

  /**
   * The measurement vocabulary writes its windows against the RPC argument -- "Trailing 30 days
   * ending at asOf" -- which is right in that file and a leaked identifier on a screen.
   * `/admin/agent-performance` printed exactly that sentence under its heading until 2026-09-01.
   *
   * The check is on the projection because that is where the substitution happens, so no surface
   * can render a descriptor that skipped it, and it names the token rather than one sentence: the
   * definitions carry it in twenty-one windows and a new metric will carry it in the next one.
   */
  it("resolves the measurement instant instead of printing the parameter that holds it", () => {
    const view = adminMeasurementView(snapshot(), "owner");

    // The positive control: without a definition that actually carries the token, the sweep below
    // would pass on a projection that substitutes nothing.
    const carriers = view.metrics.filter((row) => /\basOf\b/u.test(metricDefinition(row.key).window));
    expect(carriers.length, "no platform definition names asOf, so nothing was substituted")
      .toBeGreaterThan(0);

    for (const row of view.metrics) {
      const fields = [
        row.descriptor.denominator,
        row.descriptor.window,
        row.descriptor.clock,
        row.descriptor.text,
      ];
      for (const field of fields) expect(field).not.toMatch(/\basOf\b/u);
    }
    for (const row of carriers) expect(row.descriptor.window).toContain(AS_OF_LABEL);
  });

  /**
   * An instant that will not parse leaves the sentence as the vocabulary wrote it rather than
   * printing "Invalid Date" under a heading that claims to say when the numbers were measured.
   */
  it("leaves the window unresolved rather than inventing a date it could not read", () => {
    const view = adminMeasurementView({ ...snapshot(), asOf: "not-an-instant" }, "owner");
    const booked = view.metrics.find((row) => row.key === "platform.booked_appointments");
    expect(booked?.descriptor.window).toBe(metricDefinition("platform.booked_appointments").window);
  });

  /*
   * One cancellation in twenty-four accounts is 4.166666666666667 percent, and the card printed
   * every digit of it and overflowed. The stored preview snapshot hid this for months because its
   * values were written already rounded, so the defect only appeared once the console read the
   * real projection.
   */
  it("rounds a rate to one decimal instead of printing the raw quotient", () => {
    const evidence = snapshot();
    evidence.metrics = evidence.metrics.map((row) =>
      row.metricKey === "platform.churn_rate"
        ? { ...row, numerator: 1, denominator: 24, value: (1 / 24) * 100 }
        : row);
    const view = adminMeasurementView(evidence, "owner");
    const churn = view.metrics.find((row) => row.key === "platform.churn_rate");

    expect(churn?.value).toBe("4.2%");
  });

  it("keeps gross MRR and commission separate while history gaps remain nonnumeric", () => {
    const evidence = snapshot();
    const commissionIndex = evidence.metrics.findIndex(
      (row) => row.metricKey === "platform.affiliate_commission",
    );
    evidence.metrics[commissionIndex] = { ...evidence.metrics[commissionIndex], value: 3_000 };
    for (const key of [
      "platform.churn_rate",
      "platform.ltv",
      "platform.average_retention",
      "platform.growth_rate",
    ] as const) {
      const index = evidence.metrics.findIndex((row) => row.metricKey === key);
      evidence.metrics[index] = {
        ...evidence.metrics[index],
        numerator: null,
        denominator: null,
        value: null,
        state: "needs_more_history",
      };
    }
    const view = adminMeasurementView(evidence, "owner");
    expect(view.metrics.find((row) => row.key === "platform.gross_mrr")?.value).toBe("$300");
    expect(view.metrics.find((row) => row.key === "platform.affiliate_commission")?.value).toBe("$30");
    for (const key of [
      "platform.churn_rate",
      "platform.ltv",
      "platform.average_retention",
      "platform.growth_rate",
    ] as const) {
      const row = view.metrics.find((metricRow) => metricRow.key === key);
      expect(row).toMatchObject({ value: null, absenceLabel: "Needs more history" });
      expect(platformMetricDisplay(row!)).toBe("Needs more history");
    }
  });

  /**
   * A field nobody admitted must not arrive, in any collection and for any role.
   *
   * The key-set assertions below pin `tenantPerformance` and `subscriptions`, which were the two
   * collections rebuilt field by field; the other four were spread, so a new field on a guardrail
   * rule or a history period reached a success reviewer without this function changing and without
   * anyone re-asking the audience question. Types cannot catch that -- the row arrives from an RPC
   * at runtime, so a column added upstream is present long before the type mentions it. This plants
   * exactly that: an economics field the projection was never told about, on all six collections.
   */
  it("admits no field the projection was not told about, in any collection", () => {
    const contaminate = <T,>(rows: readonly T[]): readonly T[] =>
      rows.map((row) => ({ ...row, marginCents: 4200, costPerBooking: 7 }));
    const base = snapshot();
    const contaminated = {
      ...base,
      subscriptions: contaminate(base.subscriptions),
      tenantPerformance: contaminate(base.tenantPerformance),
      guardrailRules: contaminate(base.guardrailRules),
      followupPerformance: contaminate(base.followupPerformance),
      provisioningPerformance: contaminate(base.provisioningPerformance),
      history: contaminate(base.history),
    };

    for (const role of ["owner", "admin", "success"] as const) {
      const view = adminMeasurementView(contaminated, role);
      for (const collection of [
        "subscriptions",
        "tenantPerformance",
        "guardrailRules",
        "followupPerformance",
        "provisioningPerformance",
        "history",
      ] as const) {
        for (const row of view[collection]) {
          expect(
            Object.keys(row),
            `${collection} passed an unadmitted field through to a ${role} reader`,
          ).not.toEqual(expect.arrayContaining(["marginCents", "costPerBooking"]));
        }
      }
    }
  });

  it("omits every economics metric and tenant economics field from success serialization", () => {
    const view = adminMeasurementView(snapshot(), "success");
    const metricKeys = view.metrics.map((row) => row.key);
    for (const key of PLATFORM_METRIC_KEYS.filter((candidate) => metricDefinition(candidate).economics !== "none")) {
      expect(metricKeys).not.toContain(key);
    }
    for (const key of SUCCESS_RESTRICTED_METRIC_KEYS) expect(metricKeys).not.toContain(key);
    expect(Object.keys(view.tenantPerformance[0]).sort()).toEqual([
      "bookedAppointments",
      "tenantId",
    ]);
    expect(Object.keys(view.subscriptions[0]).sort()).toEqual([
      "periodEnd",
      "periodStart",
      "status",
      "tenantId",
    ]);
    expect(nestedKeys(view)).not.toEqual(expect.arrayContaining([
      "grossMrrCents",
      "commissionCents",
      "marginCents",
      "marginState",
      "stripePriceId",
    ]));
  });

  it("refuses every non-platform role before a cross-tenant row can be projected", () => {
    for (const role of ["coach", "coach_member", "affiliate", "build"] as const) {
      expect(() => adminMeasurementView(snapshot(), role)).toThrow("PLATFORM_MEASUREMENT_ROLE_FORBIDDEN");
    }
  });

  it("changes missing evidence from a number to its exact nonnumeric state", () => {
    const missing = snapshot();
    const churnIndex = missing.metrics.findIndex((row) => row.metricKey === "platform.churn_rate");
    missing.metrics[churnIndex] = {
      ...missing.metrics[churnIndex],
      numerator: null,
      denominator: null,
      value: null,
      state: "needs_more_history",
    };
    const view = adminMeasurementView(missing, "admin");
    const churn = view.metrics.find((row) => row.key === "platform.churn_rate");
    expect(churn).toMatchObject({ value: null, absenceLabel: "Needs more history" });
    expect(platformMetricDisplay(churn!)).toBe("Needs more history");
    // The absent mark, named rather than spliced into the alternation: see the note in
    // `src/app/em-dash.test.ts` on why an escaped dash is held to the same standing-alone rule.
    const emRule = "\u2014";
    expect(platformMetricDisplay(churn!)).not.toMatch(new RegExp(`0|${emRule}|-`, "u"));
  });

  it("keeps operational row keys exact and A2P state copy honest", () => {
    const view = adminMeasurementView(snapshot(), "success");
    expect(Object.keys(view.guardrailRules[0]).sort()).toEqual([
      "blocks", "fires", "holds", "label", "ruleKey",
    ]);
    expect(Object.keys(view.followupPerformance[0]).sort()).toEqual([
      "crossChannel", "exhausted", "replied", "sent", "touchNo",
    ]);
    expect(Object.keys(view.provisioningPerformance[0]).sort()).toEqual([
      "attempts", "failures", "medianDaysToClear", "state", "stepKey",
    ]);
    expect(provisioningStateLabel("a2p_campaign", "awaiting_provider"))
      .toBe("Registering · carrier review takes 2–3 weeks");
    expect(provisioningStateLabel("a2p_campaign", "blocked")).toBe("Permanently blocked");
    expect(provisioningStateLabel("a2p_campaign", "awaiting_provider")).not.toMatch(/%|all set|1–2 weeks/iu);
  });
});

describe("the admin surfaces on an empty platform", () => {
  function withUnavailableMargin(): PlatformMeasurement {
    const raw = snapshot();
    return {
      ...raw,
      metrics: raw.metrics.map((row) => (row.metricKey === "platform.margin"
        ? { ...row, numerator: null, denominator: 0, value: null, state: "unavailable" as const }
        : row)),
      tenantPerformance: [{
        tenantId: "tenant-other",
        bookedAppointments: 0,
        grossMrrCents: 0,
        commissionCents: 0,
        marginCents: null,
        marginState: "unavailable" as const,
      }],
    };
  }

  it("renders the margin tile as Unavailable for an owner rather than a number", () => {
    const view = adminMeasurementView(withUnavailableMargin(), "owner");
    const margin = view.metrics.find((row) => row.key === "platform.margin");
    expect(margin).toMatchObject({ value: null, absenceLabel: "Unavailable" });
    expect(platformMetricDisplay(margin!)).toBe("Unavailable");
  });

  it("keeps the margin off a success user entirely, unavailable or not", () => {
    const view = adminMeasurementView(withUnavailableMargin(), "success");
    expect(view.metrics.some((row) => SUCCESS_RESTRICTED_METRIC_KEYS.includes(row.key as never)))
      .toBe(false);
    expect(nestedKeys(view)).not.toContain("marginState");
    expect(nestedKeys(view)).not.toContain("marginCents");
  });

  it("carries a tenant row with no margin projection through to the table", () => {
    const view = adminMeasurementView(withUnavailableMargin(), "owner");
    expect(view.tenantPerformance[0]).toMatchObject({
      marginCents: null,
      marginState: "unavailable",
    });
  });
});
