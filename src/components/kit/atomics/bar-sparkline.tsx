import { TONE_MARK, type Tone } from "@/components/kit/atomics/tone";
import { cn } from "@/lib/utils";

export type BarSparklineProps = {
  /** The series, oldest first. Two points is the minimum a trend can honestly be drawn from. */
  points: readonly number[];
  /**
   * What the series is, for assistive tech: "Total leads, last 7 days". The figure is
   * `role="img"` with this as its label, because a row of bars with no words is not a metric.
   */
  label: string;
  tone?: Tone;
  height?: number;
  /** 1px on a dense trend column, up to 5px on a KPI tile. */
  barWidth?: number | "flex";
  /**
   * How many trailing bars carry full saturation. The artifact fades the older bars back so the
   * eye lands on the recent end without a second colour: 1b lights the last two of seven, 2b the
   * last three. Everything before that steps down in opacity.
   */
  emphasisCount?: number;
  className?: string;
};

/** The minimum series a sparkline will draw. One point is a bar, not a trend. */
export const BAR_SPARKLINE_MIN_POINTS = 2;

/**
 * The bar sparkline, which is the trend shape this system uses everywhere a line sparkline would
 * normally go.
 *
 * The choice is deliberate: a 26px-tall smoothed line reads as decoration, and 2b puts the trend
 * in a table column beside the number it explains, where the reader has to be able to count the
 * periods. Bars are countable; a curve is not. The existing `Sparkline` in the kit draws the
 * smoothed line and stays for the surfaces that already use it.
 *
 * The opacity ramp is the only thing carrying recency, so there is no second hue and no axis.
 */
export function BarSparkline({
  barWidth = "flex",
  className,
  emphasisCount = 2,
  height = 26,
  label,
  points,
  tone = "accent",
}: BarSparklineProps) {
  const finite = points.filter((value) => Number.isFinite(value));
  if (finite.length < BAR_SPARKLINE_MIN_POINTS) return null;

  const peak = Math.max(...finite.map((value) => Math.abs(value)));
  if (!(peak > 0)) return null;
  const emphasisFrom = Math.max(0, finite.length - Math.max(1, emphasisCount));

  return (
    <div
      aria-label={label}
      className={cn("flex items-end gap-[3px]", className)}
      data-slot="bar-sparkline"
      data-tone={tone}
      role="img"
      style={{ height }}
    >
      {finite.map((value, index) => {
        const share = Math.abs(value) / peak;
        // Older bars step back in four rungs from .3 to .5, and the emphasised tail sits solid.
        // A bar that fell to zero still draws a 2% sliver so a gap in the series is visibly a
        // measured zero rather than a period nobody recorded.
        const opacity = index >= emphasisFrom ? 1 : 0.3 + (index / Math.max(1, emphasisFrom)) * 0.2;
        return (
          <div
            data-slot="bar-sparkline-bar"
            key={index}
            style={{
              background: TONE_MARK[tone],
              borderRadius: 1,
              flex: barWidth === "flex" ? 1 : undefined,
              height: `${Math.max(2, share * 100)}%`,
              opacity,
              width: barWidth === "flex" ? undefined : barWidth,
            }}
          />
        );
      })}
    </div>
  );
}

export type HeatRowProps = {
  points: readonly number[];
  label: string;
  tone?: Tone;
  height?: number;
  className?: string;
};

/**
 * 2b's "when agents convert": one row of equal-height cells whose opacity is the value. It answers
 * a different question from the bar sparkline -- not "is this rising" but "which hour is it" -- so
 * the cells stay the same height and only the fill moves, which is what lets twelve of them sit in
 * a card without becoming a chart.
 */
export function HeatRow({ className, height = 34, label, points, tone = "accent" }: HeatRowProps) {
  const finite = points.filter((value) => Number.isFinite(value));
  const peak = Math.max(...finite.map((value) => Math.abs(value)), 0);
  if (finite.length === 0 || peak <= 0) return null;

  return (
    <div
      aria-label={label}
      className={cn("flex gap-[3px]", className)}
      data-slot="heat-row"
      data-tone={tone}
      role="img"
    >
      {finite.map((value, index) => (
        <div
          className="flex-1 rounded-[3px]"
          data-slot="heat-row-cell"
          key={index}
          style={{
            background: TONE_MARK[tone],
            height,
            // Floor at .1 so an hour with no bookings is still a drawn cell: a missing cell would
            // shift every hour after it and make the axis lie.
            opacity: 0.1 + (Math.abs(value) / peak) * 0.9,
          }}
        />
      ))}
    </div>
  );
}

/**
 * The axis strip under a chart: evenly spaced mono ticks. Separate from the chart so a caller
 * cannot end up with eleven bars over five labels that silently do not line up.
 */
export function AxisTicks({
  className,
  ticks,
}: {
  className?: string;
  ticks: readonly string[];
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("mono flex justify-between text-[10.5px] tabular-nums text-[color:var(--overline)]", className)}
      data-slot="axis-ticks"
    >
      {ticks.map((tick, index) => (
        <span key={index}>{tick}</span>
      ))}
    </div>
  );
}
