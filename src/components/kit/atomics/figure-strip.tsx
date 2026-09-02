import type { ReactNode } from "react";

import { Surface } from "@/components/kit/atomics/surface";
import type { Tone } from "@/components/kit/atomics/tone";
import { Figure, MonoMeta, Overline } from "@/components/kit/atomics/type";
import { formatMetric, type MetricFormat } from "@/lib/format/metric";
import { cn } from "@/lib/utils";

export type FigureStripItem = {
  label: string;
  /**
   * `null` means the figure could not be read or nothing has been recorded, and it renders
   * `absent` in words instead. It never renders as zero: "no commission recorded yet" and "$0.00"
   * are different claims, and only one of them is usually true.
   */
  value: number | null;
  format?: MetricFormat;
  /**
   * A claim about the number, spent only when the number is non-zero. A tone on a zero says a
   * healthy figure is a problem -- an empty failure queue is the good case, not a clay one.
   */
  tone?: Tone;
  /** What to say when `value` is null. Required in spirit; the default is deliberately blunt. */
  absent?: string;
  note?: string;
};

/**
 * A row of figures a surface reports about itself.
 *
 * This is the managed strip doing what it is for: stating values SetterFi already has, rather than
 * offering controls. It exists because the alternative kept being a grid of KPI tiles, and four
 * tiles side by side is four cards sharing an interior -- the failure `docs/DESIGN.md` names in
 * "no two cards share an interior". A strip reads as one line about one thing, which is what a
 * queue depth or an earnings total actually is.
 *
 * Use it for two to four figures that belong to the same sentence. For a single figure a page is
 * opened for, use `Figure` directly.
 *
 * **It cannot express a measured zero, and that is the line between it and `StatStrip`.** Here
 * `null` means "no value to show" and renders `absent` in words, which collapses two different
 * claims: "this could not be read" and "this was read and the answer is genuinely none". On most
 * surfaces that collapse is harmless or actively right. On a ledger it is not -- `admin-money-
 * affiliates` has a band whose emptiness means the ledger was read and nothing is in that state,
 * a real zero that must print as `0` with its entry count beside it, and swapping that page onto
 * this component silently turned a measured zero into an absence. Its test caught it and the page
 * stayed on `StatStrip`.
 *
 * So: if the difference between "unreadable" and "measured none" matters on your surface, use
 * `StatStrip` and its availability arms. This component is for figures where it does not.
 */
export function FigureStrip({
  className,
  items,
  label,
}: {
  className?: string;
  items: readonly FigureStripItem[];
  label: string;
}) {
  return (
    <Surface
      aria-label={label}
      className={cn("flex flex-wrap gap-x-[var(--s-6)] gap-y-[var(--s-3)]", className)}
      data-slot="figure-strip"
      variant="strip"
    >
      {items.map((item) => (
        <div className="min-w-0" key={item.label}>
          <Overline className="block">{item.label}</Overline>
          {item.value === null ? (
            <MonoMeta className="mt-[var(--s-1)] block">
              {item.absent ?? "not readable right now"}
            </MonoMeta>
          ) : (
            <Figure
              className="mt-[var(--s-1)] block"
              size="md"
              tone={item.value > 0 ? (item.tone ?? "neutral") : "neutral"}
            >
              {formatMetric(item.value, item.format ?? "count")}
            </Figure>
          )}
          {item.note ? (
            <MonoMeta className="mt-[2px] block">{item.note}</MonoMeta>
          ) : null}
        </div>
      ))}
    </Surface>
  );
}

export type FigureStripProps = { items: readonly FigureStripItem[]; label: string; children?: ReactNode };
