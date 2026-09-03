"use client"

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react"

import { cn } from "@/lib/utils"

export type TrendData = {
  points: readonly { at: string; value: number }[]
  periodLabel: string
  minPeriods: number
}

export type TrendPanelProps = {
  title: string
  data: TrendData | null
  emptyReason: string
  height?: number
  /**
   * How an axis tick names its period. "short" is the default and gives "Aug 2026", which is what
   * a dense console chart with twelve ticks needs. "long" gives "August", for the coach surface,
   * where six ticks have room for the whole word and the reader is the one who told us the product
   * was hard to read. It is a prop rather than a second component because the geometry, the
   * accessible table and the pending arm are identical either way.
   */
  periodFormat?: "short" | "long"
}

type ChartPoint = TrendData["points"][number] & {
  x: number
  y: number
  zeroY: number
}

// Geometry is computed in CSS pixels from the measured panel so bars and markers keep their
// drawn size at any width. Stretching a small viewBox with preserveAspectRatio="none" turned
// 5-unit bars into slabs and circles into ellipses on wide panels (F-11-TREND-MARKERS).
const FALLBACK_WIDTH = 640
const FALLBACK_HEIGHT = 120
const PAD_X = 6
const PAD_TOP = 8
const PAD_BOTTOM = 8
const BAR_WIDTH = 6
const POINT_SLOT = 48

type ChartSize = { width: number; height: number }

function formatPeriod(at: string, periodFormat: NonNullable<TrendPanelProps["periodFormat"]>) {
  const isoDate = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(at)
  if (!isoDate) return at

  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at

  // The year is dropped in the long form on purpose. The panel's own range caption already says
  // which six months these are, and "August 2026" on every tick spends the width the long month
  // name was the point of.
  return new Intl.DateTimeFormat("en-US", {
    month: periodFormat === "long" ? "long" : "short",
    timeZone: "UTC",
    ...(periodFormat === "long" ? {} : { year: "numeric" as const }),
  }).format(date)
}

function chartPoints(points: TrendData["points"], size: ChartSize): ChartPoint[] {
  const values = points.map((point) => point.value)
  const minimum = values.reduce((current, value) => Math.min(current, value), 0)
  const maximum = values.reduce((current, value) => Math.max(current, value), 0)
  const range = Math.max(maximum - minimum, 1)
  const chartTop = PAD_TOP
  const chartBottom = Math.max(size.height - PAD_BOTTOM, chartTop + 1)
  const chartStart = PAD_X + BAR_WIDTH / 2
  const chartEnd = Math.max(size.width - PAD_X - BAR_WIDTH / 2, chartStart + 1)
  const scaleY = (value: number) =>
    chartTop + ((maximum - value) / range) * (chartBottom - chartTop)
  const zeroY = scaleY(0)

  return points.map((point, index) => ({
    ...point,
    x:
      points.length === 1
        ? (chartStart + chartEnd) / 2
        : chartStart + (index / (points.length - 1)) * (chartEnd - chartStart),
    y: scaleY(point.value),
    zeroY,
  }))
}

function linePath(points: readonly ChartPoint[]) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ")
}

function PendingTrend({
  data,
  emptyReason,
  height,
}: Pick<TrendPanelProps, "data" | "emptyReason" | "height">) {
  const periods = data?.points.length ?? 0
  const requiredPeriods = data?.minPeriods ?? 0
  const progress = requiredPeriods > 0 ? Math.min(periods / requiredPeriods, 1) : 0

  return (
    <>
      <div
        className="trend__chart flex h-[calc(var(--s-12)*2+var(--s-6))] items-center justify-center rounded-[var(--r-input)] border border-dashed border-[var(--line-strong)] p-[var(--s-4)] text-center text-body text-[var(--muted)]"
        style={height === undefined ? undefined : { height }}
      >
        <p className="max-w-[var(--measure-prose)]">{emptyReason}</p>
      </div>
      {data && data.points.length < data.minPeriods ? (
        <div
          aria-hidden="true"
          className="h-[var(--s-1)] overflow-hidden rounded-[var(--r-full)] bg-[var(--quiet)]"
        >
          <i
            className="block h-full rounded-[var(--r-full)] bg-[var(--line-strong)]"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      ) : null}
    </>
  )
}

function TrendChart({
  data,
  height,
  periodFormat,
  title,
  titleId,
}: Pick<TrendPanelProps, "height" | "title"> & {
  data: TrendData
  periodFormat: NonNullable<TrendPanelProps["periodFormat"]>
  titleId: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const [isScrollable, setIsScrollable] = useState(false)
  const [size, setSize] = useState<ChartSize>({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT })
  const minWidth = data.points.length * POINT_SLOT
  const points = useMemo(() => chartPoints(data.points, size), [data.points, size])
  const path = useMemo(() => linePath(points), [points])
  const barWidth = BAR_WIDTH
  const gridTop = PAD_TOP
  const gridBottom = Math.max(size.height - PAD_BOTTOM, gridTop + 1)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const measure = () => {
      const clientWidth = container.clientWidth
      // The plot, not the scroller: the scroller now also holds the axis, so its height is the
      // pair rather than the drawing area the chart geometry is computed against.
      const clientHeight = (plotRef.current ?? container).clientHeight
      if (clientWidth > 0 && clientHeight > 0) {
        const width = Math.max(clientWidth, minWidth)
        setSize((current) =>
          current.width === width && current.height === clientHeight
            ? current
            : { width, height: clientHeight }
        )
        setIsScrollable(minWidth > clientWidth)
        return
      }
      setIsScrollable(container.scrollWidth > container.clientWidth)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    window.addEventListener("resize", measure)

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [data.points.length, height, minWidth])

  return (
    <>
      {/*
        One scroller for the plot and the axis together. They used to be siblings, the plot
        scrolling and the axis fixed, so on any panel narrow enough to scroll every period label
        sat under a point it did not belong to. Inside one scroller they move as one drawing, and
        each label is placed at its own point's x rather than distributed evenly, so a tick names
        the marker directly above it at any width.
      */}
      <div
        aria-labelledby={isScrollable ? titleId : undefined}
        className={cn("trend__chart", isScrollable && "overflow-x-auto")}
        ref={containerRef}
        role={isScrollable ? "region" : undefined}
        style={isScrollable ? { overscrollBehaviorX: "contain" } : undefined}
        tabIndex={isScrollable ? 0 : undefined}
      >
        <div
          className="flex flex-col gap-[var(--s-2)]"
          style={{ minWidth, width: size.width }}
        >
        <div
          className="trend__plot h-[calc(var(--s-12)*2+var(--s-6))]"
          ref={plotRef}
          style={height === undefined ? undefined : { height }}
        >
        <svg
          aria-hidden="true"
          className="block h-full w-full overflow-visible"
          focusable="false"
          viewBox={`0 0 ${size.width} ${size.height}`}
        >
          {/* One baseline, no gridlines: the zero line is the only rule a reader measures against. */}
          <line
            className="baseline"
            stroke="var(--line)"
            strokeWidth="1"
            x1={PAD_X}
            x2={size.width - PAD_X}
            y1={gridBottom}
            y2={gridBottom}
          />
          <g aria-hidden="true">
            {points.map((point, index) => {
              const y = Math.min(point.y, point.zeroY)
              const barHeight = Math.abs(point.zeroY - point.y)
              const isFinalBar = index === points.length - 1

              return (
                <rect
                  className={cn(
                    "bar fill-[var(--color-chart-1)]",
                    isFinalBar ? "bar--end opacity-100" : "opacity-[0.28]"
                  )}
                  rx="4"
                  height={barHeight}
                  key={`${point.at}-${index}`}
                  width={barWidth}
                  x={point.x - barWidth / 2}
                  y={y}
                />
              )
            })}
          </g>
          <path
            className="line fill-none stroke-[var(--color-chart-1)]"
            d={path}
            strokeLinejoin="round"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          {points.map((point, index) => (
            <circle
              className="dot fill-[var(--color-chart-1)] stroke-[var(--card)]"
              cx={point.x}
              cy={point.y}
              key={`${point.at}-${index}`}
              r="2"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        </div>
        <div
          aria-hidden="true"
          className="trend__axis text-over relative h-[var(--s-4)] text-[var(--faint)]"
        >
          {points.map((point, index) => (
            <span
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
              key={`${point.at}-${index}`}
              style={{ left: point.x }}
            >
              {formatPeriod(point.at, periodFormat)}
            </span>
          ))}
        </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>{`${title}, ${data.periodLabel}`}</caption>
        {/* Named columns: the row header alone left every figure as an unlabelled number. */}
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {data.points.map((point, index) => (
            <tr key={`${point.at}-${index}`}>
              <th scope="row">{formatPeriod(point.at, periodFormat)}</th>
              <td>{point.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

export function TrendPanel({
  title,
  data,
  emptyReason,
  height,
  periodFormat = "short",
}: TrendPanelProps) {
  const titleId = useId()
  const hasMeaningfulValues = data?.points.some(
    (point) => Number.isFinite(point.value) && point.value !== 0
  )
  const isPending =
    data === null || data.points.length < data.minPeriods || !hasMeaningfulValues

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "trend flex min-w-0 flex-col gap-[var(--s-3)] rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] p-[var(--s-4)]",
        isPending && "trend--pending"
      )}
    >
      <div className="flex items-baseline justify-between gap-[var(--s-3)]">
        <h2
          className="text-[length:var(--t-body)] font-[var(--t-row-w)] text-[var(--ink)]"
          id={titleId}
        >
          {title}
        </h2>
        {data ? (
          <span className="text-[length:var(--t-badge)] font-[var(--t-body-w)] text-[var(--faint)]">
            {data.periodLabel}
          </span>
        ) : null}
      </div>
      {isPending ? (
        <PendingTrend data={data} emptyReason={emptyReason} height={height} />
      ) : (
        <TrendChart
          data={data}
          height={height}
          periodFormat={periodFormat}
          title={title}
          titleId={titleId}
        />
      )}
    </section>
  )
}
