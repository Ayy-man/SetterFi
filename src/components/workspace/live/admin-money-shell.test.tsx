import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// `DataState` reads the app router to offer a retry, and the disabled-feature arm renders one.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

import { MoneySurfaceGuard, moneyPageHeader } from "@/components/workspace/live/admin-money-shell";

/**
 * The Money role gate, and what the refusal is allowed to say.
 *
 * `moneyPageAccessStatus` decides who may open which of the four Money surfaces; this is the
 * component that draws the answer when the answer is no. Three things can drift here and each one
 * is somebody's afternoon:
 *
 *   1. **The gate stops gating.** A refused surface that renders its children is a success
 *      reviewer reading cost-against-revenue figures, which is the wall `CLAUDE.md` puts around
 *      this whole route group. Every assertion below that looks for absent children is checking
 *      that, and the positive control at the bottom proves these tests can see children at all --
 *      a guard stubbed to `return null` would otherwise pass the lot of them.
 *   2. **The feature gate and the role gate get conflated.** They were one branch until the
 *      console port, which meant a surface waiting on `phase6Live` told the reader their role did
 *      not carry it. That is a false statement about the person reading it.
 *   3. **The refusal's audit claim stops matching what the product does.** This pin was written
 *      pointing the other way: the canvas drew "Logged -- this attempt is on the audit trail with
 *      your name, the page and the time", nothing wrote such a row, and the test pinned the
 *      sentence's *absence* so it could not be pasted back in from a mockup nobody had checked.
 *      **That authority is reversed, not deleted.**
 *      `supabase/migrations/20261004000001_money_page_refusal_audit.sql:26-31` inserts the
 *      `money.page.refused` action and every Money route now calls `logMoneyPageRefusal` on the
 *      role-boundary branch, so the old copy -- "nothing was recorded against you" -- became the
 *      false claim, on a security surface, and the panel now says it was logged. The pin below
 *      guards the same property from the new side: the role-boundary refusal, which writes a row,
 *      says so; the feature-flag refusal, which structurally cannot write one (see the module
 *      comment on `src/lib/repositories/money-page-audit.ts`), must never say so. The failure
 *      mode this catches today is the two refusals being conflated back into one panel and the
 *      flag-off arm inheriting a receipt it does not have.
 */
describe("MoneySurfaceGuard", () => {
  it("refuses a role that does not carry the surface, and says who does", () => {
    render(
      <MoneySurfaceGuard actorRole="success" authorized={false} enabled surface="billing">
        <p>Cost against revenue</p>
      </MoneySurfaceGuard>,
    );

    expect(screen.queryByText("Cost against revenue")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "This one is not yours to open" }),
    ).toBeVisible();
    // Not a permission-table restatement: the reason is what the page carries.
    expect(
      screen.getByText(/cost-against-revenue figures that support does not work from/),
    ).toBeVisible();
    // The rail is the only place these four surfaces are listed, so a refusal with no route
    // onwards is a dead end. It names the one Money page a success reviewer does carry.
    expect(screen.getByRole("link", { name: "Go to Corrections" })).toHaveAttribute(
      "href",
      "/admin/corrections",
    );
  });

  it("does not offer Corrections to a role that was never refused it", () => {
    render(
      <MoneySurfaceGuard actorRole="admin" authorized={false} enabled surface="affiliates">
        <p>Commission ledger</p>
      </MoneySurfaceGuard>,
    );

    expect(screen.queryByText("Commission ledger")).toBeNull();
    // An admin seeing this panel is looking at a bug, not at a permission boundary. Sending them
    // to a page they were never refused would be noise dressed up as help.
    expect(screen.queryByRole("link", { name: "Go to Corrections" })).toBeNull();
  });

  it("says the route is waiting on a flag rather than blaming the reader's role", () => {
    render(
      <MoneySurfaceGuard actorRole="owner" authorized enabled={false} surface="tiers">
        <p>Plan prices</p>
      </MoneySurfaceGuard>,
    );

    expect(screen.queryByText("Plan prices")).toBeNull();
    expect(screen.getByText("Plans are not enabled")).toBeVisible();
    // The owner carries every Money surface. Telling them otherwise because a flag is off is the
    // conflation the two-branch gate exists to prevent.
    expect(screen.queryByText("This one is not yours to open")).toBeNull();
  });

  /**
   * Three states, because the write has three outcomes and the panel used to have one sentence.
   *
   * The old pin asserted "Logged" on any role-boundary refusal, which is what let a false claim
   * ship: `logMoneyPageRefusal` swallowed its failures and returned nothing, migration
   * `20261004000001` had never reached the hosted project, and the sentence was wrong on the live
   * deployment from the day the copy landed until the outcome was threaded through. So the claim
   * is now pinned against the outcome rather than against the branch, and the failure arm below is
   * the assertion that would have caught it.
   */
  it("tells a refused role the attempt is on the audit trail when the row was written", () => {
    render(
      <MoneySurfaceGuard
        actorRole="success"
        authorized={false}
        enabled
        refusalRecord="recorded"
        surface="affiliates"
      >
        <p>Commission ledger</p>
      </MoneySurfaceGuard>,
    );

    expect(screen.getByText(/^Logged/)).toBeVisible();
    expect(screen.getByText(/on the audit trail with your name, the page and the time/)).toBeVisible();
    // The sentence this replaced. It is pinned as absent so the reversal cannot be undone by
    // half: a panel carrying both claims at once contradicts itself on a security surface.
    expect(screen.queryByText(/nothing was recorded against you/i)).toBeNull();
    expect(document.querySelector('[data-slot="money-refusal-audit"]')).toHaveAttribute(
      "data-refusal-record",
      "recorded",
    );
  });

  it("says the attempt was not recorded when the audit write failed", () => {
    render(
      <MoneySurfaceGuard
        actorRole="success"
        authorized={false}
        enabled
        refusalRecord="not-recorded"
        surface="affiliates"
      >
        <p>Commission ledger</p>
      </MoneySurfaceGuard>,
    );

    expect(screen.getByText(/We could not record this attempt on the audit trail/)).toBeVisible();
    // The claim, on the arm that cannot support it. This is the whole point of the state.
    expect(screen.queryByText(/^Logged/)).toBeNull();
    expect(screen.queryByText(/on the audit trail with your name/)).toBeNull();
    // The refusal itself still stands and the children still do not render: a broken audit path
    // is not a reason to hand a success reviewer the cost figures.
    expect(screen.queryByText("Commission ledger")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "This one is not yours to open" }),
    ).toBeVisible();
  });

  /**
   * A page that cannot see its own audit result has no grounds to claim one, so the absent case
   * reads as the failure case rather than as the success case. Defaulting the other way is how the
   * original defect would come back through a route that forgets to pass the prop.
   */
  it("claims nothing when the outcome was never passed down", () => {
    render(
      <MoneySurfaceGuard actorRole="success" authorized={false} enabled surface="affiliates">
        <p>Commission ledger</p>
      </MoneySurfaceGuard>,
    );

    expect(screen.queryByText(/^Logged/)).toBeNull();
    expect(screen.getByText(/We could not record this attempt on the audit trail/)).toBeVisible();
  });

  it("claims no audit receipt when the refusal is a feature flag, because that writes nothing", () => {
    render(
      <MoneySurfaceGuard actorRole="success" authorized={false} enabled={false} surface="affiliates">
        <p>Commission ledger</p>
      </MoneySurfaceGuard>,
    );

    // `!enabled` beats `!authorized` in the guard, and only the role-boundary arm has an RPC
    // behind it. A flag-off arm that said "Logged" would be the original falsehood restored.
    expect(screen.getByText("Affiliates are not enabled")).toBeVisible();
    expect(screen.queryByText(/on the audit trail/i)).toBeNull();
    expect(screen.queryByText(/^Logged/)).toBeNull();
    // Nor the failure sentence: the flag arm attempted no write, so "we could not record this"
    // would be its own falsehood -- there was nothing to record and nobody was refused.
    expect(screen.queryByText(/We could not record this attempt/)).toBeNull();
    expect(document.querySelector('[data-slot="money-refusal-audit"]')).toBeNull();
  });

  /**
   * One drawn screen, one behaviour.
   *
   * The four Money pages had four refusals: Revenue, Cost evidence and Corrections called
   * `forbidden()` and landed on a bare centred page with no rail and no route onwards, Affiliates
   * showed a warning `Callout` over a second "unavailable" block, and Plans had a banner of its
   * own. A success reviewer following a link from a client thread is a reader of this console, so
   * they get the panel above; a coach or an affiliate has no business under /admin at all and
   * keeps the bare page, which is why `forbidden()` still appears in every gate file.
   */
  it("hands a refused success reviewer to this panel on every Money route", () => {
    const routes = {
      "src/app/(workspace)/admin/billing/page.tsx": true,
      "src/app/(workspace)/admin/billing/costs/page.tsx": true,
      "src/app/(workspace)/admin/affiliates/page.tsx": true,
      "src/app/(workspace)/admin/tiers/render-tiers-page.tsx": false,
      "src/app/(workspace)/admin/corrections/page.tsx": false,
    };

    for (const [file, rendersRefusedComponent] of Object.entries(routes)) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      if (file.endsWith("corrections/page.tsx")) {
        // Success carries Corrections, so nobody who reads this console is refused it and the
        // bare page is the only correct answer here.
        expect(source).toContain("forbidden()");
        continue;
      }
      // The bare page is reserved for a role that does not read this console at all.
      expect(source).toContain('if (actor.role !== "success") forbidden();');
      if (rendersRefusedComponent) {
        // ...and the refused reviewer is handed the surface component with the gate shut, which
        // is what puts them in front of `MoneySurfaceGuard` inside the console shell.
        expect(source).toContain("authorized={false}");
      }
    }
  });

  it("leaves no Money surface drawing a refusal of its own", () => {
    const retired = [
      "Pricing changes are restricted for this role",
      "Pricing data is unavailable",
      "Pricing controls are not enabled",
      "Affiliate payout records are restricted for this role",
      "Affiliate payout data is unavailable",
      "Affiliate money records are not enabled",
    ];
    const surfaces = ["tiers", "billing", "billing-costs", "corrections", "affiliates"]
      .map((surface) => readFileSync(
        resolve(process.cwd(), `src/components/workspace/live/admin-money-${surface}.tsx`),
        "utf8",
      ))
      .join("\n");

    for (const sentence of retired) expect(surfaces).not.toContain(sentence);
  });

  /**
   * The positive control. Without it every assertion above passes against a component stubbed to
   * `return null`, which is exactly how three vacuous tests got into this repo on 2026-08-31.
   */
  it("renders its children when the surface is enabled and the role carries it", () => {
    render(
      <MoneySurfaceGuard actorRole="owner" authorized enabled surface="billing">
        <p>Cost against revenue</p>
      </MoneySurfaceGuard>,
    );

    expect(screen.getByText("Cost against revenue")).toBeVisible();
    expect(screen.queryByText("This one is not yours to open")).toBeNull();
  });
});

/**
 * The page header on a surface the reader may not be allowed to see.
 *
 * `MoneySurfaceGuard` above wraps a page's children, so on four of the five Money routes the
 * `<h1>`, its description and its header action sat outside the gate and survived the refusal.
 * `/admin/billing` described "what the platform bills" over a panel saying the page was not the
 * reader's, and offered a Cost evidence link that refuses them again; Cost evidence linked back.
 *
 * Two properties, and the second is the one a later reader is most likely to undo:
 *
 *   1. **A refusal describes nothing and offers nothing.** A description of withheld content is a
 *      claim about data nobody was shown, and a control over it is dead.
 *   2. **The two refusal arms keep their own sentences.** A dark feature gate is not a refusal of
 *      the person -- it is off for the owner too -- so telling that reader their role does not
 *      carry the page is false about them. The guard splits these at its `!enabled` branch and
 *      this splits them the same way; collapsing them back into one sentence is the exact defect
 *      that branch exists to prevent, and it would put the header in direct disagreement with the
 *      body underneath it.
 */
describe("moneyPageHeader", () => {
  const readable = "What the platform bills, and which subscriptions are in trouble.";
  const action = "Cost evidence";

  it("keeps the page's own description and action when the reader carries the page", () => {
    const header = moneyPageHeader({
      actions: action,
      authorized: true,
      description: readable,
      enabled: true,
    });

    expect(header.description).toBe(readable);
    expect(header.actions).toBe(action);
  });

  it("states the role boundary and drops the action when the role does not carry the page", () => {
    const header = moneyPageHeader({
      actions: action,
      authorized: false,
      description: readable,
      enabled: true,
    });

    expect(header.description).toBe("Your role does not carry this page.");
    expect(header.actions).toBeUndefined();
  });

  it("does not blame the reader's role when it is the feature gate that is dark", () => {
    const header = moneyPageHeader({
      actions: action,
      authorized: true,
      description: readable,
      enabled: false,
    });

    // The property, stated as the thing that must not happen rather than as a string match: a
    // route nobody can open yet must not tell this reader it is about them.
    expect(header.description).not.toContain("role");
    expect(header.description).toBe(
      "This route is waiting for a feature gate, so nothing on it is available yet.",
    );
    expect(header.actions).toBeUndefined();
  });

  /**
   * The gate is checked before the role, and it has to be: a refused role on a dark route would
   * otherwise be told the page is theirs to lose rather than that the route is off.
   */
  it("answers with the feature gate when both gates are shut", () => {
    const header = moneyPageHeader({ authorized: false, description: readable, enabled: false });

    expect(header.description).toBe(
      "This route is waiting for a feature gate, so nothing on it is available yet.",
    );
  });

  /**
   * The reason this helper exists rather than each page inlining a ternary: every Money route that
   * can refuse has to route its header through it, or the route that forgot keeps the old defect
   * silently. Read out of the sources so a fifth route added later is caught by the same rule.
   */
  it("is used by every Money route whose guard wraps only its children", () => {
    const routed = ["admin-money-billing", "admin-money-billing-costs", "admin-money-tiers", "admin-money-affiliates"];

    for (const file of routed) {
      const source = readFileSync(
        resolve(process.cwd(), `src/components/workspace/live/${file}.tsx`),
        "utf8",
      );
      expect(source, `${file} must route its header through moneyPageHeader`).toContain(
        "moneyPageHeader({",
      );
      // The description must reach the helper rather than sitting on `ListPage` beside it, which
      // is what the defect looked like: a `description=` prop the guard could not reach.
      expect(source, `${file} must not keep a bare description on its page template`).not.toMatch(
        /\n\s+description="/,
      );
    }
  });
});
