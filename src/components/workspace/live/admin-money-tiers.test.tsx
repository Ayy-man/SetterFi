import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminMoneyTiers } from "@/components/workspace/live/admin-money-tiers";
import { workspaceDateFormat } from "@/lib/format/datetime";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/tiers",
  useRouter: () => ({ refresh: vi.fn() }),
}));

const tierRows = [
  {
    id: "tier-growth",
    name: "Growth",
    priceCents: 29900,
    callAllowance: 60,
    fairUseCap: 72,
    fairUseNote: "A notice appears after the grace allowance.",
    active: true,
    updatedAt: "2026-08-24T12:00:00.000Z",
    dataLabel: null,
  },
];

const clientRows = [
  {
    tenantId: "tenant-reid",
    businessName: "Reid Funding Group",
    accountStatus: "active",
    subscriptionStatus: "active",
    providerUpdatedAt: "2026-08-24T12:00:00.000Z",
    currentPeriodEnd: "2026-09-01T12:00:00.000Z",
    pendingTierId: null,
    pendingEffectiveAt: null,
    dataLabel: null,
  },
];

const clientPricing = {
  "tenant-reid": {
    tierId: "tier-growth",
    tierName: "Growth",
    tierPriceCents: 29900,
    override: {
      priceCents: 24900,
      effectiveAt: "2026-03-01T12:00:00.000Z",
      endsAt: null,
      reason: "founding client rate, grandfathered",
    },
  },
};

const stripeReadinessReceipt = {
  capabilityStatus: "available" as const,
  checkedAt: "2026-08-24T12:00:00.000Z",
  connectionStatus: "connected" as const,
  receiptStatus: "received" as const,
};

const tierImpactById = {
  "tier-growth": {
    affectedWorkspaceCount: 12,
    effectiveAt: "2026-09-01T12:00:00.000Z",
  },
};

const pricingHistory = [
  {
    id: "version-2",
    tierId: "tier-growth",
    tierName: "Growth",
    priceCents: 29900,
    callAllowance: 60,
    fairUseCap: 72,
    effectiveAt: "2026-08-01T12:00:00.000Z",
    actorName: "Alec Delpuech",
    reason: "keeping the middle plan ahead of support cost",
    auditId: 812,
    changed: ["$249 to $299 a month", "Included calls 50 to 60"],
  },
  {
    id: "version-1",
    tierId: "tier-growth",
    tierName: "Growth",
    priceCents: 24900,
    callAllowance: 50,
    fairUseCap: 60,
    effectiveAt: "2026-03-01T12:00:00.000Z",
    actorName: "Alec Delpuech",
    reason: "launch pricing",
    auditId: 41,
    changed: null,
  },
];

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

describe("AdminMoneyTiers", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("renders the plans body without page chrome when embedded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    }));

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        chrome="embedded"
        clientPricingByTenantId={clientPricing}
        enabled
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    await screen.findByRole("heading", { level: 2, name: "Growth" });
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("The plans a coach can buy, what each one includes, and the fair-use cap past that. Changing one is audit-logged.")).toBeNull();
  });

  it("keeps the plans page heading by default", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        clientPricingByTenantId={clientPricing}
        enabled
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Plans and pricing" })).toBeInTheDocument();
  });

  it("does not confirm a tier update without the required reason", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          return jsonResponse({
            result: { priceVersionId: "version-one", auditId: 42 },
          });
        }
        if (url.includes("billing-tiers")) return jsonResponse(tierRows);
        if (url.includes("platform-billing")) return jsonResponse(clientRows);
        return new Response(null, { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    // The plan name is now on the card and in the client row's Plan cell, so the card's heading is
    // the one this test means.
    await screen.findByRole("heading", { name: "Growth", level: 2 });
    await user.click(
      screen.getByRole("button", { name: "Edit this plan: Growth" }),
    );
    await user.click(screen.getByRole("button", { name: "Review change" }));

    const confirm = await screen.findByRole("button", { name: /Update plan/i });
    expect(screen.getByText("12 workspaces")).toBeVisible();
    expect(screen.getByText("Takes effect").parentElement).toHaveTextContent(
      "Sep 1, 2026",
    );
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText("Reason"), "   ");
    expect(confirm).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  /**
   * One fill on the page, and it is a measurement rather than a favourite.
   *
   * The canvas fills the most-subscribed plan; the code drew no fill at all and put a bare "Most
   * clients" status in the footer instead. Both now come from `mostClientsTierId`, which is null
   * when the counts cannot be read or two plans tie, so the fill and the label are the same claim
   * and cannot disagree -- a drenched card beside a footer that does not say why is a page
   * asserting a rank it did not measure.
   */
  it("fills only the plan that measurably carries the most clients", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) {
        return jsonResponse([
          tierRows[0],
          { ...tierRows[0], id: "tier-scale", name: "Scale", priceCents: 99900 },
        ]);
      }
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={{ ...tierImpactById, "tier-scale": { affectedWorkspaceCount: 3, effectiveAt: "2026-09-01T12:00:00.000Z" } }}
      />,
    );

    await screen.findByRole("heading", { name: "Scale", level: 2 });
    const drenched = document.querySelectorAll('[data-drench="info"]');
    expect(drenched).toHaveLength(1);
    expect(drenched[0]).toHaveTextContent("Growth");
    expect(drenched[0]).toHaveTextContent("Most clients");

    // A tie is not a leader. Nothing fills, and nothing claims the rank in words either.
    rerender(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={{
          "tier-growth": { affectedWorkspaceCount: 5, effectiveAt: "2026-09-01T12:00:00.000Z" },
          "tier-scale": { affectedWorkspaceCount: 5, effectiveAt: "2026-09-01T12:00:00.000Z" },
        }}
      />,
    );

    await waitFor(() => expect(document.querySelectorAll('[data-drench="info"]')).toHaveLength(0));
    expect(screen.queryByText("Most clients")).toBeNull();
  });

  /**
   * Pricing history, and the one column that could have been a fabrication.
   *
   * `tier_price_versions` is append-only and carries when, what, who, why and the audit id, so
   * every column here is a stored fact -- except "Clients affected", which the canvas draws and
   * the table does not store. No historical count exists anywhere in `supabase/migrations`, so the
   * column is the CURRENT count on that plan and its header says so; a header reading "Clients
   * affected" over today's subscription count would be a measurement nobody made, presented as
   * history.
   */
  it("draws pricing history from the append-only versions, changes derived against the same plan", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        pricingHistory={pricingHistory}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    const table = await screen.findByRole("region", { name: "Pricing history" });
    expect(within(table).getByText("$249 to $299 a month")).toBeVisible();
    expect(within(table).getByText("Included calls 50 to 60")).toBeVisible();
    expect(within(table).getAllByText("Alec Delpuech")).toHaveLength(2);
    expect(within(table).getByText("keeping the middle plan ahead of support cost")).toBeVisible();
    // The oldest version of a plan has no previous version to be a change from, and inventing one
    // would print a price that was never recorded.
    expect(within(table).getByText("First recorded terms")).toBeVisible();
    // The count column is today's, and the header is the thing that keeps it honest.
    expect(
      within(table).getByRole("columnheader", { name: /Clients on this plan now/ }),
    ).toBeVisible();
    expect(
      within(table).queryByRole("columnheader", { name: /Clients affected/ }),
    ).toBeNull();
  });

  it("says pricing history could not be read rather than drawing an empty history", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        pricingHistory={null}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    // A failed read and "no plan has ever been repriced" are different facts about the business.
    expect(await screen.findByText("Pricing history is unavailable")).toBeVisible();
    expect(screen.queryByText("No plan has been repriced yet")).toBeNull();
  });

  /**
   * A plan is a deck panel now, so its heading is the panel's `<h2>` inside a labelled `<section>`
   * rather than an `<h3>` inside an `<article>`. The level and the container moved together in the
   * console port; nothing else about the assertion did, and the drift this still catches is a
   * plan card that stops printing its price, its allowance, its fair-use sentence, its customer
   * count, or its actions menu.
   */
  it("renders each plan as a card with its real terms and customer count", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    const card = (
      await screen.findByRole("heading", { name: "Growth", level: 2 })
    ).closest("section");
    expect(card).not.toBeNull();
    const plan = within(card as HTMLElement);
    expect(plan.getByText("$299.00")).toBeVisible();
    // The cadence beside the price. It reads "a month" since the console port, per the canvas;
    // what this catches is unchanged -- a price printed with no period attached to it.
    expect(plan.getByText("a month", { exact: false })).toBeVisible();
    expect(plan.getByText("60 booked calls per month")).toBeVisible();
    expect(
      plan.getByText("A notice appears after the grace allowance."),
    ).toBeVisible();
    expect(plan.getByText("12 customers")).toBeVisible();
    // The edit control is a button on the card, not a menu that opens onto one item.
    const edit = plan.getByRole("button", { name: "Edit this plan: Growth" });
    expect(edit).toBeVisible();
    expect(edit).toHaveTextContent("Edit this plan");
    expect(plan.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });

  it("keeps the plan rows exportable from the Plans section", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    await screen.findByRole("heading", { name: "Growth", level: 2 });
    expect(
      screen.getAllByRole("button", { name: /Export/i }).length,
    ).toBeGreaterThan(0);
  });

  /**
   * The tab strip is gone: the plans and the client book are one page now, so the thing that has
   * to survive is that a negotiated client is visibly separated from the ones paying list price,
   * and that the row says why. The reason is not decoration -- `tenant_price_overrides` requires
   * one, and an override nobody can explain later is the whole reason this column exists.
   */
  it("bands a client with a standing override away from standard pricing, and says why", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        clientPricingByTenantId={clientPricing}
        enabled
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    await screen.findByRole("heading", { name: "Growth", level: 2 });
    expect(await screen.findByText("Client overrides")).toBeVisible();
    expect(
      screen.getByText("founding client rate, grandfathered"),
    ).toBeVisible();
    // The difference against the plan's own price, signed, so the row reads as a decision.
    expect(screen.getByText(/\$249\.00 \/ month \(\u2212\$50\.00\)/)).toBeVisible();
  });

  /**
   * The plan a client is on is read from their live subscription price. When that read fails the
   * page must say so: printing the standard plan for a client we cannot place is how a negotiated
   * account quietly gets invoiced at list price.
   */
  it("says the plan is unrecorded rather than guessing when pricing could not be read", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        clientPricingByTenantId={null}
        enabled
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    expect(await screen.findByText("Client pricing is unavailable")).toBeVisible();
    expect(await screen.findByText("Plan not recorded")).toBeVisible();
  });

  it("shows an honest absence when the customer count is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) {
        return jsonResponse([
          { ...tierRows[0], fairUseNote: null, fairUseCap: null },
        ]);
      }
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={{}}
      />,
    );

    await screen.findByRole("heading", { name: "Growth", level: 2 });
    expect(screen.getByText("Customer count unavailable")).toBeVisible();
    expect(screen.getByText("No fair-use limit recorded.")).toBeVisible();
  });

  /**
   * The anchor `/admin/tiers/overrides` redirects to.
   *
   * That route used to be a second page with its own document title over this page's heading. It
   * is a redirect now, and this id is the half of that arrangement living in the markup: drop it
   * and the saved link lands at the top of the page again, which is the behaviour the redirect was
   * written to fix.
   */
  it("marks the client-override band with the id its deep link points at", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    await screen.findByRole("cell", { name: /Reid Funding Group/ });
    const band = container.querySelector("#client-overrides");
    expect(band, "no element carries the id the overrides link redirects to").not.toBeNull();
    // The id has to sit on the band holding the client rows, not merely somewhere on the page:
    // an anchor above the plans would scroll a reader to the wrong half of the screen.
    expect(
      within(band as HTMLElement).getByRole("region", { name: "Client plans and overrides" }),
    ).toBeInTheDocument();
  });

  it("opens the client record on a row press in the overrides book", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    // The kebab already reached this record; the List template asks that a row press does too.
    await user.click(
      await screen.findByRole("cell", { name: /Reid Funding Group/ }),
    );
    const panel = within(await screen.findByRole("dialog"));
    expect(panel.getByText("Subscription").parentElement).toHaveTextContent(
      "Active",
    );
    // Provider evidence is hidden behind Display in the table, so the sheet is where it surfaces.
    // Asserted as the formatted date the component would render, not as the absence of
    // "Never checked" -- an absence claim is equally satisfied by the field rendering nothing.
    expect(panel.getByText("Provider checked").parentElement).toHaveTextContent(
      workspaceDateFormat.format(new Date("2026-08-24T12:00:00.000Z")),
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses a role that does not carry Plans with the shared Money panel", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="success"
        authorized={false}
        enabled
        clientPricingByTenantId={clientPricing}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={null}
        surface="tiers"
        tierImpactById={null}
      />,
    );

    // Plans used to answer this refusal with a warning callout of its own while Revenue and Cost
    // evidence drew `MoneySurfaceGuard`'s panel: one drawn screen, four behaviours across the
    // four Money pages. The refusal is the shared panel now, and it is asserted by its heading so
    // a page that grows a second bespoke banner fails here.
    expect(
      screen.getByRole("heading", { name: "This one is not yours to open" }),
    ).toBeVisible();
    expect(screen.getByText(/Plan prices and client overrides are open to the platform owner/))
      .toBeVisible();
    // And exactly one refusal, not the old pair -- the second block underneath it is gone.
    expect(screen.queryByText("Pricing data is unavailable")).toBeNull();
    expect(document.querySelector('[data-slot="callout"]')).toBeNull();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it("fails closed when Stripe does not return a readiness receipt", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) return jsonResponse(clientRows);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={clientPricing}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={null}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    expect(document.querySelector('[data-slot="callout"]')).toHaveTextContent(
      "Pricing changes are blocked until Stripe is verified",
    );
    expect(
      await screen.findByRole("button", { name: "Edit this plan: Growth" }),
    ).toBeDisabled();
  });
});
