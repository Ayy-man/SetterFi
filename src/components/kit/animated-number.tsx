"use client";

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

export type AnimatedNumberProps = {
  /** The already-formatted figure: "$1,240", "6.0%", "Day 12". Formatting is the caller's job. */
  children: string;
  className?: string;
  /**
   * Inline styles on the figure element. The `.t-*` type roles in `tokens.css` are unlayered, so
   * they beat every Tailwind utility whatever its specificity; a caller colouring a figure has to
   * do it here or watch the class be silently ignored.
   */
  style?: CSSProperties;
  /** Anything else on the element, e.g. `data-slot`. */
  [key: `data-${string}`]: string | undefined;
};

const DIGIT = /[0-9]/;

/**
 * How many digits get their own beat before the rest share the last one. At `--digit-stagger`
 * (70ms) five beats is a 280ms ramp, which is about as long as a stagger can run before the tail
 * of it reads as lag rather than rhythm. A seven-figure number would otherwise take 420ms to
 * finish arriving.
 */
const MAX_STAGGERED_DIGITS = 5;

/**
 * A figure whose digits re-enter when it changes.
 *
 * Only the digits move. A currency symbol, a comma, a percent sign, or a word like "Day" is not
 * the thing that changed, and animating it makes a small edit look like the whole tile reloaded --
 * so those characters render flat and the digits slide up out of a blur behind them, each one a
 * beat after the last.
 *
 * The replay is a keyed remount rather than the usual remove-reflow-re-add: React owns this
 * subtree, so putting the figure itself in each character's key is both the cheapest way to
 * restart the animation and the only one that cannot leave a stale class behind.
 *
 * `role="img"` is what makes the split safe. One element per character read literally becomes
 * "one, two, four, zero"; the role makes the children presentational and hands assistive tech the
 * whole figure as a single label instead. It also keeps the element's text content exactly the
 * figure -- there is no second, hidden copy for a test or a text search to trip over.
 *
 * Reduced motion needs nothing here: `--digit-dur`, `--digit-distance` and `--digit-blur` all
 * collapse in `globals.css`, so the digits are simply already in place.
 */
export function AnimatedNumber({ children, className, style: figureStyle, ...rest }: AnimatedNumberProps) {
  // The stagger counts digits, not characters, so "$1,240" steps 0,1,2,3 across its four digits
  // rather than skipping a beat on the "$" and the comma and arriving unevenly. Resolved up front
  // rather than with a counter mutated inside the map: the render has to be able to run twice and
  // produce the same delays.
  const characters: Array<{ character: string; digitIndex: number }> = [];
  let seen = 0;
  for (const character of children) {
    const isDigit = DIGIT.test(character);
    characters.push({
      character,
      digitIndex: isDigit ? Math.min(seen, MAX_STAGGERED_DIGITS - 1) : -1,
    });
    if (isDigit) seen += 1;
  }

  return (
    <span aria-label={children} className={className} role="img" style={figureStyle} {...rest}>
      {characters.map(({ character, digitIndex }, index) => {
        if (digitIndex < 0) {
          return <span key={`${children}:${index}`}>{character}</span>;
        }

        const style: CSSProperties = {
          animationDelay: `calc(var(--digit-stagger) * ${digitIndex})`,
        };

        return (
          <span
            className={cn(
              "inline-block [animation:kit-digit-in_var(--digit-dur)_var(--digit-ease)_both]",
              "motion-reduce:animate-none",
            )}
            key={`${children}:${index}`}
            style={style}
          >
            {character}
          </span>
        );
      })}
    </span>
  );
}
