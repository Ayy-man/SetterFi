import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/billing",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { OwnerMoney } from "@/components/workspace/rehaul/owner-money";
import type { MoneyBillingRead, MrrMovementRead } from "@/lib/repositories/billing";

const MOVEMENT: MrrMovementRead = {
  asOf: "2026-09-03T00:00:00.000Z",
  churnCents: -29_700,
  clientCount: 6,
  downgradeCents: -8_800,
  missingSources: [],
  mrrCents: 298_200,
  newCents: 59_700,
  scheduledCancellations: 1,
  upgradeCents: 20_000,
  windowStart: "2026-08-03T00:00:00.000Z",
};

const ROWS = [
  {
    accountStatus: "overdue",
    businessName: "Reid Funding Group",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: "2026-08-28T00:00:00.000Z",
    dataLabel: null,
    pendingEffectiveAt: null,
    pendingTierId: null,
    providerUpdatedAt: "2026-09-03T07:00:00.000Z",
    subscriptionStatus: "past_due",
    tenantId: "tenant-reid",
  },
  {
    accountStatus: "active",
    businessName: "Cedar Ridge Credit Coaching",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: "2026-09-12T00:00:00.000Z",
    dataLabel: null,
    pendingEffectiveAt: null,
    pendingTierId: null,
    providerUpdatedAt: "2026-09-03T07:00:00.000Z",
    subscriptionStatus: "active",
    tenantId: "tenant-cedar",
  },
];

function client(overrides: Partial<MoneyBillingRead["rows"][number]> = {}) {
  return {
    accountStatus: "active",
    businessName: "Cedar Ridge Credit Coaching",
    cancelAtPeriodEnd: false,
    countsAsLive: true,
    currentPeriodEnd: "2026-09-12T00:00:00.000Z",
    dataLabel: null,
    monthlyAmountCents: 29_700,
    pendingEffectiveAt: null,
    pendingTierId: null,
    plan: "Starter",
    providerUpdatedAt: "2026-09-03T07:00:00.000Z",
    status: "active",
    subscriptionStatus: "active",
    tenantId: "tenant-cedar",
    ...overrides,
  };
}

/** Twelve month ends; only the last `pricedFromEnd` of them carry a price. */
function periods(pricedFromEnd = 12) {
  return Array.from({ length: 12 }, (_, index) => ({
    mrrCents: index >= 12 - pricedFromEnd ? 200_000 + index * 10_000 : null,
    periodEnd: `2026-${String(index + 1).padStart(2, "0")}-28T00:00:00.000Z`,
    periodStart: `2026-${String(index + 1).padStart(2, "0")}-01T00:00:00.000Z`,
  }));
}

const BILLING: MoneyBillingRead = {
  mrrByPeriod: periods(),
  rows: [
    client({
      businessName: "Reid Funding Group",
      countsAsLive: false,
      monthlyAmountCents: 59_700,
      plan: "Growth",
      status: "past_due",
      subscriptionStatus: "past_due",
      tenantId: "tenant-reid",
    }),
    client(),
  ],
};

function renderBilling() {
  return render(
    <OwnerMoney
      actorRole="owner"
      authorized
      billing={BILLING}
      enabled
      initialRows={ROWS}
      movement={MOVEMENT}
      tab="billing"
    />,
  );
}

describe("OwnerMoney, billing tab", () => {
  it("names the page once and prints the recurring revenue figure", () => {
    renderBilling();

    expect(screen.getByRole("heading", { level: 1, name: "Money" })).toBeTruthy();
    expect(screen.getByText("$2,982.00")).toBeTruthy();
  });

  it("draws the four movement slices from the projection", () => {
    renderBilling();

    for (const label of ["New", "Upgrades", "Churn", "Downgrades"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("+$597.00")).toBeTruthy();
    expect(screen.getByText("−$297.00")).toBeTruthy();
  });

  it("orders the subscriptions worst first", () => {
    const { container } = renderBilling();

    const names = [...container.querySelectorAll("tbody tr td:first-child")]
      .map((cell) => cell.textContent?.trim());
    expect(names).toEqual(["Reid Funding Group", "Cedar Ridge Credit Coaching"]);
  });

  it("carries no explainer sentence from the surface it replaces", () => {
    const { container } = renderBilling();
    const text = container.textContent ?? "";

    expect(text).not.toContain("What the platform bills, and which subscriptions are in trouble.");
    expect(text).not.toContain("Upgrades, churn and downgrades against the opening balance");
    expect(text).not.toContain("No dollar figure: the subscription mirror carries no price");
  });

  it("offers the five Money sections and counts only what the page read", () => {
    renderBilling();

    const tabs = screen.getByRole("navigation", { name: "Money sections" });
    for (const label of ["Billing", "Costs", "Tiers", "Affiliates", "Corrections"]) {
      expect(tabs.textContent).toContain(label);
    }
    // The billing tab read no correction queue and no payout queue, so neither tab carries a
    // figure: a zero here would be a count nobody measured.
    expect(tabs.textContent?.replace(/[A-Za-z· ]/g, "")).toBe("");
  });
});

/**
 * The eye docks in the page header, per `EyeRule.dc.html`.
 *
 * Floating bottom-right is where a pane's action row ends, so the eye sat on top of a primary
 * action on the screens that have one. Money has a header row, so the eye is the last control in
 * it, at the same 32px as the Export button beside it. The row renders on every tab because the
 * eye belongs to the page, not to the one tab that happened to own the other controls.
 */
describe("OwnerMoney, context eye", () => {
  it("docks the eye in the page header, after Export, on every tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    const { container, rerender } = renderBilling();

    const eye = container.querySelector('[data-slot="context-eye"]');
    expect(eye).toHaveAttribute("data-placement", "header");
    const row = eye?.parentElement;
    expect(row?.lastElementChild).toBe(eye);
    expect(row?.textContent).toContain("Export");
    expect(screen.getByRole("button", { name: "About this screen" })).toBeTruthy();

    rerender(
      <OwnerMoney actorRole="owner" authorized enabled movement={MOVEMENT} tab="tiers" />,
    );
    await screen.findByRole("heading", { level: 1, name: "Money" });
    expect(container.querySelectorAll('[data-slot="context-eye"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="context-eye"]'))
      .toHaveAttribute("data-placement", "header");
  });
});

describe("OwnerMoney, honest states", () => {
  it("counts only active rows as live, so past due sits outside the number above it", () => {
    const { container } = renderBilling();

    const book = container.querySelector('[data-slot="owner-money-book"]');
    const figures = [...(book?.querySelectorAll("span.font-mono") ?? [])]
      .map((node) => node.textContent?.trim());
    // Two receipt-backed rows, one active and one past due: Live is 1, not 2.
    expect(figures.slice(0, 3)).toEqual(["1", "1", "0"]);
  });

  it("paints no bar for a slice the projection resolved at zero", () => {
    const { container } = render(
      <OwnerMoney
        actorRole="owner"
        authorized
        enabled
        initialRows={ROWS}
        movement={{ ...MOVEMENT, upgradeCents: 0 }}
        tab="billing"
      />,
    );

    const card = container.querySelector('[data-slot="owner-money-net-mrr"]');
    const filled = [...(card?.querySelectorAll("div.h-1\\.5.rounded-\\[3px\\]") ?? [])]
      .filter((node) => !node.className.includes("bg-[oklch(0.4_0.03_262)]"));
    // Four slices, three bars: the resolved-but-zero upgrade slice draws nothing.
    expect(filled).toHaveLength(3);
  });

  it("keeps the green off a net movement that is not positive", () => {
    const { container } = render(
      <OwnerMoney
        actorRole="owner"
        authorized
        enabled
        initialRows={ROWS}
        movement={{ ...MOVEMENT, newCents: 0, upgradeCents: 0 }}
        tab="billing"
      />,
    );

    const net = [...container.querySelectorAll('[data-slot="owner-money-net-mrr"] span')]
      .find((node) => node.textContent?.includes("this month"));
    expect(net?.className).toContain("oklch(0.82_0.10_32)");
  });

  it("draws the priced tail of the month-end series and nothing before it", () => {
    const { container } = render(
      <OwnerMoney
        actorRole="owner"
        authorized
        billing={{ ...BILLING, mrrByPeriod: periods(3) }}
        enabled
        initialRows={ROWS}
        movement={MOVEMENT}
        tab="billing"
      />,
    );

    const chart = container.querySelector('[data-slot="owner-money-mrr-chart"]');
    // Nine unpriced months are absent rather than drawn at the baseline.
    expect(chart?.querySelectorAll("svg rect")).toHaveLength(3);
    expect(chart?.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("withholds the chart until two month ends carry a price", () => {
    const { container } = render(
      <OwnerMoney
        actorRole="owner"
        authorized
        billing={{ ...BILLING, mrrByPeriod: periods(1) }}
        enabled
        initialRows={ROWS}
        movement={MOVEMENT}
        tab="billing"
      />,
    );

    const chart = container.querySelector('[data-slot="owner-money-mrr-chart"]');
    expect(chart?.querySelector("svg")).toBeNull();
    expect(chart?.textContent).toContain("No closed month with priced subscription evidence yet");
  });

  it("prints the plan and the monthly amount against each client", () => {
    const { container } = renderBilling();

    const rows = container.querySelectorAll('[data-slot="card-table"] tbody tr');
    const first = [...(rows[0]?.querySelectorAll("td") ?? [])]
      .map((cell) => cell.textContent?.trim());
    expect(first?.slice(0, 4)).toEqual([
      "Reid Funding Group",
      "Growth",
      "Past due",
      "$597.00",
    ]);
  });

  it("says so where the priced read carried no plan and no amount", () => {
    const { container } = render(
      <OwnerMoney
        actorRole="owner"
        authorized
        billing={{ ...BILLING, rows: [] }}
        enabled
        initialRows={ROWS}
        movement={MOVEMENT}
        tab="billing"
      />,
    );

    expect(container.textContent).toContain("no plan recorded");
    expect(container.textContent).toContain("no price recorded");
  });

  it("says only that no subscription row came back", () => {
    const { container } = render(
      <OwnerMoney actorRole="owner" authorized enabled initialRows={[]} movement={MOVEMENT} tab="billing" />,
    );

    expect(screen.getByText("No subscription rows returned")).toBeTruthy();
    expect(container.textContent).not.toContain("after the billing mirror returns a matching row");
  });
});
