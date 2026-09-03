import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/billing",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { OwnerMoney } from "@/components/workspace/rehaul/owner-money";
import type { MrrMovementRead } from "@/lib/repositories/billing";

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

function renderBilling() {
  return render(
    <OwnerMoney
      actorRole="owner"
      authorized
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
