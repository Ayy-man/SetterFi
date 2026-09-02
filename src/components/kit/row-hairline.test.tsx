/**
 * One weight for a body row, across every surface that draws one.
 *
 * The rule is `console.css`'s and it is argued there: a row inside a panel takes `--line-soft`
 * "because these rows sit inside a panel that already has a `--line` header band under it, and two
 * hairlines at the same weight 40px apart read as a table that lost its header". Every artboard
 * draws it that way -- `AdminRevenue.dc.html:329` is a `<tr>` at `--line-soft` under the header
 * band at `:314` at `--line`, and `:266` is the same relationship for the queue row.
 *
 * The rule existed, was written out, and had been applied to `ConsoleRow` and not to `DataTable`,
 * whose `<td>` drew `--line` for as long as the component has existed. That is the shape of most of
 * what a redesign audit finds: not an unmade decision, a decision applied to one of its subjects.
 * So this holds every surface that draws a body row rather than the one that was wrong, and a new
 * table component fails here until it takes the same hairline.
 *
 * **It reads rendered class attributes rather than the source text**, so reformatting, a `cn()`
 * refactor or a conditional class that resolves to the wrong weight is still caught -- the thing
 * asserted is what the browser gets. What it cannot see is a weight set from a stylesheet rather
 * than a class, which is how `ConsoleRow` sets its own (`console.css:333`); jsdom does not load
 * the app's CSS, so that one is left to `console.css` and named here rather than silently missed.
 */

import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";

import { DataTable } from "@/components/kit/data-table";
import { ListPageSkeleton } from "@/components/kit/page-skeleton";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  usePathname: () => "/admin/platform-clients",
}));

vi.mock("@/components/kit/app-shell", () => ({
  useShellDensity: () => ({ density: "compact", setDensity: () => {} }),
}));

type Row = { id: string; name: string };

const columns: ColumnDef<Row>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "id", header: "Id" },
];

const rows: Row[] = [
  { id: "a", name: "Ballard Business Credit" },
  { id: "b", name: "Vestra Capital Group" },
];

function table() {
  return (
    <DataTable
      columns={columns}
      data={rows}
      emptyState={<div>No clients match this view.</div>}
      getRowId={(row) => row.id}
    />
  );
}

/** The hairline weight an element's class list asks for, or null if it asks for none. */
function hairline(element: Element): string | null {
  const match = /border-b\s+border-\[var\((--[a-z-]+)\)\]/.exec(element.className);
  return match ? match[1] : null;
}

describe("a body row's hairline", () => {
  it("draws a DataTable cell at --line-soft", () => {
    const { container } = render(table());

    const cells = [...container.querySelectorAll("tbody td")];
    expect(cells.length, "the table rendered no body cells to measure").toBeGreaterThan(0);

    for (const cell of cells) {
      expect(
        hairline(cell),
        `a table body cell draws its hairline at ${hairline(cell)}. Body rows take --line-soft; --line is the header band's weight, and two hairlines at one weight read as a table that lost its header (console.css, the ConsoleRow rule).`,
      ).toBe("--line-soft");
    }
  });

  it("draws a list skeleton's row at --line-soft", () => {
    const { container } = render(<ListPageSkeleton columns={4} rows={5} stats={3} />);

    const skeletonRows = [...container.querySelectorAll('[class*="h-[var(--d-row)]"]')];
    expect(skeletonRows.length, "the skeleton rendered no rows to measure").toBeGreaterThan(0);

    for (const row of skeletonRows) {
      expect(
        hairline(row),
        `a skeleton body row draws its hairline at ${hairline(row)}. A skeleton heavier than the table it stands in for makes the table look like it settled when the data arrives.`,
      ).toBe("--line-soft");
    }
  });

  /**
   * The other half of the rule, and the half that makes the first half mean something: the header
   * band keeps `--line`. Asserting only that body rows are soft would pass a table drawn entirely
   * in `--line-soft`, which has the same defect -- no header -- from the other direction.
   */
  it("keeps the header band at --line", () => {
    const { container } = render(table());

    const headerCells = [...container.querySelectorAll("thead th")];
    expect(headerCells.length, "the table rendered no header cells to measure").toBeGreaterThan(0);

    // Asserted as an equality rather than as "not --line-soft", so a header that draws no hairline
    // at all fails too. A negative assertion over a set that can be empty is a guard with nothing
    // in it, which is the failure mode this file's siblings were rewritten for tonight.
    const weights = new Set(headerCells.map(hairline));
    expect(
      weights,
      `the header band draws ${[...weights].join(", ")}. It has to be --line and nothing else: at --line-soft it is the same weight as the rows under it and the table reads as headerless, and with no hairline there is no band.`,
    ).toEqual(new Set(["--line"]));
  });
});
