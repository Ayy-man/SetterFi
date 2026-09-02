import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  TierCommercialTerms,
  type CommercialTermRow,
} from "@/components/workspace/live/tier-commercial-terms";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/tiers",
  useRouter: () => ({ refresh: vi.fn() }),
}));

const tiers = [
  { id: "tier-growth", name: "Growth" },
  { id: "tier-scale", name: "Scale" },
];

const asOf = new Date("2026-09-15T12:00:00.000Z");

const closed: CommercialTermRow = {
  id: "term-old",
  tierId: "tier-growth",
  tierName: "Growth",
  currency: "USD",
  amountCents: 24_900,
  interval: "month",
  stripePriceId: "price_2025_growth",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: "2026-09-01T00:00:00.000Z",
  reason: "Founding rate",
  auditId: 41,
};

const open: CommercialTermRow = {
  id: "term-current",
  tierId: "tier-growth",
  tierName: "Growth",
  currency: "USD",
  amountCents: 29_900,
  interval: "month",
  stripePriceId: "price_2026_growth",
  effectiveFrom: "2026-09-01T00:00:00.000Z",
  effectiveTo: null,
  reason: "2026 list price",
  auditId: 42,
};

const noTerms = async () => [];
const bothWindows = async () => [closed, open];
const openOnly = async () => [open];

function ok(result: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("commercial terms section", () => {
  it("says what an empty ledger means for signup, in the words signup already behaves by", async () => {
    render(
      <TierCommercialTerms asOf={asOf} canRead load={noTerms} tiers={tiers} />,
    );

    expect(await screen.findByText("No commercial terms")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No commercial terms are recorded. Signup shows plan names without prices until a term is recorded.",
      ),
    ).toBeInTheDocument();
  });

  it("never claims a recorded price id was checked with Stripe", async () => {
    render(
      <TierCommercialTerms asOf={asOf} canRead load={noTerms} tiers={tiers} />,
    );

    expect(
      await screen.findByText(/recorded, not verified against Stripe until Stripe is connected/i),
    ).toBeInTheDocument();
  });

  it("shows the window history and marks only the one in force", async () => {
    render(
      <TierCommercialTerms
        asOf={asOf}
        canRead
        load={bothWindows}
        tiers={tiers}
      />,
    );

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // Newest first, and the badge lands on the window that contains the instant, not on the
    // newest row by position.
    expect(within(rows[0]).getByText("price_2026_growth")).toBeInTheDocument();
    expect(within(rows[0]).getByText("In force")).toBeInTheDocument();
    expect(within(rows[1]).getByText("price_2025_growth")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("In force")).toBeNull();
    // A closed window offers no close control; only the open one does.
    expect(within(rows[1]).queryByRole("button", { name: "Close window" })).toBeNull();
    expect(within(rows[0]).getByRole("button", { name: "Close window" })).toBeInTheDocument();
  });

  it("prints the refusal the route named instead of a generic failure", async () => {
    const submit = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "This window overlaps a term already recorded for this plan.",
          code: "TIER_OFFER_TERM_WINDOW_OVERLAP",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    render(
      <TierCommercialTerms
        asOf={asOf}
        canRead
        load={openOnly}
        submit={submit}
        tiers={tiers}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Close window" }));
    await user.type(screen.getByLabelText("Effective to"), "2026-12-01");
    await user.type(screen.getByLabelText(/Reason/), "Superseded by the 2027 price.");
    await user.click(screen.getAllByRole("button", { name: "Close window" }).at(-1)!);

    await waitFor(() =>
      expect(
        screen.getByText("This window overlaps a term already recorded for this plan."),
      ).toBeInTheDocument(),
    );
  });

  it("records a closed window against its audit receipt", async () => {
    const submit = ok({ termId: "term-current", auditId: 77 });
    const load = vi.fn().mockResolvedValue([open]);
    render(
      <TierCommercialTerms
        asOf={asOf}
        canRead
        load={load}
        submit={submit}
        tiers={tiers}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Close window" }));
    await user.type(screen.getByLabelText("Effective to"), "2026-12-01");
    await user.type(screen.getByLabelText(/Reason/), "Superseded by the 2027 price.");
    await user.click(screen.getAllByRole("button", { name: "Close window" }).at(-1)!);

    await waitFor(() => expect(screen.getByText("Audit receipt #77")).toBeInTheDocument());
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "close_term", termId: "term-current" }),
    );
    // The list is read back after a write, so the surface can never show the pre-write history.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("says nothing at all when the page cannot read money data", () => {
    const load = vi.fn();
    const { container } = render(
      <TierCommercialTerms asOf={asOf} canRead={false} load={load} tiers={tiers} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(load).not.toHaveBeenCalled();
  });
});
