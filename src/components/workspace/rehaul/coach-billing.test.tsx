import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoachBillingSnapshot } from "@/components/workspace/live/coach-billing";
import { CoachBillingRehaul } from "@/components/workspace/rehaul/coach-billing";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const snapshot: CoachBillingSnapshot = {
  tierName: "Growth",
  priceCents: 59_700,
  currency: "USD",
  periodStart: "2026-08-08T00:00:00.000Z",
  periodEnd: "2026-09-08T00:00:00.000Z",
  timezone: "America/New_York",
  bookedCount: 18,
  callAllowance: 25,
  subscriptionState: "active",
  invoiceState: "paid",
  accountState: "active",
  pendingMovement: null,
  notices: [],
  correctionCandidates: [{ eventId: "event-1", label: "Maria Pena, 28 Aug" }],
  outcomePrompts: [
    { appointmentId: "appt-1", label: "Maria Pena", occurredAt: "2026-08-28T18:30:00.000Z" },
  ],
  isDemo: false,
};

const activeCheckout = {
  checkout: { state: "active", offer: null, attempt: null },
};

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(
    JSON.stringify(
      String(input).includes("/api/billing/checkout") ? activeCheckout : { snapshot },
    ),
    { headers: { "Content-Type": "application/json" }, status: 200 },
  )));
}

afterEach(() => vi.unstubAllGlobals());

describe("CoachBillingRehaul", () => {
  it("renders the title, the charge and the attendance verbs", () => {
    stubFetch();
    render(<CoachBillingRehaul checkoutReturn={null} enabled initialSnapshot={snapshot} />);

    expect(screen.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
    expect(screen.getByText("$597.00")).toBeVisible();
    expect(screen.getByText("Did they show up?")).toBeVisible();
    expect(screen.getByRole("button", { name: /Showed/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /No show/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Skip/ })).toBeVisible();
    expect(screen.getByText("Ask us to change your plan")).toBeVisible();
  });

  it("draws one bar per period the projection carries", () => {
    stubFetch();
    const { container } = render(
      <CoachBillingRehaul checkoutReturn={null} enabled initialSnapshot={snapshot} />,
    );

    const chart = container.querySelector('[data-slot="bar-chart"]');
    expect(chart).not.toBeNull();
    expect(chart?.querySelectorAll("rect")).toHaveLength(1);
    expect(chart?.querySelectorAll('[data-slot="bar-current"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="billing-allowance"]')?.textContent)
      .toBe("18/25");
  });

  it("prints none of the explainer sentences the old page carried", () => {
    stubFetch();
    render(<CoachBillingRehaul checkoutReturn={null} enabled initialSnapshot={snapshot} />);

    expect(
      screen.queryByText(/What you pay, what you have used, and how the calls went\./),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/They do not change what you are billed/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/a person checks it against the conversations/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Stripe collects payment/)).not.toBeInTheDocument();
  });
});
