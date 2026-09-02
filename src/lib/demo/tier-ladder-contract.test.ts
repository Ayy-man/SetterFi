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
      "Starter (demo)",
      "Growth (demo)",
      "Scale (demo)",
    ]);
    expect(ladder.every((rung) => rung.name.endsWith("(demo)"))).toBe(true);
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
