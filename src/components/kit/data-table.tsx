"use client";

import { ChevronRight, X } from "@/components/kit/icons";

import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type OnChangeFn,
  type PaginationState,
  type Row,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  useReactTable,
} from "@tanstack/react-table";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import { useShellDensity } from "@/components/kit/app-shell";
import { TONE_LINE, TONE_ROW_TINT, type Tone } from "@/components/kit/atomics/tone";
import { selectColumn } from "@/components/kit/columns";
import { DataState } from "@/components/kit/data-state";
import { DataTableColumnHeader } from "@/components/kit/data-table-column-header";
import { DataTablePagination } from "@/components/kit/data-table-pagination";
import {
  DataTableRowActions,
  type RowAction,
} from "@/components/kit/data-table-row-actions";
import {
  type DataTableFacet,
  type DataTableSearch,
  DataTableToolbar,
} from "@/components/kit/data-table-toolbar";
import type { ExportMenuProps } from "@/components/kit/export-menu";
import { TableGroupHeader } from "@/components/kit/table-group-header";
import { Button } from "@/components/ui/button";
import { workspaceCountFormat } from "@/lib/format/datetime";
import { cn } from "@/lib/utils";

export type { RowAction } from "@/components/kit/data-table-row-actions";
export {
  DataTableToolbarShell,
} from "@/components/kit/data-table-toolbar";
export type {
  DataTableFacet,
  DataTableSearch,
} from "@/components/kit/data-table-toolbar";

export type BulkAction = {
  id: string;
  label: string;
  disabled?: boolean;
  tone?: "default" | "critical";
  onSelect?: (ids: string[]) => void;
};

export type ExportResource = ExportMenuProps;

type OffsetPagination = {
  mode: "offset";
  pageSize?: number;
  initialPageIndex?: number;
};

type CursorPagination = {
  mode: "cursor";
  totalRows: number;
  pageSize: number;
  pageIndex: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
};

/**
 * One band of rows under a group header. `includes` is the membership rule when a caller passes
 * `groups` on their own; with `groupBy` the entry only fixes the label and the order for a key.
 */
export type DataTableGroup<T> = {
  id: string;
  label: string;
  includes?: (row: T) => boolean;
  /**
   * The right-aligned sentence on the band, saying what this group commits to: "need a fix, not a
   * reply", "claiming pauses the agent on the thread". See `TableGroupHeader` -- it is what makes
   * a rule across the table worth drawing, rather than a second spelling of the count.
   */
  annotation?: string;
  /** The band's dot: clay on money that is owed, amber on a step someone has to move. */
  tone?: Tone;
};

export type DataTableError = {
  title: string;
  body: string;
  retry: () => void;
  code?: string;
};

export type DataTableProps<T> = {
  columns: ColumnDef<T>[];
  data: readonly T[];
  getRowId: (row: T) => string;
  emptyState: ReactNode;
  /** Row click and the kebab open the same record. Both are optional. */
  onRowOpen?: (row: T) => void;
  /** Alias of `onRowOpen`, named for the brief. */
  onRowClick?: (row: T) => void;
  rowActions?: (row: T) => readonly RowAction[];
  rowActionsLabel?: (row: T) => string;
  /**
   * A row that is arithmetic over the others rather than one of them: the Total line under a
   * ledger. It renders in place and sorts and filters with the rest, but the footer's "Showing
   * 1–3 of 3" counts the rows it sums and leaves it out, because "4 rows" over three referrals
   * and their total was a miscount an affiliate could check against their own list.
   */
  summaryRow?: (row: T) => boolean;
  /** Prepends the checkbox column. `selection` alone also turns it on. */
  selectable?: boolean;
  selection?: { onBulk: (ids: string[]) => void; actions: BulkAction[] };
  exportResource?: ExportResource;
  /** Passed to the footer: `coach` swaps the numbered range and chevron pager for the portal's
   * worded controls. See `DataTablePaginationProps.scale`. */
  scale?: "console" | "coach";
  search?: DataTableSearch;
  facets?: readonly DataTableFacet[];
  toolbar?: ReactNode;
  /** Page controls that belong beside Display and Export rather than on the left of the row. */
  toolbarEnd?: ReactNode;
  /** Extra groups inside the Display menu: a layout choice, an order group. */
  displayOptions?: ReactNode;
  ariaLabel?: string;
  /**
   * The sort the table opens on, so a page whose rows arrive already ordered shows the indicator
   * on the column doing the ordering instead of leaving every header looking unsorted. Client
   * sorting only; a cursor-paginated table carries its sort in `pagination`.
   */
  initialSorting?: SortingState;
  pagination?: OffsetPagination | CursorPagination;
  /**
   * Turns state grouping on. Every row on the current page is handed to `groupBy`; rows sharing a
   * key sit together under one group header row, and a `null` key drops the row into a trailing
   * band labelled by `ungroupedLabel`. Groups appear in `groups` order when `groups` is given,
   * otherwise in the order their first row appears -- which, because grouping partitions the
   * already-sorted page, means the active sort still decides both the band order and the order
   * inside each band.
   *
   * **When rows are grouped, drop the status pill column.** The group header already says what
   * every row under it is; a pill on each row repeats that N times and stops carrying information.
   */
  groupBy?: (row: T) => string | null | undefined;
  /**
   * Explicit groups. With `groupBy` it supplies the display label and the order for each key (an
   * unlisted key is appended, labelled by the key itself). Without `groupBy` each entry must carry
   * an `includes` predicate, and a row joins the first group that claims it.
   */
  groups?: readonly DataTableGroup<T>[];
  /**
   * One annotation for every band, for a table whose groups are computed rather than declared -- a
   * day divider, a client -- and so all mean the same thing. A per-group `annotation` wins over it.
   */
  groupAnnotation?: string;
  /** Label for rows no group claims. Rows fall into this band last. */
  ungroupedLabel?: string;
  rowLabel?: { singular: string; plural: string };
  /**
   * A standing rule about these rows, printed faint after the row count.
   *
   * For the one sentence a reader needs *while looking at the rows* and nowhere else -- "blocked
   * steps cannot be retried; unblocking records who and why". Not a place for status, a count, or
   * anything that changes per row: it renders once, under everything, and never updates.
   */
  footerNote?: string;
  /**
   * Which of the two round-5 treatments this table wears.
   *
   * `ledger` is the 6a inset ledger: a dense multi-column admin table (Revenue, Audit, Compliance,
   * Corrections) sits on the card face with its inset top highlight, and its group bands, header
   * band and row rules are all inside that one surface. `quiet` is the 6b quiet-lines treatment,
   * for a list where every row has exactly one answer (the client book, support, a coach list):
   * no card at all, group headers floating on the canvas, taller rows, and a chevron standing for
   * the whole row rather than a column of controls.
   *
   * `plain` is what every table shipped before the split and stays the default, because a table
   * that has not been read against the two treatments should not be silently given one.
   */
  variant?: "plain" | "ledger" | "quiet";
  /**
   * Marks one row as the row that is wrong, in the quiet treatment only: 6b draws its past-due
   * account as a warm-tinted row inside a full hairline of the same tone, and lets the row's own
   * answer carry the words. Return `undefined` (or `neutral`) for every row that is fine -- a
   * predicate that fires on a whole band paints a stripe and stops meaning anything.
   *
   * Always a full border, never one edge: an accent bar down the left of a row is the one
   * treatment this design does not have.
   */
  rowTone?: (row: T) => Tone | undefined;
  /**
   * What a screen reader hears on the quiet treatment's chevron. It defaults to "Open row" and
   * exists because the literal "Open" collided with a status band of the same name on the support
   * queue, where the reader heard one word for two different things.
   */
  rowOpenLabel?: string;
  /**
   * The sort in the reader's words -- "newest first", "longest wait first" -- printed after the
   * count. Pair it with `footerNote` saying what that order is blind to: a reader who sees a sorted
   * table assumes the top row is the most important one, and only the page knows whether it is.
   */
  ordering?: string;
  /**
   * Marks a row as seeded demo or test data. A marked row gets a visible label in its identity
   * cell only while the set is mixed; when every row is seeded, the page-level provenance line
   * carries it instead (`everyRowIsTest` exposes that fact to the page).
   */
  testRow?: (row: T) => boolean;
  testRowLabel?: string;
  loading?: boolean;
  error?: DataTableError;
  className?: string;
};

const DEFAULT_PAGE_SIZE = 50;

function sortAriaValue(sorted: false | "asc" | "desc") {
  if (sorted === "asc") return "ascending" as const;
  if (sorted === "desc") return "descending" as const;
  return "none" as const;
}

type CellKind =
  | "actions"
  | "identity"
  | "money"
  | "secondary"
  | "selection"
  | "state"
  | undefined;

/**
 * Widths are a floor and a ceiling, not a fixed size: the table is `w-max`, so a column sizes to
 * its content between the two. Identity columns carry the longest strings on the page -- a name
 * plus its "(demo)" marker -- so they get the widest band; money stays narrow because a figure is
 * short and reads better right-aligned against the next column.
 */
function columnConstraintClass(cellKind: CellKind) {
  if (cellKind === "selection") {
    return "w-[var(--d-row)] max-w-[var(--d-row)]";
  }
  if (cellKind === "actions") {
    return "w-[var(--s-10)] max-w-[var(--s-10)]";
  }
  if (cellKind === "money") {
    return "w-[calc(var(--drawer-w)/4)] max-w-[calc(var(--drawer-w)/4)]";
  }
  if (cellKind === "identity") {
    return "min-w-[220px] max-w-[calc(var(--drawer-w)*0.75)]";
  }
  return "min-w-[calc(var(--drawer-w)/4)] max-w-[calc(var(--drawer-w)/2)]";
}

/**
 * 6b pins every row's answer to one right edge, immediately left of the chevron, so a reader
 * scanning the list tracks a single vertical line instead of re-finding the answer at whatever
 * x the previous row's evidence happened to end at. Only the quiet treatment does this: the
 * ledger is a multi-column table where a right-aligned word column would read as a figure.
 */
function stateAlignsRight(cellKind: CellKind, variant: DataTableProps<unknown>["variant"]) {
  return variant === "quiet" && cellKind === "state";
}

/**
 * A per-column override. `meta.width` pins the column; `meta.minWidth` only raises its floor.
 * Inline styles beat the arbitrary-value classes above, so a page can widen one column without
 * restating the whole set.
 */
function columnConstraintStyle(
  meta: { width?: string | number; minWidth?: string | number } | undefined,
): CSSProperties | undefined {
  if (!meta) return undefined;
  const style: CSSProperties = {};
  if (meta.width !== undefined) {
    style.width = meta.width;
    style.maxWidth = meta.width;
    style.minWidth = meta.width;
  }
  if (meta.minWidth !== undefined) style.minWidth = meta.minWidth;
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * The attention row's paint. The tint goes on as a `background-image` rather than a
 * `background-color` so the hover wash underneath it still shows through and a hovered attention
 * row reads as hovered; setting `background` outright would have made hover a no-op on exactly
 * the row a reader is most likely to point at. The border colours are set here because the
 * borders themselves are Tailwind classes on the end cells, and every side has to agree.
 */
function toneCellStyle(
  base: CSSProperties | undefined,
  tone: Tone | undefined,
): CSSProperties | undefined {
  if (!tone) return base;
  const line = TONE_LINE[tone];
  return {
    ...base,
    backgroundImage: `linear-gradient(${TONE_ROW_TINT[tone]}, ${TONE_ROW_TINT[tone]})`,
    borderBottomColor: line,
    borderLeftColor: line,
    borderRightColor: line,
    borderTopColor: line,
  };
}

/**
 * True when every row on screen is seeded demo or test data. The page-level provenance line says
 * so once; a chip on every row would repeat it N times and read as a difference between rows.
 */
export function everyRowIsTest<T>(
  data: readonly T[],
  testRow?: (row: T) => boolean,
): boolean {
  if (!testRow || data.length === 0) return false;
  return data.every((row) => testRow(row));
}

type ResolvedGroup<R> = {
  id: string;
  label: string;
  annotation?: string;
  tone?: Tone;
  rows: R[];
};

/**
 * Partitions rows that are already sorted and already paged, so grouping never reorders anything
 * the reader chose: it only draws a rule between neighbouring bands. Returns `null` when the page
 * asked for no grouping, which is the signal to render a flat tbody.
 */
function resolveGroups<T, R extends { original: T }>(
  rows: R[],
  groupBy: ((row: T) => string | null | undefined) | undefined,
  groups: readonly DataTableGroup<T>[] | undefined,
  ungroupedLabel: string,
  groupAnnotation: string | undefined,
): ResolvedGroup<R>[] | null {
  if (!groupBy && !groups) return null;

  const labels = new Map(groups?.map((group) => [group.id, group.label]));
  const annotations = new Map(groups?.map((group) => [group.id, group.annotation]));
  const tones = new Map(groups?.map((group) => [group.id, group.tone]));
  const buckets = new Map<string, ResolvedGroup<R>>();
  const ungrouped: R[] = [];

  for (const row of rows) {
    const key = groupBy
      ? (groupBy(row.original) ?? null)
      : (groups?.find((group) => group.includes?.(row.original))?.id ?? null);
    if (key === null || key === undefined) {
      ungrouped.push(row);
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket) bucket.rows.push(row);
    else {
      buckets.set(key, {
        id: key,
        label: labels.get(key) ?? key,
        annotation: annotations.get(key) ?? groupAnnotation,
        tone: tones.get(key),
        rows: [row],
      });
    }
  }

  // Declared order first, so a page can say "live, then vetting, then paused" and have empty bands
  // simply not appear rather than leaving a header with nothing under it.
  const ordered: ResolvedGroup<R>[] = [];
  for (const group of groups ?? []) {
    const bucket = buckets.get(group.id);
    if (bucket) {
      ordered.push(bucket);
      buckets.delete(group.id);
    }
  }
  ordered.push(...buckets.values());
  if (ungrouped.length > 0) {
    ordered.push({
      id: "__ungrouped__",
      label: ungroupedLabel,
      annotation: groupAnnotation,
      rows: ungrouped,
    });
  }
  return ordered;
}

function headerLabel<T>(column: ColumnDef<T>) {
  if (column.meta?.label?.trim()) return column.meta.label.trim();
  if (typeof column.header === "string" && column.header.trim()) return column.header.trim();
  return "Column";
}

export function DataTable<T>({
  ariaLabel = "Data table",
  className,
  columns,
  data,
  displayOptions,
  emptyState,
  error,
  exportResource,
  facets,
  getRowId,
  groupAnnotation,
  groupBy,
  groups,
  initialSorting,
  loading = false,
  onRowClick,
  onRowOpen,
  pagination,
  rowActions,
  rowActionsLabel,
  footerNote,
  ordering,
  rowLabel = { singular: "row", plural: "rows" },
  rowOpenLabel = "Open row",
  rowTone,
  scale = "console",
  search,
  selectable,
  selection,
  summaryRow,
  testRow,
  testRowLabel = "Demo data",
  toolbar,
  toolbarEnd,
  ungroupedLabel = "Everything else",
  variant = "plain",
}: DataTableProps<T>) {
  const generatedId = useId().replaceAll(":", "");
  const labelId = `data-table-${generatedId}-label`;
  const openRow = onRowOpen ?? onRowClick;
  const [clientSorting, setClientSorting] = useState<SortingState>(initialSorting ?? []);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState<string | undefined>(undefined);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const { density, setDensity } = useShellDensity();
  const [clientPagination, setClientPagination] = useState<PaginationState>({
    pageIndex: pagination?.mode === "offset" ? (pagination.initialPageIndex ?? 0) : 0,
    pageSize:
      pagination?.mode === "offset"
        ? (pagination.pageSize ?? DEFAULT_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE,
  });

  const showSelection = Boolean(selectable ?? selection);
  const tableColumns = useMemo<ColumnDef<T>[]>(() => {
    const withSelection = showSelection ? [selectColumn<T>(), ...columns] : [...columns];
    // The quiet treatment states its affordance once, at the end of the row, instead of hiding a
    // kebab that appears on hover: 6b's footer says in words that the chevron is the whole row.
    if (!rowActions && variant === "quiet" && openRow) {
      return [
        ...withSelection,
        {
          id: "row-open",
          enableHiding: false,
          enableSorting: false,
          header: () => <span className="sr-only">{rowOpenLabel}</span>,
          meta: { cellKind: "actions", headerClassName: "text-right", label: rowOpenLabel },
          cell: () => (
            <span className="flex justify-end" data-slot="data-table-row-chevron">
              <ChevronRight aria-hidden className="size-[var(--s-4)] text-[var(--faint)]" />
            </span>
          ),
        } satisfies ColumnDef<T>,
      ];
    }
    if (!rowActions) return withSelection;
    return [
      ...withSelection,
      {
        id: "row-actions",
        enableHiding: false,
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { cellKind: "actions", headerClassName: "text-right", label: "Actions" },
        cell: ({ row }) => (
          // The kebab is quiet until the reader is on the row, so a long table is rows of data
          // rather than a column of identical dots. `opacity`, not `display`: the button stays
          // mounted, focusable, and in the accessibility tree, so Tab still reaches it and
          // `focus-within` on the row reveals it for a keyboard reader exactly as hover does for
          // a pointer. `has-[[data-popup-open]]` holds it visible while its own menu is open,
          // because the menu takes focus into a portal and would otherwise hide its trigger.
          <span
            className="flex justify-end opacity-0 transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-out)] group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[data-popup-open]]:opacity-100 focus-within:opacity-100 motion-reduce:transition-none"
            data-slot="data-table-row-actions-cell"
          >
            <DataTableRowActions
              actions={rowActions(row.original)}
              label={rowActionsLabel?.(row.original) ?? "Row actions"}
            />
          </span>
        ),
      } satisfies ColumnDef<T>,
    ];
  }, [columns, openRow, rowActions, rowActionsLabel, rowOpenLabel, showSelection, variant]);

  // Columns marked `meta.defaultHidden` ship behind Display, so a page can carry 12 columns and
  // still open on the 4 to 6 that change what the admin does next.
  const initialVisibility = useMemo<VisibilityState>(() => {
    const hidden: VisibilityState = {};
    for (const column of tableColumns) {
      const id = column.id ?? ("accessorKey" in column ? String(column.accessorKey) : undefined);
      if (id && column.meta?.defaultHidden) hidden[id] = false;
    }
    return hidden;
  }, [tableColumns]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initialVisibility);

  const tableData = useMemo(() => Array.from(data), [data]);
  const isCursorPagination = pagination?.mode === "cursor";
  const paginationState: PaginationState = isCursorPagination
    ? { pageIndex: pagination.pageIndex, pageSize: pagination.pageSize }
    : clientPagination;
  const sorting = isCursorPagination ? pagination.sorting : clientSorting;

  // TanStack Table exposes stateful functions that React Compiler intentionally skips.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: tableData,
    columns: tableColumns,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getPaginationRowModel: getPaginationRowModel(),
    enableRowSelection: Boolean(selection),
    manualPagination: isCursorPagination,
    manualSorting: isCursorPagination,
    onSortingChange: isCursorPagination ? pagination.onSortingChange : setClientSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: (updater) =>
      setGlobalFilter(
        typeof updater === "function"
          ? (updater(globalFilter) as string | undefined)
          : (updater as string | undefined),
      ),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: isCursorPagination ? undefined : setClientPagination,
    state: {
      sorting,
      columnFilters,
      globalFilter: globalFilter ?? "",
      columnVisibility,
      rowSelection,
      pagination: paginationState,
    },
  });

  // Summary rows render but are not counted: the footer describes the rows that were summed.
  const countedRows = (rows: readonly Row<T>[]) =>
    summaryRow ? rows.filter((row) => !summaryRow(row.original)).length : rows.length;
  const filteredRowCount = table.getFilteredRowModel().rows.length;
  const totalRows = isCursorPagination
    ? pagination.totalRows
    : countedRows(table.getFilteredRowModel().rows);
  const pageCount = Math.max(1, Math.ceil(totalRows / paginationState.pageSize));

  useEffect(() => {
    if (isCursorPagination) return;
    const lastPageIndex = Math.max(
      0,
      Math.ceil(filteredRowCount / clientPagination.pageSize) - 1,
    );
    if (clientPagination.pageIndex > lastPageIndex) {
      setClientPagination((current) => ({ ...current, pageIndex: lastPageIndex }));
    }
  }, [
    clientPagination.pageIndex,
    clientPagination.pageSize,
    filteredRowCount,
    isCursorPagination,
  ]);

  const visibleRows = table.getRowModel().rows;
  const visibleColumnCount = table.getVisibleLeafColumns().length;
  const groupedRows = resolveGroups(visibleRows, groupBy, groups, ungroupedLabel, groupAnnotation);
  // When nothing on screen is real, a chip on every row is noise: the page's provenance line
  // already says the whole set is seeded. The chip earns its place only where it separates one
  // row from its neighbours.
  const allRowsAreTest = everyRowIsTest(tableData, testRow);
  const firstShown =
    totalRows === 0 ? 0 : paginationState.pageIndex * paginationState.pageSize + 1;
  const lastShown =
    totalRows === 0 ? 0 : Math.min(totalRows, firstShown + countedRows(visibleRows) - 1);
  const selectedIds = Object.entries(rowSelection)
    .filter(([, selected]) => selected)
    .map(([id]) => id);
  const hasPreviousPage = isCursorPagination
    ? pagination.hasPreviousPage
    : table.getCanPreviousPage();
  const hasNextPage = isCursorPagination ? pagination.hasNextPage : table.getCanNextPage();

  function previousPage() {
    if (isCursorPagination) pagination.onPreviousPage();
    else table.previousPage();
  }

  function nextPage() {
    if (isCursorPagination) pagination.onNextPage();
    else table.nextPage();
  }

  function runBulkAction(action: BulkAction) {
    selection?.onBulk(selectedIds);
    action.onSelect?.(selectedIds);
  }

  const body = (() => {
    if (error) {
      return (
        <div className="min-w-full p-[var(--s-5)]">
          <DataState
            body={error.body}
            code={error.code}
            kind="error"
            retry={error.retry}
            title={error.title}
          />
        </div>
      );
    }
    if (loading) {
      return (
        <div className="min-w-full">
          <DataState kind="loading" rows={6} />
        </div>
      );
    }
    if (visibleRows.length === 0) {
      return <div className="min-w-full py-[var(--s-8)]">{emptyState}</div>;
    }

    return (
      // Rows resolve out of the skeleton's blur rather than replacing it in one frame. The
      // animation is on the table element itself, so it plays exactly once -- when the table
      // mounts as `loading` flips false -- and never again on a sort, a filter, or a page change,
      // which would make the table look like it reloaded every time the reader touched it.
      // `backwards`, not `both`: `both` would leave a permanent `filter: blur(0)` on a large
      // element and force it onto its own compositing layer for the life of the page.
      <table className="w-max min-w-full border-separate border-spacing-0 text-[length:var(--t-body)] text-[var(--body)] [animation:kit-content-reveal_var(--reveal-dur)_var(--reveal-ease)_backwards] motion-reduce:animate-none">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const sortable = header.column.getCanSort();
                const sorted = header.column.getIsSorted();
                const cellKind = header.column.columnDef.meta?.cellKind;
                const content = flexRender(
                  header.column.columnDef.header,
                  header.getContext(),
                );
                return (
                  <th
                    aria-sort={sortable ? sortAriaValue(sorted) : undefined}
                    className={
                      // The 6b drawing has no column header strip at all: the quiet list is rows
                      // on the bare canvas, and the same --band fill that reads as a header inside
                      // the ledger's card reads as a stripe painted across the page here. So the
                      // header goes away visually and stays in the accessibility tree -- these are
                      // still real `th scope=col` elements, so a screen reader still announces the
                      // column for every cell, and a sortable header is still a reachable button.
                      // Dropping the row outright would have taken both with it.
                      variant === "quiet"
                        ? cn("sr-only", header.column.columnDef.meta?.headerClassName)
                        : cn(
                            // The tint is what separates the header from the rows now that the
                            // table has no card around it: a filled band reads as a header on the
                            // bare canvas, where a hairline alone would just look like another row
                            // rule. --band is a fill that can actually be seen; --quiet drew this
                            // at 1.02:1 off the card.
                            "sticky top-0 z-[var(--z-sticky)] h-[var(--d-th)] overflow-hidden border-b border-[var(--line)] bg-[var(--band)] px-[var(--cell-x)] text-left align-middle text-[length:var(--t-label)] leading-[var(--t-label-lh)] font-[var(--t-label-w)] tracking-[var(--t-label-tr)] text-ellipsis whitespace-nowrap text-[var(--muted)] uppercase",
                            columnConstraintClass(cellKind),
                            header.column.columnDef.meta?.headerClassName,
                          )
                    }
                    key={header.id}
                    scope="col"
                    style={variant === "quiet" ? undefined : columnConstraintStyle(header.column.columnDef.meta)}
                  >
                    {header.isPlaceholder ? null : sortable ? (
                      <DataTableColumnHeader
                        column={header.column}
                        label={headerLabel(header.column.columnDef)}
                        title={content}
                      />
                    ) : cellKind === "selection" ? (
                      content
                    ) : (
                      <span className="block truncate">{content}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {groupedRows
            ? groupedRows.flatMap((group) => [
                <tr data-group-id={group.id} data-slot="data-table-group-row" key={`group-${group.id}`}>
                  <th
                    className={cn(
                      "h-[var(--d-group-row)] px-[var(--cell-x)] text-left align-middle font-normal",
                      // A filled band belongs inside a surface. On the canvas the same fill reads
                      // as a stripe across the page, so the quiet treatment floats its headers on
                      // the ground. The rule that says how far the group reaches then runs
                      // *through* the band, out of the count to the table's right edge, rather
                      // than under it: a hairline under a bandless label reads as the top rule of
                      // the first row, which is the one thing it must not be mistaken for.
                      variant === "quiet"
                        ? "bg-transparent"
                        : "border-b border-[var(--line)] bg-[var(--band)]",
                    )}
                    colSpan={visibleColumnCount}
                    scope="colgroup"
                  >
                    <TableGroupHeader
                      annotation={group.annotation}
                      count={group.rows.length}
                      label={group.label}
                      rule={variant === "quiet"}
                      tone={group.tone}
                    />
                  </th>
                </tr>,
                ...group.rows.map((row) => renderRow(row)),
              ])
            : visibleRows.map((row) => renderRow(row))}
        </tbody>
      </table>
    );

    function renderRow(row: (typeof visibleRows)[number]) {
      {
            const visibleCells = row.getVisibleCells();
            const openCell = openRow
              ? visibleCells.find(
                  (cell) =>
                    cell.column.columnDef.meta?.cellKind !== "selection" &&
                    cell.column.columnDef.meta?.cellKind !== "actions",
                )
              : undefined;
            const isTestRow = (testRow?.(row.original) ?? false) && !allRowsAreTest;
            const quiet = variant === "quiet";
            const rawTone = quiet ? rowTone?.(row.original) : undefined;
            const attentionTone = rawTone && rawTone !== "neutral" ? rawTone : undefined;
            return (
              <tr
                aria-selected={selection ? row.getIsSelected() : undefined}
                className={cn(
                  // No transition on the row background, on purpose. A hover wash that fades in
                  // lags the pointer across a 40px row, so a reader scanning a table sees a
                  // smear trailing behind the cursor instead of the row they are on.
                  "group/row border-b border-[var(--line)] transition-none focus-within:outline focus-within:outline-[var(--focus-ring)]",
                  // The hover lives on the cells rather than the row for the quiet treatment,
                  // because `border-separate` gives a `tr` neither a rendered border nor a
                  // rounded corner, and 6b's hover is a rounded block the width of the row.
                  quiet ? null : "hover:bg-[var(--row-hover)]",
                  openRow && "cursor-pointer",
                  row.getIsSelected() && "bg-[var(--row-selected)]",
                )}
                data-row-tone={attentionTone}
                data-row-id={row.id}
                data-test-row={isTestRow ? "" : undefined}
                key={row.id}
                onClick={openRow ? () => openRow(row.original) : undefined}
              >
                {visibleCells.map((cell, cellIndex) => {
                  const content = flexRender(cell.column.columnDef.cell, cell.getContext());
                  const firstCell = cellIndex === 0;
                  const lastCell = cellIndex === visibleCells.length - 1;
                  const cellKind = cell.column.columnDef.meta?.cellKind;
                  const isOpenCell = cell.id === openCell?.id;
                  // A press inside the checkbox or the kebab is a press on that control, not on
                  // the row. Without this, selecting a row or opening its menu also opened the
                  // record, and two overlays came up at once.
                  const swallowsRowPress =
                    Boolean(openRow) && (cellKind === "selection" || cellKind === "actions");
                  const multiline = cell.column.columnDef.meta?.multiline === true;
                  const alignsRight = stateAlignsRight(cellKind, variant);
                  return (
                    <td
                      className={cn(
                        // `--line-soft`, not `--line`, and the rule was already written down for
                        // the console's other list shape: `console.css` says a row inside a panel
                        // takes the soft hairline "because these rows sit inside a panel that
                        // already has a `--line` header band under it, and two hairlines at the
                        // same weight 40px apart read as a table that lost its header". A table is
                        // that same shape with more columns -- every artboard draws the body rows
                        // at `--line-soft` under a header band at `--line`
                        // (`AdminRevenue.dc.html:329` against `:314`) -- and the rule had been
                        // applied to `ConsoleRow` and not here. `row-hairline.test.tsx` now holds
                        // both, so the next surface to draw a body row does not get asked again.
                        "overflow-hidden border-b border-[var(--line-soft)] px-[var(--cell-x)] align-middle text-[12.5px] leading-[1.35] text-[var(--body)]",
                        // 6b's rows are taller because each one carries its evidence stacked under
                        // the name; the ledger's own height comes from the 6a drawing, which sets
                        // its rows at 48px against the same type size the console uses at 36px.
                        // Both are fixed rungs. Quiet used to borrow --row-h-comfortable, which is
                        // the density toggle's own token, so the treatment's height moved when a
                        // reader changed a setting the drawing knows nothing about.
                        variant === "quiet"
                          ? "h-[var(--d-row-quiet)]"
                          : variant === "ledger"
                            ? "h-[var(--d-row-ledger)]"
                            : "h-[var(--d-row)]",
                        // A two-line cell needs the row to be allowed to grow; every other cell
                        // stays on one line so a long string cannot silently re-rag the table.
                        multiline
                          ? "py-[var(--s-1)] whitespace-normal"
                          : "text-ellipsis whitespace-nowrap",
                        columnConstraintClass(cellKind),
                        alignsRight && "text-right",
                        // 6b's hover and its attention row are both rounded blocks, which on a
                        // `border-separate` table can only be drawn by the end cells.
                        quiet && "group-hover/row:bg-[var(--row-hover-quiet)]",
                        quiet && firstCell && "rounded-l-[11px]",
                        quiet && lastCell && "rounded-r-[11px]",
                        // A full hairline in the tone, closed on the ends. Never one edge.
                        attentionTone && "border-t",
                        attentionTone && firstCell && "border-l",
                        attentionTone && lastCell && "border-r",
                        cell.column.columnDef.meta?.cellClassName,
                      )}
                      key={cell.id}
                      onClick={swallowsRowPress ? (event) => event.stopPropagation() : undefined}
                      style={toneCellStyle(
                        columnConstraintStyle(cell.column.columnDef.meta),
                        attentionTone,
                      )}
                    >
                      {isOpenCell ? (
                        <button
                          className={cn(
                            "flex h-full w-full min-w-0 items-center gap-[var(--s-2)]",
                            alignsRight ? "justify-end text-right" : "text-left",
                          )}
                          type="button"
                        >
                          <span className={cn("min-w-0", !multiline && "truncate")}>{content}</span>
                          {isTestRow ? (
                            <span
                              className="shrink-0 rounded-[var(--r-input)] border border-[var(--line)] px-[var(--s-1)] text-[length:var(--t-badge)] text-[var(--muted)]"
                              data-slot="data-table-test-label"
                            >
                              {testRowLabel}
                            </span>
                          ) : null}
                        </button>
                      ) : cellKind === "selection" || cellKind === "actions" ? (
                        content
                      ) : (
                        <div
                          className={cn(
                            "flex min-w-0 items-center gap-[var(--s-2)]",
                            alignsRight && "justify-end",
                          )}
                        >
                          <span className={cn("min-w-0", !multiline && "truncate")}>{content}</span>
                          {!openCell && isTestRow && cell.id === visibleCells[0]?.id ? (
                            <span
                              className="shrink-0 rounded-[var(--r-input)] border border-[var(--line)] px-[var(--s-1)] text-[length:var(--t-badge)] text-[var(--muted)]"
                              data-slot="data-table-test-label"
                            >
                              {testRowLabel}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
      }
    }
  })();

  return (
    // Two elements on purpose. The frame takes whatever height the page gives it (usually
    // `flex-1`), and the table inside it is only as tall as its rows, capped at the frame. A
    // single element took the page's `flex-1` and stretched it, so eight rows on a tall screen
    // left several hundred pixels of empty ruled table under the last one.
    //
    // No card: no border, no radius, no fill of its own. The table sits on the page canvas and
    // lets its own tinted header band and row rules do the framing, because a bordered card
    // around a bordered grid drew two boxes and made every page read as a widget on a page
    // rather than the page itself.
    <div
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
      data-slot="data-table-frame"
    >
      <div
        className={cn(
          "flex max-h-full min-h-0 min-w-0 flex-col",
          // The 6a inset ledger: the same card face and inset top highlight every other surface
          // uses, taking no padding of its own and clipping so the toolbar and the last row both
          // meet the corner. `plain` and `quiet` stay on the bare canvas -- a card around a list
          // whose rows are already separated draws two boxes.
          variant === "ledger" && "surface-card is-flush overflow-hidden",
        )}
        data-all-test-rows={allRowsAreTest ? "" : undefined}
        data-slot="data-table"
        data-variant={variant}
      >
        <DataTableToolbar
          density={density}
          displayOptions={displayOptions}
          exportResource={exportResource}
          facets={facets}
          onDensityChange={setDensity}
          search={search}
          table={table}
          toolbarEnd={toolbarEnd}
        >
          {toolbar}
        </DataTableToolbar>

        <div
          aria-labelledby={labelId}
          className="relative min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto focus-visible:outline focus-visible:outline-[var(--focus-ring)]"
          role="region"
          tabIndex={0}
        >
          <span className="sr-only" id={labelId}>
            {ariaLabel}
          </span>
          {body}
        </div>

        {selectedIds.length > 0 && selection ? (
          <div className="sticky bottom-[var(--s-4)] z-[var(--z-sticky)] mx-auto mt-[var(--s-3)] flex w-fit max-w-full flex-wrap items-center gap-[var(--s-2)] rounded-[var(--r-card)] bg-[var(--ink)] py-[var(--s-1)] pr-[var(--s-1)] pl-[var(--s-4)] text-[length:var(--t-body)] text-[var(--canvas)] shadow-[var(--shadow-raised)]">
            <span className="tabular-nums">
              {workspaceCountFormat.format(selectedIds.length)} selected
            </span>
            {selection.actions.map((action) => (
              <Button
                className={cn(
                  "text-[var(--canvas)] hover:bg-[var(--body)] hover:text-[var(--canvas)]",
                  action.tone === "critical" && "text-[var(--critical)]",
                )}
                disabled={action.disabled}
                key={action.id}
                onClick={() => runBulkAction(action)}
                size="sm"
                variant="ghost"
              >
                {action.label}
              </Button>
            ))}
            <Button
              aria-label="Clear selection"
              className="text-[var(--canvas)] hover:bg-[var(--body)] hover:text-[var(--canvas)]"
              onClick={() => setRowSelection({})}
              size="icon-sm"
              variant="ghost"
            >
              <X aria-hidden />
            </Button>
          </div>
        ) : null}

        <DataTablePagination
          firstShown={firstShown}
          note={footerNote}
          ordering={ordering}
          hasNextPage={hasNextPage}
          hasPreviousPage={hasPreviousPage}
          lastShown={lastShown}
          onNextPage={nextPage}
          onPreviousPage={previousPage}
          pageCount={pageCount}
          pageIndex={paginationState.pageIndex}
          rowLabel={rowLabel}
          scale={scale}
          selectedCount={selectedIds.length}
          totalRows={totalRows}
          variant={variant}
        />
      </div>
    </div>
  );
}
