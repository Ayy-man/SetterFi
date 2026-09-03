import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminMoneyBillingCosts } from "@/components/workspace/live/admin-money-billing-costs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function rollup(overrides: Record<string, unknown> = {}) {
  return {
    rollupId: "rollup-1",
    tenantId: "tenant-1",
    businessName: "Reid Funding Group",
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: "2026-08-31T00:00:00.000Z",
    revenueCents: 49_700,
    modelCostCents: 8_000,
    messagingCostCents: 3_000,
    embeddingCostCents: 1_400,
    complete: true,
    missingSources: null,
    sourceEvidenceAt: "2026-08-31T12:00:00.000Z",
    dataLabel: null,
    ...overrides,
  };
}

function renderCosts(rows: readonly unknown[], chrome?: "page" | "embedded") {
  return render(
    <AdminMoneyBillingCosts
      actorRole="admin"
      authorized
      chrome={chrome}
      enabled
      initialCostRows={rows}
    />,
  );
}

describe("AdminMoneyBillingCosts", () => {
  it("renders the cost table without page chrome when embedded", () => {
    renderCosts([rollup()], "embedded");

    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("Cost against revenue per billing period. Margin appears only where every required source is present.")).toBeNull();
    expect(screen.getByLabelText("Cost evidence")).toBeInTheDocument();
  });

  it("keeps the cost page heading by default", () => {
    renderCosts([rollup()]);

    expect(screen.getByRole("heading", { level: 1, name: "Cost evidence" })).toBeInTheDocument();
  });

  it("derives a margin only where every source is present", () => {
    renderCosts([rollup()]);
    // 49,700 revenue less 12,400 of cost.
    expect(screen.getByText("$373.00")).toBeVisible();
  });

  it("leaves the margin absent rather than reading as zero when a source is missing", () => {
    renderCosts([
      rollup({
        rollupId: "rollup-2",
        modelCostCents: null,
        missingSources: "model",
        complete: false,
      }),
    ]);

    // The honest state this page exists to demonstrate: an unknown margin must never render as
    // $0.00, which would be a figure the code cannot stand behind.
    const notShown = screen.getByText("Not shown");
    expect(notShown).toBeVisible();
    expect(screen.queryByText("$0.00")).toBeNull();

    /*
     * And it is an absence, not a state to weigh against the real ones, so it carries no pill.
     * This asserted `state-badge` with `data-kind="none"`, then the kit's `StatusAbsent`; under
     * the ledger treatment it is `CellQuiet`, which is the same rule with the last ambiguity
     * removed. `StatusAbsent` drew an em-rule, and a rule in a money column reads as "not
     * measured", "not applicable" and "none" at once; the quiet cell says which one it is in
     * words, and `CellQuiet` refuses a rule at render.
     */
    expect(notShown.closest('[data-slot="cell-quiet"]')).not.toBeNull();
    expect(notShown.closest('[data-slot="status"]'), "an absence must never render as a status")
      .toBeNull();
    expect(
      notShown.closest('[data-slot="status-absent"]'),
      "a money column must not spend a bare rule on a figure it could not derive",
    ).toBeNull();
  });

  it("marks a loss-making period rather than letting it read like a payment", () => {
    renderCosts([
      rollup({
        rollupId: "rollup-3",
        revenueCents: 29_700,
        modelCostCents: 30_000,
        messagingCostCents: 5_000,
        embeddingCostCents: 2_400,
      }),
    ]);

    // 29,700 revenue against 37,400 of cost. The accounting parenthesis is the point: a
    // negative margin is the row an admin came here to find.
    expect(screen.getByText("($77.00)")).toBeVisible();
  });

  it("says the period is not recorded rather than inventing a window", () => {
    renderCosts([
      rollup({ rollupId: "rollup-4", windowStart: null, windowEnd: null }),
    ]);
    expect(screen.getByText("Period not recorded")).toBeVisible();
    expect(screen.getByText("Not shown")).toBeVisible();
  });

  it("says the whole set is demo when every row is, and labels rows when only some are", () => {
    // CLAUDE.md: test data is labelled on screen. Once every row is seeded the per-row chip stops
    // distinguishing anything and the table drops it, so the page-level claim is the ONLY thing
    // saying so -- delete it and a fully seeded page claims nothing, which no per-row assertion
    // would catch. The whole-page arm is now the chip above the title rather than a sentence
    // under the description; the property is where it renders, not which words it uses.
    const { unmount } = renderCosts([
      rollup({ rollupId: "all-1", dataLabel: "Demo" }),
      rollup({ rollupId: "all-2", dataLabel: "Demo" }),
    ]);
    expect(document.querySelector('[data-slot="provenance-chip"]')).toHaveAttribute(
      "data-provenance",
      "demo",
    );
    // Never both: the chip states the page and the sentence states a subset of it.
    expect(
      screen.queryByText("Demo rows are labelled in the table and excluded from analytics."),
    ).toBeNull();
    unmount();

    renderCosts([
      rollup({ rollupId: "mixed-1", dataLabel: "Demo" }),
      rollup({ rollupId: "mixed-2", dataLabel: null }),
    ]);
    expect(
      screen.getByText(
        "Demo rows are labelled in the table and excluded from analytics.",
      ),
    ).toBeVisible();
  });

  it("says nothing about provenance when no row is seeded", () => {
    renderCosts([rollup({ dataLabel: null })]);
    expect(screen.queryByText(/excluded from/)).toBeNull();
  });

  it("opens the row's cost breakdown on a row press and closes on Escape", async () => {
    const user = userEvent.setup();
    renderCosts([rollup()]);

    // The List template: a row press opens the record's detail. Without this the rows were inert.
    await user.click(screen.getByRole("cell", { name: /Reid Funding Group/ }));
    const sheet = await screen.findByRole("dialog");
    const panel = within(sheet);

    // The three cost sources are Display-hidden columns, so the sheet is where the arithmetic
    // behind the Margin cell becomes legible.
    expect(panel.getByText("Model").parentElement).toHaveTextContent("$80.00");
    expect(panel.getByText("Messaging").parentElement).toHaveTextContent(
      "$30.00",
    );
    expect(panel.getByText("Embedding").parentElement).toHaveTextContent(
      "$14.00",
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says a cost source is not recorded rather than zero inside the sheet", async () => {
    const user = userEvent.setup();
    renderCosts([
      rollup({
        modelCostCents: null,
        missingSources: "model",
        complete: false,
      }),
    ]);

    await user.click(screen.getByRole("cell", { name: /Reid Funding Group/ }));
    const panel = within(await screen.findByRole("dialog"));
    // Same honest-state rule as the Margin column, one level down.
    expect(panel.getByText("Model").parentElement).toHaveTextContent(
      "Not recorded",
    );
    expect(panel.getByText("Missing sources").parentElement).toHaveTextContent(
      "model",
    );
  });

  it("bands the periods by evidence completeness and offers the margin chip", () => {
    renderCosts([
      rollup(),
      rollup({
        rollupId: "rollup-5",
        modelCostCents: null,
        missingSources: "model",
        complete: false,
      }),
    ]);

    const bands = [
      ...document.querySelectorAll('[data-slot="data-table-group-row"]'),
    ].map((band) => band.getAttribute("data-group-id"));
    // The band with work in it leads.
    expect(bands).toEqual(["Sources missing", "Every source present"]);
    // Grouped, so the Evidence pill comes off every row and the chip is spent on the band a
    // reader actually hunts for: the loss-making one.
    expect(
      screen.queryByRole("columnheader", { name: /^Evidence$/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Margin" })).toBeVisible();
  });

  it("renders the margin in the same mono tabular figure as the revenue beside it", () => {
    renderCosts([rollup()]);

    // A margin that does not line up digit for digit with Revenue makes the comparison the column
    // exists for into work the reader does by eye.
    const margin = screen.getByText("$373.00");
    expect(margin.className).toContain("font-mono");
    expect(margin.className).toContain("tabular-nums");
  });

  it("shows no summary strip at all rather than a row of zeros over an empty table", () => {
    renderCosts([]);

    expect(screen.queryByLabelText("Cost evidence summary")).toBeNull();
    expect(screen.getByText("No cost evidence yet")).toBeVisible();
  });

  it("keeps cost economics away from a success reviewer", () => {
    renderCosts([rollup()]);
    const admin = screen.queryByText("$373.00");
    expect(admin).not.toBeNull();

    render(
      <AdminMoneyBillingCosts
        actorRole="success"
        authorized
        enabled
        initialCostRows={[rollup()]}
      />,
    );
    // CLAUDE.md: cost-vs-revenue is admin-only. A second render must not add a second figure.
    expect(screen.getAllByText("$373.00")).toHaveLength(1);
  });
});
