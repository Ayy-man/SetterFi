import { describe, expect, it } from "vitest";

import {
  derivePricingHistory,
  type PricingVersionRow,
} from "./admin-money-pricing-history";

/**
 * The comparison that makes a price history mean anything.
 *
 * `tier_price_versions` records what a plan's terms were set TO and never what they were before,
 * so "What changed" is derived. There is exactly one way to derive it that looks right on the page
 * and is wrong: comparing each row against the plan's CURRENT values. That reads perfectly on the
 * newest row, and silently relabels every older row the next time somebody reprices -- a history
 * that rewrites itself, on the screen an operator opens to find out what was agreed and when.
 *
 * The other trap is the oldest row. It has nothing to be a change from, and manufacturing one
 * means printing a previous price that was never recorded anywhere.
 */

function version(overrides: Partial<PricingVersionRow> = {}): PricingVersionRow {
  return {
    id: "version-1",
    tierId: "tier-growth",
    priceCents: 24_900,
    callAllowance: 50,
    fairUseCap: 60,
    effectiveAt: "2026-03-01T12:00:00.000Z",
    actorId: "actor-1",
    reason: "launch pricing",
    auditId: 41,
    ...overrides,
  };
}

const NAMES = new Map([["tier-growth", "Growth"], ["tier-scale", "Scale"]]);
const ACTORS = new Map([["actor-1", "Alec Delpuech"]]);

function derive(versions: readonly PricingVersionRow[]) {
  return derivePricingHistory({ versions, tierNameById: NAMES, actorNameById: ACTORS });
}

describe("derivePricingHistory", () => {
  it("compares a version against the one it replaced, not against the plan's newest values", () => {
    const [newest, middle, oldest] = derive([
      version({ id: "v1", priceCents: 24_900, callAllowance: 50, effectiveAt: "2026-03-01T00:00:00.000Z" }),
      version({ id: "v2", priceCents: 29_900, callAllowance: 60, effectiveAt: "2026-06-01T00:00:00.000Z" }),
      version({ id: "v3", priceCents: 34_900, callAllowance: 60, effectiveAt: "2026-08-01T00:00:00.000Z" }),
    ]);

    expect(newest.id).toBe("v3");
    // Against v2, which is $299 -- not against v1's $249 and not against anything current.
    expect(newest.changed).toEqual(["$299 to $349 a month"]);
    expect(middle.changed).toEqual(["$249 to $299 a month", "Included calls 50 to 60"]);
    expect(oldest.changed).toBeNull();
  });

  it("keeps each plan's history to itself", () => {
    const entries = derive([
      version({ id: "growth-1", tierId: "tier-growth", priceCents: 24_900, effectiveAt: "2026-03-01T00:00:00.000Z" }),
      version({ id: "scale-1", tierId: "tier-scale", priceCents: 99_900, effectiveAt: "2026-04-01T00:00:00.000Z" }),
      version({ id: "growth-2", tierId: "tier-growth", priceCents: 29_900, effectiveAt: "2026-05-01T00:00:00.000Z" }),
    ]);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    // Scale's first version is Scale's origin even though a Growth row precedes it in time. A
    // comparison that walked the whole table in order would report "$249 to $999 a month" here.
    expect(byId.get("scale-1")?.changed).toBeNull();
    expect(byId.get("growth-2")?.changed).toEqual(["$249 to $299 a month"]);
    expect(byId.get("scale-1")?.tierName).toBe("Scale");
  });

  it("sorts by effective date itself rather than trusting the caller's order", () => {
    const entries = derive([
      version({ id: "v3", priceCents: 34_900, effectiveAt: "2026-08-01T00:00:00.000Z" }),
      version({ id: "v1", priceCents: 24_900, effectiveAt: "2026-03-01T00:00:00.000Z" }),
      version({ id: "v2", priceCents: 29_900, effectiveAt: "2026-06-01T00:00:00.000Z" }),
    ]);

    // Getting this wrong inverts every sentence on the page: "$349 to $299" for a price rise.
    expect(entries.map((entry) => entry.id)).toEqual(["v3", "v2", "v1"]);
    expect(entries[0].changed).toEqual(["$299 to $349 a month"]);
  });

  it("names a restatement rather than leaving the cell blank", () => {
    const [newest] = derive([
      version({ id: "v1", effectiveAt: "2026-03-01T00:00:00.000Z", reason: "launch pricing" }),
      version({ id: "v2", effectiveAt: "2026-06-01T00:00:00.000Z", reason: "re-approved after the audit" }),
    ]);

    // An append-only table can hold a version that moved none of the three values. An empty cell
    // there reads as a value that failed to load, which is a different fact.
    expect(newest.changed).toEqual(["Terms restated unchanged"]);
  });

  it("reports a fair-use cap appearing or disappearing rather than printing null", () => {
    const [newest] = derive([
      version({ id: "v1", fairUseCap: null, effectiveAt: "2026-03-01T00:00:00.000Z" }),
      version({ id: "v2", fairUseCap: 72, effectiveAt: "2026-06-01T00:00:00.000Z" }),
    ]);

    expect(newest.changed).toEqual(["Fair-use cap none to 72"]);
  });

  it("leaves an unresolvable name and an unlisted plan absent instead of inventing them", () => {
    const [entry] = derive([
      version({ id: "v1", tierId: "tier-retired", actorId: "actor-unknown" }),
    ]);

    // `actor_id` is NOT NULL, so the actor exists and only the lookup came back empty. An id
    // rendered where a person's name goes reads as a person.
    expect(entry.actorName).toBeNull();
    expect(entry.tierName).toBeNull();
    // The stored facts still come through untouched -- the audit id is what ties this row to the
    // entry that authorised it.
    expect(entry.auditId).toBe(41);
    expect(entry.reason).toBe("launch pricing");
  });
});
