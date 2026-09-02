// @vitest-environment node

/**
 * A `font-[…]` utility must spell the token it references the way that token is meant.
 *
 * Tailwind's bare arbitrary form on the `font-` prefix compiles to `font-weight`, so
 * `font-[var(--font-mono)]` becomes `font-weight: var(--font-mono)` -- and because `--font-mono` is
 * a family list, the declaration is invalid and the browser throws the whole line away. The element
 * gets neither the mono family it was asking for nor any weight at all, silently, which is the same
 * fail-open shape `token-references.test.ts` was written for. Two sites carried it until
 * 2026-09-01: the coach account chip's initials in `app-topbar.tsx` and the Inbox count badge in
 * `coach-pillbar.tsx`, both of which are numerals whose whole reason for existing is that they line
 * up in mono.
 *
 * **The obvious rule -- "every `font-[` must carry a hint" -- is wrong and would fail on correct
 * code.** Around thirty sites write `font-[var(--t-row-w)]` and `font-[var(--t-title-w)]` bare and
 * are right to: those tokens hold weights, and the bare form is exactly how you spend a weight
 * token. The rule is about what the referenced token *means*, not about the syntax around it. So
 * this resolves each name against the stylesheets that declare it and asks whether the value is a
 * weight or a family, which also covers the next family token somebody adds without anybody having
 * to remember this file exists.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function filesUnder(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (match.test(entry.name)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

/** Every custom property declared in the app's own stylesheets, last declaration winning. */
function declaredValues(): Map<string, string> {
  const values = new Map<string, string>();
  for (const file of [...filesUnder(join(ROOT, "src/app"), /\.css$/), ...filesUnder(join(ROOT, "src/components"), /\.css$/)]) {
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, name, value] of source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
      values.set(name, value.trim());
    }
  }
  return values;
}

type Meaning = "weight" | "family" | "unknown";

/**
 * What a token means, read from the value it is declared with rather than from its name. A name
 * test would need updating for `--font-display`; this does not.
 */
function meaningOf(name: string, values: Map<string, string>, seen = new Set<string>()): Meaning {
  if (seen.has(name)) return "unknown";
  seen.add(name);

  const value = values.get(name);
  if (value === undefined) {
    // Not declared in CSS at all. `next/font` injects `--font-geist-mono` and friends at runtime,
    // and those are families by construction.
    return /^--font-/.test(name) ? "family" : "unknown";
  }
  if (/^(?:[1-9]00|normal|bold|bolder|lighter)$/.test(value)) return "weight";
  if (/(?:^|[\s,(])(?:ui-monospace|ui-sans-serif|ui-serif|monospace|sans-serif|serif|system-ui|cursive|fantasy)\b/.test(value)) {
    return "family";
  }
  if (/["']/.test(value)) return "family";

  const references = Array.from(value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi), ([, referenced]) => referenced);
  if (references.length === 1 && /^var\(\s*--[a-z0-9-]+\s*\)$/.test(value)) {
    return meaningOf(references[0], values, seen);
  }
  // A comma list that leads with a font token is a family stack: `var(--font-geist-mono), monospace`.
  if (references.length > 0 && value.includes(",")) return "family";
  return "unknown";
}

type Site = {
  /** The whole utility as authored, e.g. `font-[family-name:var(--font-mono)]`. */
  utility: string;
  /** The token it references, or null for a literal like `font-[500]`. */
  token: string | null;
  /** The `family-name:` / `number:` / `length:` data-type hint, if any. */
  hint: string | null;
  where: string;
};

function fontUtilitySites(): Site[] {
  const sites: Site[] = [];
  const sources = [
    ...filesUnder(join(ROOT, "src/app"), /\.tsx?$/),
    ...filesUnder(join(ROOT, "src/components"), /\.tsx?$/),
  ].filter((file) => !/\.test\.tsx?$/.test(file));

  for (const file of sources) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const [utility, body] of line.matchAll(/font-\[([^\]]+)\]/g)) {
        const hint = /^([a-z-]+):/.exec(body)?.[1] ?? null;
        const token = /var\(\s*(--[a-z0-9-]+)/i.exec(body)?.[1] ?? null;
        sites.push({ utility, token, hint, where: `${relative(ROOT, file)}:${index + 1}` });
      }
    });
  }
  return sites;
}

/**
 * The rule itself, kept as a function so the positive controls below can run the real thing over
 * inputs the repo does not contain rather than over a paraphrase of it.
 */
function misspelledSites(sites: readonly Site[], values: Map<string, string>): string[] {
  const wrong: string[] = [];
  for (const site of sites) {
    if (site.token === null) continue;
    const meaning = meaningOf(site.token, values);
    if (site.hint === null && meaning === "family") {
      wrong.push(
        `${site.where}: ${site.utility} compiles to \`font-weight: var(${site.token})\`, but ${site.token} is a family, so the declaration is invalid and dropped. Write font-[family-name:var(${site.token})].`,
      );
    }
    if (site.hint === "family-name" && meaning === "weight") {
      wrong.push(
        `${site.where}: ${site.utility} asks for a family, but ${site.token} holds a weight. Write font-[var(${site.token})].`,
      );
    }
  }
  return wrong;
}

const VALUES = declaredValues();
const SITES = fontUtilitySites();

describe("font-[…] utilities reference tokens that mean what the utility spells", () => {
  it("finds font-[…] utilities to check at all", () => {
    // An empty match set passes every for-loop assertion below, so the scan is asserted before
    // anything is concluded from it.
    expect(SITES.length, "font-[…] sites found under src/").toBeGreaterThan(50);
    expect(
      SITES.filter((site) => site.token !== null).length,
      "font-[…] sites that reference a token",
    ).toBeGreaterThan(20);
  });

  it("reads --font-mono as a family and the --t-*-w scale as weights", () => {
    expect(meaningOf("--font-mono", VALUES)).toBe("family");
    expect(meaningOf("--font-sans", VALUES)).toBe("family");
    for (const weight of ["--t-title-w", "--t-row-w", "--t-body-w", "--t-over-w", "--t-badge-w"]) {
      expect(meaningOf(weight, VALUES), `${weight} holds a weight`).toBe("weight");
    }
  });

  it("spells every font-[…] token reference the way that token is declared", () => {
    expect(misspelledSites(SITES, VALUES)).toEqual([]);
  });

  /*
   * The two directions the rule has to get right, run through `misspelledSites` itself. The first
   * is the defect; the second is the correct code a syntax-shaped rule would have failed on, and it
   * is pinned by token name so that deleting the weight tokens cannot quietly make this vacuous.
   */
  it("flags a bare reference to a family token", () => {
    const bare: Site = {
      utility: "font-[var(--font-mono)]",
      token: "--font-mono",
      hint: null,
      where: "synthetic:1",
    };
    expect(misspelledSites([bare], VALUES)).toHaveLength(1);
  });

  it("does not flag the bare weight references the scale is spelled with", () => {
    const bareWeights = SITES.filter(
      (site) => site.hint === null && site.token !== null && /^--t-[a-z-]+-w$/.test(site.token),
    );
    expect(bareWeights.length, "bare weight-token sites (font utilities whose token matches --t-<name>-w)").toBeGreaterThan(20);
    expect(misspelledSites(bareWeights, VALUES)).toEqual([]);
  });

  it("flags a family-name: hint on a weight token", () => {
    const inverted: Site = {
      utility: "font-[family-name:var(--t-row-w)]",
      token: "--t-row-w",
      hint: "family-name",
      where: "synthetic:1",
    };
    expect(misspelledSites([inverted], VALUES)).toHaveLength(1);
  });
});
