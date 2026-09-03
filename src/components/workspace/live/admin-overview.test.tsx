import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// The attention queue is the kit's DataTable now, and a row press navigates.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import {
  PLATFORM_METRIC_KEYS,
  metricDefinition,
  type MetricEvidence,
} from "@/lib/analytics/metric-definitions";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";

import {
  AdminOverviewSurface,
  AdminPlatformDetailSurface,
  FleetHealthPanel,
  NeedsPersonToday,
  fleetSubscriptionHealth,
  type AdminExceptionCategory,
} from "./admin-overview";

function metric(key: (typeof PLATFORM_METRIC_KEYS)[number]): MetricEvidence {
  const definition = metricDefinition(key);
  const value =
    key === "platform.new_signups"
      ? 2
      : definition.unit === "cents"
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

function measurement(): PlatformMeasurement {
  return {
    origin: "synthetic_preview",
    asOf: "2026-08-24T12:00:00.000Z",
    metrics: PLATFORM_METRIC_KEYS.map(metric),
    subscriptions: [
      {
        tenantId: "tenant-review",
        subscriptionId: "subscription-review",
        status: "active",
        stripePriceId: "price-review",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
      },
    ],
    tenantPerformance: [
      {
        tenantId: "tenant-review",
        bookedAppointments: 5,
        grossMrrCents: 30_000,
        commissionCents: 3_000,
        marginCents: 20_000,
        marginState: "available",
      },
    ],
    guardrailRules: [
      {
        ruleKey: "guarantee",
        label: "Guarantee claims",
        fires: 1,
        blocks: 1,
        holds: 0,
      },
    ],
    followupPerformance: [
      {
        touchNo: 1,
        sent: 5,
        replied: 2,
        crossChannel: 1,
        exhausted: 0,
      },
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
        periodStart: "2026-06-25T12:00:00.000Z",
        periodEnd: "2026-07-25T12:00:00.000Z",
        value: 5,
        state: "available",
      },
      {
        periodStart: "2026-07-25T12:00:00.000Z",
        periodEnd: "2026-08-24T12:00:00.000Z",
        value: 2,
        state: "available",
      },
    ],
    activeSubscriptionsByPeriod: [],
    revenueByPeriod: [],
    deliveriesByDay: [],
    textingRegistrationByTenant: [],
  };
}

describe("NeedsPersonToday", () => {
  const clearCategory = (title: string): AdminExceptionCategory => ({
    title,
    count: 0,
    tone: "critical",
    href: "/admin/billing",
    note: "Review",
  });

  it("bands the live work by how soon it needs a person and leaves the clear categories out", () => {
    const categories: AdminExceptionCategory[] = [
      {
        title: "Past due",
        count: 3,
        tone: "critical",
        href: "/admin/billing",
        note: "Review accounts",
      },
      {
        title: "Provisioning blocks",
        count: 0,
        tone: "critical",
        href: "/admin/provisioning",
        note: "Review",
      },
      {
        title: "Guardrail fires",
        count: 0,
        tone: "warning",
        href: "/admin/brain/testing",
        note: "Review",
      },
      {
        title: "Holding replies",
        count: 0,
        tone: "warning",
        href: "/admin/support",
        note: "Review",
      },
      {
        title: "Exhausted follow-ups",
        count: 4,
        tone: "info",
        href: "/admin/support",
        note: "Review contacts",
      },
    ];

    render(<NeedsPersonToday categories={categories} />);

    // Two bands, in urgency order: a critical or warning category needs somebody now, an
    // informational one can wait. A zero category is not a row at all.
    const rows = screen.getAllByRole("row");
    const text = rows.map((row) => row.textContent ?? "");
    expect(text.some((line) => line.includes("Needs a person now"))).toBe(true);
    expect(text.some((line) => line.includes("Review when you can"))).toBe(
      true,
    );
    expect(screen.getByRole("cell", { name: "Past due" })).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "Exhausted follow-ups" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("cell", { name: "Provisioning blocks" }),
    ).not.toBeInTheDocument();
  });

  it("says what it checked rather than printing a row of zeroes", () => {
    render(
      <NeedsPersonToday
        categories={[
          clearCategory("Past due"),
          clearCategory("Provisioning blocks"),
        ]}
      />,
    );

    expect(
      screen.getByText("Nothing needs a person right now"),
    ).toBeInTheDocument();
    // The empty state names every category examined, so "nothing" is a finding rather than
    // an absence of evidence.
    expect(
      screen.getByText(/past due, provisioning blocks/u),
    ).toBeInTheDocument();
  });

  it("exports the queue like every other table in the console", () => {
    render(
      <NeedsPersonToday
        categories={[
          {
            title: "Past due",
            count: 2,
            tone: "critical",
            href: "/admin/billing",
            note: "Review",
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: /export/iu }),
    ).toBeInTheDocument();
  });

  it("sends the reader to the full attention queue", () => {
    render(
      <NeedsPersonToday
        categories={[
          {
            title: "Past due",
            count: 2,
            tone: "critical",
            href: "/admin/billing",
            note: "Review",
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Open the queue" }),
    ).toHaveAttribute("href", "/admin/support");
  });
});

describe("AdminOverviewSurface", () => {
  /**
   * The strip became 1b's four-up headline row, so these read the tiles rather than the old stat
   * strip. Every rule they were written for still holds; only the markup carrying it moved.
   *
   * It moved again in the console redesign, and this helper is where that shows. The lead metric
   * is now the screen's one drenched hero panel rather than the first of four identical tiles --
   * `HEADLINE_METRIC_KEYS` always documented itself as "the hero order" and the page had simply
   * never drawn it. So the row is a hero followed by a strip, and this reads both, in document
   * order, so `overlines[0]` still means "the figure this role's page leads on".
   *
   * The drift it catches is the reason it queries the container rather than the two shapes
   * separately: a port that dropped the lead metric out of the hero, or promoted a substitute
   * into the strip's first slot, would leave every assertion below reading the wrong element and
   * still passing. Reading the whole row in order is what makes the role-gating tests mean
   * anything.
   */
  function headlineTiles(container: HTMLElement) {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-slot="overview-headline-tiles"] [data-slot="overview-headline-hero"],'
        + ' [data-slot="overview-headline-tiles"] [data-slot="metric-card"]',
      ),
    );
  }

  /**
   * The metric's own label, wherever the shape it sits in keeps it: a tile writes it as the
   * overline, the hero writes it as the panel's name and spends its overline on the category.
   */
  function headlineLabel(tile: HTMLElement) {
    if (tile.dataset.slot === "overview-headline-hero") {
      return tile.querySelector(".coach-panel__name")?.textContent ?? null;
    }
    return tile.querySelector('[data-slot="overline"]')?.textContent ?? null;
  }

  function tileNamed(container: HTMLElement, overline: string) {
    return headlineTiles(container).find((tile) => headlineLabel(tile) === overline) ?? null;
  }

  it("holds a number or an honest absence in every figure slot, and never repaints one for a bad delta", () => {
    const { container } = render(
      <AdminOverviewSurface measurement={measurement()} role="owner" />,
    );

    const tiles = headlineTiles(container);
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      const figure = tile.querySelector('[data-slot="figure"]');
      const text = (figure?.textContent ?? "").trim();
      // A figure slot holds a reading or the absence dash -- never a sentence standing in for one.
      // The reason for the dash lives in the tile's note, which is asserted below.
      if (/[a-z]/iu.test(text)) {
        throw new Error(`A headline figure read as words rather than a figure: ${text}`);
      }
      if (text === "\u2013") {
        expect(tile.querySelector('[data-slot="metric-card-note"]')?.textContent ?? "").not.toBe("");
      }
    }

    // The delta is the one thing on the tile allowed to carry bad news, and it carries it alone:
    // a negative comparison tints the delta and leaves the figure in ink. Repainting the figure
    // would make the reading itself look like the problem.
    const signups = tileNamed(container, "New signups");
    expect(signups).not.toBeNull();
    expect(
      signups!.querySelector('[data-slot="figure"]')?.getAttribute("data-tone"),
    ).toBe("neutral");
  });

  it("leads on revenue and keeps the funnel metrics out of the headline row", () => {
    const { container } = render(
      <AdminOverviewSurface measurement={measurement()} role="owner" />,
    );

    // One headline row, and the figure a platform owner opens this page for leads it.
    const overlines = headlineTiles(container).map(
      (tile) => headlineLabel(tile),
    );
    expect(overlines[0]).toBe("Gross MRR");
    // Five tiles beside the hero, which is the canvas's strip. Median time to live and margin are
    // the two the canvas adds that a metric key actually backs; its third, cost per booked call,
    // has no key at all, so it is left out rather than approximated into the row.
    expect(overlines).toEqual([
      "Gross MRR",
      "New signups",
      "Active subscriptions",
      "Churn rate",
      "Median time to live, days",
      "Margin",
    ]);
    // The unit belongs to the label, never to the figure: the slot holds a reading or the absence
    // dash, which is what the figure assertions above are able to rely on.
    expect(tileNamed(container, "Median time to live, days")).not.toBeNull();

    // The funnel metrics are read once, in the funnel, so they never also take a tile.
    const row = container.querySelector('[data-slot="overview-headline-tiles"]');
    for (const label of ["Booked appointments", "No-show rate"]) {
      expect(row).not.toHaveTextContent(label);
    }
  });

  it("leads a success user on signups rather than promoting a figure they may not see", () => {
    const { container } = render(
      <AdminOverviewSurface measurement={measurement()} role="success" />,
    );

    // Revenue is refused, so the row leads on the next figure the role is allowed. The economics
    // tile is absent outright rather than rendered as an unavailable one, which would still tell a
    // success user that a gross MRR figure exists.
    const overlines = headlineTiles(container).map(
      (tile) => headlineLabel(tile),
    );
    expect(overlines[0]).toBe("New signups");
    expect(overlines).not.toContain("Gross MRR");
    // Margin is the other economics figure the strip now carries, and it is refused the same way
    // and for the same reason: an unavailable tile would still tell a success reviewer that the
    // platform holds a margin number, which is the half of the rule an absent tile keeps.
    expect(overlines).not.toContain("Margin");
    expect(
      container.querySelector('[data-slot="overview-headline-tiles"]'),
    ).not.toHaveTextContent("Gross MRR");
  });

  /**
   * Two periods is a comparison, not a series, so the row draws it as a delta. A previous period
   * flagged `needs_more_history` still carries a real count, so it is still compared against --
   * hiding it would read as no change rather than as a fall from three to zero.
   */
  it("compares a validated zero-signup history period rather than hiding it", () => {
    const snapshot = measurement();
    const history: PlatformMeasurement["history"] = [
      { ...snapshot.history[0]!, value: 3 },
      { ...snapshot.history[1]!, value: 0, state: "needs_more_history" },
    ];
    const { container } = render(
      <AdminOverviewSurface
        measurement={{ ...snapshot, history }}
        role="owner"
      />,
    );

    const signups = tileNamed(container, "New signups");
    expect(signups).not.toBeNull();
    const delta = signups!.querySelector('[data-slot="metric-card-delta"]');
    expect(delta?.textContent).toBe("\u22123");
  });

  it("uses only current unresolved evidence for the attention queue", () => {
    const snapshot = measurement();
    const { container } = render(
      <AdminOverviewSurface
        measurement={{
          ...snapshot,
          subscriptions: [],
          guardrailRules: [
            {
              ruleKey: "credit_guarantee",
              label: "credit_guarantee",
              fires: 8,
              blocks: 7,
              holds: 1,
            },
          ],
          followupPerformance: [
            {
              touchNo: 1,
              sent: 12,
              replied: 0,
              crossChannel: 0,
              exhausted: 9,
            },
          ],
          provisioningPerformance: [
            {
              stepKey: "a2p_campaign",
              state: "blocked",
              attempts: 14,
              failures: 1,
              medianDaysToClear: null,
            },
          ],
        }}
        role="owner"
      />,
    );

    // Only categories with live evidence become rows, and each carries its own count, its next
    // step, and the clause saying why it is waiting. Past due subscriptions had none, so it is
    // absent rather than present at zero.
    //
    // The name match is a prefix rather than an exact string because the identity cell is two
    // parts now: the category, then its reason beside it. Matching the whole accessible name
    // would pin the reason's exact wording into a test about which categories appear at all.
    for (const [title, count, reason] of [
      ["Provisioning blocks", "1", "Recorded step attempts that failed, on steps now blocked or failed"],
      ["Held replies awaiting a decision", "1", "A guardrail held the reply rather than blocking or sending it"],
      ["Follow-up cadences exhausted", "9", "The cadence reached its last touch with no reply"],
    ] as const) {
      const cell = screen.getByRole("cell", { name: new RegExp(`^${title}`, "u") });
      const row = within(cell.closest("tr") as HTMLElement);
      expect(row.getByText(count)).toBeInTheDocument();
      // The cause, not only the next step. A row that says "Review holds" and nothing else makes
      // the reader open it to find out what happened.
      expect(row.getByText(reason)).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("cell", { name: /^Past due subscriptions/u }),
    ).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("Nothing needs a person right now");
  });

  it("keeps the four evidence tables off the home screen and one click away", () => {
    render(<AdminOverviewSurface measurement={measurement()} role="owner" />);

    // Only the trend's screen-reader table survives; the four evidence tables moved to the detail page.
    expect(
      screen.queryByText(
        "Fires, blocks, and holding replies recorded in this measurement snapshot.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: /Touch/u }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All figures" })).toHaveAttribute(
      "href",
      "/admin/overview/detail",
    );
  });
});

describe("AdminPlatformDetailSurface", () => {
  it("opens on the figures tab and lists every evidence tab after it", () => {
    render(
      <AdminPlatformDetailSurface measurement={measurement()} role="owner" />,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Figures",
      "Acquisition",
      "Subscriptions",
      "Guardrails",
      "Follow-ups",
      "Provisioning",
    ]);
  });

  it("keeps subscriptions away from a success user", () => {
    const { container } = render(
      <AdminPlatformDetailSurface measurement={measurement()} role="success" />,
    );

    expect(
      screen.queryByRole("tab", { name: "Subscriptions" }),
    ).not.toBeInTheDocument();
    /*
     * The missing tab on its own would also be satisfied by the surface failing to render, so
     * state what a success reviewer does get. They lose the one revenue tab and keep the rest.
     */
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Figures",
      "Acquisition",
      "Guardrails",
      "Follow-ups",
      "Provisioning",
    ]);
    /*
     * And the hidden tab is presentation, not the gate. Nothing identifying a subscription may
     * reach this render by any route, which is what stays true if the tab ever comes back.
     */
    expect(container).not.toHaveTextContent("subscription-review");
    expect(container).not.toHaveTextContent("price-review");
  });

  it("reads the booked stage and show rate from evidence and marks unmeasured stages absent", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AdminPlatformDetailSurface measurement={measurement()} role="owner" />,
    );

    await user.click(screen.getByRole("tab", { name: "Acquisition" }));

    const funnel = container.querySelector('[data-slot="acquisition-funnel"]');
    expect(funnel).toHaveTextContent("New leads");
    expect(funnel).toHaveTextContent("Qualified");
    expect(funnel).toHaveTextContent("Booked appointments");
    expect(funnel).toHaveTextContent(
      "Lead volume is recorded per client, not across the platform yet",
    );
    expect(funnel).toHaveTextContent("Rate needs both stages");
    // A recorded 50% no-show rate is a 50% show rate, never an invented number.
    expect(screen.getByText("Show rate").parentElement).toHaveTextContent(
      "50%",
    );
  });

  it("renders the show rate as absent when attendance is not recorded", async () => {
    const user = userEvent.setup();
    const snapshot = measurement();
    const metrics = snapshot.metrics.map((row) =>
      row.metricKey === "platform.no_show_rate"
        ? {
            ...row,
            denominator: 0,
            numerator: 0,
            value: null,
            state: "still_filling" as const,
          }
        : row,
    );
    render(
      <AdminPlatformDetailSurface
        measurement={{ ...snapshot, metrics }}
        role="owner"
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Acquisition" }));

    const aside = screen.getByText("Show rate").parentElement;
    expect(aside).toHaveTextContent("No recorded attendance yet");
    expect(
      aside?.querySelector('[data-slot="funnel-figure"]')?.textContent,
    ).toBe("–");
  });

  it("keeps valid zero units and one-decimal day precision", () => {
    const snapshot = measurement();
    const metrics = snapshot.metrics.map((row) => {
      if (row.metricKey === "platform.gross_mrr")
        return { ...row, numerator: 0, value: 0 };
      if (row.metricKey === "platform.churn_rate")
        return { ...row, numerator: 0, value: 0 };
      if (row.metricKey === "platform.growth_rate") {
        return { ...row, numerator: 0, denominator: 0, value: 0 };
      }
      if (row.metricKey === "platform.average_retention") {
        return { ...row, numerator: 2.5, value: 2.5 };
      }
      return row;
    });

    render(
      <AdminPlatformDetailSurface
        measurement={{ ...snapshot, metrics }}
        role="owner"
      />,
    );

    // Figures live in a definition list grouped by subject, not in eighteen identical cards, and
    // every rate and day count carries one decimal so a column of them can be compared down.
    const reference = screen.getByRole("region", {
      name: "Every recorded figure",
    });
    const figure = (label: string) =>
      within(reference).getByText(label).parentElement?.textContent ?? "";

    expect(figure("Gross MRR")).toContain("$0.00");
    expect(figure("Churn rate")).toContain("0.0%");
    expect(figure("Average retention")).toContain("2.5 days");
    expect(figure("Average retention")).not.toContain(
      "Average retention, days",
    );
    expect(figure("Growth rate")).not.toMatch(/\d/u);
  });

  it("maps every history-dependent metric without inventing an elapsed-day clock", () => {
    const snapshot = measurement();
    const historyDependent = new Set([
      "platform.growth_rate",
      "platform.time_to_live",
      "platform.a2p_median_days_to_clear",
    ]);
    const metrics: PlatformMeasurement["metrics"] = snapshot.metrics.map(
      (row) => {
        if (!historyDependent.has(row.metricKey)) return row;
        const evidence =
          row.metricKey === "platform.growth_rate"
            ? { denominator: 0, numerator: 3 }
            : row.metricKey === "platform.time_to_live"
              ? { denominator: 5, numerator: 0 }
              : { denominator: 2, numerator: 0 };
        return {
          ...row,
          ...evidence,
          state: "needs_more_history" as const,
          value: null,
        };
      },
    );

    render(
      <AdminPlatformDetailSurface
        measurement={{ ...snapshot, metrics }}
        role="owner"
      />,
    );

    const reference = screen.getByRole("region", {
      name: "Every recorded figure",
    });
    for (const [label, reason] of [
      ["Growth rate", "No prior-period subscription population yet"],
      ["Median time to live", "No completed onboarding runs yet"],
      ["Median A2P days to clear", "No approved filings yet"],
    ]) {
      const row = within(reference).getByText(label).parentElement;
      expect(row).toHaveTextContent(reason);
      expect(row).not.toHaveTextContent(/Day \d+/u);
      expect(row).not.toHaveTextContent("Review evidence");
    }
  });

  it("keeps a receiptless done provisioning row neutral and evidence-missing", async () => {
    const user = userEvent.setup();
    const snapshot = measurement();
    render(
      <AdminPlatformDetailSurface
        measurement={{
          ...snapshot,
          provisioningPerformance: [
            {
              stepKey: "calendar_connect",
              state: "done",
              attempts: 1,
              failures: 0,
              medianDaysToClear: 1,
            },
          ],
        }}
        role="owner"
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Provisioning" }));

    const row = screen.getByRole("row", { name: /Calendar Connect/u });
    // The state cell moved from StateBadge to the kit's Status; the rule is unchanged, and it is
    // the one that matters here -- a done step with no receipt must stay neutral, never good.
    const badge = within(row)
      .getByText("Completion evidence missing")
      .closest("[data-slot='status']");
    expect(badge).toHaveAttribute("data-tone", "neutral");
    expect(within(row).queryByText("Done")).not.toBeInTheDocument();
  });

  it("describes guardrail evidence without claiming a real-data origin", async () => {
    const user = userEvent.setup();
    render(
      <AdminPlatformDetailSurface measurement={measurement()} role="owner" />,
    );

    await user.click(screen.getByRole("tab", { name: "Guardrails" }));

    expect(
      screen.getByText(
        "Fires, blocks, and holding replies recorded in this measurement snapshot.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/real, non-test traces/iu),
    ).not.toBeInTheDocument();
  });

  it("humanizes raw guardrail labels outside technical detail", async () => {
    const user = userEvent.setup();
    const snapshot = measurement();
    render(
      <AdminPlatformDetailSurface
        measurement={{
          ...snapshot,
          guardrailRules: [
            {
              ruleKey: "hard_credit_guarantee",
              label: "hard_credit_guarantee",
              fires: 1,
              blocks: 1,
              holds: 0,
            },
          ],
        }}
        role="owner"
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Guardrails" }));

    expect(
      screen.getByRole("cell", { name: "Hard Credit Guarantee" }),
    ).toBeInTheDocument();
    // The raw rule key is evidence, not table copy: it appears only once a row is opened.
    expect(screen.queryByText("hard_credit_guarantee")).not.toBeInTheDocument();
  });
});

/**
 * The lead row's second panel, and mostly what it refuses to say.
 *
 * `AdminOverview.dc.html:257-274` draws a donut reading 98.6 platform health beside "23/24 agents
 * healthy". Neither figure exists: no metric key defines the composite, and `PlatformMeasurement`
 * has no agent dimension at all. The ratio that ships counts subscription state per client, which
 * is the one per-client fact the read carries, and the assertions below pin all three halves of
 * that -- the count, the word it is allowed to use, and the composite staying off the page.
 */
describe("FleetHealthPanel", () => {
  function withSubscriptions(statuses: readonly string[]): PlatformMeasurement {
    const base = measurement();
    return {
      ...base,
      tenantPerformance: statuses.map((_, index) => ({
        tenantId: `tenant-${index}`,
        bookedAppointments: 1,
        grossMrrCents: 1_000,
        commissionCents: 100,
        marginCents: 500,
        marginState: "available" as const,
      })),
      subscriptions: statuses.map((status, index) => ({
        tenantId: `tenant-${index}`,
        subscriptionId: `subscription-${index}`,
        status,
        stripePriceId: "price-1",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
      })),
    };
  }

  it("counts clients rather than subscriptions, so two bad rows on one client are one client", () => {
    const base = withSubscriptions(["past_due", "active", "active"]);
    const doubled: PlatformMeasurement = {
      ...base,
      subscriptions: [
        ...base.subscriptions,
        { ...base.subscriptions[0]!, subscriptionId: "subscription-0b", status: "unpaid" },
      ],
    };

    expect(fleetSubscriptionHealth(doubled)).toEqual({ clients: 3, troubled: 1, clear: 2 });
  });

  it("draws the ratio and names the exception in words as well as in a tone", () => {
    render(<FleetHealthPanel measurement={withSubscriptions(["past_due", "active", "active"])} />);

    expect(document.querySelector('[data-slot="fleet-health-figure"]')).toHaveTextContent("2");
    expect(screen.getByText("/3")).toBeVisible();
    expect(screen.getByText("clients with no subscription in trouble")).toBeVisible();
    expect(
      screen.getByText("1 client past due, unpaid or incomplete"),
    ).toBeVisible();
  });

  it("never prints a composite health score, because nothing defines one", () => {
    const { container } = render(
      <FleetHealthPanel measurement={withSubscriptions(["active", "active"])} />,
    );

    // The canvas's 98.6, and any lookalike: a percentage in this panel would be a composite
    // assembled on the page out of numbers that were never defined against each other.
    expect(container.textContent).not.toMatch(/98\.6/);
    expect(container.textContent).not.toMatch(/%/);
    // "Healthy" is the canvas's word for an agent state this read does not carry.
    expect(container.textContent).not.toMatch(/healthy/i);
    expect(document.querySelector('[data-slot="fleet-health-exception"]')).toBeNull();
  });

  it("says there is no fleet rather than printing 0/0", () => {
    const base = measurement();
    render(
      <FleetHealthPanel measurement={{ ...base, tenantPerformance: [], subscriptions: [] }} />,
    );

    expect(
      screen.getByText("This snapshot names no client, so there is no fleet to count."),
    ).toBeVisible();
    expect(document.querySelector('[data-slot="fleet-health-figure"]')).toBeNull();
  });

  it("puts the hero and the fleet panel on one lead row", () => {
    render(<AdminOverviewSurface measurement={measurement()} role="owner" />);

    const row = document.querySelector('[data-slot="overview-lead-row"]');
    expect(row).toHaveClass("console-deck--lead");
    expect(row?.querySelector('[data-slot="overview-headline-hero"]')).not.toBeNull();
    expect(row?.querySelector('[data-slot="fleet-health-panel"]')).not.toBeNull();
  });
});
