import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function draw(overrides: Partial<CoachBillingSnapshot> = {}) {
  stubFetch();
  return render(
    <CoachBillingRehaul
      checkoutReturn={null}
      enabled
      initialSnapshot={{ ...snapshot, ...overrides }}
    />,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("CoachBillingRehaul, against Billing.dc.html", () => {
  it("shows a seeded plan by its name, without the marker the seeder staples on", () => {
    const { container } = draw({ isDemo: true, tierName: "Growth (demo)" });

    expect(screen.getByRole("heading", { level: 2, name: "Growth" })).toBeVisible();
    // A coach reading their own billing page is not chasing a record by its stored name, so the
    // marker has nothing to say here and appears nowhere on the screen.
    expect(container.textContent).not.toContain("(demo)");
  });

  /*
   * The artboard's plan card, which is the whole top-left of the screen: the allowance as the
   * figure, the price and the period as footer stats beside it, and the phrase that says what the
   * figure counts. The price is deliberately not the figure -- it is a number agreed once, and
   * the allowance is the one that moves.
   */
  it("carries the plan, the price, the period and the allowance in one card", () => {
    draw();

    expect(screen.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
    expect(screen.getByText("Your plan")).toBeVisible();
    expect(screen.getByText("$597.00")).toBeVisible();
    expect(screen.getByText("a month")).toBeVisible();
    expect(screen.getByText("Aug 7, 2026 to Sep 7, 2026")).toBeVisible();
  });

  it("reads the allowance as a figure and a phrase, and draws no bar for it", () => {
    const { container } = draw();

    expect(container.querySelector('[data-slot="billing-allowance"]')?.textContent).toBe("18");
    expect(screen.getByText("of 25")).toBeVisible();
    expect(container.querySelector('[data-slot="billing-allowance-phrase"]')?.textContent)
      .toBe("Booked calls this billing period. Resets September 7.");
    // SIMPLIFICATION-SPEC 2.8 and the artboard both draw the ratio as words. A meter under the
    // figure said the same thing a second time, which is the fact-twice defect the audit records.
    expect(container.querySelector('[data-slot="meter"]')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  /*
   * The projection carries no overage rate. Absence is content: the stat states it in the slot
   * the figure would occupy rather than printing a number the page cannot check, or vanishing and
   * leaving a coach to assume there is no charge past the allowance.
   */
  it("states the missing overage rate in words rather than inventing one", () => {
    draw();

    expect(screen.getByText("Over the allowance")).toBeVisible();
    expect(screen.getByText("Not stated on your record")).toBeVisible();
  });

  it("spends exactly one accent fill, on Change plan", () => {
    const { container } = draw();

    const filled = container.querySelectorAll('[class*="--accent-fill"]');
    expect(filled).toHaveLength(1);
    expect(filled[0].textContent).toBe("Change plan");
  });

  /*
   * SIMPLIFICATION-SPEC 2.8 kills the five caps overlines and keeps the blocks under sentence-case
   * headings. Every category line on this screen is now the panel eyebrow, sentence case, and the
   * assertion is on the exact strings so a re-shout fails rather than merely looking different.
   */
  it("labels its blocks in sentence case, with no caps overline anywhere", () => {
    const { container } = draw();

    const eyebrows = [...container.querySelectorAll(".coach-panel__eyebrow")]
      .map((node) => node.textContent);
    expect(eyebrows).toEqual(["Your plan", "Booked calls", "Only you can tell us"]);
    for (const eyebrow of eyebrows) expect(eyebrow).not.toBe(eyebrow!.toUpperCase());
  });

  /*
   * "Right instinct, too much form." The previous pass drew a picker of billable events, a reason
   * field, an in-flight status and a standing Logged caption for one sentence. The artboard draws
   * a button that opens a box.
   */
  it("hides the correction box behind one button and offers no picker", () => {
    const { container } = draw();

    expect(screen.queryByLabelText(/What should the count be/)).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "This count looks wrong" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    expect(screen.getByLabelText(/What should the count be/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Send to support/ })).toBeVisible();
    // The draft machinery. A native select is banned outright and the kit's own picker was the
    // second control this card had for one request.
    expect(container.querySelector("select")).toBeNull();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("posts the coach's words as the reason, anchored to the latest billed call", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => new Response(
      JSON.stringify(
        String(input).includes("/api/billing/checkout")
          ? activeCheckout
          : { result: { state: "requested", requestId: "req-1", requestAuditId: 7 } },
      ),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    render(<CoachBillingRehaul checkoutReturn={null} enabled initialSnapshot={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "This count looks wrong" }));
    fireEvent.change(screen.getByLabelText(/What should the count be/), {
      target: { value: "Two of these were the same person." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send to support/ }));

    await waitFor(() => expect(screen.getByText("Correction request logged")).toBeVisible());
    const posted = fetchMock.mock.calls
      .map(([, init]) => init)
      .filter((init): init is RequestInit => Boolean(init?.body))
      .map((init) => JSON.parse(String(init.body)));
    expect(posted).toContainEqual({
      action: "request_correction",
      eventId: "event-1",
      quantityDelta: -1,
      reason: "Two of these were the same person.",
    });
  });

  it("says there is nothing to correct when no call was billed this period", () => {
    draw({ correctionCandidates: [] });

    fireEvent.click(screen.getByRole("button", { name: "This count looks wrong" }));

    expect(screen.getByText("No billed calls are recorded for this period yet.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Send to support/ })).not.toBeInTheDocument();
  });

  /* Two large buttons per row and no third one. Skip was the form asking about itself. */
  it("asks the attendance question with two buttons per row", () => {
    draw();

    expect(screen.getByText("How did these appointments go?")).toBeVisible();
    expect(screen.getByText("Maria Pena")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Showed" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "No-show" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Skip/ })).not.toBeInTheDocument();
  });

  it("records an answer and drops the row it answered", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(
      JSON.stringify(
        String(input).includes("/api/billing/checkout")
          ? activeCheckout
          : { result: { auditId: 3, billableQuantity: 18 } },
      ),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    )));
    render(<CoachBillingRehaul checkoutReturn={null} enabled initialSnapshot={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Showed" }));

    await waitFor(() => expect(screen.getByText("Attendance logged")).toBeVisible());
    expect(screen.queryByRole("button", { name: "Showed" })).not.toBeInTheDocument();
  });

  /*
   * The demo tenant's invariant, stated rather than seeded around: every billable row on a demo
   * tenant carries `is_test` and the projections exclude it, so this list is empty by design. An
   * empty card with no sentence reads as a screen that failed to load.
   */
  it("names why the list is empty on a demo workspace", () => {
    const { container } = draw({ isDemo: true, outcomePrompts: [] });

    expect(container.querySelector('[data-slot="billing-attendance-absent"]')?.textContent)
      .toBe(
        "No calls are listed here. This is a demo workspace, so its bookings are marked as test "
        + "data and never billed.",
      );
  });

  it("states a plain absence on a real workspace with nothing waiting", () => {
    const { container } = draw({ outcomePrompts: [] });

    expect(container.querySelector('[data-slot="billing-attendance-absent"]')?.textContent)
      .toBe("No appointments are waiting for an answer.");
  });

  /* One line, inside the plan card, and only when something is outstanding. */
  it("carries no notice line when the billing record has nothing outstanding", () => {
    const { container } = draw();

    expect(container.querySelector('[data-slot="billing-notice"]')).toBeNull();
  });

  it("folds an outstanding notice into a single line in the plan card", () => {
    const { container } = draw({
      notices: [{
        id: "notice-1",
        kind: "warning",
        state: "queued",
        deliveryReceiptId: null,
        billingContactSource: "tenant billing contact",
      }],
    });

    const line = container.querySelector('[data-slot="billing-notice"]');
    expect(line?.textContent).toContain("1 allowance notice has not reached your billing contact");
    expect(container.querySelectorAll('[data-slot="billing-notice"]')).toHaveLength(1);
    // The line lives in the plan card rather than in a notices block of its own.
    expect(container.querySelector('[data-slot="billing-plan"]')).toContainElement(
      line as HTMLElement,
    );
  });

  it("puts an overdue account ahead of a queued notice in that one line", () => {
    const { container } = draw({
      accountState: "overdue",
      notices: [{
        id: "notice-1",
        kind: "warning",
        state: "queued",
        deliveryReceiptId: null,
        billingContactSource: "tenant billing contact",
      }],
    });

    const lines = container.querySelectorAll('[data-slot="billing-notice"]');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain("Payment is overdue");
  });

  it("prints none of the explainer sentences the old page carried", () => {
    draw();

    expect(
      screen.queryByText(/They do not change what you are billed/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/a person checks it against the conversations/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Stripe collects payment/)).not.toBeInTheDocument();
  });

  /*
   * `/api/billing/checkout` answers 404 whenever `checkoutAttemptsLive()` is off, which is every
   * deployment where hosted Stripe checkout is not configured. Reading that as a failed
   * verification printed "Checkout status could not be verified" in red, plus a "Checkout
   * unavailable" pill over an empty "Activate your plan" card, on a screen whose own snapshot says
   * the subscription is active and paid. SIMPLIFICATION-SPEC 2.8 calls the whole return path
   * invisible plumbing, so an unreadable checkout now says nothing at all.
   */
  it("says nothing about checkout when the route reports it is not configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
      String(input).includes("/api/billing/checkout")
        ? new Response(JSON.stringify({ error: "Not found." }), {
          headers: { "Content-Type": "application/json" }, status: 404,
        })
        : new Response(JSON.stringify({ snapshot }), {
          headers: { "Content-Type": "application/json" }, status: 200,
        })
    )));
    const { container } = render(
      <CoachBillingRehaul checkoutReturn={null} enabled initialSnapshot={snapshot} />,
    );

    await waitFor(() => expect(screen.getByText("$597.00")).toBeVisible());
    expect(screen.queryByText(/Checkout status could not be verified/)).not.toBeInTheDocument();
    expect(screen.queryByText("Checkout unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Activate your plan")).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="billing-notice"]')).toBeNull();
  });

  /* An offer that stands is the one checkout state a coach can act on, so it gets the line. */
  it("offers checkout in the notice line when a plan is not paid for yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(
      JSON.stringify(
        String(input).includes("/api/billing/checkout")
          ? {
            checkout: {
              state: "offered",
              attempt: null,
              offer: {
                tierId: "tier-1",
                label: "Growth",
                amountCents: 59_700,
                currency: "USD",
                interval: "month",
                effectiveTo: null,
              },
            },
          }
          : { snapshot },
      ),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    )));
    render(<CoachBillingRehaul checkoutReturn={null} enabled initialSnapshot={snapshot} />);

    expect(await screen.findByText("This plan is not paid for yet.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue to checkout" })).toBeVisible();
  });
});
