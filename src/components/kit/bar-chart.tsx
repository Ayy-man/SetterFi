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
 * Bars for magnitude by period: 4px rounded tops anchored on one baseline, past periods drawn at
 * 28% so the current period, drawn solid, is the one the eye lands on. No gridlines, no axis box,
 * labels at the two ends only; the sr-only table carries every exact figure.
 *
 * Server-renderable on purpose: the geometry is computed from `width`, so a panel that needs to
 * fill a fluid column measures itself and passes the width down.
 */
export function BarChart({
  values,
  labels,
  label,
  width = 640,
  height = 150,
  className,
}: BarChartProps) {
  if (values.length === 0) return null;
  const plotHeight = height - AXIS_HEIGHT;
  const baselineY = plotHeight - PAD_Y;
  const { maximum } = chartExtent([0, ...values]);
  const slot = width / values.length;
  const barWidth = Math.max(2, Math.min(52, slot * 0.5));
  const ends = axisEnds(labels);

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
          stroke={CHART_BASELINE_COLOR}
          strokeWidth={CHART_BASELINE_WIDTH}
          x1={0}
          x2={width}
          y1={baselineY}
          y2={baselineY}
        />
        {values.map((value, index) => {
          const safe = Number.isFinite(value) && value > 0 ? value : 0;
          const barHeight = maximum > 0 ? (safe / maximum) * (baselineY - PAD_Y) : 0;
          const x = slot * index + (slot - barWidth) / 2;
          const isCurrent = index === values.length - 1;
          return (
            <rect
              data-slot={isCurrent ? "bar-current" : "bar"}
              fill={CHART_ACCENT}
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
      </svg>
      {ends ? (
        <div className={cn("flex justify-between", CHART_AXIS_LABEL_CLASS)}>
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
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
