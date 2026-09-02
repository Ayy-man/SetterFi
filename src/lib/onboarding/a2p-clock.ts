/**
 * The one A2P registration clock.
 *
 * Two surfaces counted the same carrier review from two different rows -- the
 * integrations card from the channel_connections row's creation time, the
 * go-live checklist from the A2P submission receipt -- so a coach could read
 * "day 3" on one screen and "day 11" on the other for one registration. The
 * carrier's clock starts when the filing is submitted, so submitted_at is the
 * only defensible origin, and it lives here so nothing can fork it again.
 */

export const A2P_DAY_MS = 86_400_000;

/**
 * The 1-based day of carrier review, or null when nothing has been filed or the
 * persisted timestamp is unreadable. Null means "we do not know", and callers
 * must say so rather than fall back to day 1 -- an invented counter is exactly
 * the fake-progress this product refuses to show.
 */
export function a2pRegistrationDay(
  submittedAt: string | null | undefined,
  now: number | Date,
): number | null {
  if (!submittedAt) return null;
  const submitted = Date.parse(submittedAt);
  if (!Number.isFinite(submitted)) return null;
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) return null;
  return Math.max(1, Math.floor((nowMs - submitted) / A2P_DAY_MS) + 1);
}

/** The counter as it reads on screen. Never a percentage, never a predicted date. */
export function a2pRegistrationLabel(day: number | null) {
  return day === null
    ? "Registering · carrier review takes 2–3 weeks"
    : `Registering · day ${day}`;
}

/** Past this, the review is running long enough to be worth a human look. */
export const A2P_STALL_DAYS = 21;
