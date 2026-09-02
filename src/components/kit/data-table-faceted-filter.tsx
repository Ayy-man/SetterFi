"use client";

import { ListFilter } from "@/components/kit/icons";

import type { Column } from "@tanstack/react-table";
import { useState } from "react";

import { StateBadge } from "@/components/kit/state-badge";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type FacetOption = { label: string; value: string };

export type DataTableFacetProps<TData, TValue> = {
  column?: Column<TData, TValue>;
  title: string;
  options: readonly FacetOption[];
  /**
   * Controlled mode, for a facet whose value lives in the URL rather than in table state: pass
   * `value` and `onChange` and the chip reads and writes those instead of the column filter. It
   * exists so a page that pages on the server stops hand-rolling its own copy of this chip and
   * the two stop drifting apart.
   */
  value?: readonly string[];
  onChange?: (next: string[]) => void;
};

/**
 * The kit's faceted filter, on our menu primitive: a dashed chip that names the facet, shows the
 * chosen values inline, and holds the value list behind a single press.
 */
export function DataTableFacetedFilter<TData, TValue>({
  column,
  onChange,
  options,
  title,
  value,
}: DataTableFacetProps<TData, TValue>) {
  const [open, setOpen] = useState(false);
  const controlled = value !== undefined || onChange !== undefined;
  if (!column && !controlled) return null;

  const filterValue = controlled ? value : column?.getFilterValue();
  const selected = new Set(Array.isArray(filterValue) ? (filterValue as string[]) : []);

  function commit(next: string[]) {
    if (controlled) onChange?.(next);
    else column?.setFilterValue(next.length ? next : undefined);
  }

  function toggle(optionValue: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(optionValue);
    else next.delete(optionValue);
    commit([...next]);
  }

  const chosen = options.filter((option) => selected.has(option.value));

  return (
    <DropdownMenu
      onOpenChange={(nextOpen, details) => {
        if (details.reason !== "trigger-press") setOpen(nextOpen);
      }}
      open={open}
    >
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({ size: "sm", variant: "outline" }),
          "border-dashed data-[popup-open]:bg-[var(--quiet)]",
        )}
        onClick={() => setOpen((current) => !current)}
      >
        <ListFilter aria-hidden className="size-[var(--s-3)]" />
        {title}
        {chosen.length > 0 ? (
          <span className="ml-[var(--s-1)] flex items-center gap-[var(--s-1)]">
            {chosen.length > 2 ? (
              <StateBadge
                dot={false}
                kind="tag"
                label={`${chosen.length} selected`}
                size="sm"
                tone="neutral"
              />
            ) : (
              chosen.map((option) => (
                <StateBadge
                  dot={false}
                  key={option.value}
                  kind="tag"
                  label={option.label}
                  size="sm"
                  tone="neutral"
                />
              ))
            )}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={`${title} filter`}
        className="min-w-[calc(var(--drawer-w)/2)]"
      >
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            checked={selected.has(option.value)}
            key={option.value}
            onCheckedChange={(checked) => toggle(option.value, Boolean(checked))}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
        {chosen.length > 0 ? <DropdownMenuSeparator /> : null}
        {chosen.length > 0 ? (
          <DropdownMenuItem
            onClick={() => {
              // Same reason as the row kebab: close synchronously, then act, so anything the
              // action opens is mounted before the menu's exit animation runs.
              setOpen(false);
              commit([]);
            }}
          >
            Clear {title.toLocaleLowerCase()}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
