"use client";

import { Check, Columns, Search, SlidersHorizontal, X } from "@/components/kit/icons";

import type { Column, Table } from "@tanstack/react-table";
import { type ReactNode, useState } from "react";

import {
  DataTableFacetedFilter,
  type FacetOption,
} from "@/components/kit/data-table-faceted-filter";
import { ExportMenu, type ExportMenuProps } from "@/components/kit/export-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type DataTableDensity = "comfortable" | "compact" | "dense";

/**
 * Two choices reach the reader. `compact` is the 40px default row and `dense` the 32px one; the
 * third token value stays available to callers that already pass it.
 */
export const DENSITY_CHOICES = [
  { value: "compact", label: "Comfortable" },
  { value: "dense", label: "Compact" },
] as const satisfies readonly { value: DataTableDensity; label: string }[];

type ColumnMeta = {
  label?: string;
};

function columnDisplayLabel<TData>(column: Column<TData, unknown>) {
  const meta = column.columnDef.meta as ColumnMeta | undefined;
  if (meta?.label?.trim()) return meta.label.trim();

  const header = column.columnDef.header;
  if (typeof header === "string" && header.trim()) return header.trim();

  throw new Error("Every hideable column with a functional header requires a safe meta.label.");
}

export type DataTableSearch = {
  /** Column to filter. Omit to filter across every visible column. */
  columnId?: string;
  placeholder?: string;
  label?: string;
};

export type DataTableFacet = {
  /** The column this facet filters. Omit only in the controlled form below. */
  columnId?: string;
  title: string;
  options: readonly FacetOption[];
  /**
   * Controlled form, for a facet whose value lives in the URL because the server does the paging.
   * The chip looks and behaves the same; only the place the value lives changes. Reset clears the
   * table's own filters, so a controlled facet clears itself through its own onChange.
   */
  value?: readonly string[];
  onChange?: (next: string[]) => void;
};

/**
 * The toolbar row on its own, for a surface that shows the same controls over something that is
 * not a table (a grouped event feed, a board). Same slot and same class list, so the two layouts
 * of one page cannot drift apart.
 */
export function DataTableToolbarShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-[var(--s-2)] border-b border-[var(--line)] px-[var(--cell-x)] py-[var(--s-2)]",
        className,
      )}
      data-slot="data-table-toolbar"
    >
      {children}
    </div>
  );
}

export type DataTableToolbarProps<TData> = {
  table: Table<TData>;
  density: DataTableDensity;
  onDensityChange: (density: DataTableDensity) => void;
  exportResource?: ExportMenuProps;
  search?: DataTableSearch;
  facets?: readonly DataTableFacet[];
  /** Extra controls (view switches, saved filters) rendered before the search field. */
  children?: ReactNode;
  /** Page controls that belong beside Display and Export rather than on the left. */
  toolbarEnd?: ReactNode;
  /** Extra groups appended inside the Display menu, under Columns and Density. */
  displayOptions?: ReactNode;
};

export function DataTableToolbar<TData>({
  children,
  density,
  displayOptions,
  exportResource,
  facets,
  onDensityChange,
  search,
  table,
  toolbarEnd,
}: DataTableToolbarProps<TData>) {
  const [displayOpen, setDisplayOpen] = useState(false);
  const hideableColumns = table.getAllLeafColumns().flatMap((column) => {
    if (!column.getCanHide()) return [];
    return [{ column, label: columnDisplayLabel(column) }];
  });

  const searchColumn = search?.columnId ? table.getColumn(search.columnId) : undefined;
  const searchValue = search?.columnId
    ? String(searchColumn?.getFilterValue() ?? "")
    : String(table.getState().globalFilter ?? "");
  const filtered =
    table.getState().columnFilters.length > 0 || Boolean(table.getState().globalFilter);

  function setSearch(value: string) {
    if (search?.columnId) searchColumn?.setFilterValue(value || undefined);
    else table.setGlobalFilter(value || undefined);
  }

  function reset() {
    table.resetColumnFilters();
    table.setGlobalFilter(undefined);
  }

  return (
    <DataTableToolbarShell>
      {children ? (
        <div className="flex min-w-0 flex-wrap items-center gap-[var(--s-2)]">{children}</div>
      ) : null}
      {search ? (
        <div className="relative min-w-0 max-sm:w-full">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-[var(--s-2)] size-[var(--s-3)] -translate-y-1/2 text-[var(--muted)]"
          />
          <Input
            aria-label={search.label ?? search.placeholder ?? "Search this table"}
            className="w-full pl-[var(--s-6)] sm:w-[calc(var(--drawer-w)/2)]"
            onChange={(event) => setSearch(event.target.value)}
            placeholder={search.placeholder ?? "Search"}
            type="search"
            value={searchValue}
          />
        </div>
      ) : null}
      {facets?.map((facet) => (
        <DataTableFacetedFilter
          column={facet.columnId ? table.getColumn(facet.columnId) : undefined}
          key={facet.columnId ?? facet.title}
          onChange={facet.onChange}
          options={facet.options}
          title={facet.title}
          value={facet.value}
        />
      ))}
      {filtered ? (
        <Button onClick={reset} size="sm" type="button" variant="ghost">
          Reset
          <X aria-hidden className="size-[var(--s-3)]" />
        </Button>
      ) : null}

      <div className="ml-auto flex items-center gap-[var(--s-2)]">
        {toolbarEnd}
        <DropdownMenu
          onOpenChange={(nextOpen, details) => {
            if (details.reason !== "trigger-press") setDisplayOpen(nextOpen);
          }}
          open={displayOpen}
        >
          <DropdownMenuTrigger
            className={buttonVariants({ size: "sm", variant: "outline" })}
            onClick={() => setDisplayOpen((current) => !current)}
          >
            <SlidersHorizontal aria-hidden className="size-[var(--s-3)]" />
            Display
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            aria-label="Table display options"
            className="min-w-[calc(var(--drawer-w)/2)]"
          >
            {hideableColumns.length > 0 ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex items-center gap-[var(--s-2)] text-[length:var(--t-over)] font-[var(--t-over-w)] tracking-[var(--t-over-tr)] uppercase">
                  <Columns aria-hidden />
                  Columns
                </DropdownMenuLabel>
                {hideableColumns.map(({ column, label }) => (
                  <DropdownMenuCheckboxItem
                    checked={column.getIsVisible()}
                    key={column.id}
                    onCheckedChange={(checked) => column.toggleVisibility(Boolean(checked))}
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            ) : null}
            {hideableColumns.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-[length:var(--t-over)] font-[var(--t-over-w)] tracking-[var(--t-over-tr)] uppercase">
                Density
              </DropdownMenuLabel>
              {DENSITY_CHOICES.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => onDensityChange(option.value)}
                >
                  <span aria-hidden className="w-[var(--s-4)]">
                    {option.value === density ? <Check className="size-[var(--s-4)]" /> : null}
                  </span>
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            {displayOptions ? <DropdownMenuSeparator /> : null}
            {displayOptions}
          </DropdownMenuContent>
        </DropdownMenu>
        {exportResource ? <ExportMenu {...exportResource} /> : null}
      </div>
    </DataTableToolbarShell>
  );
}
