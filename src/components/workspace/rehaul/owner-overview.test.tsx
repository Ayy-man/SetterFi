import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import {
  PLATFORM_METRIC_KEYS,
  metricDefinition,
  type MetricEvidence,
} from "@/lib/analytics/metric-definitions";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";

import { OwnerOverview, overviewDecisions, resolveHistoryWindow } from "./owner-overview";

function metric(key: (typeof PLATFORM_METRIC_KEYS)[number]): MetricEvidence {
  const definition = metricDefinition(key);
  const value =
    key === "platform.new_signups"
      ? 3
      : key === "platform.gross_mrr"
        ? 298_200
        : definition.unit === "cents"
          ? 120_000
          : definition.unit === "percent"
            ? 4
            : definition.unit === "seconds"
              ? 120
              : 9;
  return {
    metricKey: key,
    numerator: value,
    denominator: definition.requiresPositiveDenominator ? 10 : null,
    value,
    state: "available",
    windowStart: "2026-08-04T12:00:00.000Z",
    windowEnd: "2026-09-03T12:00:00.000Z",
  };
}

function measurement(): PlatformMeasurement {
  return {
    origin: "synthetic_preview",
    asOf: "2026-09-03T12:00:00.000Z",
    metrics: PLATFORM_METRIC_KEYS.map(metric),
    subscriptions: [
      {
        tenantId: "tenant-cedar-ridge",
        subscriptionId: "subscription-cedar",
        status: "active",
        stripePriceId: "price-starter",
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
      },
      {
        tenantId: "tenant-northstar",
        subscriptionId: "subscription-northstar",
        status: "trialing",
        stripePriceId: "price-starter",
        periodStart: "2026-08-20T00:00:00.000Z",
        periodEnd: "2026-09-20T00:00:00.000Z",
      },
      {
        tenantId: "tenant-reid-funding",
        subscriptionId: "subscription-reid",
        status: "past_due",
        stripePriceId: "price-starter",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
      },
    ],
    tenantPerformance: [
      {
        tenantId: "tenant-cedar-ridge",
        bookedAppointments: 24,
        grossMrrCents: 298_200,
        commissionCents: 3_000,
        marginCents: 120_000,
        marginState: "available",
      },
    ],
    guardrailRules: [
      { ruleKey: "guarantee", label: "Guarantee claims", fires: 2, blocks: 1, holds: 1 },
    ],
    followupPerformance: [
      { touchNo: 1, sent: 5, replied: 2, crossChannel: 1, exhausted: 0 },
    ],
    provisioningPerformance: [
      {
        stepKey: "a2p_campaign",
        state: "awaiting_provider",
        attempts: 1,
        failures: 0,
        medianDaysToClear: null,
      },
    ],
    history: [
      {
        periodStart: "2026-07-05T12:00:00.000Z",
        periodEnd: "2026-08-04T12:00:00.000Z",
        value: 1,
        state: "available",
      },
      {
        periodStart: "2026-08-04T12:00:00.000Z",
        periodEnd: "2026-09-03T12:00:00.000Z",
        value: 3,
        state: "available",
      },
    ],
    activeSubscriptionsByPeriod: [
      {
        periodStart: "2026-07-05T12:00:00.000Z",
        periodEnd: "2026-08-04T12:00:00.000Z",
        value: 4,
        state: "available",
      },
      {
        periodStart: "2026-08-04T12:00:00.000Z",
        periodEnd: "2026-09-03T12:00:00.000Z",
        value: 6,
        state: "available",
      },
    ],
    revenueByPeriod: [
      {
        periodStart: "2026-07-05T12:00:00.000Z",
        periodEnd: "2026-08-04T12:00:00.000Z",
        value: 210_000,
        state: "available",
      },
      {
        periodStart: "2026-08-04T12:00:00.000Z",
        periodEnd: "2026-09-03T12:00:00.000Z",
        value: 298_200,
        state: "available",
      },
    ],
    deliveriesByDay: [],
    textingRegistrationByTenant: [],
  };
}

describe("OwnerOverview", () => {
  it("draws the title, the day it was read, and the pulse figure", () => {
    render(<OwnerOverview measurement={measurement()} role="owner" />);

    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("Thursday 3 September 2026")).toBeInTheDocument();
    // Gross MRR leads the pulse for an owner: 298,200 cents read back as money, once, as the
    // headline figure. The period strip that used to repeat it under the figure is gone.
    expect(screen.getAllByText("$2,982")).toHaveLength(1);
    // The trialing row has collected nothing, so it is named apart rather than counted active.
    expect(screen.getByText("across 1 active subscription · 1 trialing")).toBeInTheDocument();
  });

  it("counts the past due subscription into the decision queue", () => {
    render(<OwnerOverview measurement={measurement()} role="owner" />);

    expect(screen.getByRole("link", { name: "Past due subscriptions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Needs a decision" })).toBeInTheDocument();
  });

  it("routes the decision queue at the folded inbox with the artboard's own wording", () => {
    render(<OwnerOverview measurement={measurement()} role="owner" />);

    expect(screen.getByRole("link", { name: "Open inbox" })).toHaveAttribute(
      "href",
      "/admin/support",
    );
  });

  it("carries no explainer sentence from the old surface", () => {
    render(<OwnerOverview measurement={measurement()} role="owner" />);

    expect(
      screen.queryByText(
        "The chart appears once a full 30-day period has closed with a recorded signup.",
      ),
    ).toBeNull();
    expect(
      screen.queryByText(
        "No active-subscription history series is recorded, so only signups are drawn",
      ),
    ).toBeNull();

    expect(
      screen.queryByText(
        "Platform performance, client health, and the work that needs a human decision.",
      ),
    ).toBeNull();
    expect(screen.queryByText("Each bar is one trailing 30-day period, oldest first")).toBeNull();
    expect(
      screen.queryByText("Messages sent at each touch of the cadence, this snapshot"),
    ).toBeNull();
  });

  it("opens the figures dialog from a card's expand control", async () => {
    render(<OwnerOverview measurement={measurement()} role="owner" />);

    await userEvent.click(screen.getByRole("button", { name: "Expand New signups" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Signups and active subscriptions, by period" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Subscriptions in this snapshot" })).toBeInTheDocument();
    // The delta names the period it was taken against, as the artboard's "+2 vs last month" does.
    expect(screen.getByText("+2 vs Jul 2026")).toBeInTheDocument();
    expect(screen.getByText("Demo and test rows excluded")).toBeInTheDocument();
  });

  it("draws the pulse as the figure alone, with no period strip under it", () => {
    const { container } = render(<OwnerOverview measurement={measurement()} role="owner" />);

    // The strip under the headline figure was removed on 2026-09-04: a row of ten near-invisible
    // slivers ending in one bar labelled with a figure that disagreed with the headline read as a
    // broken chart, not a history. The history lives in the signups panel and the KPI dialogs.
    const pulse = container.querySelector('[data-slot="overview-pulse"]') as HTMLElement;
    expect(pulse.querySelector('[data-slot="bar-current"]')).toBeNull();
    expect(pulse.querySelector("table")).toBeNull();
    expect(screen.queryByRole("img", { name: /by 30-day period/u })).toBeNull();
    expect(pulse.textContent).toContain("$2,982");
  });

  it("replaces the KPI trend slot with a comparison against the prior period", () => {
    const { container } = render(<OwnerOverview measurement={measurement()} role="owner" />);

    expect(screen.getByText("3 this period, 1 last period")).toBeInTheDocument();
    expect(screen.getByText("6 active, 4 a period ago")).toBeInTheDocument();
    // No card draws a 36px curve any more, and none of them tells the reader about a chart that
    // was never going to exist.
    expect(container.querySelectorAll('[data-slot="sparkline"]')).toHaveLength(0);
    expect(screen.queryByText("No period series recorded")).toBeNull();
  });

  it("gives churn and time to live no comparison line at all", () => {
    const { container } = render(<OwnerOverview measurement={measurement()} role="owner" />);

    const cards = [...container.querySelectorAll('[data-slot="overview-kpi"]')];
    expect(cards).toHaveLength(4);
    // The snapshot carries no period series for either, so those two cards simply end after their
    // figure and pill rather than spending a line saying a chart is missing.
    const withComparison = cards.filter((card) =>
      card.querySelector('[data-slot="kpi-comparison"]') !== null,
    );
    expect(withComparison).toHaveLength(2);
    expect(screen.getByText("most recent cycle")).toBeInTheDocument();
    expect(screen.getByText("median")).toBeInTheDocument();
  });

  it("says so rather than inventing a comparison when there is no prior period", () => {
    const base = measurement();
    render(
      <OwnerOverview
        measurement={{
          ...base,
          activeSubscriptionsByPeriod: base.activeSubscriptionsByPeriod.slice(-1),
          history: base.history.slice(-1),
        }}
        role="owner"
      />,
    );

    expect(screen.getByText("3 this period, no prior period recorded")).toBeInTheDocument();
    expect(screen.getByText("6 active, no prior period recorded")).toBeInTheDocument();
  });

  it("prints the latest signup period's own figure on its bar", () => {
    const { container } = render(<OwnerOverview measurement={measurement()} role="owner" />);

    const panel = container.querySelector('[data-slot="signups-panel"]') as HTMLElement;
    expect(panel.querySelector('[data-slot="bar-current-value"]')?.textContent).toBe("3");
    // The bar panel is now the only place this series is drawn.
    expect(panel.querySelector('[data-slot="sparkline"]')).toBeNull();
  });

  it("holds the absence when a period carries no measured reading", () => {
    const base = measurement();
    render(
      <OwnerOverview
        measurement={{
          ...base,
          revenueByPeriod: base.revenueByPeriod.map((period) => ({
            ...period,
            state: "needs_more_history" as const,
          })),
        }}
        role="owner"
      />,
    );

    expect(screen.queryByText("No revenue period recorded yet")).toBeNull();
    expect(
      screen.queryByRole("img", { name: /^Gross MRR by 30-day period/u }),
    ).toBeNull();
  });

  it("draws signups and active subscriptions as two named lines in the dialog", async () => {
    render(<OwnerOverview measurement={measurement()} role="owner" />);

    await userEvent.click(screen.getByRole("button", { name: "Expand New signups" }));

    expect(
      await screen.findByRole("heading", { name: "Signups and active subscriptions, by period" }),
    ).toBeInTheDocument();
    // The legend names both lines, and the sr-only table repeats them as columns.
    expect(screen.getAllByText("Active subscriptions").length).toBeGreaterThan(1);
    expect(
      screen.queryByText("No active-subscription reading over these periods"),
    ).toBeNull();
  });

  it("refuses revenue to a success reviewer rather than substituting a figure", () => {
    render(<OwnerOverview measurement={measurement()} role="success" />);

    expect(screen.queryAllByText("$2,982")).toHaveLength(0);
    expect(screen.queryByText("Margin")).toBeNull();
    // The pulse falls to signups rather than promoting another figure into the money slot.
    expect(screen.getAllByText("New signups").length).toBeGreaterThan(0);
  });
});

describe("resolveHistoryWindow", () => {
  it("falls back to the full series for an unknown or missing param", () => {
    expect(resolveHistoryWindow(undefined)).toBe("all");
    expect(resolveHistoryWindow("1d")).toBe("all");
    expect(resolveHistoryWindow("3M")).toBe("3m");
  });
});

describe("overviewDecisions", () => {
  it("counts only categories the snapshot carries evidence for", () => {
    const rows = overviewDecisions(measurement());

    expect(rows.find((row) => row.id === "past-due")?.count).toBe(1);
    expect(rows.find((row) => row.id === "holds")?.count).toBe(1);
    expect(rows.find((row) => row.id === "provisioning")?.count).toBe(0);
    expect(rows.find((row) => row.id === "exhausted")?.count).toBe(0);
  });
});
