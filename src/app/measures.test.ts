import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The Line Length rule, as a test rather than a sentence.
 *
 * `docs/DESIGN.md:350` caps prose at 65-75ch and has said so since the redesign began, but for
 * most of that time nothing enforced it: the rule was hand-rolled at 100 sites across 49 files in
 * eleven different `ch` values, and the most common of them -- 64ch, at 34 uses -- sat below the
 * rule's own floor. A named rule that drifts across eleven values is a rule in prose only, so
 * these two tests are what actually hold it.
 */

const SRC = new URL("../", import.meta.url).pathname;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path));
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(path);
  }
  return out;
}

describe("the Line Length rule", () => {
  /**
   * The guard. A new `max-w-[64ch]` anywhere in the tree fails here, which is the only thing
   * standing between four measures and a twelfth value.
   */
  it("is never hand-rolled: every measure comes from a token", () => {
    const offenders = tsxFiles(SRC)
      .map((path) => ({ path, hits: readFileSync(path, "utf8").match(/max-w-\[\d+ch\]/gu) }))
      .filter((entry) => entry.hits !== null)
      .map((entry) => `${entry.path.slice(SRC.length)}: ${entry.hits!.join(", ")}`);

    expect(offenders).toEqual([]);
  });

  /**
   * The measures themselves have to obey the rule they implement. `prose` and `wide` are the two
   * that carry body copy, so both must land inside 65-75ch; `tight` and `caption` are narrower on
   * purpose and are not prose -- they are centred empty-state copy and metadata meant to wrap into
   * a block beside a figure -- so the cap does not apply to them.
   */
  it("keeps both prose measures inside the 65-75ch band DESIGN.md sets", () => {
    const tokens = readFileSync(join(SRC, "app/tokens.css"), "utf8");
    const read = (name: string) => {
      const found = new RegExp(`--measure-${name}:\\s*(\\d+)ch`, "u").exec(tokens);
      expect(found, `--measure-${name} is not declared`).not.toBeNull();
      return Number(found![1]);
    };

    for (const name of ["prose", "wide"]) {
      const value = read(name);
      expect(value, `--measure-${name} is ${value}ch`).toBeGreaterThanOrEqual(65);
      expect(value, `--measure-${name} is ${value}ch`).toBeLessThanOrEqual(75);
    }

    // The narrow roles exist so that a caption is never widened into a paragraph.
    expect(read("tight")).toBeLessThan(65);
    expect(read("caption")).toBeLessThan(read("tight"));
  });
});
