import { cleanup, render, screen, within } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";

import { CellQuiet } from "@/components/kit/cell-quiet";
import { CellTwoLine } from "@/components/kit/cell-two-line";
import { DataTable } from "@/components/kit/data-table";
import { StatStrip } from "@/components/kit/stat-strip";
import { TableFooterNote } from "@/components/kit/table-footer-note";
import { TableGroupHeader } from "@/components/kit/table-group-header";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock("@/components/kit/app-shell", () => ({
  useShellDensity: () => ({ density: "compact", setDensity: () => {} }),
}));

/**
 * The table language extracted from the drawn Inbox (`.planning/design/screens-r2/1a.html` and
 * `.planning/design/screens-r4/5a.html`). Each test below pins the part of the drawing that a
 * hand-rolled table keeps losing: the annotation on a group band, the sentence under the count,
 * the second line of a cell, and the single toned figure in the strip.
 */
describe("table group header", () => {
  it("states what the band means beside its label and count", () => {
    render(
      <TableGroupHeader
        annotation="need a fix, not a reply"
        count={3}
        label="System problems"
      />,
    );

    const header = document.querySelector('[data-slot="table-group-header"]');
    expect(header).not.toBeNull();
    expect(
      within(header as HTMLElement).getByText("System problems"),
    ).toBeVisible();
    expect(
      within(header as HTMLElement).getByText("3", {
        selector: '[data-slot="data-table-group-count"]',
      }),
    ).toBeVisible();
    const annotation = header?.querySelector(
      '[data-slot="table-group-annotation"]',
    );
    expect(annotation).toHaveTextContent("need a fix, not a reply");
    // Right-aligned by an auto margin, never by an edge rule or a second column.
    expect(annotation?.className).toContain("ml-auto");
  });

  it("draws no band annotation when the group has none to make", () => {
    render(<TableGroupHeader count={2} label="Lead handoffs" />);

    expect(
      document.querySelector('[data-slot="table-group-annotation"]'),
    ).toBeNull();
  });
});

describe("DataTable group annotations", () => {
  type Row = { id: string; name: string; kind: string };

  const columns: ColumnDef<Row>[] = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "kind", header: "Kind" },
  ];

  const rows: Row[] = [
    { id: "a", name: "Elevate Funding", kind: "system" },
    { id: "b", name: "Marcus T.", kind: "handoff" },
  ];

  it("carries a declared group's annotation onto its band", () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        emptyState={<div>Nothing waiting.</div>}
        getRowId={(row) => row.id}
        groupBy={(row) => row.kind}
        groups={[
          {
            id: "system",
            label: "System problems",
            annotation: "need a fix, not a reply",
          },
          {
            id: "handoff",
            label: "Lead handoffs",
            annotation: "claiming pauses the agent on the thread",
          },
        ]}
      />,
    );

    const system = document.querySelector('[data-group-id="system"]');
    expect(
      within(system as HTMLElement).getByText("need a fix, not a reply"),
    ).toBeVisible();
    const handoff = document.querySelector('[data-group-id="handoff"]');
    expect(
      within(handoff as HTMLElement).getByText(
        "claiming pauses the agent on the thread",
      ),
    ).toBeVisible();
  });

  it("repeats one annotation across computed bands that all mean the same thing", () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        emptyState={<div>Nothing waiting.</div>}
        getRowId={(row) => row.id}
        groupAnnotation="day boundaries follow the workspace clock"
        groupBy={(row) => row.kind}
      />,
    );

    expect(
      screen.getAllByText("day boundaries follow the workspace clock"),
    ).toHaveLength(2);
  });
});

describe("table footer note", () => {
  it("prints the range, the ordering, and what the ordering cannot tell you", () => {
    render(
      <TableFooterNote
        note="Order is when each event was recorded, not when it took effect."
        ordering="longest wait first"
        range="Showing 1–7 of 7 items"
      />,
    );

    expect(screen.getByText("Showing 1–7 of 7 items")).toBeVisible();
    expect(screen.getByText("· longest wait first")).toBeVisible();
    expect(
      screen.getByText(
        "Order is when each event was recorded, not when it took effect.",
      ),
    ).toBeVisible();
  });

  it("puts the ordering and the sentence under a real table's count", () => {
    type Row = { id: string; name: string };
    render(
      <DataTable
        columns={[{ accessorKey: "name", header: "Name" }] as ColumnDef<Row>[]}
        data={[{ id: "a", name: "Ana" }]}
        emptyState={<div>None.</div>}
        footerNote="A row leaves this page when it is claimed, not when it is answered."
        getRowId={(row) => row.id}
        ordering="newest first"
        rowLabel={{ singular: "event", plural: "events" }}
      />,
    );

    const footer = document.querySelector('[data-slot="table-footer-note"]');
    expect(
      within(footer as HTMLElement).getByText(/Showing 1–1 of 1 event/),
    ).toBeVisible();
    expect(
      footer?.querySelector('[data-slot="table-footer-ordering"]'),
    ).toHaveTextContent("newest first");
    expect(
      footer?.querySelector('[data-slot="data-table-footer-note"]'),
    ).toHaveTextContent(
      "A row leaves this page when it is claimed, not when it is answered.",
    );
  });
});

describe("two-line cell", () => {
  it("puts the context under the name in mono rather than in another column", () => {
    render(<CellTwoLine primary="Marcus T." subline="IG Closer · Elevate" />);

    const cell = document.querySelector('[data-slot="cell-two-line"]');
    expect(
      within(cell as HTMLElement).getByText("Marcus T."),
    ).toBeVisible();
    const subline = cell?.querySelector('[data-slot="cell-two-line-subline"]');
    expect(subline).toHaveTextContent("IG Closer · Elevate");
    expect(subline?.className).toContain("font-mono");
  });

  it("names what is missing rather than printing a dash", () => {
    render(<CellTwoLine absentSubline="no origin recorded" primary="Marcus T." />);

    const subline = document.querySelector(
      '[data-slot="cell-two-line-subline"]',
    );
    expect(subline).toHaveTextContent("no origin recorded");
    expect(subline).toHaveAttribute("data-absent", "");
    // Em and en dash, built from char codes: the repo-wide em-dash scan decodes escape
    // spellings on purpose, so the characters must not appear in source in any spelling.
    const dashes = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`);
    expect(document.body.textContent).not.toMatch(dashes);
  });

  /**
   * One identity size across the three components that render the same role. They shipped at
   * 12.5px/400 here, 13px/500 in `identityColumn` and 13.5px/500 in `GridTableIdentity`, so two
   * lists on one page disagreed about how loud a row's own name is.
   */
  it("sets the name at the one identity size the drawing uses", () => {
    render(<CellTwoLine primary="Marcus T." subline="IG Closer" />);
    const primary = document.querySelector('[data-slot="cell-two-line-primary"]');
    expect(primary?.className).toContain("text-[14px]");
    expect(primary?.className).toContain("font-[600]");
  });

  /**
   * Mono is for figures. A subline carrying a sentence somebody wrote -- the support queue's
   * subject line -- takes 11px sans instead, the same treatment `GridTableIdentity` gives its own.
   */
  it("sets a prose subline in sans and keeps mono for the figures", () => {
    render(<CellTwoLine primary="Northstar" subline="Payout is late again" sublineKind="prose" />);
    const subline = document.querySelector('[data-slot="cell-two-line-subline"]');
    expect(subline?.className).not.toContain("font-mono");
    expect(subline?.className).toContain("text-[11px]");
  });

  /**
   * Not italic, for the two reasons `absentValue` stopped being italic: italic reads as emphasis,
   * so a column where half the rows have no subline shouts about the rows where nothing happened,
   * and `truncate` clips an italic's overhang.
   */
  it("says the absent subline in the same face as a present one, never in italic", () => {
    render(<CellTwoLine absentSubline="no origin recorded" primary="Marcus T." />);
    expect(
      document.querySelector('[data-slot="cell-two-line-subline"]')?.className,
    ).not.toContain("italic");
  });

  it("drops the second line entirely when there is no second fact", () => {
    render(<CellTwoLine primary="Marcus T." />);

    expect(
      document.querySelector('[data-slot="cell-two-line-subline"]'),
    ).toBeNull();
  });
});

describe("stat strip emphasis", () => {
  it("colours the one figure that needs someone, and marks it with a dot", () => {
    render(
      <StatStrip
        items={[
          {
            label: "Events recorded",
            availability: { kind: "value", value: 212, format: "count" },
          },
          {
            label: "Refused or failed",
            availability: { kind: "value", value: 4, format: "count" },
            tone: "warning",
          },
        ]}
      />,
    );

    const tiles = screen.getAllByTestId("stat-tile");
    const toned = tiles[1] as HTMLElement;
    expect(
      toned.querySelector('[data-slot="stat-strip-tone-dot"]'),
    ).not.toBeNull();
    const figure = toned.querySelector('[data-slot="stat-strip-figure"]');
    expect(figure).toHaveAttribute("data-tone", "warning");
    expect(figure).toHaveStyle({ color: "var(--warning-text)" });
    expect(
      (tiles[0] as HTMLElement).querySelector(
        '[data-slot="stat-strip-tone-dot"]',
      ),
    ).toBeNull();
  });

  /*
   * An empty failure queue is the good case. Colouring the zero says a healthy figure is a
   * problem, which is the same defect as an amber "0 open requests" tile.
   */
  it("refuses the tone on a measured zero", () => {
    render(
      <StatStrip
        items={[
          {
            label: "Refused or failed",
            availability: { kind: "value", value: 0, format: "count" },
            tone: "warning",
          },
        ]}
      />,
    );

    expect(
      document.querySelector('[data-slot="stat-strip-tone-dot"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-slot="stat-strip-figure"]'),
    ).not.toHaveAttribute("data-tone");
  });

  it("refuses the tone on a figure that was never read", () => {
    render(
      <StatStrip
        items={[
          {
            label: "Refused or failed",
            availability: { kind: "unavailable", note: "no window measured yet" },
            tone: "warning",
          },
        ]}
      />,
    );

    expect(
      document.querySelector('[data-slot="stat-strip-tone-dot"]'),
    ).toBeNull();
    expect(screen.getByText("not yet")).toBeVisible();
  });
});

/**
 * The two round-5 treatments (`.planning/design/screens-r5/6ab-table-anatomy-screenshot.png`).
 * `ledger` puts a dense admin table on the card face; `quiet` keeps a one-answer list on the
 * canvas and states its affordance once, at the end of the row.
 */
describe("table treatments", () => {
  type Row = { id: string; name: string; kind: string };

  const columns: ColumnDef<Row>[] = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "kind", header: "Kind" },
  ];

  const rows: Row[] = [
    { id: "a", name: "Northstar Capital", kind: "past-due" },
    { id: "b", name: "Reid Funding", kind: "active" },
  ];

  function renderVariant(variant: "plain" | "ledger" | "quiet", open?: () => void) {
    return render(
      <DataTable
        columns={columns}
        data={rows}
        emptyState={<div>None.</div>}
        getRowId={(row) => row.id}
        groupBy={(row) => row.kind}
        groups={[
          {
            id: "past-due",
            label: "Past due",
            annotation: "money is owed, read these first",
            tone: "failure",
          },
          { id: "active", label: "Active", annotation: "billing normally", tone: "good" },
        ]}
        onRowOpen={open}
        variant={variant}
      />,
    );
  }

  it("puts a ledger table on the card face and leaves the other two on the canvas", () => {
    renderVariant("ledger");
    expect(document.querySelector('[data-slot="data-table"]')?.className).toContain(
      "surface-card",
    );

    cleanup();
    renderVariant("plain");
    expect(document.querySelector('[data-slot="data-table"]')?.className).not.toContain(
      "surface-card",
    );

    cleanup();
    renderVariant("quiet");
    expect(document.querySelector('[data-slot="data-table"]')?.className).not.toContain(
      "surface-card",
    );
  });

  it("floats the quiet treatment's group headers instead of filling them", () => {
    renderVariant("quiet");
    const band = document.querySelector('[data-group-id="past-due"] th');
    expect(band?.className).toContain("bg-transparent");
    expect(band?.className).not.toContain("bg-[var(--band)]");

    cleanup();
    renderVariant("ledger");
    // --band, not --quiet: --quiet aliases --well, which sits 1.02:1 off --card, so the fill the
    // ledger shipped with was a band nobody could see.
    expect(
      document.querySelector('[data-group-id="past-due"] th')?.className,
    ).toContain("bg-[var(--band)]");
  });

  it("marks a band with a dot when the band is a claim rather than a partition", () => {
    renderVariant("ledger");
    const band = document.querySelector('[data-group-id="past-due"]');
    expect(
      within(band as HTMLElement).getByText("money is owed, read these first"),
    ).toBeVisible();
    const dot = band?.querySelector('[data-slot="table-group-dot"]');
    expect(dot).not.toBeNull();
    // Flat: the product spends its one glow elsewhere.
    expect(dot?.getAttribute("style")).not.toContain("box-shadow");
  });

  it("gives a quiet row one chevron for the whole row, and no other treatment one", () => {
    renderVariant("quiet", () => {});
    expect(
      document.querySelectorAll('[data-slot="data-table-row-chevron"]'),
    ).toHaveLength(2);

    cleanup();
    renderVariant("ledger", () => {});
    expect(
      document.querySelectorAll('[data-slot="data-table-row-chevron"]'),
    ).toHaveLength(0);
  });

  /**
   * 6b has no column header strip at all. The header still has to exist for a screen reader and
   * for sorting, so it goes `sr-only` on real `th scope="col"` elements rather than away.
   */
  it("hides the quiet treatment's column headers without taking them out of the table", () => {
    renderVariant("quiet");
    const head = document.querySelector("thead th") as HTMLElement;
    expect(head.className).toContain("sr-only");
    expect(head.className).not.toContain("bg-[var(--band)]");
    expect(head.tagName).toBe("TH");
    expect(head.getAttribute("scope")).toBe("col");
  });

  it("keeps the ledger's filled header band", () => {
    renderVariant("ledger");
    expect((document.querySelector("thead th") as HTMLElement).className).toContain(
      "bg-[var(--band)]",
    );
  });

  /**
   * The band's own anatomy: dot, tone-tinted overline, count, then a hairline out to the table's
   * right edge saying how far the group reaches. The quiet band has no fill and no card edge, so
   * without the rule the label floats mid-canvas with nothing bounding it; 6a needs none because
   * its band is a filled row and the fill already draws the width.
   */
  it("runs a rule out of the quiet band and none out of the ledger's", () => {
    renderVariant("quiet");
    const band = document.querySelector('[data-group-id="past-due"] th') as HTMLElement;
    expect(band.querySelector('[data-slot="table-group-rule"]')).not.toBeNull();
    expect(band.className).not.toContain("border-b");
    const label = band.querySelector('[data-slot="table-group-label"]') as HTMLElement;
    expect(label.className).toContain("text-[9.5px]");
    expect(label.getAttribute("style")).toContain("var(--failure-text)");

    cleanup();
    renderVariant("ledger");
    const ledgerBand = document.querySelector('[data-group-id="past-due"] th') as HTMLElement;
    expect(ledgerBand.querySelector('[data-slot="table-group-rule"]')).toBeNull();
    expect(ledgerBand.className).toContain("border-b");
  });

  /** 6b draws no rule and no fill under its footer; 6a draws both, and that split is deliberate. */
  it("closes the ledger's footer with a rule and leaves the quiet one open", () => {
    renderVariant("ledger");
    expect(
      (document.querySelector('[data-slot="data-table-pagination"]') as HTMLElement).className,
    ).toContain("border-t");

    cleanup();
    renderVariant("quiet");
    expect(
      (document.querySelector('[data-slot="data-table-pagination"]') as HTMLElement).className,
    ).not.toContain("border-t");
  });

  /**
   * The attention row: a tint and a hairline of the same tone closed on all four sides. Never a
   * left- or right-edge-only bar, which is the one treatment this design does not have.
   */
  it("marks an attention row with a full tone border and never one edge", () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        emptyState={<div>None.</div>}
        getRowId={(row) => row.id}
        rowTone={(row) => (row.id === "a" ? "failure" : undefined)}
        variant="quiet"
      />,
    );

    const toned = document.querySelector('tr[data-row-tone="failure"]') as HTMLElement;
    const cells = Array.from(toned.querySelectorAll("td"));
    expect(cells[0].className).toContain("border-l");
    expect(cells.at(-1)?.className).toContain("border-r");
    for (const cell of cells) {
      expect(cell.className).toContain("border-t");
      expect(cell.getAttribute("style")).toContain("var(--failure-line)");
      expect(cell.getAttribute("style")).toContain("linear-gradient");
    }
    // Every other row is left alone: a tint that fires on a whole band is a stripe, not a row.
    expect(document.querySelectorAll('tr[data-row-tone]')).toHaveLength(1);
  });

  /**
   * The chevron's label is caller-suppliable because the default collided with a status band
   * literally named "Open" on the support queue: a screen reader heard one word for a state and
   * for a control, on the same table.
   */
  it("lets a page rename the row-open chevron away from a band of the same name", () => {
    renderVariant("quiet", () => {});
    expect(screen.getAllByText("Open row").length).toBeGreaterThan(0);

    cleanup();
    render(
      <DataTable
        columns={columns}
        data={rows}
        emptyState={<div>None.</div>}
        getRowId={(row) => row.id}
        onRowOpen={() => {}}
        rowOpenLabel="Open this request"
        variant="quiet"
      />,
    );
    expect(screen.getAllByText("Open this request").length).toBeGreaterThan(0);
    expect(screen.queryByText("Open row")).toBeNull();
  });

  /**
   * The quiet hover is its own token. --row-hover is tuned for a row on the ledger's card face,
   * and at .03 on the bare canvas 6b's rows had no click signal at all. It is rounded because the
   * drawing's hover is a rounded block, which on a `border-separate` table only the end cells can
   * draw -- so the wash lives on the cells rather than on the row.
   */
  it("gives the quiet treatment its own rounded hover", () => {
    renderVariant("quiet");
    const cells = Array.from(document.querySelectorAll("tbody tr[data-row-id]:last-child td"));
    expect(cells[0]?.className).toContain("group-hover/row:bg-[var(--row-hover-quiet)]");
    expect(cells[0]?.className).toContain("rounded-l-[11px]");
    expect(cells.at(-1)?.className).toContain("rounded-r-[11px]");

    cleanup();
    renderVariant("ledger");
    expect(
      (document.querySelector("tbody tr[data-row-id]") as HTMLElement).className,
    ).toContain("hover:bg-[var(--row-hover)]");
  });

  /**
   * 6b pins every row's answer to one right edge above the chevron, so the eye tracks a single
   * vertical line instead of re-finding the answer wherever the previous row's evidence ended.
   */
  it("right-aligns the quiet treatment's answer column and leaves the ledger's alone", () => {
    const stateColumns: ColumnDef<Row>[] = [
      { accessorKey: "name", header: "Name" },
      { accessorKey: "kind", header: "Kind", meta: { cellKind: "state" } },
    ];
    const table = (variant: "ledger" | "quiet") => (
      <DataTable
        columns={stateColumns}
        data={rows}
        emptyState={<div>None.</div>}
        getRowId={(row) => row.id}
        variant={variant}
      />
    );

    render(table("quiet"));
    expect(
      (document.querySelector("tbody tr td:last-child") as HTMLElement).className,
    ).toContain("text-right");

    cleanup();
    render(table("ledger"));
    expect(
      (document.querySelector("tbody tr td:last-child") as HTMLElement).className,
    ).not.toContain("text-right");
  });

  it("gives each treatment its own row height, and the ledger the drawing's", () => {
    // Quiet has its own rung too, for the same reason the ledger got one and one more besides:
    // it used to borrow --row-h-comfortable, which is the density toggle's own token, so a reader
    // switching the console to dense silently moved a treatment the 6b drawing fixes.
    renderVariant("quiet");
    expect(document.querySelector("tbody td")?.className).toContain(
      "h-[var(--d-row-quiet)]",
    );
    expect(document.querySelector("tbody td")?.className).not.toContain(
      "h-[var(--row-h-comfortable)]",
    );

    // The ledger has its own rung now. It used to share the console's --d-row, and at 36px the
    // 6a table read as compressed against the drawing it was built from at the same type size.
    cleanup();
    renderVariant("ledger");
    expect(document.querySelector("tbody td")?.className).toContain("h-[var(--d-row-ledger)]");

    cleanup();
    renderVariant("plain");
    expect(document.querySelector("tbody td")?.className).toContain("h-[var(--d-row)]");
  });
});

describe("quiet cell", () => {
  it("says what did not happen in muted plain text, not italic filler", () => {
    render(<CellQuiet>nothing scheduled</CellQuiet>);

    const cell = document.querySelector('[data-slot="cell-quiet"]');
    expect(cell).toHaveTextContent("nothing scheduled");
    expect(cell?.className).toContain("text-[color:var(--muted)]");
    expect(cell?.className).not.toContain("italic");
  });

  it("refuses a dash, which claims three different absences at once", () => {
    expect(() => render(<CellQuiet>{"\u2014"}</CellQuiet>)).toThrow(
      /must name what did not happen/,
    );
  });
});
