import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CoachBilling,
  parseBillingCheckoutState,
  type CoachBillingSnapshot,
  validatedStripeCheckoutUrl,
} from "@/components/workspace/live/coach-billing";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const suspendedSnapshot: CoachBillingSnapshot = {
  tierName: "Growth",
  priceCents: 49_700,
  currency: "USD",
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  timezone: "America/New_York",
  bookedCount: 18,
  callAllowance: 25,
  subscriptionState: "past_due",
  invoiceState: "past_due",
  accountState: "suspended",
  pendingMovement: null,
  notices: [],
  correctionCandidates: [],
  outcomePrompts: [],
  isDemo: false,
};

afterEach(() => vi.unstubAllGlobals());

const offeredCheckout = {
  checkout: {
    state: "offered",
    offer: {
      tierId: "tier-growth",
      label: "Growth",
      currency: "USD",
      amountCents: 49_700,
      interval: "month",
      effectiveTo: null,
    },
    attempt: null,
  },
};

describe("CoachBilling", () => {
  it("marks suspended wording as draft copy without exposing the internal review note", () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/api/billing/checkout")
        ? offeredCheckout
        : { snapshot: suspendedSnapshot },
    ), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })));

    render(<CoachBilling enabled initialSnapshot={suspendedSnapshot} />);

    expect(screen.getByText("Draft copy")).toBeVisible();
    expect(screen.getByText("This account is suspended")).toBeVisible();
    expect(screen.queryByText(/demo placeholder/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/internal review note/i)).not.toBeInTheDocument();
  });

  it("renders the server-authorized offer and sends only its opaque tier id", async () => {
    const user = userEvent.setup();
    let release!: (response: Response) => void;
    const checkoutPost = new Promise<Response>((resolve) => { release = resolve; });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/billing/checkout") && init?.method === "POST") {
        return checkoutPost;
      }
      return new Response(JSON.stringify(
        String(input).includes("/api/billing/checkout")
          ? offeredCheckout
          : { snapshot: null },
      ), { headers: { "Content-Type": "application/json" }, status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    render(<CoachBilling enabled />);
    const action = await screen.findByRole("button", { name: "Continue to checkout" });
    await user.click(action);
    await user.click(action);

    const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ tierId: "tier-growth" });
    expect(action).toBeDisabled();
    release(new Response(JSON.stringify({ error: "refused" }), {
      headers: { "Content-Type": "application/json" },
      status: 409,
    }));
    await waitFor(() => expect(screen.getByText(/nothing was charged/i)).toBeVisible());
  });

  it("does not call a cancellation return payment and labels retry intent explicitly", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/api/billing/checkout")
        ? {
          checkout: {
            ...offeredCheckout.checkout,
            state: "pending",
            attempt: { outcome: "pending", expiresAt: "2026-09-01T00:30:00.000Z" },
          },
        }
        : { snapshot: null },
    ), { headers: { "Content-Type": "application/json" }, status: 200 }));
    vi.stubGlobal("fetch", fetch);

    render(<CoachBilling checkoutReturn="canceled" enabled />);

    expect(await screen.findByText("Checkout canceled in this browser")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try checkout again" })).toBeVisible();
    expect(screen.queryByText("Subscription active")).not.toBeInTheDocument();
  });

  it("treats a success return as pending until local provider read-back is active", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/api/billing/checkout")
        ? {
          checkout: {
            ...offeredCheckout.checkout,
            state: "pending",
            attempt: { outcome: "pending", expiresAt: "2026-09-01T00:30:00.000Z" },
          },
        }
        : { snapshot: null },
    ), { headers: { "Content-Type": "application/json" }, status: 200 })));

    render(<CoachBilling checkoutReturn="returned" enabled />);

    expect(await screen.findByText("Waiting for Stripe confirmation")).toBeVisible();
    expect(screen.getByText(/does not prove payment/i)).toBeVisible();
    expect(screen.queryByText("Subscription active")).not.toBeInTheDocument();
  });

  /**
   * The drift this catches: the plan-change panel growing a claim the billing record cannot back.
   *
   * The `CoachPlanChange` artboard states four consequences and two buttons. Only three of the
   * consequences survive contact with the data: `allowance_actions` gives a tier name, a price and
   * an `effective_at` that `allowances.ts` pins to the period end and Stripe honours at
   * `proration_behavior: "none"`. It does NOT give the new tier's allowance -- the projection
   * returns `pending_tier_name` and `pending_price_cents` and stops -- there is no per-extra-call
   * rate on `tiers`, `tier_price_versions` or `tier_offer_terms`, and `allowance_actions` is
   * append-only with no `scheduled -> cancelled` transition, so "you can move back any time before
   * the date" is false. Each of those is a sentence that ends in a billing dispute, so each is
   * asserted absent here, after a positive control proves the panel actually rendered.
   */
  it("states only the scheduled-movement facts the billing record carries", async () => {
    const scheduled: CoachBillingSnapshot = {
      ...suspendedSnapshot,
      accountState: "active",
      subscriptionState: "active",
      invoiceState: "paid",
      pendingMovement: {
        tierName: "Scale",
        priceCents: 99_700,
        effectiveAt: "2026-09-01T00:00:00.000Z",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/api/billing/checkout")
        ? offeredCheckout
        : { snapshot: scheduled },
    ), { headers: { "Content-Type": "application/json" }, status: 200 })));

    render(<CoachBilling enabled initialSnapshot={scheduled} />);

    // Positive control first: without it every assertion below passes against a panel that never
    // rendered, which is how a component stubbed to `return null` gets a green suite.
    const panel = (await screen.findByRole("heading", { name: "Your plan" }))
      .closest("section") as HTMLElement;
    expect(panel).not.toBeNull();
    // Aug 31 and not Sep 1: `workspaceDateFormat` renders in the workspace display timezone, and a
    // midnight-UTC period boundary is the previous evening in New York. The heading and the
    // sentence below it read the same instant through the same formatter, so they cannot disagree.
    expect(panel).toHaveTextContent("What happens on Aug 31, 2026");
    expect(panel).toHaveTextContent("Your plan becomes Scale at");
    expect(panel).toHaveTextContent("$997.00");
    expect(panel).toHaveTextContent("the day this billing period ends");
    expect(panel).toHaveTextContent("calls already booked in this period stay on Growth");
    expect(panel).toHaveTextContent("Nothing is charged today.");
    // A privileged, money-moving schedule keeps its audit microcopy where the coach can see it.
    expect(panel).toHaveTextContent("Logged.");

    const text = panel.textContent ?? "";
    // No allowance for the tier we are moving to: the projection does not carry one.
    expect(text).toContain("does not carry the new plan");
    expect(text).not.toMatch(/allowance is \d+|instead of \d+|\d+ calls instead/);
    // No per-extra-call rate anywhere in the schema, so none in the sentence. The pattern is money
    // beside a rate word rather than the bare word "each", because the plan card these blocks were
    // folded into labels its own price "Charged each month" -- a plan price, which the record does
    // carry, and not a rate for a call past the allowance, which it does not.
    expect(text).not.toMatch(/\$[\d.,]+ (each|per|a call)|extra calls?|overage|per extra|billed at/i);
    // No reversal promise: a scheduled movement cannot be cancelled from this product.
    expect(text).not.toMatch(/move back|switch back|cancel|reversible|any time before/i);
    // No button that would post to a plan-change route this codebase does not have.
    expect(screen.queryByRole("button", { name: /Move to Scale|Keep Growth|Pick /i }))
      .not.toBeInTheDocument();
  });

  /**
   * The drift this catches: an absent movement rendering as an invented offer.
   *
   * With nothing scheduled the honest answer is that nothing is scheduled and that a change is
   * arranged with SetterFi, because no coach-callable route exists to start one. A tier card, a
   * price the coach is not on, or a consequence sentence here would all be fiction.
   */
  it("says nothing is scheduled rather than offering a plan the coach cannot buy", async () => {
    const settled: CoachBillingSnapshot = {
      ...suspendedSnapshot,
      accountState: "active",
      subscriptionState: "active",
      invoiceState: "paid",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/api/billing/checkout")
        ? offeredCheckout
        : { snapshot: settled },
    ), { headers: { "Content-Type": "application/json" }, status: 200 })));

    render(<CoachBilling enabled initialSnapshot={settled} />);

    const panel = (await screen.findByRole("heading", { name: "Your plan" }))
      .closest("section") as HTMLElement;
    // Positive control: the coach's own plan is stated before anything is asserted absent.
    expect(panel).toHaveTextContent("Growth");
    expect(panel).toHaveTextContent("$497.00");
    expect(panel).toHaveTextContent("25 booked calls a month");

    expect(panel).toHaveTextContent("No plan change is scheduled.");
    expect(panel).toHaveTextContent("arranged with SetterFi rather than started");
    expect(panel?.textContent ?? "").not.toMatch(/What happens on|becomes .* at \$/);
  });

  /**
   * The drift this catches: the page growing back into five cards.
   *
   * `Billing.dc.html` is three blocks -- the plan, the attendance question, and a correction strip
   * -- and the four cards this page used to draw made a coach read four faces to answer "what am I
   * paying and when does it reset". The reset sentence and the plan action now live in the plan
   * card, the four notice rows are one sentence inside it, and the raw provider states are gone:
   * `past_due` is a string from Stripe, not a fact a coach can act on, and it was the one place on
   * this page where the record leaked out in its own vocabulary.
   */
  it("answers what you pay, when it resets and what we sent you inside one plan card", async () => {
    const settled: CoachBillingSnapshot = {
      ...suspendedSnapshot,
      accountState: "active",
      subscriptionState: "active",
      invoiceState: "paid",
      notices: [
        { id: "n1", kind: "warning", state: "sent", deliveryReceiptId: "r1", billingContactSource: "billing_email" },
        { id: "n2", kind: "crossing", state: "queued", deliveryReceiptId: null, billingContactSource: "billing_email" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/api/billing/checkout")
        ? offeredCheckout
        : { snapshot: settled },
    ), { headers: { "Content-Type": "application/json" }, status: 200 })));

    const { container } = render(<CoachBilling enabled initialSnapshot={settled} />);

    const panel = (await screen.findByRole("heading", { name: "Your plan" }))
      .closest("section") as HTMLElement;
    // Positive control: the card carries the allowance and its meter before anything is asserted
    // absent, so a card that failed to render cannot pass the rest of this test.
    expect(panel).toHaveTextContent("18 of 25");
    // The reset sentence, moved off the billing-period card and onto the allowance it resets. Aug
    // 31 and not Sep 1: a midnight-UTC boundary is the previous evening in the display timezone.
    expect(panel).toHaveTextContent("Your month resets on Aug 31, 2026");

    // The notices card, folded to one line that keeps the queued half separate from the sent half.
    const notices = panel.querySelector('[data-slot="billing-notices-line"]');
    expect(notices?.textContent).toContain("1 of 2 allowance notices reached your billing contact");
    expect(screen.queryByRole("heading", { name: "Billing notices" })).not.toBeInTheDocument();

    // The provider's own state strings are off the page.
    expect(container.querySelector('[data-slot="technical-detail"]')).toBeNull();
    // No card update control: the billing snapshot carries no saved-card record to update.
    expect(screen.queryByRole("button", { name: /card/i })).not.toBeInTheDocument();
  });

  /**
   * The drift this catches: a dispute form standing open on a page nobody came to dispute.
   *
   * The record picker and the reason box are the heaviest controls on this screen and they matter
   * to the rare coach whose count looks wrong. The canvas gives that coach one button and gives
   * everyone else a sentence, so the form must not exist in the document until the button is
   * pressed -- rendered-and-hidden would still put a required select in the tab order.
   */
  it("keeps the correction form shut until a coach says a number looks wrong", async () => {
    const settled: CoachBillingSnapshot = {
      ...suspendedSnapshot,
      accountState: "active",
      subscriptionState: "active",
      invoiceState: "paid",
      correctionCandidates: [{ eventId: "evt-1", label: "Janae Whitfield, Aug 12" }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/api/billing/checkout")
        ? offeredCheckout
        : { snapshot: settled },
    ), { headers: { "Content-Type": "application/json" }, status: 200 })));

    render(<CoachBilling enabled initialSnapshot={settled} />);

    const open = await screen.findByRole("button", { name: "This looks wrong" });
    expect(screen.queryByLabelText(/Reason/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request correction" })).not.toBeInTheDocument();

    await userEvent.click(open);

    expect(await screen.findByRole("button", { name: "Request correction" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Reason/)).toBeInTheDocument();
  });

  it("accepts only exact Stripe-hosted HTTPS handoff URLs", () => {
    expect(validatedStripeCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test#token")).toBe(
      "https://checkout.stripe.com/c/pay/cs_test#token",
    );
    expect(validatedStripeCheckoutUrl("http://checkout.stripe.com/c/pay/cs_test")).toBeNull();
    expect(validatedStripeCheckoutUrl("https://checkout.stripe.com.evil.test/c/pay/cs_test")).toBeNull();
    expect(validatedStripeCheckoutUrl("https://user@checkout.stripe.com/c/pay/cs_test")).toBeNull();
  });

  it("rejects malformed checkout state instead of rendering invented commercial terms", () => {
    expect(() => parseBillingCheckoutState({
      checkout: {
        ...offeredCheckout.checkout,
        offer: { ...offeredCheckout.checkout.offer, amountCents: 49.7 },
      },
    })).toThrow("BILLING_CHECKOUT_STATE_INVALID");
  });
});

/*
 * The two card shapes on this page, and the two headings that were already the wrong size.
 *
 * `Billing.dc.html` draws "Your plan" (`:98`) and "Did they show up?" (`:151`) with no header band
 * at all -- a 22px/600 title as the card's first line -- while the code routed both through the
 * banded `DeckPanel` and gave each a 78px eyebrow band the drawing never had. The correction strip
 * at `:178` is the other half of the same reading: it is a row, not a sixth card, and its heading
 * is drawn at the same 18px/500 as the two attendee names three cards above it (`:156`, `:166`),
 * where the code rendered it at the 20px panel-name size.
 *
 * These read the anatomy and the role class, not the pixels: a band that came back fails the first
 * two assertions whatever it is padded with, and the correction heading is checked against
 * `ROW_TITLE_CLASS`'s own 18px rather than against a number retyped here.
 */
describe("CoachBilling card shapes", () => {
  const settled: CoachBillingSnapshot = {
    ...suspendedSnapshot,
    accountState: "active",
    subscriptionState: "active",
    invoiceState: "paid",
    outcomePrompts: [
      { appointmentId: "apt-1", label: "Janae Whitfield", occurredAt: "2026-08-25T18:00:00.000Z" },
    ],
  };

  function stubBilling() {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/api/billing/checkout")
        ? offeredCheckout
        : { snapshot: settled },
    ), { headers: { "Content-Type": "application/json" }, status: 200 })));
  }

  it("draws the plan and attendance cards title-led, with no header band over either", async () => {
    stubBilling();
    render(<CoachBilling enabled initialSnapshot={settled} />);

    for (const name of ["Your plan", "Did they show up?"]) {
      const heading = await screen.findByRole("heading", { name });
      const card = heading.closest("section") as HTMLElement;

      // Positive control: the card rendered its own contents, so the band's absence below is an
      // absence inside a real card.
      expect(card).toHaveTextContent(name);
      expect(card.querySelector(".coach-panel__header")).toBeNull();
      expect(card.querySelector(".coach-panel__eyebrow")).toBeNull();
      expect(heading).not.toHaveClass("coach-panel__name");
      expect(heading).toHaveClass("text-[22px]", "font-semibold");
    }
  });

  it("keeps the correction strip's heading at the attendee-name size, not a panel name's", async () => {
    stubBilling();
    render(<CoachBilling enabled initialSnapshot={settled} />);

    const heading = await screen.findByRole("heading", { name: /look wrong/u });
    // The row role, which is the same class the attendee name three cards above it takes.
    expect(heading).toHaveClass("text-[18px]");
    expect(heading.className).not.toContain("--coach-panel-name");
    expect(screen.getByText("Janae Whitfield")).toHaveClass("text-[18px]");
  });
});
