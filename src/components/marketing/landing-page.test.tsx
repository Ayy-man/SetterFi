import { createElement } from "react";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "@/app/tokens.css";
import "@/app/globals.css";

import { LandingPage, type LandingPlan } from "@/components/marketing/landing-page";
import { isPublicIngressPath } from "@/lib/auth/claims";

/**
 * The public page is the only surface in the product a stranger reads before they have agreed to
 * anything, so the things it may not say are as load-bearing as the things it does. Every test
 * below opens with a positive control, because a negative assertion on a component stubbed to
 * `return null` passes with flying colours -- the exact vacuous shape found three times in this
 * suite already.
 */

/**
 * The plans as the catalogue hands them over, already ordered by allowance the way
 * `src/app/page.tsx` orders them. Every price and allowance the page prints comes from here now,
 * so a fixture rather than a literal in the component is the point of the change these guard.
 */
const PLANS: readonly LandingPlan[] = [
  { id: "tier-starter", name: "Starter", callAllowance: 10, price: { amount: "$297", period: "a month" } },
  { id: "tier-growth", name: "Growth", callAllowance: 25, price: { amount: "$497", period: "a month" } },
  { id: "tier-scale", name: "Scale", callAllowance: 60, price: { amount: "$997", period: "a month" } },
];

/** Every currency amount the rendered page prints, in order. */
function renderedAmounts() {
  return (document.body.textContent ?? "").match(/\$[\d,]+(?:\.\d+)?/gu) ?? [];
}

function renderPage(plans: readonly LandingPlan[] = PLANS) {
  render(createElement(LandingPage, { plans }));
  // The positive control every assertion below leans on. If this is missing, the page did not
  // render and nothing after it means anything.
  expect(screen.getByRole("heading", {
    level: 1,
    name: /Every funding DM answered, qualified and booked, without you\./u,
  })).toBeVisible();
}

describe("the public marketing page", () => {
  /**
   * The drench budget, counted rather than eyeballed. `docs/REDESIGN-CANVAS.md` caps a screen at
   * two saturated panels; this page spends one, and the one it does not spend is the point.
   *
   * The second used to sit on the middle pricing card. That started as `plan.name === "Growth"`
   * with a "Most picked" pill, which is `docs/DECISIONS.md` DEC12's recommendation under another
   * name: the catalogue returns operator-chosen labels with no recommended flag, so nothing in
   * this product knows which plan most coaches pick. The pill was removed and the fill was moved
   * to the middle position on the reasoning that a position asserts nothing, and DEC12 names that
   * move specifically: a filled middle card in a row of three is how a pricing page says "this
   * one", which is exactly why the artboard drenched Growth. The reader takes the claim whether
   * or not the code writes a word, so the honest shape is three identical cards.
   *
   * This test asserts both halves, because either alone can be satisfied while the page still
   * recommends: a count of one says nothing about whether the cards match, and matching cards say
   * nothing about a third band appearing elsewhere.
   */
  it("drenches the proof band and nothing else, and singles out no plan", () => {
    renderPage();

    const drenched = Array.from(document.querySelectorAll<HTMLElement>("[style]"))
      .filter((element) => element.style.background.includes("--coach-drench"));

    expect(drenched).toHaveLength(1);
    expect(drenched[0]).toHaveTextContent("What August looked like at Reid Funding Group");

    // Positive control: the three cards really did render, so the sameness below is a decision
    // this page made rather than an empty list agreeing with itself.
    const cards = PLANS.map((plan) => screen.getByRole("heading", { level: 3, name: plan.name }).closest("article")!);
    expect(cards).toHaveLength(3);
    expect(cards.every(Boolean)).toBe(true);

    const treatments = new Set(cards.map((card) => `${card.className}|${card.getAttribute("style") ?? ""}`));
    expect(treatments.size).toBe(1);
  });

  /**
   * Seeded records are labelled where they are read, not in a footnote. The proof band's three
   * figures come from the demo tenant, and a marketing page quietly dropping that marker would
   * turn demo numbers into a claim about a real month.
   */
  it("labels the proof band's figures as demo workspace data, on the band itself", () => {
    renderPage();

    const band = screen.getByText("What August looked like at Reid Funding Group").closest("div")!
      .parentElement!.parentElement!;

    expect(within(band).getByText("214")).toBeVisible();
    expect(within(band).getByText("Demo workspace data")).toBeVisible();
  });

  /**
   * The A2P clock, stated as elapsed days and never as a finish date. This is the single claim on
   * the page most likely to be "improved" into a promise nobody can keep, and the honest-states
   * rule exists because carrier vetting is genuinely outside anyone's control.
   */
  it("says three weeks and a day count for texting, and predicts no finish date", () => {
    renderPage();

    const answer = screen.getByRole("heading", { name: "How long before it is working?" })
      .closest("article")!;

    expect(answer).toHaveTextContent(/carriers vet every business that wants to send texts/u);
    expect(answer).toHaveTextContent(/we show you the day count and nothing else/u);
    expect(answer).toHaveTextContent(/Nobody can give you a finish date, so we do not invent one/u);
    // A percentage or a date would both be the prediction the rule forbids.
    expect(answer).not.toHaveTextContent(/\d+%/u);
    expect(answer).not.toHaveTextContent(/ready by|live by|by [A-Z][a-z]+ \d/u);
  });

  /**
   * Two hard rules that are one assertion each and would be invisible until a client saw them:
   * GHL is backend plumbing and is never named where a coach or a lead can read it, and cost or
   * margin economics belong to the owner console. The prices here are subscription prices, which
   * is what the reader is buying, so they are not what this test is about.
   */
  it("names no GoHighLevel branding and no cost or margin economics", () => {
    renderPage();

    const page = document.body.textContent ?? "";

    expect(page).not.toMatch(/gohighlevel|highlevel|\bGHL\b/iu);
    expect(page).not.toMatch(/margin|cost per|cost-per|gross profit|model spend/iu);
    // The positive half: the prices a coach is actually buying are still on the page.
    expect(page).toContain("$497");
  });

  /**
   * The grounding rule on the most externally visible surface in the product. The page used to
   * carry `$297` / `$497` / `$997` and three allowances as string literals while `/signup`
   * projected the same plans from `public.list_signup_tier_catalog`, so a stranger read three
   * prices no read stood behind and an operator editing a tier moved one page and not the other.
   *
   * Asserted as an equality over every currency amount on the page rather than as three absences:
   * a hard-coded figure put back anywhere -- a fourth card, a comparison line, a footnote -- fails
   * this, where three `not.toContain`s would only catch the three numbers that were there before.
   */
  it("prints no money the tier catalogue did not give it", () => {
    renderPage([
      { id: "tier-a", name: "Starter", callAllowance: 4, price: { amount: "$111", period: "a month" } },
      { id: "tier-b", name: "Growth", callAllowance: 8, price: { amount: "$222", period: "a month" } },
      { id: "tier-c", name: "Scale", callAllowance: 12, price: { amount: "$333", period: "a month" } },
    ]);

    expect(renderedAmounts()).toEqual(["$111", "$222", "$333"]);
    // The allowance is the other figure the catalogue owns, and the number is its own span, so
    // this reads the composed text rather than one node.
    expect(document.body.textContent).toContain("4 booked calls included a month");
  });

  /**
   * The honest state when the catalogue cannot be read. `landingPlans` in `src/app/page.tsx`
   * turns a failed read into an empty list precisely so this page can say it has no price to
   * show; falling back to the last figures anybody typed is the defect the projection replaced.
   */
  it("quotes nothing at all when the catalogue returned no plans", () => {
    renderPage([]);

    expect(renderedAmounts()).toEqual([]);
    expect(screen.getByText(/Plans are not loading right now/u)).toBeVisible();
  });

  /**
   * `docs/DECISIONS.md` DEC11 and DEC12, both of which are absences with a reason. No per-call
   * overage rate is recorded in any column, contract field or env value in this product, and the
   * catalogue returns operator-chosen labels with no recommended flag -- so a page that stated
   * either would be manufacturing a commercial term a customer could hold us to.
   */
  it("names no overage rate and recommends no plan", () => {
    renderPage();

    const page = document.body.textContent ?? "";

    expect(page).not.toMatch(/then \$|each after|per extra|overage/iu);
    expect(page).not.toMatch(/most picked|most coaches start|recommended|most popular/iu);
  });

  /**
   * Every link goes somewhere that exists. The coach rail had to be un-demoted in `f8d0381`
   * because four destinations lost their route, and a marketing footer pointing at `/legal/terms`
   * -- which the canvas draws and this product does not have -- is the same defect aimed at
   * someone who has not signed up yet.
   */
  it("links only at routes this app serves", () => {
    renderPage();

    const hrefs = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href")!)
      .filter((href) => !href.startsWith("#"));

    expect(hrefs.length).toBeGreaterThan(0);
    expect(new Set(hrefs)).toEqual(new Set(["/signup", "/login"]));
  });

  /**
   * Existing is not the same as reachable, and the version of the check above that only asked
   * whether a route existed passed while the footer's "Partner programme" pointed at `/affiliate`
   * -- a real route, gated, which bounced a signed-out stranger to `/login`. This page is read
   * almost entirely by people with no session, so every destination it offers has to be one the
   * proxy lets a signed-out request through to. `isPublicIngressPath` is that inventory, so the guard
   * asks it directly rather than restating a list that would drift away from it.
   */
  it("offers a signed-out reader no destination the proxy will not serve them", () => {
    renderPage();

    const unreachable = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href")!)
      .filter((href) => href.startsWith("/"))
      .filter((href) => !isPublicIngressPath(href));

    expect(unreachable).toEqual([]);
  });

  /**
   * The overline is gone from this surface, which is the whole point of the redesign's type pass
   * and the easiest thing to reintroduce by copying a header off a console screen.
   */
  it("draws no uppercase overline anywhere on the page", () => {
    renderPage();

    const uppercased = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .filter((element) => element.className.toString().includes("uppercase"));

    expect(uppercased).toEqual([]);
  });

  /**
   * The one action, repeated rather than competed with. Three different primary calls to action
   * would each be claiming to be the live one, which is the One Fill Rule's failure mode written
   * as a sales page.
   */
  it("asks for one thing, in the same words, everywhere it asks", () => {
    renderPage();

    const asks = screen.getAllByRole("link", { name: /Start your setup/u });

    expect(asks).toHaveLength(3);
    for (const ask of asks) expect(ask).toHaveAttribute("href", "/signup");
  });
});
