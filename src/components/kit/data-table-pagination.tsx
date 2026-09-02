"use client";

import { ChevronLeft, ChevronRight } from "@/components/kit/icons";


import { TableFooterNote } from "@/components/kit/table-footer-note";
import { Button } from "@/components/ui/button";
import { workspaceCountFormat } from "@/lib/format/datetime";
import { cn } from "@/lib/utils";

export type DataTablePaginationProps = {
  firstShown: number;
  lastShown: number;
  totalRows: number;
  pageIndex: number;
  pageCount: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  rowLabel: { singular: string; plural: string };
  selectedCount?: number;
  /** One standing rule about the rows, printed under the count. See `DataTableProps.footerNote`. */
  note?: string;
  /** The sort in the reader's words, printed after the count. See `DataTableProps.ordering`. */
  ordering?: string;
  /**
   * Which table treatment this footer closes. 6a rules its footer off from the last row because
   * the table is a card and the rule is that card's last edge; 6b draws neither a rule nor a fill
   * under its footer, because a quiet list has no edge for one to close.
   */
  variant?: "plain" | "ledger" | "quiet";
  /**
   * `coach` is the portal footer `Leads.dc.html` draws: "Showing 6 of 214 leads" over the rows on
   * screen rather than a numbered range, and two worded 44px buttons instead of a chevron pager
   * and a "Page 1 of 3" readout. The console keeps the range and the pager -- an operator paging
   * an audit log needs to know which page they are on, and a coach reading their own leads does
   * not.
   */
  scale?: "console" | "coach";
};

export function DataTablePagination({
  firstShown,
  hasNextPage,
  hasPreviousPage,
  lastShown,
  onNextPage,
  note,
  ordering,
  onPreviousPage,
  pageCount,
  pageIndex,
  rowLabel,
  scale = "console",
  selectedCount = 0,
  totalRows,
  variant = "plain",
}: DataTablePaginationProps) {
  const coach = scale === "coach";
  const shownCount = Math.max(0, lastShown - firstShown + 1);
  const countLabel = totalRows === 1 ? rowLabel.singular : rowLabel.plural;
  // "Showing 1-8 of 8": the range first, the total last, in the order a reader asks the two
  // questions. The older "8 entries, showing 1 to 8" led with the number nobody was looking for.
  const rangeLabel =
    totalRows === 0
      ? `No ${rowLabel.plural}`
      : coach
        ? `Showing ${workspaceCountFormat.format(shownCount)} of ${workspaceCountFormat.format(totalRows)} ${countLabel}`
        : `Showing ${workspaceCountFormat.format(firstShown)}–${workspaceCountFormat.format(lastShown)} of ${workspaceCountFormat.format(totalRows)} ${countLabel}`;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-[var(--s-4)] px-[var(--cell-x)] py-[var(--s-2)] text-[length:var(--t-body)] text-[var(--muted)]",
        variant === "quiet" ? null : "border-t border-[var(--line)]",
      )}
      data-slot="data-table-pagination"
    >
      <TableFooterNote
        note={note}
        ordering={ordering}
        range={`${rangeLabel}${
          selectedCount > 0
            ? `, ${workspaceCountFormat.format(selectedCount)} selected`
            : ""
        }`}
      />
      {pageCount > 1 && coach ? (
        /*
          Worded buttons at the coach's 44px floor, as the artboard draws them. "Back" and "More
          leads" say what they do; a chevron pair with "Page 2 of 5" between them is a control for
          somebody who is auditing a list, not for somebody reading their own. The row label is
          the plural the surface already declares, so the second button names whatever the table
          is a table of rather than hard-coding leads.
        */
        <div className="flex items-center gap-[var(--s-2)]">
          <Button
            className="h-[44px] px-[var(--s-4)] text-[16px]"
            disabled={!hasPreviousPage}
            onClick={onPreviousPage}
            type="button"
            variant="outline"
          >
            Back
          </Button>
          <Button
            className="h-[44px] px-[var(--s-4)] text-[16px]"
            disabled={!hasNextPage}
            onClick={onNextPage}
            type="button"
            variant="outline"
          >
            More {rowLabel.plural}
          </Button>
        </div>
      ) : pageCount > 1 ? (
        <div className="flex items-center gap-[var(--s-1)]">
          <Button
            aria-label="Previous page"
            disabled={!hasPreviousPage}
            onClick={onPreviousPage}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronLeft aria-hidden />
          </Button>
          <span className="tabular-nums">
            Page {workspaceCountFormat.format(pageIndex + 1)} of{" "}
            {workspaceCountFormat.format(pageCount)}
          </span>
          <Button
            aria-label="Next page"
            disabled={!hasNextPage}
            onClick={onNextPage}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
