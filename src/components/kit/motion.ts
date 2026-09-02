"use client";

import type { Transition } from "motion/react";

/**
 * The motion scale lives in `tokens.css` as CSS custom properties, which covers everything that
 * animates in CSS. Motion's layout animations cannot read a custom property -- they need numbers
 * -- so this is the one place the scale is restated in JS. Keep it in step with `tokens.css`.
 */

/** `--tabs-dur`, in seconds. */
const INDICATOR_DURATION_S = 0.25;

/** `--ease-smooth-out`, as control points. */
const EASE_SMOOTH_OUT = [0.22, 1, 0.36, 1] as const;

/**
 * The travel of an indicator that follows the current thing: the tab pill, the view-switch rule,
 * the sidebar's active wash. All three read as the same object moving, so all three move on the
 * same clock as the CSS-driven tab indicator -- a spring on one of them and a tween on the next
 * would make two identical gestures feel like different components.
 *
 * A tween rather than a spring for the same reason the scale prefers `--ease-smooth-out` on a
 * position change: an indicator that overshoots its target draws attention to itself instead of
 * to the thing it is marking.
 */
export const INDICATOR_TRANSITION: Transition = {
  duration: INDICATOR_DURATION_S,
  ease: [...EASE_SMOOTH_OUT],
  type: "tween",
};

/** Reduced motion means the indicator is simply already where it belongs. */
export const INDICATOR_TRANSITION_REDUCED: Transition = { duration: 0 };

export function indicatorTransition(reduced: boolean | null): Transition {
  return reduced ? INDICATOR_TRANSITION_REDUCED : INDICATOR_TRANSITION;
}
