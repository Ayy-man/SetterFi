import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The empty-snapshot branch renders the kit's DataState, which reaches for the app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  PLATFORM_METRIC_KEYS,
  metricDefinition,
  type MetricEvidence,
} from "@/lib/analytics/metric-definitions";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";

import {
  AdminAgentPerformanceSurface,
  MEASURES,
  MIN_BASELINE_ROWS,
  baselineMedian,
  comparableRows,
  deltaTone,
  evidenceTintedRows,
  followupReplyRates,
  type Measure,
  type PerformanceRow,
} from "./admin-agent-performance";
import {
  adminMeasurementView,
  type PlatformMeasurementRole,
} from "./admin-measurement-view-models";

type TenantRow = PlatformMeasurement["tenantPerformance"][number];

const NORTHSTAR: TenantRow = {
  tenantId: "tenant-northstar",
  bookedAppointments: 11,
  grossMrrCents: 149_700,
  commissionCents: 8_982,
  marginCents: 96_400,
  marginState: "available",
};

const SUMMIT: TenantRow = {
  tenantId: "tenant-summit",
  bookedAppointments: 5,
  grossMrrCents: null,
  commissionCents: 2_982,
  marginCents: null,
  marginState: "unavailable",
};

/** A third client, so the median has enough rows to exist. */
const RIDGE: TenantRow = {
  tenantId: "tenant-ridge",
  bookedAppointments: 2,
  grossMrrCents: 49_900,
  commissionCents: 1_200,
  marginCents: 21_000,
  marginState: "available",
};

const CLIENT_NAMES = {
  "tenant-northstar": "Northstar Capital (demo)",
  "tenant-summit": "Summit Funding (demo)",
  "tenant-ridge": "Ridge Lending (demo)",
} as const;

const FOLLOWUPS: PlatformMeasurement["followupPerformance"] = [
  { touchNo: 1, sent: 800, replied: 240, crossChannel: 40, exhausted: 0 },
  { touchNo: 2, sent: 500, replied: 90, crossChannel: 20, exhausted: 0 },
  { touchNo: 3, sent: 0, replied: 0, crossChannel: 0, exhausted: 0 },
];

/** The page projects on the server; the surface only ever sees the projected view. */
function renderSurface(
  role: PlatformMeasurementRole,
  tenantPerformance: readonly TenantRow[] = [NORTHSTAR, SUMMIT],
  followupPerformance: PlatformMeasurement["followupPerformance"] = FOLLOWUPS,
) {
  const snapshot = measurement(tenantPerformance, followupPerformance);
  return render(
    <AdminAgentPerformanceSurface
      clientNames={CLIENT_NAMES}
      origin={snapshot.origin}
      view={adminMeasurementView(snapshot, role)}
    />,
  );
}

function metric(key: (typeof PLATFORM_METRIC_KEYS)[number]): MetricEvidence {
  const definition = metricDefinition(key);
  const value =
    definition.unit === "cents"
      ? 30_000
      : definition.unit === "percent"
        ? 50
        : definition.unit === "seconds"
          ? 120
          : 5;
  return {
    metricKey: key,
    numerator: value,
    denominator: definition.requiresPositiveDenominator ? 10 : null,
    value,
    state: "available",
    windowStart: "2026-07-25T12:00:00.000Z",
    windowEnd: "2026-08-24T12:00:00.000Z",
  };
}

function measurement(
  tenantPerformance: readonly TenantRow[],
  followupPerformance: PlatformMeasurement["followupPerformance"] = FOLLOWUPS,
): PlatformMeasurement {
  return {
    origin: "synthetic_preview",
    asOf: "2026-08-24T12:00:00.000Z",
    metrics: PLATFORM_METRIC_KEYS.map(metric),
    subscriptions: [],
    tenantPerformance,
    guardrailRules: [],
    followupPerformance,
    provisioningPerformance: [],
    history: [],
  };
}

function row(overrides: Partial<PerformanceRow> & { tenantId: string }): PerformanceRow {
  return {
    client: overrides.tenantId,
    bookedAppointments: 0,
    ...overrides,
  };
}

const BOOKED = MEASURES[0] as Measure;

describe("the measure contract", () => {
  it("ranks a total without asking for a denominator", () => {
    const { ranked, withheld, absent } = comparableRows(BOOKED, [
      row({ tenantId: "a", bookedAppointments: 4 }),
      row({ tenantId: "b", bookedAppointments: 40 }),
    ]);
    expect(ranked.map((entry) => entry.row.tenantId)).toEqual(["b", "a"]);
    expect(withheld).toHaveLength(0);
    expect(absent).toHaveLength(0);
  });

  it("keeps a row with no value out of the ranking rather than reading it as zero", () => {
    const margin = MEASURES.find((measure) => measure.key === "margin") as Measure;
    const { ranked, absent } = comparableRows(margin, [
      row({ tenantId: "a", marginCents: 500 }),
      row({ tenantId: "b", marginCents: null }),
    ]);
    expect(ranked.map((entry) => entry.row.tenantId)).toEqual(["a"]);
    expect(absent.map((entry) => entry.tenantId)).toEqual(["b"]);
  });

  /**
   * The brief's chart-that-lies, run against the contract directly: a perfect rate over four leads
   * must not outrank a good rate over three hundred. It is withheld from the ranking and keeps its
   * denominator, rather than being placed at rank 01.
   */
  it("withholds a rate over too small a population from the ranking", () => {
    const bookingRate: Measure = {
      key: "booked",
      kind: "rate",
      label: "Booking rate",
      overline: "Booking",
      economics: false,
      emptyLabel: "No leads recorded",
      value: (candidate) => (candidate.commissionCents ?? 0) / (candidate.bookedAppointments || 1),
      format: (value) => `${Math.round(value * 100)}%`,
      formatDelta: (delta) => `${delta > 0 ? "+" : "−"}${Math.abs(Math.round(delta * 100))}pts`,
      denominator: (candidate) => candidate.bookedAppointments,
      denominatorLabel: "leads",
      minDenominator: 30,
    };
    const tiny = row({ tenantId: "tiny", bookedAppointments: 4, commissionCents: 4 });
    const large = row({ tenantId: "large", bookedAppointments: 300, commissionCents: 132 });

    const { ranked, withheld } = comparableRows(bookingRate, [tiny, large]);
    expect(ranked.map((entry) => entry.row.tenantId)).toEqual(["large"]);
    expect(withheld.map((entry) => entry.row.tenantId)).toEqual(["tiny"]);
    expect(withheld[0].denominator).toBe(4);
  });

  it("refuses a median under the floor and takes one at or above it", () => {
    expect(baselineMedian([10, 20])).toBeNull();
    expect(MIN_BASELINE_ROWS).toBe(3);
    expect(baselineMedian([10, 30, 20])).toBe(20);
    expect(baselineMedian([10, 30, 20, 40])).toBe(25);
  });

  it("spends clay only on a figure far below the baseline, not on every one below it", () => {
    expect(deltaTone(30, 20)).toBe("good");
    expect(deltaTone(20, 20)).toBe("neutral");
    expect(deltaTone(15, 20)).toBe("neutral");
    expect(deltaTone(4, 20)).toBe("failure");
  });

  it("tints missing cost evidence only while it is the exception", () => {
    const missing = row({ tenantId: "a", marginState: "unavailable" });
    const recorded = row({ tenantId: "b", marginState: "available" });
    expect([...evidenceTintedRows([missing, recorded, recorded])]).toEqual(["a"]);
    expect([...evidenceTintedRows([missing, missing, recorded])]).toEqual([]);
  });

  it("drops a follow-up touch that has sent nothing rather than drawing it as a zero rate", () => {
    const { rates, unsentTouches } = followupReplyRates(FOLLOWUPS);
    expect(rates.map((touch) => touch.touchNo)).toEqual([1, 2]);
    expect(unsentTouches).toEqual([3]);
    expect(rates[0].rate).toBeCloseTo(0.3);
  });
});

describe("AdminAgentPerformanceSurface", () => {
  it("gives success users a non-economic client table export and no economics segments", () => {
    renderSurface("success");

    expect(screen.getByRole("button", { name: "Export table" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Gross MRR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Margin" })).not.toBeInTheDocument();
    // One measure means no switch: a segmented control with a single option is a control that
    // cannot do anything.
    expect(screen.queryByRole("group", { name: "Rank clients by" })).not.toBeInTheDocument();
  });

  it("shows economics columns and the measure switch to an owner", () => {
    renderSurface("owner");

    expect(screen.getByRole("columnheader", { name: "Gross MRR" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Margin" })).toBeInTheDocument();
    const segments = screen.getByRole("group", { name: "Rank clients by" });
    expect(
      within(segments).getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Booked", "Gross MRR", "Margin"]);
  });

  it("says the rows are a review preview rather than real analytics", () => {
    renderSurface("owner");

    // The chip over the title, which is where the console states this. "Synthetic preview" rather
    // than "demo" on purpose: these are generated numbers, which is a stronger warning than seeded
    // rows and keeps its own word.
    expect(screen.getByText("Synthetic preview data")).toBeInTheDocument();
    expect(screen.getByText("Excluded from analytics")).toBeInTheDocument();
  });

  /**
   * The window, ending at a date rather than at the name of the parameter that holds it.
   *
   * This asserted the sentence containing "asOf" until 2026-09-01, which is how an argument name
   * out of `metric-definitions.ts` reached the screen under a heading and stayed there: the check
   * pinned the leak. The date is the fixture's own `asOf` printed in UTC, because the same
   * descriptor declares `clock: "UTC."` a few words later.
   */
  it("names the window it ranks over by the date it ends at, not by a parameter name", () => {
    renderSurface("owner");

    expect(
      screen.getByText(/Window: Trailing 30 days ending at Aug 24, 2026, 12:00 PM UTC/),
    ).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("asOf");
  });

  it("prints a missing margin as the evidence that is absent, never as a zero", () => {
    renderSurface("owner");

    expect(screen.getAllByText("No cost evidence").length).toBeGreaterThan(0);
    expect(screen.getByText("No priced subscription")).toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
  });

  it("ranks the clients by the selected measure and numbers them in order", () => {
    renderSurface("owner", [SUMMIT, NORTHSTAR, RIDGE]);

    const rows = screen.getAllByRole("row").slice(1);
    expect(
      rows.map((element) => within(element).getAllByRole("cell")[0].textContent),
    ).toEqual(["01", "02", "03"]);
    expect(
      rows.map((element) => within(element).getByRole("button").textContent),
    ).toEqual([
      "Northstar Capital (demo)",
      "Summit Funding (demo)",
      "Ridge Lending (demo)",
    ]);
  });

  /**
   * The named-baseline requirement. A bare delta column is a comparison against something the
   * reader has to guess at, so the head says what it is and the footer says over how many rows.
   */
  it("names the baseline the delta is against", () => {
    renderSurface("owner", [SUMMIT, NORTHSTAR, RIDGE]);

    expect(screen.getByRole("columnheader", { name: "Vs median" })).toBeInTheDocument();
    expect(screen.getByText(/median 5 · 3 clients/)).toBeInTheDocument();
    expect(
      screen.getByText(/The baseline is the median across the 3 clients/),
    ).toBeInTheDocument();
  });

  it("draws no delta column at all when there are too few clients for a median", () => {
    renderSurface("owner", [NORTHSTAR, SUMMIT]);

    expect(screen.queryByRole("columnheader", { name: "Vs median" })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Fewer than 3 clients carry a booked figure, so there is no median/),
    ).toBeInTheDocument();
  });

  it("renders the follow-up reply rates with the population each one is over", () => {
    const { container } = renderSurface("owner");

    expect(screen.getByRole("img", { name: /Reply rate across 2 follow-up touches/ })).toBeInTheDocument();
    const denominators = container.querySelector("[data-slot='followup-denominators']");
    expect(denominators?.textContent).toBe("800500");
    expect(screen.getByText(/1 touch had nothing sent and are not drawn\./)).toBeInTheDocument();
  });

  it("refuses to draw reply rates when no touch has sent anything", () => {
    renderSurface("owner", [NORTHSTAR, SUMMIT], [
      { touchNo: 1, sent: 0, replied: 0, crossChannel: 0, exhausted: 0 },
    ]);

    expect(
      screen.getByText(/No follow-up touch in this snapshot has sent a message yet/),
    ).toBeInTheDocument();
  });

  /**
   * Retiring an agent is a real consequence for a real business. The card may not assert one the
   * data cannot support, and it may not carry a verb that would act on it.
   */
  it("states that no action is derivable instead of asserting one, and offers no verb", () => {
    const { container } = renderSurface("owner");

    const card = container.querySelector("[data-slot='suggested-action']");
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Nothing in this snapshot supports a recommendation.");
    expect(card!.textContent).not.toMatch(/Retire the|Re-route queue/);
    expect(within(card as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("spends no accent fill: nothing on this page is a live action", () => {
    const { container } = renderSurface("owner");

    expect(container.innerHTML).not.toContain("accent-fill");
  });

  /**
   * The figures moved from `StatStrip` tiles to console deck panels in the canvas port, so this
   * reads `console-stat-panel` where it used to read `stat-strip-tile`. The claim is unchanged and
   * deliberately so: the drift this catches is a renderer that turns an absence into a confident
   * figure, and the panel is larger and louder than the tile was, which makes it more important
   * rather than less. "not yet" is `StatStrip`'s own word, and both renderers must keep using it
   * for the same state.
   */
  it("reads an average over no clients as not yet rather than as zero", () => {
    renderSurface("owner", []);

    const tile = screen
      .getByText("Booked per client")
      .closest("[data-slot='console-stat-panel']");
    expect(tile).not.toBeNull();
    expect(within(tile as HTMLElement).getByText("not yet")).toBeInTheDocument();
    expect(
      within(tile as HTMLElement).getByText("No clients in this snapshot to average over"),
    ).toBeInTheDocument();
    // Positive control: the panel is really drawn, so a stubbed-out deck could not pass the
    // negative above by rendering nothing at all.
    expect(within(tile as HTMLElement).getByText("Booked per client")).toBeInTheDocument();
  });

  /**
   * Catches the drift where a lane adds a second drenched panel to a console screen. `console.css`
   * allows exactly one -- the console already spends its attention on a nineteen-item rail, a
   * topbar and a banded table -- and a strip where every figure fills has stopped ranking anything.
   */
  it("drenches exactly one figure on the strip", () => {
    const { container } = renderSurface("owner");

    const panels = [...container.querySelectorAll("[data-slot='console-stat-panel']")];
    expect(panels.length).toBeGreaterThan(1);
    expect(panels.filter((panel) => panel.getAttribute("data-drench"))).toHaveLength(1);
    expect(
      container.querySelector("[data-slot='console-stat-panel'][data-drench]"),
    ).toHaveTextContent("Booked appointments");
  });

  it("keeps a measured empty snapshot readable as zero rather than as an absence", () => {
    renderSurface("owner", []);

    const tile = screen
      .getByText("Clients measured")
      .closest("[data-slot='console-stat-panel']");
    expect(tile).not.toBeNull();
    expect(within(tile as HTMLElement).getByText("0")).toBeInTheDocument();
    expect(
      within(tile as HTMLElement).getByText("The snapshot carried no client rows"),
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing measured yet")).toBeInTheDocument();
  });
});
