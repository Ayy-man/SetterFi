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

  it("does not collapse a legacy demo Growth plan into the contract Growth plan", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("billing-tiers")) return jsonResponse([
        { ...tierRows[0], priceCents: 59700, callAllowance: 75 },
        { ...tierRows[0], id: "legacy-demo", name: "Growth (demo)", active: false, priceCents: 49700, callAllowance: 25 },
      ]);
      if (String(input).includes("platform-billing")) return jsonResponse([]);
      return new Response(null, { status: 404 });
    }));
    render(<AdminMoneyTiers actorRole="admin" authorized enabled surface="tiers"
      stripeReadinessReceipt={null} stripeActionHref="https://dashboard.stripe.com/settings/account"
      tierImpactById={null} clientPricingByTenantId={null} />);
    const plans = await screen.findByRole("region", { name: "Plans" });
    expect(within(plans).getByText("Growth", { exact: true })).toBeInTheDocument();
    const demo = within(plans).getByText("Growth (demo)", { exact: true }).closest("tr")!;
    expect(demo).not.toHaveAttribute("data-nested");
    expect(within(demo).getByText("Inactive")).toBeInTheDocument();
    expect(within(plans).queryByText("Retired")).toBeNull();
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

    await screen.findByRole("region", { name: "Plans" });
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

    await user.click(
      await screen.findByRole("button", { name: "Edit this plan: Growth" }),
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
   * A repriced plan leaves its predecessor behind, and the two rows are one plan's history.
   *
   * `tiers` carries no version number, so the nesting is derived: rows sharing a displayed name
   * group together, the active one heads the group, and the rest sit under it as retired. The
   * "v1" / "v2" ordinal is a POSITION in that group ordered by `updated_at`, printed only when
   * every row in the group carries one -- an ordinal over an unmeasurable order would be a
   * version number the database never recorded.
   */
  it("nests a retired predecessor under the plan that replaced it", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) {
        return jsonResponse([
          tierRows[0],
          {
            ...tierRows[0],
            id: "tier-growth-v1",
            priceCents: 24900,
            active: false,
            updatedAt: "2026-03-01T12:00:00.000Z",
          },
          { ...tierRows[0], id: "tier-agency", name: "Agency", active: false },
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
        tierImpactById={tierImpactById}
      />,
    );

    const plans = within(await screen.findByRole("region", { name: "Plans" }));
    const rows = plans.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("data-nested"))).toEqual([null, "", null]);
    // Newest first in the group, so the live plan is v2 and the row under it is v1.
    expect(rows[0]).toHaveTextContent("v2");
    expect(rows[1]).toHaveTextContent("v1");
    expect(within(rows[1]).getByText("Retired")).toBeVisible();
    // A plan nobody replaced is not retired, it is simply not for sale.
    expect(within(rows[2]).getByText("Inactive")).toBeVisible();
    // A retired row has no terms left to set; what it offers is the record of what it charged.
    expect(within(rows[1]).getByRole("button", { name: "Price history for Growth" })).toBeVisible();
    expect(within(rows[1]).queryByRole("button", { name: /^Edit this plan/ })).toBeNull();
  });

  /**
   * The one ordinal this page must not print.
   *
   * Two rows under one name and no `updated_at` on one of them is a group whose order nobody
   * measured, so neither row carries a version. The nesting still stands: it comes from the
   * active flag, which is stored.
   */
  it("prints no version ordinal when the group's order cannot be measured", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) {
        return jsonResponse([
          tierRows[0],
          { ...tierRows[0], id: "tier-growth-v1", active: false, updatedAt: null },
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
        tierImpactById={tierImpactById}
      />,
    );

    const plans = within(await screen.findByRole("region", { name: "Plans" }));
    expect(plans.getAllByRole("row").slice(1)).toHaveLength(2);
    expect(plans.queryByText("v1")).toBeNull();
    expect(plans.queryByText("v2")).toBeNull();
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
        pricingHistory={pricingHistory}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    // The record opens on purpose now, so the test opens it before reading it.
    await user.click(await screen.findByText("Price history"));
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
        pricingHistory={null}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    // A failed read and "no plan has ever been repriced" are different facts about the business,
    // and the closed line says which one it is before the panel is ever opened.
    await user.click(await screen.findByText("Price history"));
    expect(document.querySelector('[data-slot="tiers-price-history"]'))
      .toHaveTextContent("Could not be read");
    expect(await screen.findByText("Pricing history is unavailable")).toBeVisible();
    expect(screen.queryByText("No plan has been repriced yet")).toBeNull();
  });

  /**
   * A plan is a row now, not a card.
   *
   * The deck gave every plan a 44px figure and a paragraph, so five plans were a page of
   * scrolling and the facts a reader compares across them -- price, allowance, how many clients
   * are on it, whether it is still sold -- never lined up. Those are columns. What this still
   * catches is a plan that stops printing any of them, or loses its edit control.
   */
  it("renders each plan as a row with its real terms and customer count", async () => {
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

    const plans = within(await screen.findByRole("region", { name: "Plans" }));
    for (const header of ["Plan", "Price", "Calls / mo", "Customers", "State", "Updated"]) {
      expect(plans.getByRole("columnheader", { name: header })).toBeVisible();
    }
    const row = within(plans.getAllByRole("row")[1]);
    expect(row.getByText("Growth")).toBeVisible();
    expect(row.getByText("$299.00")).toBeVisible();
    expect(row.getByText("60")).toBeVisible();
    expect(row.getByText("12")).toBeVisible();
    expect(row.getByText("Active")).toBeVisible();
    // What happens past the allowance is a different claim from the allowance, so it survives the
    // move out of the card.
    expect(row.getByText("A notice appears after the grace allowance.")).toBeVisible();
    expect(row.getByRole("button", { name: "Edit this plan: Growth" })).toBeVisible();
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

    await screen.findByRole("region", { name: "Plans" });
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

    await screen.findByRole("region", { name: "Plans" });
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

    await screen.findByRole("region", { name: "Plans" });
    expect(screen.getByText("Customer count unavailable")).toBeInTheDocument();
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

  /**
   * Two records, one line each until asked for.
   *
   * Price history and commercial terms are both records of what was true, not the thing a reader
   * came here for, and as full panels they pushed the client book two screens down. Closed, each
   * says what is inside; a retired plan's History control is the one thing that opens the first
   * one, because that is the record that row points at.
   */
  it("keeps the two records collapsed, and opens price history from a retired plan", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) {
        return jsonResponse([
          tierRows[0],
          {
            ...tierRows[0],
            id: "tier-growth-v1",
            active: false,
            updatedAt: "2026-03-01T12:00:00.000Z",
          },
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
        pricingHistory={pricingHistory}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    await screen.findByRole("region", { name: "Plans" });
    const history = document.querySelector('[data-slot="tiers-price-history"]');
    const terms = document.querySelector('[data-slot="tiers-commercial-terms"]');
    expect(history).not.toHaveAttribute("open");
    expect(terms).not.toHaveAttribute("open");
    // Closed, the line says what is inside rather than only naming the record.
    expect(history).toHaveTextContent("2 price versions, newest first");

    await user.click(screen.getByRole("button", { name: "Price history for Growth" }));
    expect(history).toHaveAttribute("open");
  });

  /**
   * The client book's two chips, and what makes them different from the search field beside them.
   *
   * Search narrows by name; the chips narrow by a fact about the account -- which plan it is on,
   * and whether its price was bent. Both filter rows the page already holds, so neither refetches
   * and neither can disagree with the rows underneath it.
   */
  it("filters the client book by search text and by the Plan and Override chips", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("billing-tiers")) return jsonResponse(tierRows);
      if (url.includes("platform-billing")) {
        return jsonResponse([
          clientRows[0],
          { ...clientRows[0], tenantId: "tenant-northstar", businessName: "Northstar Capital Coaching (demo)" },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyTiers
        actorRole="admin"
        authorized
        enabled
        clientPricingByTenantId={{
          ...clientPricing,
          "tenant-northstar": {
            tierId: "tier-growth",
            tierName: "Growth (demo)",
            tierPriceCents: 29900,
            override: null,
          },
        }}
        stripeActionHref="https://dashboard.stripe.com/settings/account"
        stripeReadinessReceipt={stripeReadinessReceipt}
        surface="tiers"
        tierImpactById={tierImpactById}
      />,
    );

    // The seeded marker is off the name a human reads; the demo pill is what says the row is seeded.
    expect(await screen.findByRole("cell", { name: /Northstar Capital Coaching/ })).toBeVisible();
    expect(screen.queryByText(/Northstar Capital Coaching \(demo\)/)).toBeNull();

    await user.type(screen.getByPlaceholderText("Search clients"), "Northstar");
    await waitFor(() => expect(screen.queryByRole("cell", { name: /Reid Funding Group/ })).toBeNull());
    await user.clear(screen.getByPlaceholderText("Search clients"));
    await screen.findByRole("cell", { name: /Reid Funding Group/ });

    // The Override chip: one of the two clients has a standing override, and the other does not.
    const toolbar = [...document.querySelectorAll('[data-slot="data-table-toolbar"]')]
      .find((node) => node.textContent?.includes("Client pricing")) as HTMLElement;
    await user.click(within(toolbar).getByRole("button", { name: /Override/ }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Has an override" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("cell", { name: /Northstar Capital Coaching/ })).toBeNull());
    expect(screen.getByRole("cell", { name: /Reid Funding Group/ })).toBeVisible();
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

    // One amber line, not a callout with a heading and a paragraph: the values below still read
    // and the strip says so in the same breath as what is blocked.
    const strip = document.querySelector('[data-slot="money-blocking-strip"]');
    expect(strip).toHaveTextContent("Pricing changes are blocked until Stripe is verified");
    expect(strip).toHaveTextContent("Plans and client pricing stay readable.");
    expect(document.querySelector('[data-slot="callout"]')).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Edit this plan: Growth" }),
    ).toBeDisabled();
  });
});
