import type { ElementType, HTMLAttributes, ReactNode } from "react";

import { TONE_TEXT, type Tone } from "@/components/kit/atomics/tone";
import { cn } from "@/lib/utils";

/**
 * The mono overline: SURFACE LADDER, TOTAL LEADS, BLAST RADIUS, MOVEMENT THIS MONTH.
 *
 * 9.5px mono at .09em, uppercase, on `--overline`. It sits below the 11px type-token floor on
 * purpose and so is a utility rather than a `--t-*` token, which is the arrangement
 * `docs/DESIGN.md` describes: the floor applies to type tokens, and a wide-tracked mono label that
 * never carries prose is exempt. Nothing here may hold a sentence.
 *
 * The size is 9.5px because `docs/DESIGN.md:333` says so, and the badge beside it at 10px is a
 * different role. This was 10px until 2026-08-31 -- the badge's size, wearing the overline's name
 * -- and the docstring asserted that 10px was what DESIGN.md described, which is how the
 * conflation survived being read several times. Both sizes are genuinely in the artifact (10px
 * 44 times, 9.5px 21), so the markup could not settle it; the named rule could.
 */
export function Overline({
  as,
  children,
  className,
  ...rest
}: { as?: ElementType; children?: ReactNode } & HTMLAttributes<HTMLElement>) {
  const Component = (as ?? "span") as ElementType;
  return (
    <Component
      className={cn(
        "font-mono text-[9.5px] leading-[1.2] font-[500] tracking-[0.09em] uppercase text-[color:var(--overline)]",
        className,
      )}
      data-slot="overline"
      {...rest}
    >
      {children}
    </Component>
  );
}

export type FigureSize = "sm" | "md" | "lg" | "xl";

/**
 * Every number on the page. Mono, tabular, negative tracking, and never a sans face.
 *
 * The four sizes are the ones the artifact actually sets: `sm` is a table cell or a delta, `md` a
 * KPI tile's own value in a dense strip, `lg` the figure a page is opened for, `xl` the single
 * headline figure a revenue screen is allowed. Tabular numerals are not optional -- a column of
 * MRR that does not align is the difference between a readout and a form field.
 */
const FIGURE_SIZE = {
  sm: "text-[12.5px] leading-[1.3] font-[500] tracking-[-0.01em]",
  md: "text-[15px] leading-[1.2] font-[500] tracking-[-0.02em]",
  lg: "text-[27px] leading-[1.05] font-[500] tracking-[-0.033em]",
  xl: "text-[34px] leading-[1] font-[500] tracking-[-0.044em]",
} as const satisfies Record<FigureSize, string>;

export type FigureProps = {
  children?: ReactNode;
  size?: FigureSize;
  /** A tone here is a claim about the number: a clay figure means this one is the problem. */
  tone?: Tone;
  as?: ElementType;
} & Omit<HTMLAttributes<HTMLElement>, "color">;

export function Figure({
  as,
  children,
  className,
  size = "md",
  style,
  tone = "neutral",
  ...rest
}: FigureProps) {
  const Component = (as ?? "span") as ElementType;
  return (
    <Component
      className={cn(
        "mono inline-block whitespace-nowrap tabular-nums",
        FIGURE_SIZE[size],
        className,
      )}
      data-figure-size={size}
      data-slot="figure"
      data-tone={tone}
      style={{ color: tone === "neutral" ? "var(--ink)" : TONE_TEXT[tone], ...style }}
      {...rest}
    >
      {children}
    </Component>
  );
}

/**
 * Mono metadata: timestamps, versions, "3 selected", "oldest 2d 4h", "retry 2 of 4". 12px mono on
 * `--muted`, or the tone's own text colour when the metadata is itself the bad news ("retry Aug 31"
 * in clay on the past-due row in 2c).
 */
export function MonoMeta({
  children,
  className,
  style,
  tone = "neutral",
  ...rest
}: { children?: ReactNode; tone?: Tone } & Omit<HTMLAttributes<HTMLElement>, "color">) {
  return (
    <span
      className={cn("mono text-[12px] leading-[1.4] font-[400] tabular-nums", className)}
      data-slot="mono-meta"
      data-tone={tone}
      style={{ color: tone === "neutral" ? "var(--muted)" : TONE_TEXT[tone], ...style }}
      {...rest}
    >
      {children}
    </span>
  );
}

export type Measure = "caption" | "tight" | "prose" | "wide";

const MEASURE: Record<Measure, string> = {
  caption: "var(--measure-caption)",
  tight: "var(--measure-tight)",
  prose: "var(--measure-prose)",
  wide: "var(--measure-wide)",
};

/**
 * A paragraph that obeys the Line Length rule. `docs/DESIGN.md` names the rule; this is where it
 * is actually enforced, because before this existed the rule was hand-rolled at 62 sites in 11
 * different `ch` values and no two screens agreed on what "a paragraph" measures.
 *
 * `prose` is the default and the answer for almost all copy. Reach for another measure only when
 * the paragraph is doing a different job: `wide` when it owns a full pane, `tight` for centred
 * empty-state copy, `caption` for narrow metadata meant to wrap into a block beside a figure.
 *
 * It sets the measure and nothing else. Size, weight and colour stay with the caller, because the
 * type-scale reconciliation is a separate decision and this component must not quietly take a side
 * in it.
 */
export function Prose({
  as,
  children,
  className,
  measure = "prose",
  style,
  ...rest
}: {
  as?: ElementType;
  children?: ReactNode;
  measure?: Measure;
} & HTMLAttributes<HTMLElement>) {
  const Tag = as ?? "p";
  return (
    <Tag
      className={cn("min-w-0", className)}
      data-measure={measure}
      data-slot="prose"
      style={{ maxWidth: MEASURE[measure], ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
