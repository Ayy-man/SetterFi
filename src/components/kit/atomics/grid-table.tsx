import type { HTMLAttributes, ReactNode } from "react";

import { TONE_ROW_TINT, type Tone } from "@/components/kit/atomics/tone";
import { cn } from "@/lib/utils";

/**
 * The dense grid table every admin list is built from: 1a's client book, 1c's dense variant, 2b's
 * agent leaderboard, 2c's subscription ledger.
 *
 * It is CSS grid rather than a `<table>` on purpose -- the artifact's rows put a monogram, two
 * lines of text, a status pill and a right-aligned mono figure in one 36px row, and a grid keeps
 * every column aligned while a cell's contents change height. It stays a table semantically:
 * `role="table"`/`row`/`cell` are on the elements, so a screen reader still reads it as a grid and
 * not as a stack of divs.
 *
 * The column template lives on the parent and every row inherits it through a CSS custom
 * property, which is the whole reason this exists as a component: a screen that restates the
 * template on the header and on each row will eventually get one of them wrong, and a misaligned
 * MRR column is the single most obvious way for a console to look unfinished.
 */
export type GridTableProps = {
  /** A grid-template-columns value: `"1.7fr 1fr .9fr .8fr 90px"`. */
  columns: string;
  /**
   * The template to fall back to in a narrow container. Applying it is one class on the table,
   * and the class must name the `grid-table` container:
   *
   *   <GridTable className="@max-[640px]/grid-table:[--grid-table-columns:var(--grid-table-columns-narrow)]" ... />
   *
   * **Two things have to be true, and this component used to get both wrong.** The query has to
   * resolve, *and* the value it sets has to be able to win. Fixing either one alone looks like a
   * fix and changes nothing on screen, which is how this survived: the arrangement below is what
   * satisfies both, so do not take one half of it away.
   *
   * *Resolving.* `GridTable` wraps itself in an element declaring `@container/grid-table`, and the
   * class above lands on the table *inside* that wrapper. A container query resolves against an
   * ancestor container and never against the element establishing the container itself, so the
   * query and the `@container` cannot sit on one element -- which is what this did, making every
   * `columnsNarrow` dead. The container is *named* rather than anonymous because a `Surface` is
   * itself a container: an unnamed query binds to whichever is nearest, so the same table would
   * measure different boxes depending on where somebody mounted it.
   *
   * *Winning.* Both templates are set inline on the wrapper and inherited, never set on the table.
   * An inline custom property outranks any class, so with the templates on the table the query
   * would have matched at the right width and the class it applied would have lost to the inline
   * value -- the same wide columns, and nothing to see in the DOM explaining why.
   *
   * The width that matters is the table's own and not the window's: 3a puts a list in a 266px
   * column and a panel in the content pane on one screen, and a viewport breakpoint would be
   * measuring neither of them.
   */
  columnsNarrow?: string;
  label: string;
  children?: ReactNode;
  className?: string;
};

export function GridTable({ children, className, columns, columnsNarrow, label }: GridTableProps) {
  return (
    /*
      Two elements, and which one carries what is the whole fix.

      The wrapper declares the named container and holds both templates as inherited custom
      properties. It carries no caller styling at all, so nothing a screen passes can stop it
      being a container.

      The table itself takes `className`, because that is where a caller's layout belongs -- and
      because the narrow-template class has to land on a *descendant* of the container to resolve.
      It is also why neither template is set inline here: an inline `--grid-table-columns` would
      outrank the class that swaps it, so the query would match and still change nothing. Inherited
      from the wrapper, the class wins the moment it applies, and rows read one property either
      way.
    */
    <div
      className="@container/grid-table w-full"
      data-slot="grid-table-container"
      style={
        {
          "--grid-table-columns": columns,
          "--grid-table-columns-narrow": columnsNarrow ?? columns,
        } as React.CSSProperties
      }
    >
      <div aria-label={label} className={cn("w-full", className)} data-slot="grid-table" role="table">
        {children}
      </div>
    </div>
  );
}

/** The header strip: mono overlines on a 2% wash, footed with a hairline. */
export function GridTableHead({
  className,
  columns,
}: {
  className?: string;
  /** `align: "right"` on the last column is the norm; money is always right-aligned. */
  columns: readonly { label: ReactNode; align?: "left" | "right" | "center" }[];
}) {
  return (
    <div
      className={cn(
        "mono grid border-b border-[var(--line)] bg-[var(--row-hover)] px-[var(--s-4)] py-[9px] text-[9.5px] font-[500] tracking-[0.09em] uppercase text-[color:var(--overline)]",
        className,
      )}
      data-slot="grid-table-head"
      role="row"
      style={{ gridTemplateColumns: "var(--grid-table-columns)" }}
    >
      {columns.map((column, index) => (
        <div
          className={cn(
            "min-w-0 truncate",
            column.align === "right" && "text-right",
            column.align === "center" && "text-center",
          )}
          key={index}
          role="columnheader"
        >
          {column.label}
        </div>
      ))}
    </div>
  );
}

export type GridTableRowProps = {
  /**
   * A tone tints the whole row at 5% and says "this is the row that is wrong": 1a's open request,
   * 2b's collapsing agent, 2c's past-due account. It never draws an edge stripe.
   */
  tone?: Tone;
  selected?: boolean;
  /** The last row in a panel drops its divider so the hairline does not sit on the rounded corner. */
  last?: boolean;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "color">;

export function GridTableRow({
  children,
  className,
  last,
  selected,
  style,
  tone = "neutral",
  ...rest
}: GridTableRowProps) {
  return (
    <div
      aria-selected={selected || undefined}
      className={cn(
        "grid items-center gap-[var(--s-2)] px-[var(--s-4)] py-[11px] transition-colors duration-[var(--duration-quick)] motion-reduce:transition-none",
        !last && "border-b border-[var(--line-soft)]",
        "hover:bg-[var(--row-hover)]",
        className,
      )}
      data-slot="grid-table-row"
      data-tone={tone}
      role="row"
      style={{
        background: selected ? "var(--row-selected)" : TONE_ROW_TINT[tone],
        gridTemplateColumns: "var(--grid-table-columns)",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function GridTableCell({
  align = "left",
  children,
  className,
  ...rest
}: { align?: "left" | "right" | "center" } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "min-w-0 text-[13px] text-[color:var(--body)]",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
      data-align={align}
      data-slot="grid-table-cell"
      role="cell"
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * The two-line identity cell every list leads with: a monogram, a name that truncates, and a
 * subline naming the plan. It is one component because getting `min-width: 0` wrong on any of the
 * three nested flex boxes is what makes a long client name push the MRR column off the card, and
 * eight lanes should not each rediscover that.
 */
export function GridTableIdentity({
  className,
  leading,
  name,
  subline,
}: {
  className?: string;
  leading?: ReactNode;
  name: ReactNode;
  subline?: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-[11px]", className)} data-slot="grid-table-identity">
      {leading}
      <div className="min-w-0">
        {/* 14px/600, the one identity size shared with `CellTwoLine` and `identityColumn`. */}
        <div className="truncate text-[14px] leading-[1.3] font-[600] text-[color:var(--ink)]">{name}</div>
        {subline ? (
          <div className="truncate text-[11px] text-[color:var(--faint)]">{subline}</div>
        ) : null}
      </div>
    </div>
  );
}

/** The footer bar under a list: what is in view on the left, the total of it on the right. */
export function GridTableFooter({
  className,
  left,
  right,
}: {
  className?: string;
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-[var(--s-3)] gap-y-[var(--s-1)] border-t border-[var(--line)] bg-[var(--row-hover)] px-[var(--s-4)] py-[11px] text-[12px] text-[color:var(--faint)]",
        className,
      )}
      data-slot="grid-table-footer"
    >
      {/*
        The two halves wrap rather than fight.

        `min-w-0 truncate` on the left against `ml-auto shrink-0` on the right is the shape that
        cost the coach inbox every lead's name: the non-shrinking side takes its full width first
        and the truncating side gets whatever is left, which in a narrow column is a couple of
        characters and an ellipsis. The stakes here are lower -- this row carries "showing N of M"
        and a count -- but it is a shared atomic that both languages read, and the coach side runs
        it at a larger size in a narrower pane than the console ever will.

        `flex-wrap` on the container plus a sane basis on the left half means the count drops to its
        own line instead of clipping the sentence. Nothing needs a breakpoint to know when: the
        moment the two no longer fit, the row becomes two rows.
      */}
      <span className="min-w-0 flex-1 basis-[16ch] truncate">{left}</span>
      {right ? <span className="mono ml-auto shrink-0 text-[11.5px] tabular-nums">{right}</span> : null}
    </div>
  );
}
