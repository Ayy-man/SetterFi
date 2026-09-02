/**
 * The two attention-queue formatters the screen needs, kept apart from the queue loader.
 *
 * `attention-queue.ts` reaches Postgres through `createSupabaseServiceClient`, which imports
 * `next/headers`, and `admin-attention.tsx` is a client component. Importing a value out of that
 * module — rather than a type, which the compiler erases — puts the server client in the browser
 * graph and fails the production build with "You're importing a module that depends on
 * next/headers". Types cross that boundary freely; functions do not, so the functions live here.
 */

import type { AttentionItem } from "@/lib/operations/attention-queue";

/**
 * "41m", "4h 10m", "2d 3h", "6d". The units the artifact sets, and never a percentage or a
 * predicted date. Days drop their hours past a week, where an extra "4h" is noise.
 */
export function formatElapsed(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  if (hours < 24) {
    const remainder = total % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder === 0 || days >= 7 ? `${days}d` : `${days}d ${remainder}h`;
}

/**
 * The clock a queue row wears. A row with a response target reads how long is left, or how far
 * past it already is; a row without one reads how long it has been open, in the same words the
 * summary uses, so the two cannot be confused for each other.
 */
export function formatQueueClock(item: Pick<AttentionItem, "minutesToBreach" | "openForMinutes">): string {
  if (item.minutesToBreach === null) return `open ${formatElapsed(item.openForMinutes)}`;
  return item.minutesToBreach < 0
    ? `${formatElapsed(-item.minutesToBreach)} over`
    : formatElapsed(item.minutesToBreach);
}
