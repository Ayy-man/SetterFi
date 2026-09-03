import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The small pieces the rehaul screens share and the kit does not carry.
 *
 * Everything here is server-renderable on purpose: no state, no handlers, no `"use client"`.
 * A page that needs one of these inside a client tree can still import it, but nothing in this
 * file forces a page to become a client component.
 *
 * Sizes come from the artboard CSS (`_owner.css` for the console density, `_coach.css` for the
 * coach app), not from a fresh scale. Where the two densities differ the component takes a
 * `density` prop and defaults to `"owner"`, because the console is where these appear most.
 */

/* --------------------------------------------------------------------------------------------
 * Tabs
 * ------------------------------------------------------------------------------------------ */

export type RehaulTabItem = {
  label: string;
  count?: number;
  /** "warning" (default) is the amber "this needs you" figure; "neutral" is a plain size, like Knowledge or Versions. */
  countTone?: "warning" | "neutral";
  active?: boolean;
  href?: string;
};

export type RehaulTabsProps = {
  items: readonly RehaulTabItem[];
  className?: string;
  /** Accessible name for the row, e.g. "Money sections". */
  label?: string;
};

/**
 * The underline tab row: a flex row of 13px labels over a hairline, the active one carrying a
 * 2px accent border and the accent text colour. The count that trails a label is the amber
 * "this needs you" figure from the artboards, so it stays mono and warning-toned rather than
 * becoming a neutral badge.
 */
export function RehaulTabs({ className, items, label }: RehaulTabsProps) {
  return (
    <nav
      aria-label={label ?? "Sections"}
      className={cn(
        "flex gap-[22px] border-b border-[var(--line)] text-[13px]",
        className,
      )}
      data-slot="rehaul-tabs"
    >
      {items.map((item) => {
        const content = (
          <>
            {item.label}
            {typeof item.count === "number" ? (
              <span className={cn("ml-1.5 font-mono text-[11.5px]", item.countTone === "neutral" ? "text-[var(--faint)]" : "text-[var(--warning-text)]")}>
                {item.count}
              </span>
            ) : null}
          </>
        );
        const tabClassName = cn(
          "py-2",
          item.active
            ? "border-b-2 border-[var(--accent)] font-medium text-[var(--accent-text)]"
            : "text-[var(--faint)]",
        );

        if (item.href) {
          return (
            <Link
              aria-current={item.active ? "page" : undefined}
              className={cn(tabClassName, "no-underline hover:no-underline")}
              href={item.href}
              key={item.label}
            >
              {content}
            </Link>
          );
        }

        return (
          <span
            aria-current={item.active ? "page" : undefined}
            className={tabClassName}
            key={item.label}
          >
            {content}
          </span>
        );
      })}
    </nav>
  );
}

/* --------------------------------------------------------------------------------------------
 * Status dot
 * ------------------------------------------------------------------------------------------ */

export type StatusTone = "good" | "amber" | "wait" | "bad" | "grey";

/**
 * `--warning` rather than a `--warn` alias: the token file names it `--warning` and tokens.css is
 * not ours to edit. `wait` and `bad` have no token at all, so they carry the artboard's literal
 * OKLCH, which is what `_owner.css` ships.
 */
const DOT_TONE: Record<StatusTone, string> = {
  amber: "bg-[var(--warning)]",
  bad: "bg-[oklch(0.6503_0.135_32)]",
  good: "bg-[var(--good)]",
  grey: "bg-[rgba(60,90,150,0.3)]",
  wait: "bg-[oklch(0.6398_0.115_271)]",
};

export type StatusDotProps = {
  tone: StatusTone;
  className?: string;
};

/** A 7px round status dot. Decorative: the row it sits in carries the word. */
export function StatusDot({ className, tone }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[7px] flex-[0_0_7px] rounded-full",
        DOT_TONE[tone],
        className,
      )}
      data-slot="status-dot"
      data-tone={tone}
    />
  );
}

/* --------------------------------------------------------------------------------------------
 * Pill
 * ------------------------------------------------------------------------------------------ */

export type PillTone = "neutral" | "amber" | "good" | "accent";

const PILL_TONE: Record<PillTone, string> = {
  accent:
    "border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[var(--accent-text)]",
  amber:
    "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[var(--warning-text)]",
  good: "border-[var(--good-line)] bg-[var(--good-wash)] text-[var(--good-text)]",
  neutral: "border-[var(--line)] text-[var(--muted)]",
};

export type PillProps = {
  children: ReactNode;
  tone?: PillTone;
  className?: string;
};

/** The 12px bordered pill from the artboards. Neutral by default; amber is the loud one. */
export function Pill({ children, className, tone = "neutral" }: PillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px]",
        PILL_TONE[tone],
        className,
      )}
      data-slot="pill"
      data-tone={tone}
    >
      {children}
    </span>
  );
}

/* --------------------------------------------------------------------------------------------
 * Figure
 * ------------------------------------------------------------------------------------------ */

export type FigureSize = "sm" | "md" | "lg" | "hero";

/**
 * Four figure sizes, and the hero is not just a bigger `lg`. At 72px the artboard tightens the
 * tracking to -0.075em and drops the line box to 0.92, because at that size the default tracking
 * opens visible gaps between digits and a 1.0 line box leaves a band of dead space under the
 * number. Below 44px neither correction is needed, so the smaller three share -0.05em.
 */
const FIGURE_SIZE: Record<FigureSize, string> = {
  hero: "text-[72px] leading-[0.92] tracking-[-0.075em]",
  lg: "text-[44px] leading-none tracking-[-0.05em]",
  md: "text-[30px] leading-none tracking-[-0.05em]",
  sm: "text-[24px] leading-none tracking-[-0.05em]",
};

export type FigureProps = {
  children: ReactNode;
  size: FigureSize;
  className?: string;
};

/** A mono figure. The number is the content; nothing here adds a label. */
export function Figure({ children, className, size }: FigureProps) {
  return (
    <div
      className={cn("font-mono font-medium", FIGURE_SIZE[size], className)}
      data-size={size}
      data-slot="figure"
    >
      {children}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * Segmented control
 * ------------------------------------------------------------------------------------------ */

export type SegItem = {
  label: string;
  active?: boolean;
  href?: string;
};

export type SegDensity = "owner" | "coach";

export type SegProps = {
  items: readonly SegItem[];
  density?: SegDensity;
  className?: string;
  /** Accessible name for the group, e.g. "Window". */
  label?: string;
};

const SEG_SHELL: Record<SegDensity, string> = {
  coach: "rounded-[10px] p-[3px]",
  owner: "rounded-lg p-0.5",
};

const SEG_ITEM: Record<SegDensity, string> = {
  coach: "h-[38px] rounded-lg px-4 text-[15px]",
  owner: "rounded-md px-2.5 py-[5px] text-[12.5px]",
};

/** The segmented control: a bordered trough with one washed, accent-toned active cell. */
export function Seg({ className, density = "owner", items, label }: SegProps) {
  return (
    <div
      aria-label={label ?? "View"}
      className={cn(
        "inline-flex border border-[var(--line-input)] bg-[var(--card)]",
        SEG_SHELL[density],
        className,
      )}
      data-slot="seg"
      role="group"
    >
      {items.map((item) => {
        const itemClassName = cn(
          "inline-flex items-center justify-center",
          SEG_ITEM[density],
          item.active
            ? "bg-[var(--accent-wash-strong)] font-medium text-[var(--accent-text)]"
            : "text-[var(--muted)]",
        );

        if (item.href) {
          return (
            <Link
              aria-current={item.active ? "true" : undefined}
              className={cn(itemClassName, "no-underline hover:no-underline")}
              href={item.href}
              key={item.label}
            >
              {item.label}
            </Link>
          );
        }

        return (
          <span
            aria-current={item.active ? "true" : undefined}
            className={itemClassName}
            key={item.label}
          >
            {item.label}
          </span>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * Card table
 * ------------------------------------------------------------------------------------------ */

/**
 * The table-in-a-card class vocabulary, exported as strings so a screen can hand them straight to
 * its own `<table>` markup. A component that owned the whole table would have to own its columns
 * too, and every rehaul screen has a different set.
 */
export const CARD_TABLE = {
  card: "overflow-hidden rounded-[14px] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_1px_2px_rgba(28,42,82,0.04),0_8px_20px_-14px_rgba(28,42,82,0.16)]",
  num: "text-right font-mono",
  table: "w-full border-collapse text-[13px]",
  td: "h-10 whitespace-nowrap border-b border-[var(--line-soft)] px-3",
  th: "border-b border-[var(--line)] bg-[var(--band)] px-3 py-2 text-left text-[11.5px] font-medium text-[var(--faint)]",
} as const;

export type CardTableProps = {
  children: ReactNode;
  className?: string;
};

/** The card face a rehaul table sits in. The `<table>` inside it uses the `CARD_TABLE` classes. */
export function CardTable({ children, className }: CardTableProps) {
  return (
    <div className={cn(CARD_TABLE.card, className)} data-slot="card-table">
      {children}
    </div>
  );
}
