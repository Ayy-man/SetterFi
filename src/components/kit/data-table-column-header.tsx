"use client";

import { EyeOff, SortAscending, SortDescending, SortNone } from "@/components/kit/icons";

import type { Column } from "@tanstack/react-table";
import { type ReactNode, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type DataTableColumnHeaderProps<TData, TValue> = {
  column: Column<TData, TValue>;
  title: ReactNode;
  /** Plain-text name used for the accessible label of the menu trigger. */
  label: string;
  className?: string;
};

/**
 * The kit's sortable header: the title is the trigger for a small menu offering ascending,
 * descending, and hide. One control does all three, so a header never grows a second affordance
 * and the reader never has to guess whether a click sorts or opens.
 *
 * It inherits the `th`'s own type -- 11px uppercase, muted -- rather than restating it. Two
 * treatments in one header row (ink sentence-case for sortable columns, muted uppercase for the
 * rest) made sortability look like a difference in the data. The sort chevron carries that
 * difference instead, and only on hover, focus, or while the column is sorted.
 */
export function DataTableColumnHeader<TData, TValue>({
  className,
  column,
  label,
  title,
}: DataTableColumnHeaderProps<TData, TValue>) {
  const [open, setOpen] = useState(false);
  const sorted = column.getIsSorted();
  const canHide = column.getCanHide();

  if (!column.getCanSort()) {
    return <span className={cn("block truncate", className)}>{title}</span>;
  }

  const SortIcon =
    sorted === "asc" ? SortAscending : sorted === "desc" ? SortDescending : SortNone;

  return (
    <DropdownMenu
      onOpenChange={(nextOpen, details) => {
        if (details.reason !== "trigger-press") setOpen(nextOpen);
      }}
      open={open}
    >
      <DropdownMenuTrigger
        aria-label={`${label} column options`}
        className={cn(
          "group/th -mx-[var(--s-1)] inline-flex h-full max-w-full min-w-0 items-center gap-[var(--s-1)] rounded-[var(--r-control)] px-[var(--s-1)] font-[inherit] tracking-[inherit] text-inherit uppercase hover:text-[var(--ink)] data-[popup-open]:bg-[var(--quiet)] data-[popup-open]:text-[var(--ink)]",
          className,
        )}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 truncate">{title}</span>
        <SortIcon
          aria-hidden
          className={cn(
            // The chevron is a hover hint, so it fades on the quick clock -- long enough not to
            // blink, short enough that it is there by the time the eye arrives.
            "size-[var(--s-3)] shrink-0 transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:transition-none",
            sorted
              ? "text-[var(--ink)] opacity-100"
              : "text-[var(--muted)] opacity-0 group-hover/th:opacity-100 group-focus-visible/th:opacity-100 group-data-[popup-open]/th:opacity-100",
          )}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={`${label} column options`}
        className="min-w-[calc(var(--drawer-w)/3)]"
      >
        <DropdownMenuItem onClick={() => column.toggleSorting(false)}>
          <SortAscending aria-hidden className="size-[var(--s-3)] text-[var(--muted)]" />
          Sort ascending
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => column.toggleSorting(true)}>
          <SortDescending aria-hidden className="size-[var(--s-3)] text-[var(--muted)]" />
          Sort descending
        </DropdownMenuItem>
        {canHide ? <DropdownMenuSeparator /> : null}
        {canHide ? (
          <DropdownMenuItem onClick={() => column.toggleVisibility(false)}>
            <EyeOff aria-hidden className="size-[var(--s-3)] text-[var(--muted)]" />
            Hide column
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
