import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEMO_TIER_LADDER, RETIRED_DEMO_TIER_IDS } from "../../../scripts/fixtures/names.mjs";

/**
 * The seeded plan ladder is the client's price list, so it is checked against the client.
 *
 * It was not, and the numbers drifted the whole way: the seed shipped $197 / $497 / $997 / $1,497 /
 * $2,497, chosen only so three seeders could take one rung each without rendering duplicate names,
 * while `docs/INTAKE.md:53-57` records Alec answering the pricing questions himself -- "297/mo upto
 * 25 calls/m", "597/m upto 75 calls/m", "997 beyond that". One of the invented rungs priced the
 * client's own 25-call tier at $497 instead of $297, on a screen a coach reads.
 *
 * This reads the intake rather than restating it, because a test that restated the three prices
 * would be a third copy agreeing with the second, and the whole failure mode here is a number
 * nobody checked against the source. `docs/INTAKE.md` is described in `CLAUDE.md` as the client's
 * intake "reproduced verbatim" and "ground truth for client intent", which is what makes it the
 * thing worth parsing.
 */

const INTAKE = join(process.cwd(), "docs/INTAKE.md");

type Rung = {
  id: string;
  name: string;
  priceCents: number;
  callAllowance: number;
  fairUseCap: number | null;
  isUncapped: boolean;
};

const ladder = DEMO_TIER_LADDER as readonly Rung[];

/**
 * The intake is prose a human typed into a form -- "297/mo upto 25 calls/m" -- so this pulls the
 * dollar figures out of the two pricing answers and nothing else. Anchored on the two question
 * headings rather than scanning the file, because the document is long and a bare three-digit
 * number appears elsewhere in it.
 */
function intakePricing(): { dollars: number[]; calls: number[] } {
  const source = readFileSync(INTAKE, "utf8");
  const start = source.indexOf("## Pricing and billing");
  const end = source.indexOf("\n## ", start + 1);
  expect(start, "docs/INTAKE.md no longer has a Pricing and billing section").toBeGreaterThan(-1);
  const section = source.slice(start, end === -1 ? undefined : end);
  return {
    // Every three-digit figure in the section is a dollar amount; the call counts are two-digit and
    // always carry the word. The top tier is written "997 beyond that" with no "/m" after it, which
    // is why this does not key on the rate suffix.
    dollars: [...section.matchAll(/\b(\d{3})\b/gu)].map((match) => Number(match[1])),
    calls: [...section.matchAll(/(\d+)\s*calls/gu)].map((match) => Number(match[1])),
  };
}

describe("the seeded plan ladder is the client's contracted price list", () => {
  it("renames only the contract ladder without rewriting prices or allowances", () => {
    const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261014000001_contract_tier_names.sql"), "utf8");
    expect(migration).toContain("set name = names.name");
    expect(migration).toContain("tier.id = names.id and tier.name = names.old_name");
    for (const rung of ladder) expect(migration).toContain(rung.id);
    expect(migration).not.toMatch(/\b(?:price_cents|call_allowance|fair_use_cap|stripe_price_id|active)\s*=/u);
    expect(migration).not.toContain(RETIRED_DEMO_TIER_IDS.gaps);
    expect(migration).not.toContain(RETIRED_DEMO_TIER_IDS.phase5);
  });

  it("prices every rung at what the client's own intake says", () => {
    const { dollars } = intakePricing();

    expect(dollars).toEqual([297, 597, 997]);
    expect(ladder.map((rung) => rung.priceCents)).toEqual(dollars.map((amount) => amount * 100));
  });

  it("carries the two call ceilings the intake names, and no others", () => {
    const { calls } = intakePricing();

    expect(calls).toEqual([25, 75]);
    // The third rung is "997 beyond that", so its threshold is the second rung's ceiling and it
    // states no ceiling of its own -- which is what `isUncapped` records.
    expect(ladder.map((rung) => rung.callAllowance)).toEqual([25, 75, 75]);
  });

  /**
   * The rung count is the finding, not a tidiness rule. A fourth priced row on Plans and pricing is
   * the product quoting a coach a price the client never agreed to sell, which is exactly how the
   * $497 rung came to exist.
   */
  it("holds exactly the three tiers the client sells", () => {
    expect(ladder).toHaveLength(3);
    expect(ladder.map((rung) => rung.name)).toEqual([
      "Starter",
      "Growth",
      "Scale",
    ]);
    expect(ladder.every((rung) => !rung.name.endsWith("(demo)"))).toBe(true);
  });

  /**
   * `tiers.call_allowance` stays `int NOT NULL`, so the top rung's number is the threshold it
   * begins at and `isUncapped` is the separate fact that nothing happens past it. A fair-use cap on
   * that rung would be a ceiling under another name, and its absence on a capped rung would sell an
   * unlimited plan at a capped price.
   */
  it("marks exactly the unbounded rung uncapped, and gives only that one no fair-use cap", () => {
    expect(ladder.map((rung) => rung.isUncapped)).toEqual([false, false, true]);
    expect(ladder.map((rung) => rung.fairUseCap === null)).toEqual([false, false, true]);
  });

  /**
   * Three seeders converge on these three ids so the five rows they used to write collapse to the
   * three tiers that exist. The two retired ids must stay out of the ladder: a seeder deactivating
   * an id the ladder still writes would turn its own plan off.
   */
  it("keeps the retired seeder ids out of the ladder it deactivates them against", () => {
    const ids = new Set(ladder.map((rung) => rung.id));

    expect(ids.size).toBe(3);
    expect(ids.has(RETIRED_DEMO_TIER_IDS.phase5)).toBe(false);
    expect(ids.has(RETIRED_DEMO_TIER_IDS.gaps)).toBe(false);
  });
});

/**
 * The ladder is only half the fix. Every money row a screen renders has to be a figure from it,
 * because a coach reading $597 on Plans and pricing and a $180 affiliate commission on the same
 * subscription has been shown two different products.
 *
 * These read the seeders rather than restating the numbers, for the same reason the block above
 * reads the intake: a test that restated them would be another copy agreeing with the last one.
 */
describe("every seeded money row is priced from the ladder", () => {
  it("invoices each referred business at the rung it is signed up to", async () => {
    const seeder = await import("../../../scripts/seed-demo-gaps.mjs");
    const rung = ladder[1]!;
    const fixtures = seeder.referredBusinessFixtures() as Array<{ invoiceCents: number[] }>;

    expect(fixtures.every((fixture) => fixture.invoiceCents.length > 0)).toBe(true);
    expect(fixtures.flatMap((fixture) => fixture.invoiceCents)
      .every((cents) => cents === rung.priceCents)).toBe(true);
    // The portfolio still varies, by paid months rather than by invented prices.
    expect(new Set(fixtures.map((fixture) => fixture.invoiceCents.length)).size)
      .toBeGreaterThan(1);
  });

  /**
   * The affiliate surface used to be handed `DEMO_GAPS_IDS.tier`, the rung this seeder minted
   * before the ladder collapsed. `ensureTier` deactivates that id, so on a fresh database it named
   * no row and `signup_intents_tier_id_fkey` aborted the whole gaps seed at the first referral.
   */
  it("signs referred businesses up to the tier the billing surface actually wrote", () => {
    const seed = readFileSync(join(process.cwd(), "scripts/seed-demo-gaps.mjs"), "utf8");

    expect(seed).toContain("seedAffiliateSurface(client, now, billing.tierId)");
    expect(seed).not.toContain("seedAffiliateSurface(client, now, DEMO_GAPS_IDS.tier)");
  });

  it("recognises the same subscription price as revenue in the cost evidence", () => {
    const review = readFileSync(join(process.cwd(), "scripts/seed-platform-review-data.mjs"), "utf8");
    const phase6 = readFileSync(join(process.cwd(), "scripts/seed-phase6-demo.mjs"), "utf8");

    expect(review).toContain("const REVIEW_SUBSCRIPTION_CENTS = DEMO_TIER_LADDER[1].priceCents;");
    // Three rollups, all recognising that one figure; the spread lives in the costs.
    expect(review.match(/revenueCents: REVIEW_SUBSCRIPTION_CENTS,/gu)).toHaveLength(3);
    expect(review).not.toMatch(/revenueCents: \d/u);
    // The money tenant's paid month is its own rung, and its unpaid one stays at zero.
    expect(phase6).toContain("DEMO_TIER_LADDER[0].priceCents, DEMO_TIER_LADDER[0].priceCents,");
    expect(phase6).toContain("revenueCents: DEMO_TIER_LADDER[0].priceCents,");
    expect(phase6).toContain("revenueCents: 0, modelCents: 10,");
  });
  /**
   * A subscription's tier is resolved by matching `tiers.stripe_price_id`
   * (`src/lib/billing/allowances.ts`), so a seeded subscription carrying a price id no tier row
   * holds is a tenant the platform cannot price. The suspended demo tenant carried exactly that,
   * an invented `..._SUSPENDED_PRICE`, and the allowance job logged a failed read and skipped it
   * on every run. Suspension is `tenants.status`, never a price.
   *
   * Every price id a seeder writes is derived from a rung, so this checks for the one thing that
   * can reintroduce the defect: a price id spelled out by hand.
   */
  it("never writes a subscription price id that no rung derives", () => {
    const seeders = ["scripts/seed-phase6-demo.mjs", "scripts/seed-demo-gaps.mjs"];
    const invented = /"SETTERFI_DEMO_PLACEHOLDER_(?:SUSPENDED_)?PRICE[^"]*"/gu;

    for (const path of seeders) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      const literals = [...source.matchAll(invented)]
        // The prefix constant and the sentinel guard that releases stale ids are the definition
        // and its check, not a subscription being written to a price.
        .map((match) => match[0])
        .filter((literal) => literal !== '"SETTERFI_DEMO_PLACEHOLDER_PRICE_"');
      expect(literals, `${path} spells out a price id instead of deriving it`).toEqual([]);
    }
  });
});

/**
 * Reseeding a database that already holds an older ladder is the whole point of these seeders on
 * hosted, and it used to abort. `apply_billing_subscription_snapshot` rejects two different
 * snapshots stamped the same instant with STRIPE_SUBSCRIPTION_TIMESTAMP_COLLISION, which is right
 * for a provider webhook, and the seeder wrote one hard-coded stamp. Production held the old price
 * under that stamp, so the reseed that was supposed to correct it stopped there instead.
 */
describe("the subscription snapshot stamp advances only when the snapshot changed", () => {
  const desired = {
    priceId: "SETTERFI_DEMO_PLACEHOLDER_PRICE_STARTER",
    status: "active",
    periodStart: "2026-08-01T00:00:00Z",
    periodEnd: "2026-09-01T00:00:00Z",
    cancelAtPeriodEnd: false,
  };
  const FIXED = "2026-08-01T00:00:01Z";
  const stored = (overrides: Record<string, unknown>) => ({
    query: async () => ({
      rows: [{
        stripe_price_id: desired.priceId,
        status: desired.status,
        current_period_start: new Date(desired.periodStart),
        current_period_end: new Date(desired.periodEnd),
        cancel_at_period_end: desired.cancelAtPeriodEnd,
        provider_updated_at: new Date(FIXED),
        ...overrides,
      }],
    }),
  });

  it("writes the fixed stamp when there is no subscription yet", async () => {
    const { snapshotStampFor } = await import("../../../scripts/seed-phase6-demo.mjs");
    const empty = { query: async () => ({ rows: [] }) };

    expect(await snapshotStampFor(empty, "t", desired, FIXED)).toBe(FIXED);
  });

  it("advances past the stored stamp when the price changed", async () => {
    const { snapshotStampFor } = await import("../../../scripts/seed-phase6-demo.mjs");
    const database = stored({ stripe_price_id: "SETTERFI_DEMO_PLACEHOLDER_SUSPENDED_PRICE" });

    expect(await snapshotStampFor(database, "t", desired, FIXED))
      .toBe("2026-08-01T00:00:02.000Z");
  });

  it("advances past a stamp already later than the fixed one", async () => {
    const { snapshotStampFor } = await import("../../../scripts/seed-phase6-demo.mjs");
    const database = stored({
      stripe_price_id: "SETTERFI_DEMO_PLACEHOLDER_SUSPENDED_PRICE",
      provider_updated_at: new Date("2026-08-25T00:00:00Z"),
    });

    expect(await snapshotStampFor(database, "t", desired, FIXED))
      .toBe("2026-08-25T00:00:01.000Z");
  });

  /**
   * The rerun case. Restating an agreeing snapshot under the fixed stamp is a stale snapshot the
   * moment an earlier run advanced it, so the seeder would fail on its own output.
   */
  it("restates an unchanged snapshot under the stamp it already carries", async () => {
    const { snapshotStampFor } = await import("../../../scripts/seed-phase6-demo.mjs");
    const database = stored({ provider_updated_at: new Date("2026-08-01T00:00:02Z") });

    expect(await snapshotStampFor(database, "t", desired, FIXED))
      .toBe("2026-08-01T00:00:02.000Z");
  });
});

/**
 * A cost rollup is the one record here with no correction path. Its window is unique per tenant,
 * `write_tenant_cost_rollup` raises COST_ROLLUP_REPLAY_MISMATCH on a differing replay, and the
 * append-only trigger refuses every update and delete, cascade included. A month computes once.
 *
 * The seeders write a rung's price into that record, so reseeding a database holding an older
 * ladder used to abort: the seeder was asking to restate a closed month, which nothing in the
 * product can do. It now asks before writing.
 */
describe("a cost rollup is written once and never restated", () => {
  const rollup = {
    tenantId: "t", windowStart: "2026-07-01T00:00:00Z", windowEnd: "2026-08-01T00:00:00Z",
    revenueCents: 29_700, modelCents: 7_300, messagingCents: 2_800, embeddingCents: 600,
    missingSources: [], evidence: "SETTERFI_DEMO_PLACEHOLDER_COMPLETE",
  };
  const row = (overrides: Record<string, unknown>) => ({
    recognized_subscription_cents: 29_700, model_cents: 7_300, messaging_cents: 2_800,
    embedding_cents: 600, missing_sources: [],
    source_evidence: { source: "SETTERFI_DEMO_PLACEHOLDER_COMPLETE" },
    ...overrides,
  });
  const database = (rows: Record<string, unknown>[]) => {
    const calls: string[] = [];
    return {
      calls,
      query: async (text: string) => {
        calls.push(text);
        return { rows: text.includes("write_tenant_cost_rollup") ? [] : rows };
      },
    };
  };

  it("writes a window nothing has computed yet", async () => {
    const { writeCostRollupOnce } = await import("../../../scripts/seed-phase6-demo.mjs");
    const empty = database([]);

    expect(await writeCostRollupOnce(empty, rollup)).toBe("written");
    expect(empty.calls[1]).toContain("write_tenant_cost_rollup");
  });

  it("never writes over a window that already holds a computed month", async () => {
    const { writeCostRollupOnce } = await import("../../../scripts/seed-phase6-demo.mjs");
    const held = database([row({ recognized_subscription_cents: 19_700 })]);

    expect(await writeCostRollupOnce(held, rollup)).toBe("present");
    expect(held.calls).toHaveLength(1);
  });

  it("passes a window holding exactly these figures", async () => {
    const { verifyCostRollups } = await import("../../../scripts/seed-phase6-demo.mjs");

    expect(await verifyCostRollups(database([row({})]), [rollup])).toEqual([]);
  });

  /**
   * The production case: the old ladder's $197 sits in a closed month the seeder can neither
   * rewrite nor delete. Reporting a successful reseed there leaves the admin margin figures wrong,
   * so it is a mismatch and it is named.
   */
  it("catches a month left at the old price", async () => {
    const { verifyCostRollups } = await import("../../../scripts/seed-phase6-demo.mjs");
    const stale = await verifyCostRollups(
      database([row({ recognized_subscription_cents: 19_700 })]), [rollup],
    );

    expect(stale).toHaveLength(1);
    expect(stale[0].stored?.recognized_subscription_cents).toBe(19_700);
    expect(stale[0].expected.recognized_subscription_cents).toBe(29_700);
  });

  /** Amounts are not the only way a month can be wrong, so all six columns are judged. */
  it("catches a month whose evidence or missing sources disagree", async () => {
    const { verifyCostRollups } = await import("../../../scripts/seed-phase6-demo.mjs");

    expect(await verifyCostRollups(
      database([row({ source_evidence: { source: "SOMETHING_ELSE" } })]), [rollup],
    )).toHaveLength(1);
    expect(await verifyCostRollups(
      database([row({ missing_sources: ["model"] })]), [rollup],
    )).toHaveLength(1);
  });

  it("catches a window with no rollup at all", async () => {
    const { verifyCostRollups } = await import("../../../scripts/seed-phase6-demo.mjs");
    const stale = await verifyCostRollups(database([]), [rollup]);

    expect(stale).toHaveLength(1);
    expect(stale[0].stored).toBeNull();
  });
});

/**
 * A month the seeder could not correct has to stop the reseed. Returning quietly let a hosted
 * database carrying the old tier price report a successful reseed while the admin margin figures
 * stayed wrong, which is worse than failing.
 */
describe("a stale cost month fails the reseed unless it is acknowledged", () => {
  const stale = [{
    rollup: {
      tenantId: "8f000000-0000-4000-8000-000000000001",
      windowStart: "2026-07-01T00:00:00Z", windowEnd: "2026-08-01T00:00:00Z",
    },
    stored: { recognized_subscription_cents: 19_700 },
    expected: { recognized_subscription_cents: 29_700 },
  }];

  it("passes silently when every month is current", async () => {
    const { assertCostRollupsCurrent } = await import("../../../scripts/seed-phase6-demo.mjs");

    expect(assertCostRollupsCurrent([], [], "CODE")).toBe(0);
  });

  it("throws by default, naming the tenant, the period and both figures", async () => {
    const { assertCostRollupsCurrent } = await import("../../../scripts/seed-phase6-demo.mjs");

    try {
      assertCostRollupsCurrent(stale, [], "PHASE6_DEMO_COST_ROLLUP_STALE");
      expect.unreachable("a stale month has to stop the reseed");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("PHASE6_DEMO_COST_ROLLUP_STALE");
      expect(message).toContain("8f000000-0000-4000-8000-000000000001");
      expect(message).toContain("2026-07-01T00:00:00Z to 2026-08-01T00:00:00Z");
      expect(message).toContain("19700");
      expect(message).toContain("29700");
    }
  });

  /** The flag is a decision to live with those months, so it has to print them in full. */
  it("downgrades to a printed list under the acknowledgement flag", async () => {
    const { ACKNOWLEDGE_STALE_ROLLUPS, assertCostRollupsCurrent } =
      await import("../../../scripts/seed-phase6-demo.mjs");
    const warned: string[] = [];
    const restore = console.warn;
    console.warn = (message: string) => { warned.push(message); };

    try {
      expect(assertCostRollupsCurrent(stale, [ACKNOWLEDGE_STALE_ROLLUPS], "CODE")).toBe(1);
    } finally {
      console.warn = restore;
    }
    expect(warned.join("\n")).toContain("19700");
    expect(warned.join("\n")).toContain("29700");
  });

  /**
   * The flag must not become a way past anything else. The read-back equality is asserted before
   * the flag is ever consulted, so a count that drifted still fails with the flag set.
   */
  it("is consulted only after the read-back equality has already been asserted", () => {
    const seed = readFileSync(join(process.cwd(), "scripts/seed-phase6-demo.mjs"), "utf8");

    expect(seed.indexOf("PHASE6_DEMO_READBACK_INVALID"))
      .toBeLessThan(seed.indexOf("assertCostRollupsCurrent(\n"));
  });

  /**
   * And it is judged before the transaction commits. A stale month that is not acknowledged has
   * to roll back the tiers, tenants and subscriptions written above it, otherwise a failed exit
   * leaves half a reseed committed and the retry starts from a state no run ever described. Both
   * seeders that write rollups hold the same order.
   */
  it("fails before anything the seeder wrote is committed", () => {
    for (const path of ["scripts/seed-phase6-demo.mjs", "scripts/seed-platform-review-data.mjs"]) {
      const seed = readFileSync(join(process.cwd(), path), "utf8");
      const gate = seed.indexOf("assertCostRollupsCurrent(\n");
      const commit = seed.indexOf('database.query("commit")');

      expect(gate, path).toBeGreaterThan(0);
      expect(commit, path).toBeGreaterThan(gate);
      expect(seed.indexOf('database.query("commit")', commit + 1), path).toBe(-1);
    }
  });
});
