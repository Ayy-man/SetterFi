"use client";

import { useId } from "react";

import {
  CHART_ACCENT,
  CHART_AREA_OPACITY,
  areaPath,
  chartGeometry,
  seriesColor,
  smoothPath,
  type ChartPoint,
} from "@/components/kit/chart-theme";
import { cn } from "@/lib/utils";

export type SparklineProps = {
  /** The series, oldest first. Two points is the minimum a trend can honestly be drawn from. */
  points: readonly number[];
  /**
   * What the line is, for assistive tech: "Booked calls, last 14 days". The SVG is `role="img"`
   * with this as its label, because a shape with no words is not a metric.
   */
  label: string;
  width?: number;
  height?: number;
  className?: string;
};

/**
 * The minimum series a sparkline will draw. One point is a dot, not a trend, and a tile that shows
 * a one-point "trend" is claiming a direction it cannot know -- so the component renders nothing
 * and the tile's own note carries the reason.
 */
export const SPARKLINE_MIN_POINTS = 2;

const DEFAULT_WIDTH = 96;
const DEFAULT_HEIGHT = 24;
/**
 * Padding, in the same CSS pixels as everything else here. The stroke is 1.5 wide and the endpoint
 * dot is r=2 with a 1.5 halo, so roughly 4px of inset on each edge keeps both inside the box
 * without `overflow: visible` letting them bleed into the figure above.
 */
const PAD_X = 4;
const PAD_Y = 4;

const STROKE_WIDTH = 1.5;
const DOT_RADIUS = 2;

/**
 * A smoothed area sparkline: accent stroke, a gradient fill fading to transparent, and a dot on
 * the latest point. No axes, no gridlines, no baseline -- at 96x24 a rule is a second line the
 * reader has to separate from the data. Everything it draws comes from `chart-theme`, so it moves
 * when the theme moves.
 *
 * The geometry is computed in CSS pixels and the `viewBox` matches the drawn size one-to-one, the
 * same technique `trend-panel.tsx` uses: a stretched viewBox turns the 1.5px stroke into a wedge
 * and the endpoint dot into an ellipse as soon as the tile is wider than the box.
 */
export function Sparkline({
  points,
  label,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  className,
}: SparklineProps) {
  // The gradient id has to be unique per instance: four tiles in a strip each define a gradient,
  // and duplicate ids mean every line after the first paints with the first one's fill.
  const gradientId = `sparkline-fill-${useId()}`;

  const finite = points.filter((value) => Number.isFinite(value));
  if (finite.length < SPARKLINE_MIN_POINTS) return null;

  const geometry = chartGeometry(finite, { height, padX: PAD_X, padY: PAD_Y, width });
  const line = smoothPath(geometry);
  const area = areaPath(geometry, height - PAD_Y);
  const last = geometry[geometry.length - 1] as ChartPoint;

  return (
    <svg
      aria-label={label}
      className={cn("block", className)}
      data-slot="sparkline"
      height={height}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={CHART_ACCENT} stopOpacity={CHART_AREA_OPACITY} />
          <stop offset="100%" stopColor={CHART_ACCENT} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} data-slot="sparkline-area" fill={`url(#${gradientId})`} />
      <path
        d={line}
        data-slot="sparkline-line"
        fill="none"
        stroke={CHART_ACCENT}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={STROKE_WIDTH}
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={last.x}
        cy={last.y}
        data-slot="sparkline-endpoint"
        fill={CHART_ACCENT}
        r={DOT_RADIUS}
        stroke="var(--card)"
        strokeWidth={STROKE_WIDTH}
      />
    </svg>
  );
}

/* ------------------------------------------------------- proportion bar */

export type ProportionSegment = {
  /** What this slice is, in words: "Model", "Messaging", "23 days". */
  label: string;
  /** The slice's own value, in whatever unit `total` is in. Negative and non-finite are dropped. */
  value: number;
  /**
   * Which of the theme's three series colours to paint it. Defaults to the segment's own index,
   * so a three-part composition gets the palette in draw order without the caller saying so.
   */
  series?: number;
};

export type ProportionBarProps = {
  segments: readonly ProportionSegment[];
  /**
   * The whole the segments are a share of -- revenue, the longest wait in view, the size of the
   * book. It has to be a real measured quantity: the bar's entire claim is "this much of that",
   * and a denominator nobody measured makes the claim meaningless rather than merely imprecise.
   */
  total: number;
  /**
   * The accessible name, carrying the shares in words. A bar is a shape; the shape is not the
   * number, so the number has to be said somewhere a screen reader reaches.
   */
  label: string;
  /** Bar height in CSS pixels. 6 in a card, 4 inside a table row where the line is the point. */
  height?: number;
  className?: string;
};

/**
 * A composition bar: one track, up to three segments, no labels of its own.
 *
 * It lives beside `Sparkline` because it is the same category of thing -- a small inline graphic
 * that turns one row's numbers into a shape you can compare down a column without reading -- and
 * it paints from the same `chart-theme` series, so a bar and a line on one screen are the same
 * three colours in the same order.
 *
 * The honesty rules are structural rather than advisory:
 *
 *  - **No denominator, no bar.** A `total` that is not a finite positive number renders nothing,
 *    because a share of an unknown whole is not a share.
 *  - **No measured segment, no bar.** Every segment being zero or unreadable renders nothing
 *    rather than an empty track, which reads as "measured, and it was none of it".
 *  - **Over-run is drawn, not clipped.** When the segments sum past the total -- cost above
 *    revenue, a wait past the window -- the bar scales against the sum instead, so the track
 *    fills and the remainder disappears. The caller's `label` is what says the total was passed;
 *    silently clamping to 100% would draw a client losing money the same as one breaking even.
 *
 * Exact proportions, with no minimum segment width: a slice worth 0.3% draws at 0.3% and may not
 * be visible. The figures beside the bar are what carry the small numbers; widening the slice to
 * make it visible would make every neighbouring slice wrong.
 */
export function ProportionBar({
  segments,
  total,
  label,
  height = 6,
  className,
}: ProportionBarProps) {
  if (!Number.isFinite(total) || total <= 0) return null;

  const drawable = segments.filter(
    (segment) => Number.isFinite(segment.value) && segment.value > 0,
  );
  if (drawable.length === 0) return null;

  const sum = drawable.reduce((running, segment) => running + segment.value, 0);
  const denominator = Math.max(total, sum);

  return (
    <span
      aria-label={label}
      className={cn(
        "flex w-full min-w-0 overflow-hidden rounded-full bg-[var(--line)]",
        className,
      )}
      data-slot="proportion-bar"
      role="img"
      style={{ height }}
    >
      {drawable.map((segment, index) => (
        <span
          data-slot="proportion-segment"
          data-segment={segment.label}
          key={segment.label}
          style={{
            backgroundColor: seriesColor(segment.series ?? index),
            width: `${(segment.value / denominator) * 100}%`,
          }}
        />
      ))}
    </span>
  );
}
