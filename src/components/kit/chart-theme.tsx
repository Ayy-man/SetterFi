/**
 * The kit's one chart theme.
 *
 * There is no charting library in this repo and there is not going to be one: every chart is
 * hand-written inline SVG (see `trend-panel.tsx`, `sparkline.tsx`). That makes a shared theme the
 * only thing standing between four surfaces and four different-looking charts, so every series
 * colour, every hairline, every axis label and every legend swatch in the product comes from here.
 *
 * Deliberately directive-free: no `"use client"` anywhere in this module. It exports plain
 * constants that server components read as values, and a client module's exports reach a server
 * component as client references rather than values -- the same reason `toast-preset.ts` has no
 * directive. Everything below is either a constant, a pure function, or a presentational component
 * with no hooks and no event handlers, so it renders on either side of the boundary. Anything that
 * needs state or a handler belongs in its own `"use client"` module, not here.
 *
 * The rules the theme encodes, so a new chart does not have to relitigate them:
 *
 *  - **Series colours are exactly three**, `--t-data-1` (accent), `--t-data-2` (muted) and
 *    `--t-data-3` (warn), in that order. A fourth series is a sign the chart is doing too much.
 *  - **One baseline hairline, no gridlines and no axis box.** Gridlines at every step turn a small
 *    chart into graph paper; the zero line is the only rule a reader actually measures against.
 *  - **Axis labels at the range ends only**, mono 10px faint. The middle ticks are noise at this
 *    size, and the sr-only data table is what carries the exact numbers.
 *  - **Legends are words with an 8px square**, never a colour the reader has to decode alone.
 *  - **The current period is emphasised with a 2px accent ring**, not a different fill, so "now"
 *    reads as the same series rather than as a fourth colour.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ colours */

/**
 * The series palette, in draw order. Index 0 is the subject of the chart; 1 is context beside it;
 * 2 is the one series that carries a warning. Both light and dark values live in `tokens.css`, so
 * a chart never hard-codes a colour and never needs a theme branch of its own.
 */
export const CHART_SERIES = [
  "var(--t-data-1)",
  "var(--t-data-2)",
  "var(--t-data-3)",
] as const;

export type ChartSeriesIndex = 0 | 1 | 2;

/** The accent series, named, for the many charts that draw exactly one line. */
export const CHART_ACCENT = CHART_SERIES[0];

/**
 * Pick a series colour by index. It wraps rather than throwing so a chart handed one row too many
 * still renders; the wrap repeating a colour is the visible signal that the chart is over its
 * three-series budget.
 */
export function seriesColor(index: number): string {
  const count = CHART_SERIES.length;
  const wrapped = ((Math.trunc(index) % count) + count) % count;
  return CHART_SERIES[wrapped] as string;
}

/** The single hairline a chart is allowed: the baseline. There are no gridlines. */
export const CHART_BASELINE_COLOR = "var(--line)";
export const CHART_BASELINE_WIDTH = 1;

/** Emphasis for the current period: a ring in the accent, never a second fill colour. */
export const CHART_EMPHASIS_COLOR = CHART_ACCENT;
export const CHART_EMPHASIS_WIDTH = 2;

/** The legend's colour chip. Small enough to read as a marker, not as a block of colour. */
export const CHART_LEGEND_SWATCH_PX = 8;

/** Axis labels: mono 10px faint, and only ever at the two ends of the range. */
export const CHART_AXIS_LABEL_CLASS =
  "font-[family-name:var(--font-mono)] text-[10px] leading-none text-[var(--faint)] tabular-nums";

/** Series fills carry opacity rather than a lighter colour, so the hue stays one hue. */
export const CHART_AREA_OPACITY = 0.18;

/* ----------------------------------------------------------------- geometry */

export type ChartPoint = { x: number; y: number };

export type ChartExtent = { minimum: number; maximum: number; range: number };

/**
 * The value range a chart scales against. `range` is never zero -- a flat series would otherwise
 * divide by it and put every point at NaN -- so a series of identical values draws as a flat line
 * through the middle instead of disappearing.
 */
export function chartExtent(values: readonly number[]): ChartExtent {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { minimum: 0, maximum: 0, range: 1 };

  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  return { minimum, maximum, range: maximum - minimum || 1 };
}

/**
 * Lay values out in CSS pixels across a box, y inverted for SVG. Geometry is computed in real
 * pixels rather than in a stretched viewBox: `preserveAspectRatio="none"` turns a 2px stroke into
 * a wedge and a dot into an ellipse the moment the panel is wider than the viewBox.
 */
export function chartGeometry(
  values: readonly number[],
  box: { width: number; height: number; padX?: number; padY?: number },
): ChartPoint[] {
  const padX = box.padX ?? 0;
  const padY = box.padY ?? 0;
  const { minimum, range } = chartExtent(values);
  const left = padX;
  const right = Math.max(box.width - padX, left + 1);
  const top = padY;
  const bottom = Math.max(box.height - padY, top + 1);

  return values.map((value, index) => ({
    x:
      values.length === 1
        ? (left + right) / 2
        : left + (index / (values.length - 1)) * (right - left),
    y: bottom - ((Number.isFinite(value) ? value - minimum : 0) / range) * (bottom - top),
  }));
}

/**
 * A smoothed cubic through every point.
 *
 * Catmull-Rom control points, with each control's y clamped into the span of the two points it
 * sits between. Unclamped Catmull-Rom overshoots on a spike -- a series of 0, 0, 40 dips visibly
 * below zero on its way up -- and a trend line that draws a value the data never held is exactly
 * the kind of quiet dishonesty the rest of this product refuses. The clamp costs a little of the
 * curve's roundness at a corner and buys a curve that stays inside its own data.
 */
export function smoothPath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return "";
  const [first] = points;
  if (!first) return "";
  if (points.length === 1) return `M ${first.x} ${first.y}`;

  const clamp = (value: number, a: number, b: number) =>
    Math.min(Math.max(value, Math.min(a, b)), Math.max(a, b));

  let path = `M ${first.x} ${first.y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(index - 1, 0)] as ChartPoint;
    const current = points[index] as ChartPoint;
    const next = points[index + 1] as ChartPoint;
    const after = points[Math.min(index + 2, points.length - 1)] as ChartPoint;

    const control1 = {
      x: current.x + (next.x - previous.x) / 6,
      y: clamp(current.y + (next.y - previous.y) / 6, current.y, next.y),
    };
    const control2 = {
      x: next.x - (after.x - current.x) / 6,
      y: clamp(next.y - (after.y - current.y) / 6, current.y, next.y),
    };

    path += ` C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${next.x} ${next.y}`;
  }

  return path;
}

/**
 * The same curve, closed down to a baseline, for the gradient fill under a line. The fill is a
 * shape under the line rather than a second series, so it is drawn from the identical path.
 */
export function areaPath(points: readonly ChartPoint[], baselineY: number): string {
  if (points.length === 0) return "";
  const first = points[0] as ChartPoint;
  const last = points[points.length - 1] as ChartPoint;
  return `${smoothPath(points)} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}

/**
 * The two axis labels a chart gets: the first and the last of the range. Anything between them is
 * left to the sr-only table, which is where an exact reading belongs anyway.
 */
export function axisEnds(labels: readonly string[]): { start: string; end: string } | null {
  if (labels.length === 0) return null;
  const start = labels[0] as string;
  const end = labels[labels.length - 1] as string;
  return { start, end };
}

/* --------------------------------------------------------------- components */

export type ChartLegendItem = {
  label: string;
  /** Index into `CHART_SERIES`; an out-of-range index wraps rather than blanking the swatch. */
  series: number;
};

/**
 * Words with an 8px square. The label is the legend; the square only ties it to the mark on the
 * chart, which is why it is small and why there is never a colour without a word beside it.
 */
export function ChartLegend({
  items,
  className,
}: {
  items: readonly ChartLegendItem[];
  className?: string;
}) {
  return (
    <ul
      className={cn(
        "m-0 flex list-none flex-wrap items-center gap-[var(--s-3)] p-0",
        className,
      )}
      data-slot="chart-legend"
    >
      {items.map((item) => (
        <li
          className="flex items-center gap-[var(--s-2)] text-[length:var(--t-mono-crumb)] text-[var(--muted)]"
          key={item.label}
        >
          <span
            aria-hidden="true"
            className="block shrink-0 rounded-[1px]"
            data-slot="chart-legend-swatch"
            style={{
              backgroundColor: seriesColor(item.series),
              height: CHART_LEGEND_SWATCH_PX,
              width: CHART_LEGEND_SWATCH_PX,
            }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The zero rule, and the only rule. Draw it inside the chart's `<svg>`; there is no gridline
 * component here because there are no gridlines.
 */
export function ChartBaseline({ width, y, x = 0 }: { width: number; y: number; x?: number }) {
  return (
    <line
      data-slot="chart-baseline"
      shapeRendering="crispEdges"
      stroke={CHART_BASELINE_COLOR}
      strokeWidth={CHART_BASELINE_WIDTH}
      x1={x}
      x2={x + width}
      y1={y}
      y2={y}
    />
  );
}

/**
 * The range ends, mono 10 faint, pushed to the two edges. Rendered as HTML beside the chart rather
 * than as SVG text so the labels stay in the page's font stack and stay selectable.
 */
export function ChartAxisEnds({
  labels,
  className,
}: {
  labels: readonly string[];
  className?: string;
}) {
  const ends = axisEnds(labels);
  if (!ends) return null;

  return (
    <div
      className={cn("flex items-baseline justify-between gap-[var(--s-3)]", className)}
      data-slot="chart-axis-ends"
    >
      <span className={CHART_AXIS_LABEL_CLASS}>{ends.start}</span>
      <span className={CHART_AXIS_LABEL_CLASS}>{ends.end}</span>
    </div>
  );
}

/**
 * A tooltip drawn on the card tokens -- same surface, same hairline, same radius as every other
 * raised thing in the product, so a hover does not introduce a new material. Positioning and the
 * hover state itself belong to the chart that owns the pointer; this is only the box.
 */
export function ChartTooltip({
  label,
  children,
  className,
}: {
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none flex flex-col gap-[calc(var(--s-1)/2)] rounded-[var(--r-card)]",
        "border border-[var(--line)] bg-[var(--raised)] px-[var(--s-2)] py-[var(--s-1)]",
        "shadow-[var(--shadow-toast)]",
        className,
      )}
      data-slot="chart-tooltip"
      role="tooltip"
    >
      <span className="text-[length:var(--t-mono-crumb)] text-[var(--faint)]">{label}</span>
      {children ? (
        <span className="text-[length:var(--t-mono-meta)] text-[var(--ink)] tabular-nums">
          {children}
        </span>
      ) : null}
    </div>
  );
}
