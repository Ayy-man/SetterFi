import {
  CHART_ACCENT,
  CHART_AXIS_LABEL_CLASS,
  CHART_BASELINE_COLOR,
  CHART_BASELINE_WIDTH,
  axisEnds,
  chartExtent,
} from "@/components/kit/chart-theme";
import { cn } from "@/lib/utils";

export type BarChartProps = {
  /** One value per period, oldest first. */
  values: readonly number[];
  /** One label per value, same order; only the two ends are drawn, all of them go to the table. */
  labels: readonly string[];
  /** What the chart is, for assistive tech and the table caption. */
  label: string;
  /**
   * The latest bar's own reading, already formatted, drawn above that bar.
   *
   * A bar strip says which period was biggest and nothing about how big. One number, on the bar
   * the reader came for, is what turns the shape back into a magnitude without a hover the print
   * and the screen reader both miss. Omit it and the chart keeps its old headroom.
   */
  currentValueLabel?: string;
  /**
   * The bar colour. Defaults to the theme's accent, which is what a chart on a card wants; a
   * drenched surface passes its own so the bars stay readable against it.
   */
  fill?: string;
  /** The baseline hairline's colour, for the same reason `fill` exists. */
  baselineColor?: string;
  /**
   * The two end labels' colour, for the same reason `fill` exists. Set as a style rather than a
   * class: the default lives in `CHART_AXIS_LABEL_CLASS` as an arbitrary Tailwind value, and a
   * second arbitrary text colour merged against it is decided by stylesheet order rather than by
   * the caller.
   */
  axisColor?: string;
  /**
   * How a value reads in the sr-only table. A series carried in cents or seconds would otherwise
   * put its raw unit in front of the one reader who has nothing but that table, so a caller whose
   * numbers are not already in the reader's units passes the same formatter it labels the bar with.
   */
  valueText?: (value: number) => string;
  width?: number;
  height?: number;
  className?: string;
};

/** Bars keep a 2px gap of surface between them and the last one is the only solid bar. */
export const BAR_CHART_PAST_OPACITY = 0.28;
const BAR_RADIUS = 4;
const PAD_Y = 4;
const AXIS_HEIGHT = 16;
/**
 * Headroom reserved above the tallest bar when a value label is drawn, so the label sits over the
 * bar rather than clipping out of the top of the box. Nothing is reserved when there is no label.
 */
const VALUE_LABEL_BAND = 19;

/**
 * Bars for magnitude by period: 4px rounded tops anchored on one baseline, past periods drawn at
 * 28% so the current period, drawn solid, is the one the eye lands on. No gridlines, no axis box,
 * labels at the two ends only; the sr-only table carries every exact figure, and
 * `currentValueLabel` puts the latest reading on the bar itself so the shape is not the only thing
 * a sighted reader gets. That label is 14px rather than the 10px the axis ends carry: it is the
 * one figure on the chart, it has to clear the coach floor `docs/SIMPLIFICATION-SPEC.md` §5 sets
 * for anything a coach page can mount, and a value nobody can read defeats the point of drawing
 * it.
 *
 * Server-renderable on purpose: the geometry is computed from `width`, so a panel that needs to
 * fill a fluid column measures itself and passes the width down.
 */
export function BarChart({
  values,
  labels,
  label,
  axisColor,
  baselineColor = CHART_BASELINE_COLOR,
  currentValueLabel,
  fill = CHART_ACCENT,
  valueText,
  width = 640,
  height = 150,
  className,
}: BarChartProps) {
  if (values.length === 0) return null;
  const plotHeight = height - AXIS_HEIGHT;
  const baselineY = plotHeight - PAD_Y;
  const topPad = PAD_Y + (currentValueLabel ? VALUE_LABEL_BAND : 0);
  const { maximum } = chartExtent([0, ...values]);
  const slot = width / values.length;
  const barWidth = Math.max(2, Math.min(52, slot * 0.5));
  const ends = axisEnds(labels);
  const currentIndex = values.length - 1;
  const currentSafe = Number.isFinite(values[currentIndex]) && (values[currentIndex] as number) > 0
    ? (values[currentIndex] as number)
    : 0;
  const currentHeight = maximum > 0 ? (currentSafe / maximum) * (baselineY - topPad) : 0;
  // Anchored at the bar's right edge rather than its centre: the current bar is the rightmost one,
  // and a centred label on a long figure runs off the end of the box.
  const currentLabelX = Math.min(
    width,
    slot * currentIndex + (slot - barWidth) / 2 + barWidth,
  );

  return (
    <div className={cn("flex flex-col", className)} data-slot="bar-chart">
      <svg
        aria-label={label}
        className="block"
        height={height}
        role="img"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
      >
        <line
          stroke={baselineColor}
          strokeWidth={CHART_BASELINE_WIDTH}
          x1={0}
          x2={width}
          y1={baselineY}
          y2={baselineY}
        />
        {values.map((value, index) => {
          const safe = Number.isFinite(value) && value > 0 ? value : 0;
          const barHeight = maximum > 0 ? (safe / maximum) * (baselineY - topPad) : 0;
          const x = slot * index + (slot - barWidth) / 2;
          const isCurrent = index === values.length - 1;
          return (
            <rect
              data-slot={isCurrent ? "bar-current" : "bar"}
              fill={fill}
              fillOpacity={isCurrent ? 1 : BAR_CHART_PAST_OPACITY}
              height={Math.max(0, barHeight)}
              key={`${labels[index] ?? index}-${index}`}
              rx={BAR_RADIUS}
              width={barWidth}
              x={x}
              y={baselineY - Math.max(0, barHeight)}
            />
          );
        })}
        {currentValueLabel ? (
          <text
            className="font-[family-name:var(--font-mono)] text-[14px] tabular-nums"
            data-slot="bar-current-value"
            fill="currentColor"
            textAnchor="end"
            x={currentLabelX}
            y={Math.max(14, baselineY - currentHeight - 5)}
          >
            {currentValueLabel}
          </text>
        ) : null}
      </svg>
      {ends ? (
        <div
          className={cn("flex justify-between", CHART_AXIS_LABEL_CLASS)}
          style={axisColor ? { color: axisColor } : undefined}
        >
          <span>{ends.start}</span>
          <span>{ends.end}</span>
        </div>
      ) : null}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {values.map((value, index) => (
            <tr key={`${labels[index] ?? index}-${index}`}>
              <th scope="row">{labels[index] ?? String(index + 1)}</th>
              <td>{valueText ? valueText(value) : value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
