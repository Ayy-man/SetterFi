import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminMoneyAffiliates } from "@/components/workspace/live/admin-money-affiliates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const ledgerRows = [
  {
    ledgerId: "ledger-one",
    affiliateId: "affiliate-tasha",
    affiliateName: "Tasha Greene",
    businessName: "Reid Funding Group",
    commissionCents: 4500,
    entryKind: "accrual",
    reversesLedgerId: null,
    payoutId: null,
    payoutTotalCents: null,
    payoutState: "pending_approval",
    approvedEventId: null,
    approvedAt: null,
    approvedBy: null,
    approvedAuditId: null,
    sentEventId: null,
    sentAuditId: null,
    reference: null,
    paidOn: null,
    createdAt: "2026-08-21T12:00:00.000Z",
    dataLabel: null,
  },
  {
    ledgerId: "ledger-two",
    affiliateId: "affiliate-tasha",
    affiliateName: "Tasha Greene",
    businessName: "Northstar Capital Coaching",
    commissionCents: 7200,
    entryKind: "accrual",
    reversesLedgerId: null,
    payoutId: null,
    payoutTotalCents: null,
    payoutState: "pending_approval",
    approvedEventId: null,
    approvedAt: null,
    approvedBy: null,
    approvedAuditId: null,
    sentEventId: null,
    sentAuditId: null,
    reference: null,
    paidOn: null,
    createdAt: "2026-08-22T12:00:00.000Z",
    dataLabel: null,
  },
] as const;

const mixedRows = [
  ledgerRows[0],
  {
    ...ledgerRows[1],
    ledgerId: "ledger-three",
    affiliateId: "affiliate-marcus",
    affiliateName: "Marcus Hale",
    businessName: "Clearpath Credit",
    commissionCents: 3000,
  },
  {
    ...ledgerRows[1],
    ledgerId: "ledger-four",
    businessName: "Beacon Funding Lab",
    commissionCents: 5000,
    payoutId: "payout-one",
    payoutTotalCents: 5000,
    payoutState: "approved_for_payout",
  },
] as const;

/**
 * One payout built out of two commission entries, one of them a clawback, so the payout total is
 * genuinely a sum rather than a copy of a single row. `payoutTotalCents` agrees with the entries.
 */
const payoutRows = [
  {
    ...ledgerRows[0],
    ledgerId: "ledger-five",
    businessName: "Beacon Funding Lab",
    commissionCents: 5000,
    payoutId: "payout-one",
    payoutTotalCents: 3800,
    payoutState: "approved_for_payout",
  },
  {
    ...ledgerRows[0],
    ledgerId: "ledger-six",
    businessName: "Reid Funding Group",
    commissionCents: -1200,
    entryKind: "offset",
    payoutId: "payout-one",
    payoutTotalCents: 3800,
    payoutState: "approved_for_payout",
  },
] as const;

async function openFirstRecord() {
  const rows = await screen.findAllByRole("button", { name: "Tasha Greene" });
  await userEvent.click(rows[0]!);
  return within(await screen.findByRole("dialog"));
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function renderAffiliates(
  actorRole: "admin" | "success" = "admin",
  rows: readonly unknown[] = ledgerRows,
  chrome?: "page" | "embedded",
) {
  const fetchMock = vi.fn(async () => jsonResponse(rows));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <AdminMoneyAffiliates
      actorRole={actorRole}
      affiliatesEnabled
      authorized={actorRole === "admin"}
      chrome={chrome}
      enabled
      surface="affiliates"
    />,
  );
  return fetchMock;
}

// The shared UI setup installs these observer stubs once with vi.stubGlobal, so
// unstubbing per test would strip them for every later test in this file.
class ObserverStub {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];

  disconnect() {}
  observe() {}
  takeRecords() {
    return [];
  }
  unobserve() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("IntersectionObserver", ObserverStub);
  vi.stubGlobal("ResizeObserver", ObserverStub);
});

describe("AdminMoneyAffiliates", () => {
  it("renders the payout strip without page chrome when embedded", async () => {
    renderAffiliates("admin", ledgerRows, "embedded");

    await screen.findByLabelText("Affiliate payout summary");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("Every commission entry, banded by what is waiting on whom. SetterFi never moves the money; this page records what your bank did.")).toBeNull();
  });

  it("keeps the affiliate page heading by default", () => {
    renderAffiliates();

    expect(screen.getByRole("heading", { level: 1, name: "Affiliates and payouts" })).toBeInTheDocument();
  });

  it("carries the demo claim at page level once every ledger row is seeded", async () => {
    // Once every row is seeded the table drops its per-row chip, so the page-level claim is the
    // only thing on screen saying the ledger is demo. No per-row assertion can catch its removal.
    // It is now the chip above the title, which is where the console artboards put it.
    renderAffiliates(
      "admin",
      ledgerRows.map((row) => ({ ...row, dataLabel: "Demo" })),
    );
    await waitFor(() => {
      expect(document.querySelector('[data-slot="provenance-chip"]')).toHaveAttribute(
        "data-provenance",
        "demo",
      );
    });
    expect(
      screen.queryByText("Demo rows are labelled in the table and excluded from analytics."),
    ).toBeNull();
  });

  it("labels the seeded rows in the table when only some are demo", async () => {
    renderAffiliates("admin", [
      { ...ledgerRows[0], dataLabel: "Demo" },
      { ...ledgerRows[1], dataLabel: null },
    ]);
    expect(
      await screen.findByText(
        "Demo rows are labelled in the table and excluded from analytics.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the bulk approval bar only after a ledger row is selected", async () => {
    const user = userEvent.setup();
    renderAffiliates();

    const firstRow = await screen.findByRole("checkbox", {
      name: "Select commission row for Reid Funding Group, $45.00",
    });
    expect(
      screen.queryByRole("toolbar", { name: "Selected payout actions" }),
    ).not.toBeInTheDocument();

    await user.click(firstRow);

    const bulkBar = screen.getByRole("toolbar", {
      name: "Selected payout actions",
    });
    expect(
      within(bulkBar).getByRole("button", { name: "Approve 1 selected" }),
    ).toBeVisible();
  });

  /**
   * 2026-09-02, production: the bar rendered about sixty pixels wide with its words broken
   * mid-word. It was a `Surface`, and every `Surface` is a `@container` (inline-size containment),
   * under which a `w-fit` element has no intrinsic width and collapses to its padding. The bar
   * is a floating object over the rows, not a card carrying a container-queried header, so it
   * must not be one.
   */
  it("floats the bulk approval bar without inline-size containment, so w-fit can measure it", async () => {
    const user = userEvent.setup();
    renderAffiliates();

    await user.click(await screen.findByRole("checkbox", {
      name: "Select commission row for Reid Funding Group, $45.00",
    }));

    const bulkBar = screen.getByRole("toolbar", { name: "Selected payout actions" });
    expect(bulkBar).not.toHaveClass("@container");
    expect(bulkBar).not.toHaveAttribute("data-slot", "surface");
    expect(bulkBar).toHaveClass("surface-card", "w-fit", "max-w-full");
  });

  it("lists one confirmation line for every selected ledger row", async () => {
    const user = userEvent.setup();
    renderAffiliates();

    await user.click(
      await screen.findByRole("checkbox", {
        name: "Select commission row for Reid Funding Group, $45.00",
      }),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "Select commission row for Northstar Capital Coaching, $72.00",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Approve 2 selected" }),
    );

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getAllByText("Ledger row")).toHaveLength(2);
    expect(
      within(sheet).getByText(
        /Reid Funding Group, Commission earned, \$45\.00/,
      ),
    ).toBeVisible();
    expect(
      within(sheet).getByText(
        /Northstar Capital Coaching, Commission earned, \$72\.00/,
      ),
    ).toBeVisible();
    expect(within(sheet).getByText("$117.00")).toBeVisible();
  });

  it("renders the ledger through the kit table with sortable headers and an export", async () => {
    renderAffiliates();

    const ledger = await screen.findByRole("region", {
      name: "Affiliate commission ledger",
    });
    expect(
      within(ledger).getByRole("button", { name: /Commission/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Export table" })).toBeVisible();
    expect(screen.getByText("Showing 1–2 of 2 entries")).toBeVisible();
  });

  it("locks selection to one affiliate and offers the sent record once per payout", async () => {
    const user = userEvent.setup();
    renderAffiliates("admin", mixedRows);

    await user.click(
      await screen.findByRole("checkbox", {
        name: "Select commission row for Reid Funding Group, $45.00",
      }),
    );

    expect(
      screen.getByRole("checkbox", {
        name: "Select commission row for Clearpath Credit, $30.00",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("checkbox", {
        name: "Select commission row for Beacon Funding Lab, $50.00",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: "Payout actions for Tasha Greene" }),
    ).toBeVisible();
  });

  it("bands the ledger by payout state and spends the chip on the entry kind", async () => {
    renderAffiliates("admin", mixedRows);

    await screen.findByText("Reid Funding Group");
    const bands = [
      ...document.querySelectorAll('[data-slot="data-table-group-row"]'),
    ].map((band) => band.textContent);
    // Pending work leads; the money already out the door sits under it.
    expect(bands[0]).toContain("Pending approval");
    expect(bands[1]).toContain("Approved, not sent");
    // Grouped, so the state pill comes off every row.
    expect(
      screen.queryByRole("columnheader", { name: /Payout state/ }),
    ).not.toBeInTheDocument();
    // The chip answers what the bands cannot: which rows are clawbacks rather than payments.
    expect(screen.getByRole("button", { name: /Entry/ })).toBeVisible();
  });

  it("puts the entry count on the tile's note line and reads an empty band as zero", async () => {
    renderAffiliates("admin", ledgerRows);

    const summary = within(
      await screen.findByLabelText("Affiliate payout summary"),
    );
    // The tile is a deck panel since the console port, so its label is the panel's heading and
    // the note sits in the panel body -- two different elements under one `<section>`. Scoping to
    // that section is what the old `.parentElement` meant when the tile was one flat div.
    const pending = summary.getByText("Pending approval")
      .closest("section") as HTMLElement;
    // Substring, because the note now carries the band's own detail after the count ("2 entries ·
    // oldest Aug 21"). The claim under test is unchanged: the count is on the note line and comes
    // from the list, not from the label.
    expect(within(pending).getByText(/^2 entries\b/)).toBeVisible();
    // Both rows are pending, so "Recorded sent" was measured and came back empty. That is a real
    // zero, not an absence, and it says how many entries stand behind it.
    const sent = summary.getByText("Recorded sent")
      .closest("section") as HTMLElement;
    expect(within(sent).getByText("0")).toBeVisible();
    expect(within(sent).getByText("0 entries")).toBeVisible();
  });

  it("shows what a payout is made of rather than only its total", async () => {
    // The traceability claim, and the reason the drawer exists on a money screen: a payout total
    // that names no entries is a number an admin has to take on faith. Every line of the sum is
    // on screen, the clawback among them, and the subtotal is rendered from those lines.
    renderAffiliates("admin", payoutRows);

    const sheet = await openFirstRecord();
    expect(sheet.getByText("What this payout is made of")).toBeVisible();
    const entries = within(
      sheet.getByRole("list", { name: "Commission entries in this payout" }),
    );
    expect(entries.getByText("Beacon Funding Lab")).toBeVisible();
    expect(entries.getByText("Reid Funding Group")).toBeVisible();
    expect(entries.getByText("$50.00")).toBeVisible();
    // A reversal reads as a reversal from its parenthesis, not from its colour alone.
    expect(entries.getByText("($12.00)")).toBeVisible();
    expect(sheet.getByText("2 entries shown here")).toBeVisible();
    // The subtotal of the lines and the recorded payout total, both $38.00 because they agree.
    expect(sheet.getAllByText("$38.00")).toHaveLength(2);
    expect(
      sheet.queryByText(/do not add up to the recorded payout total/),
    ).not.toBeInTheDocument();
  });

  it("says so when the entries it holds do not add up to the recorded payout total", async () => {
    // The derived sum and the recorded total are different claims. Printing the derived sum under
    // the words "payout total" would hide the disagreement, which on a ledger is the whole bug.
    renderAffiliates(
      "admin",
      payoutRows.map((row) => ({ ...row, payoutTotalCents: 5000 })),
    );

    const sheet = await openFirstRecord();
    // The subtotal of the lines this view holds, kept apart from the total that was recorded.
    expect(sheet.getByText("$38.00")).toBeVisible();
    expect(sheet.getByText("Payout total recorded")).toBeVisible();
    expect(
      sheet.getByRole("list", { name: "Commission entries in this payout" }),
    ).not.toHaveTextContent("$38.00");
    expect(
      sheet.getByText(/do not add up to the recorded payout total/),
    ).toBeVisible();
  });

  it("counts the bank references in the sent band rather than claiming them", async () => {
    // The DB check makes "every sent entry carries a reference" true, but a note that says so
    // without looking is a promise. Counted, it survives a projection that drops the column.
    renderAffiliates("admin", [
      { ...mixedRows[2], ledgerId: "sent-one", payoutState: "sent", reference: "ACH-88102", paidOn: "2026-08-12" },
      { ...mixedRows[2], ledgerId: "sent-two", payoutId: "payout-two", payoutState: "sent", reference: "WIRE-4410", paidOn: "2026-08-04" },
    ]);

    const summary = within(await screen.findByLabelText("Affiliate payout summary"));
    const sent = summary.getByText("Recorded sent").closest("section") as HTMLElement;
    expect(
      within(sent).getByText("2 entries · 2 payouts, each with a bank reference"),
    ).toBeVisible();
  });

  it("says how many sent entries have no reference instead of claiming they all do", async () => {
    renderAffiliates("admin", [
      { ...mixedRows[2], ledgerId: "sent-one", payoutState: "sent", reference: "ACH-88102", paidOn: "2026-08-12" },
      { ...mixedRows[2], ledgerId: "sent-two", payoutState: "sent", reference: null, paidOn: null },
    ]);

    const summary = within(await screen.findByLabelText("Affiliate payout summary"));
    const sent = summary.getByText("Recorded sent").closest("section") as HTMLElement;
    expect(
      within(sent).getByText("2 entries · 1 payout, 1 with no reference recorded"),
    ).toBeVisible();
  });

  it("puts the bank reference on the row and names what has not happened yet", async () => {
    renderAffiliates("admin", [
      ...mixedRows,
      { ...mixedRows[2], ledgerId: "sent-one", payoutId: "payout-two", payoutState: "sent", reference: "ACH-88102", paidOn: "2026-08-12" },
    ]);

    await screen.findByText("Reid Funding Group");
    expect(screen.getByText(/ACH-88102 · Aug 12, 2026/)).toBeVisible();
    // Approved but unsent, and pending approval, are two different absences and say so.
    expect(screen.getByText("no reference yet")).toBeVisible();
    expect(screen.getAllByText("not approved yet").length).toBeGreaterThan(0);
  });

  it("names the payout, marks the reference required, and says the record cannot be undone", async () => {
    const user = userEvent.setup();
    renderAffiliates("admin", mixedRows);

    await user.click(
      await screen.findByRole("button", { name: "Payout actions for Tasha Greene" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Record sent" }));

    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText("Record payout as sent for Tasha Greene"),
    ).toBeVisible();
    // The total is recognisable: what it is, how many entries, and which coaches they came from.
    expect(
      within(sheet).getByText(/\$50\.00 across 1 entry\./),
    ).toBeVisible();
    expect(within(sheet).getByText(/1 entry · Beacon Funding Lab/)).toBeVisible();
    expect(within(sheet).getByText("Bank reference")).toBeVisible();
    // Append-only tables plus a partial unique index on the sent event: this is enforced, so the
    // dialog says it before a reference is typed rather than after.
    expect(within(sheet).getByText("SetterFi does not move money")).toBeVisible();
    expect(
      within(sheet).getByText(/cannot be undone or corrected, only offset by a recovery entry/),
    ).toBeVisible();
  });

  it("says when a payout was approved and by whom, on the row and in the sent dialog", async () => {
    const user = userEvent.setup();
    // Marcus carries the pending band; Tasha's single row is the approved payout, so the record
    // opened by name is unambiguously the one under test.
    renderAffiliates("admin", [
      mixedRows[1],
      {
        ...mixedRows[2],
        approvedEventId: "event-one",
        approvedAt: "2026-08-28T15:04:00.000Z",
        approvedBy: "Alec Delpuech",
      },
    ]);

    const record = await openFirstRecord();
    expect(record.getByText("Aug 28, 2026")).toBeVisible();
    expect(record.getByText("Alec Delpuech")).toBeVisible();
    await user.keyboard("{Escape}");

    // The same two facts reach the person typing a bank reference, which is where they decide
    // whether a total is safe to act on.
    await user.click(
      await screen.findByRole("button", { name: "Payout actions for Tasha Greene" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Record sent" }));
    const sheet = within(await screen.findByRole("dialog"));
    expect(sheet.getByText("Approved")).toBeVisible();
    expect(sheet.getByText("by Alec Delpuech")).toBeVisible();
  });

  it("states a missing approver name as missing rather than as an id", async () => {
    // `users.full_name` is nullable, so an approver can genuinely have no display name. The export
    // carries the name and nothing else, which is deliberate: there is no actor id here to fall
    // back to, and it would identify nobody a person could go and ask. "You" would be a guess
    // about who is reading. So the absence is stated.
    renderAffiliates("admin", [
      mixedRows[1],
      {
        ...mixedRows[2],
        approvedEventId: "event-one",
        approvedAt: "2026-08-28T15:04:00.000Z",
        approvedBy: null,
      },
    ]);

    const record = await openFirstRecord();
    expect(record.getByText("Aug 28, 2026")).toBeVisible();
    expect(record.getByText("Name not recorded on the account")).toBeVisible();
    expect(record.queryByText(/approved by you|by you\b/iu)).not.toBeInTheDocument();
    expect(record.queryByText(/^unknown$/iu)).not.toBeInTheDocument();
  });

  it("does not render payout controls for the success role", async () => {
    const fetchMock = renderAffiliates("success");

    expect(screen.queryByText(/Approve .* selected/)).not.toBeInTheDocument();
    expect(screen.queryByText("Record sent")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
