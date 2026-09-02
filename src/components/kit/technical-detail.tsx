"use client";

import type { ReactNode } from "react";

import { ChevronDown } from "@/components/kit/icons";


import { CopyValue } from "@/components/kit/copy-value";
import { cn } from "@/lib/utils";

export type TechnicalDetailItem = {
  label: string;
  value: string;
  mono?: boolean;
};

export type TechnicalDetailProps = {
  items: readonly TechnicalDetailItem[];
  className?: string;
  /**
   * What the closed disclosure says. Defaults to "Technical detail", which is what every admin
   * caller wants. The coach's Setup receipts pass "Show the technical record" because there the
   * strip already carries a heading explaining what is behind the fold, so a second generic noun
   * would name the box rather than the action.
   */
  label?: string;
  /**
   * Rendered above the item rows, inside the fold. Lets a caller put its own prose or tables
   * behind the same single disclosure instead of stacking a second one next to this.
   */
  children?: ReactNode;
};

export function TechnicalDetail({
  children,
  className,
  items,
  label = "Technical detail",
}: TechnicalDetailProps) {
  if (items.length === 0 && !children) return null;

  return (
    <details
      className={cn(
        "group rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)]",
        className,
      )}
      data-slot="technical-detail"
    >
      <summary className="flex cursor-pointer list-none items-center gap-[var(--s-2)] rounded-[var(--r-card)] px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--t-body)] font-medium text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--ink)] focus-visible:outline-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
        {label}
        <ChevronDown
          aria-hidden
          className="ml-auto size-[var(--s-4)] transition-transform duration-[var(--duration-quick)] ease-[var(--ease-out)] group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-[var(--s-2)] px-[var(--s-3)] pb-[var(--s-3)] pt-[var(--s-1)]">
        {children}
        {items.map((item, index) => (
          <div
            className="flex min-w-0 items-center gap-[var(--s-2)]"
            data-slot="technical-detail-row"
            key={`${item.label}:${index}`}
          >
            <span className="min-w-[calc(var(--s-12)*2)] text-[length:var(--t-badge)] font-normal text-[var(--faint)]">
              {item.label}
            </span>
            <code
              className={cn(
                "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--t-badge)] font-[var(--t-badge-w)] leading-[var(--t-badge-lh)] tracking-[var(--t-badge-tr)] text-[var(--muted)]",
                item.mono !== false && "font-mono",
              )}
            >
              {item.value}
            </code>
            <CopyValue label={item.label} value={item.value} />
          </div>
        ))}
      </div>
    </details>
  );
}
