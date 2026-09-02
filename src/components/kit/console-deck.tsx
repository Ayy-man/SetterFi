import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The console's layout pieces for a deck of panels.
 *
 * Structure only -- every size, colour and hairline in here comes from
 * `src/app/(workspace)/admin/console.css`, which is scoped to `[data-shell-role="admin"]` and
 * loaded by the admin route group's layout. That is why these are three thin components rather
 * than three Tailwind class strings pasted onto seven screens: the console strip is drawn on
 * Revenue, Plans, Affiliates, Corrections, the Brain, Evals and Compliance, and seven lanes
 * retyping the same grid at slightly different gaps is the exact drift the 2026-08-30 craft audit
 * catalogued. One definition, seven callers.
 *
 * The panel itself is `src/components/kit/deck-panel.tsx`, unchanged and shared with the coach
 * side. These wrap it; they do not replace it.
 */

export type ConsoleDeckProps = {
  children: ReactNode;
  /**
   * `lead` is the two-column shape the canvas draws at the top of Revenue and the Brain: one wide
   * panel -- usually the screen's single drenched hero -- beside a narrower column. Omitted, the
   * deck auto-fits equal columns, which is what a four-figure strip wants.
   */
  variant?: "strip" | "lead";
  ariaLabel?: string;
  className?: string;
};

export function ConsoleDeck({ ariaLabel, children, className, variant = "strip" }: ConsoleDeckProps) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn("console-deck", variant === "lead" && "console-deck--lead", className)}
    >
      {children}
    </section>
  );
}

export type ConsoleRowProps = {
  /** A small square mark at the head of the row. Never the only carrier of a state -- see below. */
  mark?: ReactNode;
  name: ReactNode;
  /**
   * One sentence saying what is actually wrong or true, in words.
   *
   * Required, and that is the Never-Colour-Alone rule rendered: a red mark beside a business name
   * tells a reader that something is wrong and not which thing, and these rows are the list an
   * admin works from. "All Stripe retries exhausted" and "Automation off 52h" are the same colour
   * and completely different jobs.
   */
  sentence: ReactNode;
  /**
   * The figure or state at the end of the row, if the row has one.
   *
   * It gives before the name does. A `shrink-0` trailing element sharing a line with a truncating
   * label eats the label as soon as the column narrows -- the coach inbox rendered every lead name
   * as "Jo..." that way -- and on these rows the name is the identity a reader is scanning for
   * while the trailing figure is metadata about it. So the trailing track is `minmax(0, auto)`
   * rather than `auto`, and the trailing span truncates rather than holding its width.
   */
  trailing?: ReactNode;
  className?: string;
};

export function ConsoleRow({ className, mark, name, sentence, trailing }: ConsoleRowProps) {
  return (
    <div className={cn("console-row", className)}>
      <span className="console-row__mark">{mark}</span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] text-[color:var(--ink)]">{name}</span>
        <span className="block text-[11.5px] leading-[1.4] text-[color:var(--muted)]">{sentence}</span>
      </span>
      <span className="min-w-0 truncate text-right">{trailing}</span>
    </div>
  );
}

export type ConsoleSubstatItem = {
  label: string;
  value: ReactNode;
};

/**
 * The row of small figures under a hero's hairline.
 *
 * Three at most in practice. It is a footer widget, so it is passed to `DeckPanel`'s `footer`
 * slot and lands on `margin-top: auto`, which keeps it on the same line as the footers of the
 * panels beside it however much copy sits above.
 */
export function ConsoleSubstat({ items }: { items: readonly ConsoleSubstatItem[] }) {
  return (
    <div className="console-substat">
      {items.map((item) => (
        <span key={item.label}>
          <strong className="console-substat__figure">{item.value}</strong>
          <i className="console-substat__label">{item.label}</i>
        </span>
      ))}
    </div>
  );
}
