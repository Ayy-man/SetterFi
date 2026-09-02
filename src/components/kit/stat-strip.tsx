"use client";

import type { ReactNode } from "react";

import { AnimatedNumber } from "@/components/kit/animated-number";
import { TONE_MARK, TONE_TEXT, type Tone } from "@/components/kit/atomics/tone";
import { Sparkline } from "@/components/kit/sparkline";
import { cn } from "@/lib/utils";
import { formatMetric } from "@/lib/format/metric";
import type {
  DataStateAction,
  HeadlineStatProps,
  MetricAvailability,
} from "@/components/kit/headline-stat";
import type { MetricFormat } from "@/lib/format/metric";

/**
 * A delta is a comparison against a previous window, and the two directions are both carried as
 * props: `direction` is which way the number moved, `goodDirection` is which way it is *supposed*
 * to move for this particular metric. Nothing is inferred from the metric's name or its sign --
 * a falling cost and a falling booking rate are the same arrow and opposite news, and only the
 * caller knows which is which. Because `goodDirection` is required, a `delta` is by definition a
 * real comparison, which is what earns it colour.
 */
export type StatStripDelta = NonNullable<HeadlineStatProps["delta"]> & {
  /** The window compared against, e.g. "vs prior 30 days". Rendered faint after the figure. */
  basis?: string;
};

export type StatStripItem = Pick<HeadlineStatProps, "label" | "action"> & {
  availability: MetricAvailability;
  delta?: StatStripDelta;
  /**
   * A muted line under the figure: the window it covers, the caveat it carries. Mostly for a
   * `value` metric, which is the one kind whose availability carries no note of its own; where a
   * kind supplies one, this replaces it, so a tile still shows exactly one note line.
   */
  note?: string;
  /**
   * Fraction digits for the figure, fixed. Without it a metric formats at its type's default (no
   * decimals for a count, at most one for a percent), so a tile could read 6% beside a table that
   * reads 6.0% for the same number. Ignored by the duration format, which picks its own unit.
   */
  precision?: number;
  /**
   * The series behind the figure, oldest first. Given this, the tile draws the kit's `Sparkline`
   * itself, so a caller does not have to know the chart theme to get a themed line.
   */
  points?: readonly number[];
  /** Optional inline trend, rendered under the figure. Wins over `points` when both are given. */
  sparkline?: ReactNode;
  /**
   * A claim about the figure, carried as a dot before the label and the figure's own colour: the
   * drawn strip spends amber on the one number that needs someone to act and leaves the other
   * three in `--ink`.
   *
   * Two rules the component enforces rather than trusting the caller with. It applies only to a
   * real reading -- an absence renders "not yet" in faint and a tone there would colour a number
   * that does not exist -- and only to a non-zero one, because an empty failure queue is the good
   * case and a clay zero says the opposite of what happened. Spend it on at most one tile: a strip
   * where every figure is coloured has stopped ranking anything.
   */
  tone?: Tone;
};

export type StatStripProps = {
  items: readonly StatStripItem[];
  ariaLabel?: string;
  className?: string;
};

/** Four tiles is the cap: past that, the strip stops being a glance and starts being a table. */
export const MAX_STAT_TILES = 4;

const ACTION_CLASS =
  "inline-flex items-center rounded-[var(--r-control)] text-[length:var(--t-mono-crumb)] font-medium text-[var(--accent-text)] underline-offset-[var(--s-1)] hover:underline";

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

/**
 * One anatomy for every tile, whatever the metric's availability: an 11px label, a mono figure
 * line, and at most one note under it. Four tiles side by side read as one row of figures rather
 * than four differently shaped cards.
 */
type TileParts = {
  figure?: ReactNode;
  note?: ReactNode;
  /** The read-failed tile is an alert, not a figure. */
  alert?: boolean;
};

/** The figure role: mono 22/500, ink, tabular. `.t-figure` carries all of it from `tokens.css`. */
const FIGURE_CLASS = "t-figure";

/**
 * The one thing a tile says when it has no number: "not yet", in italic faint, with the context on
 * the note line under it. Never a zero (which claims the thing was measured and came back empty),
 * never a percentage of a bar filling up, and never a predicted date -- the honest-states rule in
 * CLAUDE.md, rendered.
 */
const NOT_YET_CLASS = "text-[length:var(--t-mono-meta)] italic text-[var(--faint)]";

function NotYet() {
  return (
    <span className={NOT_YET_CLASS} data-slot="stat-strip-figure" data-state="not-yet">
      not yet
    </span>
  );
}

/**
 * The figure, at a fixed number of decimals when the tile asks for one. A stat and the table under
 * it should never render the same number to different precision.
 *
 * Exported because the console renders the same `StatStripItem[]` as deck panels
 * (`console-stat-deck.tsx`), and a second copy of this function is how "6%" here and "6.0%" there
 * gets into the product. One definition, two renderers.
 */
export function figureText(value: number, format: MetricFormat, precision?: number) {
  if (precision === undefined || format === "duration") return formatMetric(value, format);

  const digits = { maximumFractionDigits: precision, minimumFractionDigits: precision };
  if (format === "percent") {
    return new Intl.NumberFormat("en-US", { style: "percent", ...digits }).format(value / 100);
  }
  if (format === "money") {
    return new Intl.NumberFormat("en-US", { currency: "USD", style: "currency", ...digits })
      .format(value / 100);
  }
  return new Intl.NumberFormat("en-US", digits).format(value);
}

const NOTE_CLASS = "text-[length:var(--t-mono-crumb)] leading-[1.35] text-[var(--faint)]";

/**
 * The tone a tile is actually allowed to spend: a real reading, and a non-zero one. `null` for
 * every other case, which is what stops a colour from landing on an absence or on the zero that
 * means the queue is empty.
 */
function spentTone(item: StatStripItem): Tone | null {
  if (!item.tone || item.tone === "neutral") return null;
  if (item.availability.kind !== "value") return null;
  return item.availability.value === 0 ? null : item.tone;
}

function tileParts(item: StatStripItem): TileParts {
  const { availability } = item;
  const tone = spentTone(item);

  if (availability.kind === "value") {
    return {
      figure: (
        <AnimatedNumber
          className={FIGURE_CLASS}
          data-slot="stat-strip-figure"
          data-tone={tone ?? undefined}
          style={tone ? { color: TONE_TEXT[tone] } : undefined}
        >
          {figureText(availability.value, availability.format, item.precision)}
        </AnimatedNumber>
      ),
    };
  }

  // `no-events` is the one absence that legitimately *is* a number: the window was measured and
  // nothing happened in it, so zero is the true reading and "not yet" would understate what we
  // know. Every other kind below has no measurement at all and says so.
  if (availability.kind === "no-events") {
    return {
      figure: (
        <span className={FIGURE_CLASS} data-slot="stat-strip-figure">
          0
        </span>
      ),
      note: availability.note,
    };
  }

  if (availability.kind === "unavailable") {
    return { figure: <NotYet />, note: availability.note };
  }

  if (availability.kind === "needs-history") {
    // A day counter and the days still needed -- never a percentage of a progress bar and never a
    // date we would be guessing at.
    return {
      figure: <NotYet />,
      note: (
        <>
          <span data-slot="stat-strip-day-counter">
            day {formatMetric(availability.days, "count")}
          </span>
          <span>of about {formatMetric(availability.needs, "count")} needed</span>
        </>
      ),
    };
  }

  if (availability.kind === "not-connected") {
    return {
      figure: <NotYet />,
      note: (
        <>
          <span>{availability.source}</span>
          <ActionControl action={availability.action} />
        </>
      ),
    };
  }

  return {
    alert: true,
    figure: <NotYet />,
    note: (
      <>
        <span className="text-[var(--critical-text)]">Couldn&apos;t read this metric</span>
        <button className={ACTION_CLASS} onClick={availability.retry} type="button">
          Retry
        </button>
      </>
    ),
  };
}

/**
 * The delta, on its own line under the figure, in mono 11.
 *
 * The colour is driven entirely by the two props: `direction` against `goodDirection`. Only a
 * `value` tile gets one, because a metric with no reading has nothing to compare against, and
 * colouring an arrow beside "not yet" would be inventing a trend.
 */
function DeltaLine({ item }: { item: StatStripItem }) {
  const { availability, delta } = item;
  if (!delta || availability.kind !== "value") return null;

  const tone = delta.direction === delta.goodDirection ? "good" : "critical";
  const figure = figureText(Math.abs(delta.value), availability.format, item.precision);

  return (
    <p
      aria-label={`${delta.direction === "up" ? "Up" : "Down"} ${figure}${
        delta.basis ? ` ${delta.basis}` : ""
      }`}
      className={cn(
        "m-0 flex items-baseline gap-[var(--s-1)] font-[family-name:var(--font-mono)]",
        "text-[11px] leading-[1.3] tabular-nums",
        tone === "good" ? "text-[var(--good)]" : "text-[var(--critical-text)]",
      )}
      data-direction={delta.direction}
      data-slot="stat-strip-delta"
      data-tone={tone}
      // Every child is aria-hidden so an arrow glyph is not read out as punctuation; the role is
      // what makes the aria-label above the thing assistive tech actually announces.
      role="img"
    >
      <span aria-hidden>{delta.direction === "up" ? "↑" : "↓"}</span>
      <span aria-hidden>{figure}</span>
      {delta.basis ? (
        <span aria-hidden className="text-[var(--faint)]">
          {delta.basis}
        </span>
      ) : null}
    </p>
  );
}

/**
 * One strip, not four cards.
 *
 * The border, the radius and the card ground belong to the strip; the tiles inside it are divided
 * by a single 1px `--line` rule and carry no chrome of their own. Four bordered boxes in a row read
 * as four separate things the reader has to relate to each other; one strip reads as one row of
 * figures. The rules run vertically at `lg`, where the strip is a single row -- when it stacks
 * below that, the same hairline runs horizontally between the stacked tiles instead.
 *
 * **The strip is a block, not a wide table row.** A tile stands at 20/16 of padding around a 22px
 * figure, which puts it near 100px tall against the 36px `--d-row` of the table underneath -- close
 * to three rows to one tile. At the 16/12 it used to carry it stood at roughly two, and a summary
 * that reads as two rows of the thing it summarises is not a summary. The horizontal padding
 * clears a table cell's 12px by enough to be seen for the same reason: nothing about the strip
 * should line up with the grid below it.
 */
export function StatStrip({ items, ariaLabel = "Summary metrics", className }: StatStripProps) {
  if (process.env.NODE_ENV !== "production" && items.length > MAX_STAT_TILES) {
    console.warn(
      `StatStrip renders at most ${MAX_STAT_TILES} tiles by design; it was given ${items.length}. Move the rest into the table or a later tab.`,
    );
  }

  return (
    <dl
      aria-label={ariaLabel}
      className={cn(
        "m-0 grid grid-cols-1 overflow-hidden rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)]",
        "lg:grid-flow-col lg:auto-cols-fr",
        className,
      )}
      data-slot="stat-strip"
      data-tile-count={items.length}
    >
      {items.map((item) => {
        const parts = tileParts(item);
        const tone = spentTone(item);
        const note = item.note ?? parts.note;
        const sparkline = item.sparkline ?? (item.points
          ? <Sparkline label={`${item.label} trend`} points={item.points} />
          : null);

        return (
          <div
            className={cn(
              "flex min-w-0 flex-col gap-[var(--s-2)] px-[var(--s-5)] py-[var(--s-4)]",
              // The divider: one hairline between tiles, never around them.
              "border-t border-[var(--line)] first:border-t-0",
              "lg:border-t-0 lg:border-l lg:first:border-l-0",
            )}
            data-label={item.label}
            data-slot="stat-strip-tile"
            data-testid="stat-tile"
            key={item.label}
          >
            {/*
              The dot, not a tinted card and not an edge stripe: the drawn strip marks the tile
              that needs someone by a 5px mark beside its overline and leaves the tile's own face
              identical to its three neighbours. Flat -- the product spends its one glow elsewhere
              (see `TONE_GLOWS`). An untoned tile keeps the label text directly in the `dt`, which
              is the shape three surfaces reach for by walking up from the label to the tile.
            */}
            {tone ? (
              <dt
                className="t-label flex min-w-0 items-center gap-[var(--s-2)] whitespace-nowrap"
                data-slot="stat-strip-label"
                title={item.label}
              >
                <span
                  aria-hidden
                  className="size-[5px] shrink-0 rounded-[var(--r-full)]"
                  data-slot="stat-strip-tone-dot"
                  style={{ background: TONE_MARK[tone] }}
                />
                <span className="min-w-0 truncate">{item.label}</span>
              </dt>
            ) : (
              <dt
                className="t-label truncate whitespace-nowrap"
                data-slot="stat-strip-label"
                title={item.label}
              >
                {item.label}
              </dt>
            )}
            <dd className="m-0 flex min-w-0 flex-col gap-[var(--s-1)]">
              {parts.figure ? (
                <span className="flex min-w-0 items-baseline">{parts.figure}</span>
              ) : null}
              <DeltaLine item={item} />
              {note ? (
                <span
                  className={`flex flex-wrap items-baseline gap-[var(--s-2)] ${NOTE_CLASS}`}
                  data-slot="stat-strip-note"
                  role={parts.alert ? "alert" : undefined}
                >
                  {note}
                </span>
              ) : null}
              {item.action && item.availability.kind !== "not-connected" ? (
                <ActionControl action={item.action} />
              ) : null}
            </dd>
            {sparkline ? (
              <div className="mt-[var(--s-1)] min-w-0" data-slot="stat-strip-sparkline">
                {sparkline}
              </div>
            ) : null}
          </div>
        );
      })}
    </dl>
  );
}
