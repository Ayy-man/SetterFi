"use client";

import type { ReactNode } from "react";

import {
  DataState,
  type DataStateAction,
} from "@/components/kit/data-state";
import { FAILURE_BODY } from "@/lib/copy/failure";
import { cn } from "@/lib/utils";
import { formatMetric, type MetricFormat } from "@/lib/format/metric";

export type { DataStateAction } from "@/components/kit/data-state";

export type TrendData = {
  points: readonly { at: string; value: number }[];
  periodLabel: string;
  minPeriods: number;
};

export type MetricAvailability =
  | { kind: "value"; value: number; format: MetricFormat }
  | { kind: "no-events"; note: string }
  | { kind: "unavailable"; note: string }
  | { kind: "needs-history"; days: number; needs: number }
  | { kind: "not-connected"; source: string; action: DataStateAction }
  | { kind: "read-failed"; retry: () => void };

export type HeadlineStatProps = {
  label: string;
  availability: MetricAvailability;
  delta?: {
    value: number;
    direction: "up" | "down";
    goodDirection: "up" | "down";
  };
  trend?: TrendData | null;
  action?: DataStateAction;
  methodology?: { summary: string; detail: ReactNode };
};

type Delta = NonNullable<HeadlineStatProps["delta"]>;
type MetricTone = "neutral" | "good" | "critical";

const FIGURE_CLASS = "text-metric tabular-nums";

const ACTION_CLASS =
  "inline-flex min-h-[var(--row-h-dense)] items-center rounded-[var(--r-control)] text-[length:var(--t-body)] font-medium text-[var(--accent-text)] underline-offset-[var(--s-1)] hover:underline";

function toneFor(delta: Delta | undefined): MetricTone {
  if (!delta) return "neutral";
  return delta.direction === delta.goodDirection ? "good" : "critical";
}

// A 30px figure is the loudest thing on the screen, so it never carries direction as colour: the
// figure reads as ink and the delta as body text, with the arrow and data-tone carrying direction.
const FIGURE_TONE_CLASS = "text-[var(--ink)]";
const DELTA_TONE_CLASS = "text-[var(--body)]";

function ActionControl({ action }: { action: DataStateAction }) {
  if (action.href) {
    return (
      <a className={ACTION_CLASS} href={action.href} onClick={action.onClick}>
        {action.label}
      </a>
    );
  }

  return (
    <button
      className={ACTION_CLASS}
      disabled={!action.onClick}
      onClick={action.onClick}
      type="button"
    >
      {action.label}
    </button>
  );
}

function Figure({ children, tone }: { children: ReactNode; tone: MetricTone }) {
  return (
    <output
      className={`${FIGURE_CLASS} ${FIGURE_TONE_CLASS}`}
      data-slot="headline-stat-figure"
      data-tone={tone}
    >
      {children}
    </output>
  );
}

function Counter({ children }: { children: ReactNode }) {
  return (
    <output
      className={`${FIGURE_CLASS} ${FIGURE_TONE_CLASS}`}
      data-slot="headline-stat-counter"
    >
      {children}
    </output>
  );
}

function DeltaValue({ delta, format }: { delta: Delta; format: MetricFormat }) {
  const tone = toneFor(delta);
  const label = `${delta.direction === "up" ? "Up" : "Down"} ${formatMetric(
    Math.abs(delta.value),
    format,
  )}`;

  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-[var(--s-1)] text-[length:var(--t-body)] font-medium tabular-nums",
        DELTA_TONE_CLASS,
      )}
      data-direction={delta.direction}
      data-slot="headline-stat-delta"
      data-tone={tone}
    >
      <span aria-hidden>{delta.direction === "up" ? "↑" : "↓"}</span>
      {formatMetric(Math.abs(delta.value), format)}
    </span>
  );
}

function Sparkline({ trend }: { trend: TrendData }) {
  const recordedPeriods = trend.points.length;
  const requiredPeriods = Math.max(2, trend.minPeriods);

  if (recordedPeriods < requiredPeriods) {
    return (
      <p
        className="m-0 mt-[var(--s-1)] border-t border-dashed border-[var(--line)] pt-[var(--s-2)] text-[length:var(--t-body)] text-[var(--faint)]"
        data-slot="headline-stat-trend-empty"
      >
        {formatMetric(recordedPeriods, "count")} of{" "}
        {formatMetric(requiredPeriods, "count")} periods recorded. Trend over{" "}
        {trend.periodLabel} appears when all {formatMetric(requiredPeriods, "count")} periods
        are available.
      </p>
    );
  }

  const values = trend.points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = range === 0 ? 20 : 36 - ((value - minimum) / range) * 32;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <div className="mt-[var(--s-1)] h-[var(--s-10)] text-[var(--accent)]" data-slot="headline-stat-trend">
      <svg
        aria-label={`Trend over ${trend.periodLabel}`}
        className="block size-full"
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 100 40"
      >
        <polyline
          fill="none"
          points={points}
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

function Availability({
  availability,
  delta,
  tone,
}: {
  availability: MetricAvailability;
  delta?: Delta;
  tone: MetricTone;
}) {
  if (availability.kind === "value") {
    return (
      <div className="flex flex-wrap items-baseline gap-[var(--s-3)]">
        <Figure tone={tone}>{formatMetric(availability.value, availability.format)}</Figure>
        {delta ? <DeltaValue delta={delta} format={availability.format} /> : null}
      </div>
    );
  }

  if (availability.kind === "no-events") {
    return (
      <>
        <Figure tone={tone}>0</Figure>
        <p className="m-0 text-[length:var(--t-body)] text-[var(--faint)]">
          {availability.note}
        </p>
      </>
    );
  }

  if (availability.kind === "unavailable") {
    return (
      <>
        <Figure tone={tone}>{"\u2013"}</Figure>
        <p className="m-0 text-[length:var(--t-body)] text-[var(--faint)]">
          {availability.note}
        </p>
      </>
    );
  }

  if (availability.kind === "needs-history") {
    return (
      <>
        <Counter>Day {formatMetric(availability.days, "count")}</Counter>
        <p className="m-0 text-[length:var(--t-body)] text-[var(--faint)]">
          of about {formatMetric(availability.needs, "count")} needed
        </p>
      </>
    );
  }

  if (availability.kind === "not-connected") {
    return (
      <div className="flex flex-wrap items-baseline gap-[var(--s-3)]" data-slot="headline-stat-connection">
        <span className="text-[length:var(--t-section)] font-medium text-[var(--muted)]">
          {availability.source}
        </span>
        <ActionControl action={availability.action} />
      </div>
    );
  }

  return (
    <DataState
      body={FAILURE_BODY.platform}
      className="max-w-none p-[var(--s-3)]"
      kind="error"
      retry={availability.retry}
      title="We couldn't read this metric"
    />
  );
}

export function HeadlineStat({
  label,
  availability,
  delta,
  trend,
  action,
  methodology,
}: HeadlineStatProps) {
  const tone = availability.kind === "value" ? toneFor(delta) : "neutral";

  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-[var(--s-2)] border-t-2 border-[var(--line-strong)] py-[var(--s-4)]"
      data-slot="headline-stat"
      data-tone={tone}
    >
      <h3 className="m-0 text-[length:var(--t-body)] font-medium text-[var(--muted)]">
        {label}
      </h3>
      <Availability availability={availability} delta={delta} tone={tone} />
      {action && availability.kind !== "not-connected" ? (
        <div><ActionControl action={action} /></div>
      ) : null}
      {trend ? <Sparkline trend={trend} /> : null}
      {methodology ? (
        <details className="text-[length:var(--t-body)] text-[var(--body)]" data-slot="headline-stat-methodology">
          <summary className="cursor-pointer font-medium text-[var(--accent-text)]">
            {methodology.summary}
          </summary>
          <div className="mt-[var(--s-2)] max-w-[var(--measure-wide)]">{methodology.detail}</div>
        </details>
      ) : null}
    </section>
  );
}
