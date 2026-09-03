import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  AffiliatePayoutView,
  AffiliateReferralView,
} from "@/components/workspace/live/affiliate-money";
import { AffiliateHome } from "@/components/workspace/rehaul/affiliate-home";

const referrals: readonly AffiliateReferralView[] = [
  { accountStatus: "paying", businessName: "Cedar Ridge Credit Coaching", commissionEarnedCents: 29_800 },
  { accountStatus: "paying", businessName: "Bright Path Credit", commissionEarnedCents: 29_800 },
  { accountStatus: "payment_problem", businessName: "Northstar Funding", commissionEarnedCents: 14_900 },
  { accountStatus: "setting_up", businessName: "Harbor Credit Lab", commissionEarnedCents: 0 },
  { accountStatus: "cancelled", businessName: "Summit Capital Coaching", commissionEarnedCents: 14_900 },
];

const payouts: readonly AffiliatePayoutView[] = [
  { amountCents: 160_000, recordedOn: "2026-08-04", reference: "SFI-4390", state: "sent" },
  { amountCents: 161_000, recordedOn: "2026-09-02", reference: "SFI-4471", state: "sent" },
  { amountCents: 12_500, recordedOn: null, reference: null, state: "approved_for_payout" },
];

function renderHome() {
  return render(
    <AffiliateHome
      enabled
      initialPayouts={payouts}
      initialReferralCode="AVA-2026"
      initialReferralLink="https://setterfi.test/signup?ref=AVA-2026"
      initialReferrals={referrals}
      termsCopy={null}
    />,
  );
}

describe("AffiliateHome", () => {
  it("renders the title, the three figures and the last bank reference", () => {
    const { container } = renderHome();

    expect(screen.getByRole("heading", { level: 1, name: "Your referrals" })).toBeVisible();
    expect(container.querySelector('[data-slot="affiliate-referral-count"]')?.textContent)
      .toBe("5");
    expect(container.querySelector('[data-slot="affiliate-earned"]')?.textContent)
      .toBe("$894.00");
    expect(container.querySelector('[data-slot="affiliate-paid-out"]')?.textContent)
      .toBe("$3,210.00");
    expect(screen.getByText("Last reference SFI-4471, Sep 2, 2026.")).toBeVisible();
    expect(container.querySelector('[data-slot="affiliate-status"]')?.textContent)
      .toContain("2 of your 5 coaches are paying");
  });

  it("shows only name, status and commission, never performance data", () => {
    const { container } = renderHome();

    const headers = Array.from(
      container.querySelectorAll('[data-slot="affiliate-referral-table"] thead th'),
    ).map((cell) => cell.textContent);
    expect(headers).toEqual(["Referred coach", "Status", "Commission earned"]);
    expect(screen.getByText("Northstar Funding")).toBeVisible();
    expect(screen.getByText("Payment problem")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Export/ }).length).toBeGreaterThan(0);
  });

  it("draws one commission bar, because one period is what the projection carries", () => {
    const { container } = renderHome();

    const chart = container.querySelector('[data-slot="bar-chart"]');
    expect(chart).not.toBeNull();
    expect(chart?.querySelectorAll("rect")).toHaveLength(1);
    expect(chart?.querySelectorAll('[data-slot="bar-current"]')).toHaveLength(1);
  });

  it("prints none of the explainer sentences the old page carried", () => {
    renderHome();

    expect(
      screen.queryByText(/Coaches who signed up through your code/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Their leads, conversations and revenue are theirs alone/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/SetterFi records the payment, your bank makes it\./),
    ).not.toBeInTheDocument();
  });
});
