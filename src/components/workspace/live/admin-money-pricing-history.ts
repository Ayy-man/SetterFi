/**
 * What each row of `public.tier_price_versions` actually changed.
 *
 * The table is append-only and records what a plan's terms were SET TO, never what they were
 * before. The canvas's "What changed" column is therefore derived, and the derivation has exactly
 * one way to be wrong that still looks right: comparing a row against the plan's CURRENT values
 * instead of against the version it replaced. That reads correctly on the newest row and relabels
 * every older row the next time somebody reprices, which is a history that rewrites itself.
 *
 * So the comparison walks each plan's own versions in time order and compares against the previous
 * version OF THAT PLAN. The oldest version of a plan gets `null` rather than a manufactured change:
 * there is no earlier price recorded anywhere, and printing one would be inventing a figure.
 *
 * Pure, and separate from the surface for that reason -- the rule is worth testing without
 * rendering a table.
 */

export type PricingVersionRow = {
  id: string;
  tierId: string;
  priceCents: number;
  callAllowance: number;
  fairUseCap: number | null;
  effectiveAt: string;
  actorId: string;
  reason: string;
  auditId: number;
};

export type PricingHistoryEntry = {
  id: string;
  tierId: string;
  tierName: string | null;
  priceCents: number;
  callAllowance: number;
  fairUseCap: number | null;
  effectiveAt: string;
  /** Resolved from `users`; null when the row's actor could not be named, never invented. */
  actorName: string | null;
  reason: string;
  auditId: number;
  /**
   * What this version changed against the previous version of the same plan, or null when this is
   * the oldest recorded version of it.
   */
  changed: readonly string[] | null;
};

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function cap(value: number | null) {
  return value === null ? "none" : String(value);
}

/**
 * Newest-first entries for the surface. `versions` may arrive in any order; the comparison sorts
 * by `effective_at` itself rather than trusting the caller's query, because getting that wrong
 * inverts every change sentence on the page.
 */
export function derivePricingHistory(input: {
  versions: readonly PricingVersionRow[];
  tierNameById: ReadonlyMap<string, string>;
  actorNameById: ReadonlyMap<string, string>;
}): PricingHistoryEntry[] {
  const { versions, tierNameById, actorNameById } = input;
  const oldestFirst = [...versions].sort((left, right) =>
    left.effectiveAt === right.effectiveAt
      ? left.id.localeCompare(right.id)
      : left.effectiveAt.localeCompare(right.effectiveAt));

  const previousByTier = new Map<string, PricingVersionRow>();
  const changedById = new Map<string, string[] | null>();
  for (const row of oldestFirst) {
    const previous = previousByTier.get(row.tierId);
    if (!previous) {
      changedById.set(row.id, null);
    } else {
      const changed: string[] = [];
      if (previous.priceCents !== row.priceCents) {
        changed.push(`${money(previous.priceCents)} to ${money(row.priceCents)} a month`);
      }
      if (previous.callAllowance !== row.callAllowance) {
        changed.push(`Included calls ${previous.callAllowance} to ${row.callAllowance}`);
      }
      if (previous.fairUseCap !== row.fairUseCap) {
        changed.push(`Fair-use cap ${cap(previous.fairUseCap)} to ${cap(row.fairUseCap)}`);
      }
      // An append-only table can hold a version that moved none of the three -- a restatement with
      // a new reason. Saying so beats an empty cell, which reads as a value that failed to load.
      changedById.set(row.id, changed.length > 0 ? changed : ["Terms restated unchanged"]);
    }
    previousByTier.set(row.tierId, row);
  }

  return [...oldestFirst].reverse().map((row) => ({
    id: row.id,
    tierId: row.tierId,
    tierName: tierNameById.get(row.tierId) ?? null,
    priceCents: row.priceCents,
    callAllowance: row.callAllowance,
    fairUseCap: row.fairUseCap,
    effectiveAt: row.effectiveAt,
    actorName: actorNameById.get(row.actorId) ?? null,
    reason: row.reason,
    auditId: row.auditId,
    changed: changedById.get(row.id) ?? null,
  }));
}
