// @vitest-environment node

/**
 * No client-visible surface names the plumbing.
 *
 * CLAUDE.md: "No GoHighLevel branding anywhere client-visible. GHL is backend plumbing only."
 *
 * Thirteen files already guard this and every one of them is scoped to a single file --
 * `coach-integrations.test.ts` scans `coach-integrations.tsx`, `connect-view-models.test.ts` scans
 * its own view models, and so on down. That is thirteen guards and zero coverage for the case that
 * actually happens: a NEW coach surface, written in a redesign pass, naming the provider in a
 * label. `src/app/onboarding/calendar/page.tsx` shipped "GoHighLevel Calendar" as a select option
 * until 2026-08-31, on the most client-facing screen in the product, and none of the other twelve
 * could see it because none of them was pointed at that file.
 *
 * So this walks the import graph out of every client route the way
 * `coach-economics-wall.test.ts` does for margin, and scans everything it reaches. A surface added
 * tomorrow is covered the day it is written.
 *
 * ## Copy, not identifiers
 *
 * This is the whole difficulty, and it is why the economics guard's shape does not transfer
 * unchanged. A coach route genuinely reaches the plumbing: `coach/integrations/page.tsx` imports
 * `listGhlInstallLocationsForTenant`, `coach/home/page.tsx` computes a `"ghl"` provider
 * discriminant, and both are correct -- the rule bans the BRAND on screen, not the integration
 * behind it. Scanning identifiers would fail on correct code, and a guard that fails on correct
 * code gets switched off, which is worse than no guard.
 *
 * So only rendered copy is scanned: string and template literals, and JSX text. And the brand is
 * matched in the forms a reader would see -- `GoHighLevel`, `HighLevel`, `LeadConnector`, and
 * `GHL` capitalised -- while a lowercase `"ghl"` is left alone, because that is the discriminant
 * the code stores in `connections.provider` and never a label. If a label ever needs to be
 * lowercase `ghl`, that is a bad label for reasons beyond this rule.
 *
 * The module walk is duplicated from `coach-economics-wall.test.ts` rather than shared. Extracting
 * it would mean editing that file, which is a guard four lanes are currently working around, and a
 * shared helper whose change silently reshapes two independent rules is its own hazard.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/**
 * Every surface a person outside the client's own team can reach.
 *
 * Wider than the economics wall's list, and deliberately: that rule protects the coach from seeing
 * our margin, so it covers the coach and affiliate portals. This one protects the product's story
 * about who is answering the messages, so it also covers the lead's own screens and the onboarding
 * a coach walks before they have a workspace -- which is exactly where the one real leak was.
 */
const CLIENT_ENTRY_DIRECTORIES = [
  "src/app/(workspace)/coach",
  "src/app/(workspace)/affiliate",
  "src/app/consumer",
  "src/app/onboarding",
  "src/app/meet-agent",
  "src/components/marketing",
];

/** The brand as a reader would see it. Lowercase `ghl` is the stored discriminant, not a label. */
const BRAND = /GoHighLevel|HighLevel|LeadConnector|\bGHL\b/;

function entryFiles(directories: ReadonlyArray<string>): string[] {
  return directories.flatMap((directory) => {
    const absolute = resolve(ROOT, directory);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute, { recursive: true, encoding: "utf8" })
      .map((entry) => resolve(absolute, entry))
      .filter((path) => statSync(path).isFile() && SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)));
  });
}

function importSpecifiers(source: string): string[] {
  return [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function resolveSpecifier(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null;

  for (const candidate of [
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
    SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext)) ? base : null,
  ]) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function reachableModules(directories: ReadonlyArray<string>): Set<string> {
  const seen = new Set<string>();
  const queue = entryFiles(directories);

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || /\.test\.tsx?$/.test(file)) continue;
    seen.add(file);

    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return seen;
}

/**
 * Comments out, then the copy.
 *
 * A comment explaining why the brand is absent must never read as the brand being present -- that
 * is the mistake that makes a guard fail on the note documenting it, and this file is itself full
 * of the word it forbids.
 */
function renderedCopy(source: string): string {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(?<!:)\/\/[^\n]*/g, " ");

  const literals = [...code.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map(
    (match) => match[0],
  );
  // JSX text: what sits between a tag close and the next tag open, which no literal captures.
  const jsxText = [...code.matchAll(/>([^<>{}]{2,})</g)].map((match) => match[1]);

  return [...literals, ...jsxText].join("\n");
}

describe("no client-visible surface names GoHighLevel", () => {
  const modules = [...reachableModules(CLIENT_ENTRY_DIRECTORIES)].sort();

  it("reaches a non-vacuous set of client modules", () => {
    // A walk that resolves nothing would pass every assertion below while reading no code at all.
    expect(modules.length).toBeGreaterThan(50);
    expect(modules.some((file) => file.includes("onboarding"))).toBe(true);
    expect(modules.some((file) => file.includes("consumer"))).toBe(true);
  });

  it("puts the brand in no string, template or JSX text a client route can reach", () => {
    const hits = modules
      .map((file) => ({
        file: relative(ROOT, file),
        lines: renderedCopy(readFileSync(file, "utf8"))
          .split("\n")
          .filter((line) => BRAND.test(line)),
      }))
      .filter(({ lines }) => lines.length > 0)
      .map(({ file, lines }) => `${file}: ${lines.join(" | ")}`);

    expect(
      hits,
      "GHL is backend plumbing. The identifier is fine and the stored 'ghl' discriminant is fine; the brand may not reach a reader.",
    ).toEqual([]);
  });
});
