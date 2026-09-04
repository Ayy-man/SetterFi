/**
 * Platform-owned cadence timing and default purposes.
 *
 * Timing stays in code because changing consumer-message frequency requires the
 * review and test trail of a deploy. Coaches may replace only the typed purpose
 * attached to the fixed touch position.
 */

import type { OfferCadencePurpose } from "@/lib/offer/types";

export type DurableTouch = Readonly<{
  touchNo: number;
  offsetMs: number;
  purpose: OfferCadencePurpose;
}>;

export type WindowBoundTouch = Readonly<{
  touchNo: number;
  beforeWindowCloseMs: number;
  purpose: OfferCadencePurpose;
}>;

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export const DURABLE_TOUCHES: readonly DurableTouch[] = Object.freeze([
  Object.freeze({ touchNo: 1, offsetMs: 2 * HOUR_MS, purpose: "lead_magnet" }),
  Object.freeze({ touchNo: 2, offsetMs: DAY_MS, purpose: "value_nudge" }),
  Object.freeze({ touchNo: 3, offsetMs: 3 * DAY_MS, purpose: "proof_point" }),
  Object.freeze({ touchNo: 4, offsetMs: 7 * DAY_MS, purpose: "new_angle" }),
  Object.freeze({ touchNo: 5, offsetMs: 14 * DAY_MS, purpose: "last_touch" }),
]);

export const WINDOW_BOUND_TOUCHES: readonly WindowBoundTouch[] = Object.freeze([
  Object.freeze({ touchNo: 1, beforeWindowCloseMs: 22 * HOUR_MS, purpose: "lead_magnet" }),
  Object.freeze({ touchNo: 2, beforeWindowCloseMs: 4 * HOUR_MS, purpose: "last_touch" }),
]);

/** How many of the platform's touches still send, given the coach's purpose rows. */
export function cadenceTouchSummary(
  rows: readonly { channelClass: "durable" | "window_bound" | "none"; purpose: OfferCadencePurpose }[],
): { sending: number; total: number } {
  const total = DURABLE_TOUCHES.length + WINDOW_BOUND_TOUCHES.length;
  const off = rows.filter((row) =>
    row.purpose === "none" && (row.channelClass === "durable" || row.channelClass === "window_bound"),
  ).length;
  return { sending: Math.max(0, total - off), total };
}
