import type { ReactNode } from "react";

import { IconTile } from "@/components/kit/atomics/icon-tile";
import { Surface } from "@/components/kit/atomics/surface";
import { TONE_MARK, TONE_TEXT, type Tone } from "@/components/kit/atomics/tone";
import { Figure, Overline } from "@/components/kit/atomics/type";
import { cn } from "@/lib/utils";

export type MetricCardProps = {
  /** The mono overline: TOTAL LEADS, OPEN REQUESTS, NET MRR. Uppercased by the component. */
  overline: ReactNode;
  /** The number itself, already formatted. Formatting is the caller's, because units are. */
  value: ReactNode;
  /**
   * The words beside the number: "avg 11 days to live", "1,780 of 4,812", "nobody owns these".
   * A KPI without one is a number with no denominator, which is how a dashboard lies by omission.
   */
  note?: ReactNode;
  /** A signed delta, set in mono beside the value: "+7pts", "−3s", "+$6,180". */
  delta?: ReactNode;
  deltaTone?: Tone;
  /**
   * The tone frames the whole tile -- hairline, corner glow, figure colour. `neutral` is the
   * resting state and most tiles on a healthy screen are neutral; a toned tile is a claim that
   * this figure is the one to look at.
   */
  tone?: Tone;
  icon?: ReactNode;
  /**
   * The corner radial. 1a's tiles carry one off the top-left in the tile's own tone; it is the
   * only decoration on the card and it exists so a strip of four tiles has a light direction
   * rather than reading as four flat rectangles. Off by default: four glowing tiles in a row is
   * exactly the "hero metric template" the system rejects.
   */
  glow?: boolean;
  /** A sparkline, a progress bar, or a second line of note, under the figure. */
  footer?: ReactNode;
  className?: string;
};

/**
 * The KPI tile.
 *
 * The interior order is fixed and deliberate: label, then figure, then what the figure is a share
 * of. It is the inverse of the hero-metric template the system rejects, where a big number leads
 * and the label apologises for it underneath.
 */
export function MetricCard({
  className,
  delta,
  deltaTone,
  footer,
  glow,
  icon,
  note,
  overline,
  tone = "neutral",
  value,
}: MetricCardProps) {
  return (
    <Surface
      className={cn("relative overflow-hidden p-[15px_16px]", className)}
      data-slot="metric-card"
      tone={tone}
    >
      {glow ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-y-[40%] -left-[10%] right-[55%]"
          data-slot="metric-card-glow"
          style={{
            background: `radial-gradient(closest-side, color-mix(in oklab, ${TONE_MARK[tone]} 16%, transparent), transparent)`,
          }}
        />
      ) : null}

      <div className="relative flex flex-col gap-[12px]">
        <div className="flex items-center gap-[10px]">
          {icon ? (
            <IconTile size="sm" tone={tone === "neutral" ? "accent" : tone}>
              {icon}
            </IconTile>
          ) : null}
          <Overline
            style={tone === "neutral" ? undefined : { color: TONE_TEXT[tone], opacity: 0.85 }}
          >
            {overline}
          </Overline>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-[var(--s-2)] gap-y-[var(--s-1)]">
          <Figure size="lg" tone={tone}>
            {value}
          </Figure>
          {delta !== undefined ? (
            <span
              className="mono text-[11.5px] font-[500] tabular-nums"
              data-slot="metric-card-delta"
              style={{ color: TONE_TEXT[deltaTone ?? "good"] }}
            >
              {delta}
            </span>
          ) : null}
          {note ? (
            <span
              className="text-[11.5px] leading-[1.4]"
              data-slot="metric-card-note"
              style={{ color: tone === "neutral" ? "var(--muted)" : TONE_TEXT[tone] }}
            >
              {note}
            </span>
          ) : null}
        </div>

        {footer ? (
          <div className="min-w-0" data-slot="metric-card-footer">
            {footer}
          </div>
        ) : null}
      </div>
    </Surface>
  );
}

export type KeyValueRow = { label: ReactNode; value: ReactNode; tone?: Tone };

/**
 * The label-left / mono-value-right list: 2a's BLAST RADIUS, 1c's HEALTH, 2b's spec lines.
 *
 * It is a `<dl>` and not a table because there is one value per label and no column to sort. The
 * tone lives on the value, not the row: "Leads waiting 38" is only alarming because of the 38.
 */
export function KeyValueList({
  className,
  rows,
}: {
  className?: string;
  rows: readonly KeyValueRow[];
}) {
  return (
    <dl className={cn("flex flex-col gap-[var(--s-2)]", className)} data-slot="key-value-list">
      {rows.map((row, index) => (
        <div className="flex items-baseline justify-between gap-[var(--s-3)]" key={index}>
          <dt className="min-w-0 truncate text-[12px] text-[color:var(--muted)]">{row.label}</dt>
          <dd
            className="mono shrink-0 text-[12px] tabular-nums"
            data-tone={row.tone ?? "neutral"}
            style={{ color: row.tone && row.tone !== "neutral" ? TONE_TEXT[row.tone] : "var(--ink)" }}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
