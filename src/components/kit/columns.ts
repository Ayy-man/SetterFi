import type { KitIcon } from "@/components/kit/icons";

import type { ColumnDef, RowData } from "@tanstack/react-table";
import { createElement, type ComponentType, type ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { workspaceDateTimeFormat } from "@/lib/format/datetime";

declare module "@tanstack/react-table" {
  // TanStack requires both generic parameters for declaration merging.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    cellClassName?: string;
    cellKind?: "identity" | "money" | "secondary" | "selection" | "state" | "actions";
    /** Ships hidden: the column is available behind Display but not on the default 4-6. */
    defaultHidden?: boolean;
    /**
     * This column carries a two-line cell (see `CellTwoLine`), so the table drops its single-line
     * clamp on it and lets the row grow. Without it the cell's second line is clipped by the
     * row's `whitespace-nowrap` and the reader sees a name with an empty gap under it.
     */
    multiline?: boolean;
    headerClassName?: string;
    label?: string;
    /** Fixes this column's width, e.g. "18rem" or 240. Beats the cellKind default. */
    width?: string | number;
    /** Floor for this column's width. Beats the cellKind default. */
    minWidth?: string | number;
  }
}

type ColumnFactoryBase<TData, TValue> = {
  id: string;
  header: string;
  accessor: (row: TData) => TValue;
  enableHiding?: boolean;
  enableSorting?: boolean;
};

/**
 * An em dash is not an answer, and neither is a zero that was never measured. A cell with nothing
 * in it says the actual thing that did not happen -- "never", "not connected", "no payout yet" --
 * so a reader can tell an absence from a value at a glance without reading it as a number. The
 * guard below is the honest-states rule made mechanical: a placeholder glyph or a bare zero throws
 * at render rather than shipping.
 *
 * It draws in `CellQuiet`'s treatment, muted and upright, because the two used to land on the same
 * row: a subscriptions row read "No provider receipt" in italic next to "no scheduled change"
 * upright, two spellings of one idea in one line. The italic also clipped -- a slanted glyph
 * overhangs the advance width its containing `truncate` span is measured against, so the last
 * letter of every absent label lost its tail to `overflow: hidden`.
 */
const FORBIDDEN_ABSENT_LABELS = new Set(["—", "–", "-", "--", "0", "n/a", "N/A", ""]);

export function absentValue(label: string): ReactNode {
  if (FORBIDDEN_ABSENT_LABELS.has(label.trim())) {
    throw new Error(
      `An absent value must name what did not happen (e.g. "never", "not connected"), not ${JSON.stringify(label)}.`,
    );
  }
  return createElement(
    "span",
    {
      className: "text-[color:var(--muted)]",
      "data-slot": "absent-value",
    },
    label,
  );
}

/** Money and counts share one treatment: mono, tabular, right-aligned against the next column. */
const NUMERIC_CELL_CLASS =
  "font-mono text-[12.5px] leading-[1.35] tabular-nums text-[var(--ink)]";

export type IdentityColumnOptions<TData, TValue = ReactNode> = ColumnFactoryBase<TData, TValue> & {
  render?: (value: TValue, row: TData) => ReactNode;
  /**
   * The muted line that sits beside the name on the same baseline -- a slug, an email, a channel.
   * Return null and the identity cell is just the name.
   */
  secondary?: (row: TData) => ReactNode;
};

export function identityColumn<TData, TValue = ReactNode>({
  id,
  header,
  accessor,
  render,
  secondary,
  enableHiding = true,
  enableSorting = true,
}: IdentityColumnOptions<TData, TValue>): ColumnDef<TData, TValue> {
  return {
    id,
    accessorFn: accessor,
    header,
    enableHiding,
    enableSorting,
    meta: {
      cellKind: "identity",
      label: header,
    },
    cell: ({ getValue, row }) => {
      const value = getValue();
      const name = createElement(
        "span",
        {
          // 14px/600, the one identity size. `CellTwoLine` and `GridTableIdentity` set the same
          // role, and the three of them used to disagree by half a pixel and a weight step, so a
          // page carrying two of them looked like two tables from two products.
          className:
            "min-w-0 truncate text-[14px] leading-[1.3] font-[600] tracking-[-0.003em] text-[var(--ink)]",
          "data-slot": "identity-name",
        },
        render ? render(value, row.original) : String(value ?? ""),
      );
      const detail = secondary?.(row.original);
      if (detail === null || detail === undefined || detail === false || detail === "") return name;
      return createElement(
        "span",
        { className: "flex min-w-0 items-baseline gap-[var(--s-2)]" },
        name,
        createElement(
          "span",
          {
            className:
              "min-w-0 shrink truncate text-[length:var(--t-mono-meta)] leading-[var(--t-mono-meta-lh)] text-[var(--muted)]",
            "data-slot": "identity-secondary",
          },
          detail,
        ),
      );
    },
  };
}

export type MoneyColumnOptions<TData> = ColumnFactoryBase<TData, number | null | undefined> & {
  currency?: string;
  locale?: string;
  emptyLabel?: string;
};

export function moneyColumn<TData>({
  id,
  header,
  accessor,
  currency = "USD",
  locale = "en-US",
  emptyLabel = "Not recorded",
  enableHiding = true,
  enableSorting = true,
}: MoneyColumnOptions<TData>): ColumnDef<TData, number | null | undefined> {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });

  return {
    id,
    accessorFn: accessor,
    header,
    enableHiding,
    enableSorting,
    meta: {
      cellClassName: "text-right",
      cellKind: "money",
      headerClassName: "text-right",
      label: header,
    },
    cell: ({ getValue }) => {
      const value = getValue();
      if (value === null || value === undefined) return absentValue(emptyLabel);
      return createElement(
        "span",
        { className: NUMERIC_CELL_CLASS },
        formatter.format(value / 100),
      );
    },
  };
}

export type NumberColumnOptions<TData> = ColumnFactoryBase<TData, number | null | undefined> & {
  locale?: string;
  format?: Intl.NumberFormatOptions;
  emptyLabel?: string;
};

/**
 * A plain numeric column: right-aligned, mono, tabular. `emptyLabel` names what did not happen --
 * it is never rendered as 0, because a count nobody has measured and a count of zero are different
 * facts and a reader cannot tell them apart once they look the same.
 */
export function numberColumn<TData>({
  id,
  header,
  accessor,
  emptyLabel = "Not recorded",
  format,
  locale = "en-US",
  enableHiding = true,
  enableSorting = true,
}: NumberColumnOptions<TData>): ColumnDef<TData, number | null | undefined> {
  const formatter = new Intl.NumberFormat(locale, format);

  return {
    id,
    accessorFn: accessor,
    header,
    enableHiding,
    enableSorting,
    meta: {
      cellClassName: "text-right",
      cellKind: "money",
      headerClassName: "text-right",
      label: header,
    },
    cell: ({ getValue }) => {
      const value = getValue();
      if (value === null || value === undefined) return absentValue(emptyLabel);
      return createElement("span", { className: NUMERIC_CELL_CLASS }, formatter.format(value));
    },
  };
}

export type DateColumnOptions<TData> = ColumnFactoryBase<TData, Date | string | number | null | undefined> & {
  emptyLabel?: string;
};

export function dateColumn<TData>({
  id,
  header,
  accessor,
  emptyLabel = "Not recorded",
  enableHiding = true,
  enableSorting = true,
}: DateColumnOptions<TData>): ColumnDef<TData, Date | string | number | null | undefined> {
  return {
    id,
    accessorFn: accessor,
    header,
    enableHiding,
    enableSorting,
    meta: {
      cellKind: "secondary",
      label: header,
    },
    cell: ({ getValue }) => {
      const value = getValue();
      const date = value instanceof Date ? value : value === null || value === undefined ? null : new Date(value);
      if (!date || Number.isNaN(date.getTime())) return absentValue(emptyLabel);
      return createElement(
        "span",
        {
          className:
            "font-mono text-[length:var(--t-mono-meta)] leading-[var(--t-mono-meta-lh)] tabular-nums text-[var(--muted)]",
        },
        workspaceDateTimeFormat.format(date),
      );
    },
  };
}

export type StateBadgeRendererProps = {
  tone: "neutral" | "good" | "warning" | "critical" | "info";
  label: string;
  /** `none` renders quiet muted text with no pill, for a cell that says a thing has not happened. */
  kind: "lifecycle" | "verdict" | "tag" | "none";
  detail?: string;
  icon?: KitIcon;
};

export type StateColumnOptions<TData> = ColumnFactoryBase<TData, StateBadgeRendererProps> & {
  StateBadge: ComponentType<StateBadgeRendererProps>;
};

export function stateColumn<TData>({
  id,
  header,
  accessor,
  StateBadge,
  enableHiding = true,
  enableSorting = true,
}: StateColumnOptions<TData>): ColumnDef<TData, StateBadgeRendererProps> {
  return {
    id,
    accessorFn: accessor,
    header,
    enableHiding,
    enableSorting,
    sortDescFirst: false,
    sortingFn: (rowA, rowB, columnId) => {
      const labelA = rowA.getValue<StateBadgeRendererProps>(columnId).label;
      const labelB = rowB.getValue<StateBadgeRendererProps>(columnId).label;
      return labelA.localeCompare(labelB);
    },
    meta: {
      cellKind: "state",
      label: header,
    },
    cell: ({ getValue }) => createElement(StateBadge, getValue()),
  };
}

export function selectColumn<TData>(): ColumnDef<TData, unknown> {
  return {
    id: "select",
    enableHiding: false,
    enableSorting: false,
    meta: {
      cellKind: "selection",
      headerClassName: "w-[var(--d-row)]",
      label: "Select",
    },
    header: ({ table }) => createElement(Checkbox, {
      "aria-label": "Select all rows on this page",
      checked: table.getIsAllPageRowsSelected(),
      indeterminate: table.getIsSomePageRowsSelected(),
      onCheckedChange: (checked) => table.toggleAllPageRowsSelected(Boolean(checked)),
    }),
    cell: ({ row }) => createElement(Checkbox, {
      "aria-label": `Select row ${row.index + 1}`,
      checked: row.getIsSelected(),
      disabled: !row.getCanSelect(),
      onCheckedChange: (checked) => row.toggleSelected(Boolean(checked)),
      onClick: (event) => event.stopPropagation(),
    }),
  };
}
