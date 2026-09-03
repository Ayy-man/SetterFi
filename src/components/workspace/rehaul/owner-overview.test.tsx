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
  };
}

describe("OwnerOverview", () => {
  it("draws the title, the day it was read, and the pulse figure", () => {
    render(<OwnerOverview measurement={measurement()} role="owner" />);

    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("Thursday 3 September 2026")).toBeInTheDocument();
    // Gross MRR leads the pulse for an owner: 298,200 cents read back as money.
    expect(screen.getByText("$2,982")).toBeInTheDocument();
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
      screen.getByRole("heading", { name: "Signups by period" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Subscriptions in this snapshot" })).toBeInTheDocument();
    // The delta names the period it was taken against, as the artboard's "+2 vs last month" does.
    expect(screen.getByText("+2 vs Jul 2026")).toBeInTheDocument();
    expect(screen.getByText("Demo and test rows excluded")).toBeInTheDocument();
  });

  it("refuses revenue to a success reviewer rather than substituting a figure", () => {
    render(<OwnerOverview measurement={measurement()} role="success" />);

    expect(screen.queryByText("$2,982")).toBeNull();
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
