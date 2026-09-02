"use client";

import type { ReactNode } from "react";

import { ConsoleDeck } from "@/components/kit/console-deck";
import { DeckPanel } from "@/components/kit/deck-panel";
import { figureText, type StatStripItem } from "@/components/kit/stat-strip";

/**
 * The console's four-figure strip, drawn as deck panels rather than as `StatStrip` tiles.
 *
 * `docs/REDESIGN-CANVAS.md` puts one card shape on every screen in the product, and this is that
 * shape at console scale: the header band carries the figure's name, the body carries the figure
 * itself in mono at `--console-figure`, and one sentence says what the figure is over. The
 * styling is entirely `src/app/(workspace)/admin/console.css` under `[data-shell-role="admin"]`,
 * which is why this component writes no sizes of its own -- the two densities are kept apart by
 * one stylesheet per route group, and a component that hard-codes `text-[30px]` breaks that.
 *
 * **It is the panel's anatomy at the tile's corner, and the two halves of that come from different
 * places.** The header band, the mono figure and the sentence are the deck panel's, which is what
 * "one card shape" means. The corner is not: `AdminAffiliates.dc.html:244` and
 * `AdminAgentPerformance.dc.html:241` draw the four-figure strip at `15px 15px 11px 11px` above
 * cards drawn at 24/24/17/17 on the same screen, because a 24px top corner on a 90px tile eats the
 * label sitting in it. This docstring used to say the strip was the panel shape at console scale
 * and stop there, while `console.css` said in its own comment that the KPI strip is the exception
 * at 15/11 and cited the canvas for it -- two rules about one strip, and the code drew the one the
 * canvas does not. The stylesheet now gives `[data-slot="console-stat-panel"]` the tile corner, so
 * the drawing decides it rather than whichever comment a reader found first.
 *
 * **It takes `StatStripItem`, deliberately.** The console screens already build their tiles as
 * `StatStripItem[]`, and every one of those items carries a `MetricAvailability` rather than a
 * bare number. That union is the honest-states rule in a type: a figure that could not be read
 * says so, a metric with no events yet is a real zero with a note, and a metric that needs more
 * history says how much more. Re-typing these panels around `{ label, value }` would have thrown
 * all of that away at the exact moment the panel got larger and louder, so the port reuses the
 * type instead of inventing a flatter one. `StatStrip` stays the coach-side and narrow-column
 * renderer of the same items; this is the console renderer.
 *
 * The drench is capped at one. `console.css` says why: a console screen already spends its
 * attention on a 246px rail, a topbar and a banded table, and a second saturated panel leaves the
 * reader nothing to rank against. `heroLabel` names the single item that may fill; passing a
 * label that matches nothing simply draws no hero rather than throwing, because a strip whose
 * figures all became unavailable should still render.
 */

export type ConsoleStatDeckProps = {
  items: readonly StatStripItem[];
  /**
   * The `label` of the one item that renders drenched. Optional: a strip with nothing worth
   * leading on spends no fill at all, which is the correct answer more often than not.
   */
  heroLabel?: string;
  ariaLabel: string;
  className?: string;
};

/**
 * What a panel shows where a figure would be when there is no figure.
 *
 * The words are `StatStrip`'s words, on purpose. Both components render the same
 * `StatStripItem[]`, so a metric that reads "not yet" in a narrow column must not read
 * "Unavailable" in a deck panel -- one state with two vocabularies is how a reader learns to
 * distrust both. The distinguishing information lives in the note, exactly as it does there: a
 * `needs-history` metric prints a day counter and the days still needed, never a percentage and
 * never a date we would be guessing at.
 *
 * `no-events` is the one absence that legitimately is a number. The window was measured and
 * nothing happened in it, so zero is the true reading and "not yet" would understate what we know.
 */
function absenceFigure(item: StatStripItem): { figure: ReactNode; note: string } | null {
  const { availability } = item;

  if (availability.kind === "value") return null;

  if (availability.kind === "no-events") {
    return { figure: "0", note: availability.note };
  }

  const note = availability.kind === "needs-history"
    ? `Day ${availability.days} of about ${availability.needs} needed.`
    : availability.kind === "not-connected"
      ? `${availability.source} is not connected, so there is nothing to count yet.`
      : availability.kind === "read-failed"
        ? "Couldn't read this metric. Nothing is being hidden and nothing has changed."
        : availability.note;

  return {
    /*
     * Body size rather than `--console-figure`. A 34px "not yet" is a headline claiming the gap is
     * the news, when the news is that the number is missing; the panel's name already says which
     * number that is.
     */
    figure: (
      <span
        className="text-[length:var(--t-body)] font-normal tracking-normal text-[color:var(--faint)]"
        data-state="not-yet"
      >
        not yet
      </span>
    ),
    note,
  };
}

export function ConsoleStatDeck({
  ariaLabel,
  className,
  heroLabel,
  items,
}: ConsoleStatDeckProps) {
  return (
    <ConsoleDeck ariaLabel={ariaLabel} className={className}>
      {items.map((item) => {
        const absent = absenceFigure(item);
        const figure = absent
          ? absent.figure
          : item.availability.kind === "value"
            ? figureText(
              item.availability.value,
              item.availability.format,
              item.precision,
            )
            : null;
        // `note` wins over the availability's own note so a tile still shows exactly one line,
        // which is the same precedence `StatStrip` documents for the same items.
        const sentence = item.note ?? absent?.note ?? null;

        return (
          <DeckPanel
            dataSlot="console-stat-panel"
            figure={figure ?? undefined}
            key={item.label}
            name={item.label}
            sentence={sentence ?? undefined}
            {...(heroLabel !== undefined && item.label === heroLabel
              ? { drench: "live" as const, hero: true }
              : {})}
          />
        );
      })}
    </ConsoleDeck>
  );
}
