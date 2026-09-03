import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AdminMoneyBilling,
  receiptBackedCount,
} from "@/components/workspace/live/admin-money-billing";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

type SubscriptionFixture = {
  tenantId: string;
  businessName: string;
  accountStatus: string;
  subscriptionStatus: string | null;
  providerUpdatedAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pendingTierId: string | null;
  pendingEffectiveAt: string | null;
  dataLabel: string | null;
};

const subscription: SubscriptionFixture = {
  tenantId: "tenant-synthetic-1",
  businessName: "Northstar Capital Coaching",
  accountStatus: "active",
  subscriptionStatus: "past_due",
  providerUpdatedAt: "2026-08-22T14:30:00.000Z",
  currentPeriodEnd: "2026-09-22T14:30:00.000Z",
  cancelAtPeriodEnd: false,
  pendingTierId: null,
  pendingEffectiveAt: null,
  dataLabel: null,
};

const costPeriod = {
  rollupId: "rollup-1",
  tenantId: "tenant-synthetic-1",
  businessName: "Northstar Capital Coaching",
  windowStart: "2026-07-01T00:00:00.000Z",
  windowEnd: "2026-07-31T00:00:00.000Z",
  revenueCents: 100_000,
  modelCostCents: 20_000,
  messagingCostCents: 10_000,
  embeddingCostCents: 5_000,
  complete: true,
  missingSources: null,
  sourceEvidenceAt: "2026-08-01T00:00:00.000Z",
  dataLabel: null,
};

/** Lets the kebab popup finish closing so the sheet it opens is mounted. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 600));
}

function renderBilling(
  initialRows: SubscriptionFixture[] = [subscription],
  initialCostRows: Record<string, unknown>[] = [],
) {
  return render(
    <AdminMoneyBilling
      actorRole="admin"
      authorized
      enabled
      initialCostRows={initialCostRows}
      initialRows={initialRows}
      movement={null}
      surface="billing"
    />,
  );
}

describe("AdminMoneyBilling", () => {
  it("opens the row-scoped state flow with no option selected", async () => {
    renderBilling();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Actions for Northstar Capital Coaching",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Change account state/ }),
    );

    // Base UI closes the kebab popup before the account-state sheet mounts, so the sheet lands a
    // frame later than the menu press.
    await settle();
    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(3);
    for (const option of options) expect(option).not.toBeChecked();

    const confirmButton = screen.getByRole("button", {
      name: "Confirm account state",
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Payment follow-up was completed without resolution." },
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: /Suspended/i }));
    expect(
      screen.getByRole("button", { name: /Suspend account/i }),
    ).toBeEnabled();
  });

  it("bands the rows by state and puts the day count in the Movement column", () => {
    renderBilling([
      { ...subscription, currentPeriodEnd: "2026-08-19T14:30:00.000Z" },
    ]);

    // The state is the band header. A pill column repeating it on every row would say what the
    // band above the row already says, so it is gone and Movement carries what the band cannot.
    const band = document.querySelector('[data-slot="data-table-group-row"]');
    expect(band).toHaveAttribute("data-group-id", "Past due");
    expect(band).toHaveTextContent("Past due");
    expect(
      screen.getByRole("columnheader", { name: /Movement/ }),
    ).toBeVisible();
    expect(screen.getByText(/^Past due, \d+ days?$/)).toBeVisible();
  });

  it("keeps both raw states readable in the row's account-state drawer", async () => {
    renderBilling();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Actions for Northstar Capital Coaching",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Change account state/ }),
    );

    await settle();
    const drawer = within(screen.getByRole("dialog"));
    expect(drawer.getByText("Account state").parentElement).toHaveTextContent(
      "Active",
    );
    expect(drawer.getByText("Provider state")).toBeVisible();
    expect(drawer.getByText("Past due")).toBeVisible();
    expect(drawer.getByText("Provider evidence at")).toBeVisible();
  });

  it("titles the page and keeps the admin-only cost economics off it", () => {
    renderBilling();

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Revenue and subscriptions",
      }),
    ).toBeVisible();
    // Cost economics is reachable, but as a quiet link rather than the page's primary action.
    expect(screen.getByRole("link", { name: "Cost evidence" })).toHaveAttribute(
      "href",
      "/admin/billing/costs",
    );
    expect(
      screen.queryByRole("columnheader", { name: /Margin/ }),
    ).not.toBeInTheDocument();
  });

  it("reads the receipt-backed counts on the summary strip", () => {
    renderBilling();

    const summary = within(screen.getByLabelText("Revenue summary"));
    expect(
      summary.getByText("Live subscriptions").parentElement,
    ).toHaveTextContent("1");
    expect(summary.getByText("Past due").parentElement).toHaveTextContent("1");
  });

  it("collapses the three receipt counts into one tile rather than repeating the same sentence", () => {
    renderBilling([
      { ...subscription, dataLabel: "Demo" },
      {
        ...subscription,
        tenantId: "tenant-synthetic-2",
        providerUpdatedAt: null,
      },
      {
        ...subscription,
        tenantId: "tenant-synthetic-3",
        subscriptionStatus: null,
      },
    ]);

    const summary = within(screen.getByLabelText("Revenue summary"));
    // Three tiles printing the same "no receipt" line is a wall of grey, not three facts.
    expect(summary.queryByText("Live subscriptions")).toBeNull();
    expect(summary.queryByText("Past due")).toBeNull();
    expect(summary.queryByText("Cancelling at renewal")).toBeNull();
    const tile = summary.getByText("Receipt-backed subscriptions")
      .parentElement as HTMLElement;
    expect(tile.textContent).not.toMatch(/\d/);
    expect(
      within(tile).getByText("No row carries a provider receipt yet"),
    ).toBeInTheDocument();
  });

  it("carries the demo claim at page level once every subscription is seeded", () => {
    // Once every row is seeded the table drops its per-row chip, so the page-level claim is the
    // only thing on screen saying the set is demo. A per-row assertion cannot catch its removal,
    // which is how a fully seeded page ends up claiming nothing at all. The whole-page arm is the
    // chip above the title now; the mixed arm below is still the sentence, and never both.
    const { unmount } = renderBilling([
      { ...subscription, dataLabel: "Demo" },
      { ...subscription, tenantId: "tenant-synthetic-2", dataLabel: "Demo" },
    ]);
    expect(document.querySelector('[data-slot="provenance-chip"]')).toHaveAttribute(
      "data-provenance",
      "demo",
    );
    expect(
      screen.queryByText("Demo rows are labelled in the table and excluded from analytics."),
    ).toBeNull();
    unmount();

    renderBilling([
      { ...subscription, dataLabel: "Demo" },
      { ...subscription, tenantId: "tenant-synthetic-2", dataLabel: null },
    ]);
    expect(
      screen.getByText(
        "Demo rows are labelled in the table and excluded from analytics.",
      ),
    ).toBeInTheDocument();
  });

  it("excludes demo, test, and unreceipted rows from subscription counts", () => {
    const rows = [
      subscription,
      { ...subscription, tenantId: "tenant-synthetic-2", dataLabel: "Demo" },
      { ...subscription, tenantId: "tenant-synthetic-3", dataLabel: "Test" },
      {
        ...subscription,
        tenantId: "tenant-synthetic-4",
        providerUpdatedAt: null,
      },
      {
        ...subscription,
        tenantId: "tenant-synthetic-5",
        subscriptionStatus: null,
      },
    ].map((row, index) => ({ ...row, rowKey: `subscription-${index}` }));

    expect(receiptBackedCount("all", rows)).toBe(1);
    expect(receiptBackedCount("past-due", rows)).toBe(1);
  });

  it("leaves counts absent without a receipt-backed real subscription", () => {
    const rows = [
      { ...subscription, dataLabel: "Demo" },
      {
        ...subscription,
        tenantId: "tenant-synthetic-2",
        providerUpdatedAt: null,
      },
      {
        ...subscription,
        tenantId: "tenant-synthetic-3",
        subscriptionStatus: null,
      },
    ].map((row, index) => ({ ...row, rowKey: `subscription-${index}` }));

    expect(receiptBackedCount("all", rows)).toBeNull();
    expect(receiptBackedCount("past-due", rows)).toBeNull();
  });

  it("filters provider-paused subscriptions apart from suspended accounts", async () => {
    const user = userEvent.setup();
    const providerPaused = {
      ...subscription,
      tenantId: "tenant-synthetic-2",
      businessName: "Provider Paused Coaching",
      subscriptionStatus: "paused",
    };
    const manuallySuspended = {
      ...subscription,
      tenantId: "tenant-synthetic-3",
      businessName: "Manually Suspended Coaching",
      accountStatus: "suspended",
      subscriptionStatus: "active",
    };
    renderBilling([providerPaused, manuallySuspended]);

    await user.click(screen.getByRole("button", { name: /Subscription view/ }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: /Paused/ }),
    );

    expect(
      subscriptionTable().getByText("Provider Paused Coaching"),
    ).toBeInTheDocument();
    expect(
      subscriptionTable().queryByText("Manually Suspended Coaching"),
    ).not.toBeInTheDocument();
  });
});

describe("AdminMoneyBilling cost rows from the server", () => {
  it("reads the cost periods it was handed instead of waiting for a fetch it skipped", async () => {
    renderBilling([subscription], [costPeriod]);
    await openCostTab();

    // The cost read is skipped whenever the server supplied rows, so state that ignores them
    // leaves every client's Cost tab claiming no period was ever recorded.
    expect(screen.getByText("Jun 30, 2026 to Jul 30, 2026")).toBeVisible();
    expect(screen.getByText("$1,000.00")).toBeVisible();
    expect(screen.queryByText(/No source-backed cost period/)).toBeNull();
  });
});

function segmentWidths() {
  return [...document.querySelectorAll('[data-slot="proportion-segment"]')].map(
    (node) => (node as HTMLElement).style.width,
  );
}

/**
 * The at-risk card names the same accounts the table does, so an unscoped text query now matches
 * twice. Every account lookup here means the table row, so it is scoped to the table's own region.
 */
function subscriptionTable() {
  return within(screen.getByRole("region", { name: "Subscriptions" }));
}

async function openCostTab() {
  await userEvent.click(subscriptionTable().getByText("Northstar Capital Coaching"));
  await userEvent.click(await screen.findByRole("tab", { name: "Cost" }));
}

describe("AdminMoneyBilling row texture", () => {
  it("ranks the past-due rows against the deepest one on screen", () => {
    renderBilling([
      { ...subscription, currentPeriodEnd: "2026-08-10T00:00:00.000Z" },
      {
        ...subscription,
        businessName: "Second Chance Funding",
        tenantId: "tenant-synthetic-2",
        currentPeriodEnd: "2026-07-21T00:00:00.000Z",
      },
    ]);

    // Two rows, two bars, and the deeper run fills the track it set the scale for. The day counts
    // move with the clock, so the assertion is on the ranking rather than on two fixed widths.
    const widths = segmentWidths().map((width) => Number.parseFloat(width));
    expect(widths).toHaveLength(2);
    expect(Math.max(...widths)).toBeCloseTo(100, 5);
    expect(Math.min(...widths)).toBeLessThan(100);
  });

  it("still draws a bar where one past-due row is the whole scale", () => {
    renderBilling([
      { ...subscription, currentPeriodEnd: "2026-08-10T00:00:00.000Z" },
    ]);

    // One row sets the scale and fills it, and its label says why: it is the longest run on this
    // screen because it is the only one. Withholding the bar until a second row appeared meant
    // the mechanism could not fire on the set an admin usually opens -- one account in trouble --
    // so every row paid the reserved 48px gutter for a bar that never came.
    expect(segmentWidths()).toEqual(["100%"]);
    expect(screen.getByText(/^Past due, \d+ days?$/)).toBeVisible();
  });

  it("reserves the bar's gutter only on the rows that can draw one", () => {
    renderBilling([
      { ...subscription, currentPeriodEnd: "2026-08-10T00:00:00.000Z" },
      {
        ...subscription,
        businessName: "Steady State Funding",
        subscriptionStatus: "active",
        tenantId: "tenant-synthetic-3",
      },
    ]);

    const gutters = document.querySelectorAll(".w-\\[3rem\\]");
    expect(gutters).toHaveLength(1);
  });
});

describe("AdminMoneyBilling cost composition", () => {
  it("shows where a period's revenue went, with every figure in the legend", async () => {
    renderBilling([subscription], [costPeriod]);
    await openCostTab();

    // 20%, 10% and 5% of revenue, leaving 65% of the track as bare margin: the shape answers
    // "is cost a sliver or most of it" without reading a digit.
    expect(segmentWidths()).toEqual(["20%", "10%", "5%"]);
    expect(
      screen.getByRole("img", {
        name: "Model 20%, Messaging 10%, Embedding 5% of revenue; 65% left as margin.",
      }),
    ).toBeInTheDocument();
    // The bar is a shape, and a shape is not a number, so the legend still carries the figures.
    expect(screen.getByText("Model $200.00")).toBeVisible();
    expect(screen.getByText("Embedding $50.00")).toBeVisible();
  });

  it("fills the track when cost ran past revenue instead of clamping it flat", async () => {
    renderBilling(
      [subscription],
      [
        {
          ...costPeriod,
          embeddingCostCents: null,
          messagingCostCents: 60_000,
          modelCostCents: 90_000,
        },
      ],
    );
    await openCostTab();

    expect(segmentWidths()).toEqual(["60%", "40%"]);
    expect(
      screen.getByRole("img", { name: /Cost ran past revenue/ }),
    ).toBeInTheDocument();
  });

  it("draws no bar for a period that is missing a cost source", async () => {
    renderBilling(
      [subscription],
      [{ ...costPeriod, complete: false, missingSources: "embedding" }],
    );
    await openCostTab();

    // Two of three sources drawn would read as a cheap client when it is really an unmeasured
    // one. The Evidence line below names what is missing instead.
    expect(segmentWidths()).toEqual([]);
    expect(screen.getByText("Sources missing: embedding")).toBeVisible();
  });

  it("draws no revenue line off a single recorded period", async () => {
    renderBilling([subscription], [costPeriod]);
    await openCostTab();

    // One reading is a dot, not a direction.
    expect(document.querySelector('[data-slot="sparkline"]')).toBeNull();
  });

  it("draws no revenue line off a run too short to smooth", async () => {
    renderBilling(
      [subscription],
      [
        {
          ...costPeriod,
          revenueCents: 40_000,
          rollupId: "rollup-3",
          windowStart: "2026-06-01T00:00:00.000Z",
        },
        costPeriod,
      ],
    );
    await openCostTab();

    // Two readings are enough to compute a direction and not enough to draw one: the smoothed
    // curve would be inventing every point between them. The period blocks carry the figures.
    expect(document.querySelector('[data-slot="sparkline"]')).toBeNull();
  });

  it("draws the revenue line across the periods, oldest first, skipping unrecorded ones", async () => {
    renderBilling(
      [subscription],
      [
        { ...costPeriod, revenueCents: 40_000, rollupId: "r-2", windowStart: "2026-02-01T00:00:00.000Z" },
        { ...costPeriod, revenueCents: 50_000, rollupId: "r-3", windowStart: "2026-03-01T00:00:00.000Z" },
        { ...costPeriod, revenueCents: 60_000, rollupId: "r-4", windowStart: "2026-04-01T00:00:00.000Z" },
        { ...costPeriod, revenueCents: null, rollupId: "r-5", windowStart: "2026-05-01T00:00:00.000Z" },
        { ...costPeriod, revenueCents: 70_000, rollupId: "r-6", windowStart: "2026-06-01T00:00:00.000Z" },
        { ...costPeriod, revenueCents: 80_000, rollupId: "r-7", windowStart: "2026-06-15T00:00:00.000Z" },
        costPeriod,
      ],
    );
    await openCostTab();

    // Seven periods, one with no recorded revenue: it is dropped rather than plotted as a zero the
    // client never billed, so the line runs across six readings and claims nothing about May.
    expect(
      screen.getByRole("img", {
        name: "Revenue across 6 recorded periods, $400.00 to $1,000.00",
      }),
    ).toBeInTheDocument();
  });
});
