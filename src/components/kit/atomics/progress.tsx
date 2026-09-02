import type { ReactNode } from "react";

import { TONE_MARK, TONE_TEXT, type Tone } from "@/components/kit/atomics/tone";
import { formatMetric } from "@/lib/format/metric";
import { cn } from "@/lib/utils";

/** The fill gradient for a tone: the tone's own mark lightening left to right. */
function fillFor(tone: Tone): string {
  return `linear-gradient(90deg, color-mix(in oklab, ${TONE_MARK[tone]} 62%, black), ${TONE_MARK[tone]})`;
}

export type ProgressBarProps = {
  /** 0 to 1. Anything outside is clamped, so a bad denominator draws a full bar rather than an overflow. */
  value: number;
  /**
   * What the bar measures, in words -- "Rollout checklist, 4 of 6". The bar is a `progressbar` and
   * this is its accessible name; a bar with no name is a decoration claiming to be a measurement.
   */
  label: string;
  tone?: Tone;
  /** 4px in a rail card, 5px on a funnel row, 6px on a KPI, 8px on a movement bar. */
  height?: 4 | 5 | 6 | 8;
  className?: string;
};

export function ProgressBar({ className, height = 5, label, tone = "accent", value }: ProgressBarProps) {
  const ratio = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const percent = Math.round(ratio * 1000) / 10;
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
      className={cn("w-full overflow-hidden rounded-[var(--r-full)] bg-[var(--band)]", className)}
      data-slot="progress-bar"
      data-tone={tone}
      role="progressbar"
      style={{ height }}
    >
      <div
        className="h-full rounded-[var(--r-full)]"
        data-slot="progress-bar-fill"
        style={{ background: fillFor(tone), width: `${percent}%` }}
      />
    </div>
  );
}

export type SplitSegment = {
  label: string;
  value: number;
  tone: Tone;
  /** A second slice of the same tone, drawn dimmer: upgrades beside new, downgrades beside churn. */
  secondary?: boolean;
};

export type SplitBarProps = {
  segments: readonly SplitSegment[];
  /**
   * The whole the segments are a share of. It has to be a real measured quantity: the bar's entire
   * claim is "this much of that", and a denominator nobody measured makes the claim meaningless
   * rather than merely imprecise. Defaults to the sum of the segments.
   */
  total?: number;
  label: string;
  height?: 8 | 9;
  className?: string;
};

/**
 * The composition bar: 2c's MRR movement and its plan mix, 1b's funnel in miniature. One bar
 * rather than four cards, which is the point of the screen it comes from -- four figures in four
 * boxes cannot show that churn ate a third of what new business brought in.
 */
export function SplitBar({ className, height = 8, label, segments, total }: SplitBarProps) {
  const values = segments.map((segment) => (Number.isFinite(segment.value) ? Math.max(0, segment.value) : 0));
  const denominator = total ?? values.reduce((sum, value) => sum + value, 0);
  if (denominator <= 0) return null;

  return (
    <div
      aria-label={label}
      className={cn("flex w-full overflow-hidden rounded-[var(--r-full)] bg-[var(--control-fill)]", className)}
      data-slot="split-bar"
      role="img"
      style={{ height }}
    >
      {segments.map((segment, index) => (
        <div
          data-slot="split-bar-segment"
          data-tone={segment.tone}
          key={`${segment.label}-${index}`}
          style={{
            background: segment.secondary
              ? `color-mix(in oklab, ${TONE_MARK[segment.tone]} 55%, black)`
              : fillFor(segment.tone),
            width: `${(values[index]! / denominator) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

export type LegendItem = { label: ReactNode; tone: Tone; value?: ReactNode };

/**
 * The key under a split bar or a chart. A 7px rounded square rather than a dot, so it never reads
 * as a status dot -- the two live within a few pixels of each other on 2c and confusing them would
 * make a plan-mix key look like four accounts in trouble.
 */
export function Legend({
  className,
  items,
}: {
  className?: string;
  items: readonly LegendItem[];
}) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-[22px] gap-y-[var(--s-2)]", className)} data-slot="legend">
      {items.map((item, index) => (
        <li className="flex items-center gap-[var(--s-2)]" key={index}>
          <span
            aria-hidden="true"
            className="size-[7px] shrink-0 rounded-[2px]"
            data-slot="legend-swatch"
            data-tone={item.tone}
            style={{ background: TONE_MARK[item.tone] }}
          />
          <span className="text-[12px] text-[color:var(--muted)]">{item.label}</span>
          {item.value !== undefined ? (
            <span
              className="mono text-[12px] font-[500] tabular-nums"
              style={{ color: item.tone === "neutral" ? "var(--body)" : TONE_TEXT[item.tone] }}
            >
              {item.value}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export type FunnelStep = { label: ReactNode; value: number; tone?: Tone };

/**
 * The funnel from 1b: a label, its mono count, and a bar underneath at its share of the top step.
 *
 * Counts go through `formatMetric`, which is pinned to `en-US`, rather than through
 * the ambient-locale helpers on `Number`. Those format against whatever locale the environment
 * happens to carry, which on a server render is the server's, so the same figure can come back
 * with different separators depending on where it was rendered. A primitive formats on behalf of
 * every screen that adopts it, so that would have been eight admin surfaces, not one file.
 * Every share is computed from the steps themselves, so a hardcoded percentage cannot drift away
 * from the numbers beside it -- which is the failure the "render every count from its list" rule
 * exists to prevent.
 */
export function FunnelBars({
  className,
  steps,
}: {
  className?: string;
  steps: readonly FunnelStep[];
}) {
  const top = steps[0]?.value ?? 0;
  if (!(top > 0)) return null;
  return (
    <div className={cn("flex flex-col gap-[13px]", className)} data-slot="funnel-bars">
      {steps.map((step, index) => {
        const tone = step.tone ?? "accent";
        return (
          <div key={index}>
            <div className="mb-[6px] flex items-baseline justify-between gap-[var(--s-2)]">
              <span
                className="text-[12.5px]"
                style={{ color: tone === "neutral" || tone === "accent" ? "var(--body)" : TONE_TEXT[tone] }}
              >
                {step.label}
              </span>
              <span
                className="mono text-[12px] font-[500] tabular-nums"
                style={{ color: tone === "neutral" || tone === "accent" ? "var(--ink)" : TONE_TEXT[tone] }}
              >
                {formatMetric(step.value, "count")}
              </span>
            </div>
            <ProgressBar
              height={6}
              label={`${typeof step.label === "string" ? step.label : "Step"}: ${formatMetric(step.value, "count")} of ${formatMetric(top, "count")}`}
              tone={tone}
              value={step.value / top}
            />
          </div>
        );
      })}
    </div>
  );
}
