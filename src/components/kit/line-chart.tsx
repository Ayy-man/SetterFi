"use client";

import { useId, useState, type PointerEvent } from "react";

import {
  CHART_AREA_OPACITY,
  CHART_AXIS_LABEL_CLASS,
  CHART_BASELINE_COLOR,
  CHART_BASELINE_WIDTH,
  ChartLegend,
  ChartTooltip,
  areaPath,
  axisEnds,
  chartGeometry,
  seriesColor,
  smoothPath,
  type ChartPoint,
} from "@/components/kit/chart-theme";
import { cn } from "@/lib/utils";

export type LineChartSeries = {
  name: string;
  /** One value per label, oldest first. Series must share the label axis. */
  values: readonly number[];
};

export type LineChartProps = {
  series: readonly LineChartSeries[];
  labels: readonly string[];
  /** What the chart is, for assistive tech and the table caption. */
  label: string;
  width?: number;
  height?: number;
  className?: string;
};

const PAD_X = 4;
const PAD_Y = 6;
const STROKE = 2;
const MARKER = 4;
const AXIS_HEIGHT = 16;

/**
 * Up to three series on one axis. 2px smoothed lines, the first series carrying a faint area,
 * a legend whenever there is more than one line, end-only axis labels, and a crosshair tooltip
 * that follows the pointer. Every series is scaled against the same extent, so two lines are
 * comparable by eye; two measures of different scale belong in two charts, never on two axes.
 */
export function LineChart({
  series,
  labels,
  label,
  width = 640,
  height = 200,
  className,
}: LineChartProps) {
  const gradientId = `line-chart-fill-${useId()}`;
  const [hover, setHover] = useState<number | null>(null);
  const drawn = series.slice(0, 3).filter((entry) => entry.values.length >= 2);
  if (drawn.length === 0) return null;

  const plotHeight = height - AXIS_HEIGHT;
  const baselineY = plotHeight - PAD_Y;
  const all = drawn.flatMap((entry) => entry.values).filter((value) => Number.isFinite(value));
  const minimum = Math.min(0, ...all);
  const maximum = Math.max(...all);
  const count = Math.max(...drawn.map((entry) => entry.values.length));
  const geometries = drawn.map((entry) =>
    chartGeometry(
      // Pad the extent so every series shares one scale.
      [minimum, maximum, ...entry.values],
      { height: plotHeight, padX: PAD_X, padY: PAD_Y, width },
    ).slice(2),
  );
  const ends = axisEnds(labels);

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
    const index = Math.round(ratio * (count - 1));
    setHover(Math.max(0, Math.min(count - 1, index)));
  };

  const hoverX = hover === null ? null : ((geometries[0]?.[hover] as ChartPoint | undefined)?.x ?? null);

  return (
    <div className={cn("relative flex flex-col gap-[var(--s-2)]", className)} data-slot="line-chart">
      {drawn.length > 1 ? (
        <ChartLegend
          items={drawn.map((entry, index) => ({ label: entry.name, series: index }))}
        />
      ) : null}
      <svg
        aria-label={label}
        className="block overflow-visible"
        height={height}
        onPointerLeave={() => setHover(null)}
        onPointerMove={onMove}
        role="img"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={seriesColor(0)} stopOpacity={CHART_AREA_OPACITY} />
            <stop offset="100%" stopColor={seriesColor(0)} stopOpacity={0} />
          </linearGradient>
        </defs>
        <line
          stroke={CHART_BASELINE_COLOR}
          strokeWidth={CHART_BASELINE_WIDTH}
          x1={0}
          x2={width}
          y1={baselineY}
          y2={baselineY}
        />
        {geometries[0] ? (
          <path d={areaPath(geometries[0], baselineY)} data-slot="line-chart-area" fill={`url(#${gradientId})`} />
        ) : null}
        {geometries.map((points, index) => (
          <path
            d={smoothPath(points)}
            data-slot="line-chart-line"
            fill="none"
            key={drawn[index]?.name ?? index}
            stroke={seriesColor(index)}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={STROKE}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hoverX !== null ? (
          <line
            data-slot="line-chart-crosshair"
            stroke="var(--faint)"
            strokeDasharray="3 3"
            strokeWidth={1}
            x1={hoverX}
            x2={hoverX}
            y1={PAD_Y}
            y2={baselineY}
          />
        ) : null}
        {geometries.map((points, index) => {
          const point = hover === null ? points[points.length - 1] : points[hover];
          if (!point) return null;
          return (
            <circle
              cx={point.x}
              cy={point.y}
              data-slot="line-chart-marker"
              fill={seriesColor(index)}
              key={`marker-${drawn[index]?.name ?? index}`}
              r={MARKER}
              stroke="var(--card)"
              strokeWidth={STROKE}
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
      {hover !== null && hoverX !== null ? (
        <ChartTooltip
          className="absolute top-0"
          label={labels[hover] ?? String(hover + 1)}
        >
          {drawn.map((entry) => `${entry.name} ${entry.values[hover] ?? "—"}`).join(" · ")}
        </ChartTooltip>
      ) : null}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {drawn.map((entry) => (
              <th key={entry.name} scope="col">
                {entry.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: count }, (_, row) => (
            <tr key={labels[row] ?? row}>
              <th scope="row">{labels[row] ?? String(row + 1)}</th>
              {drawn.map((entry) => (
                <td key={entry.name}>{entry.values[row] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
