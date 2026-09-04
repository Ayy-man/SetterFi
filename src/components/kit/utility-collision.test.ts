// @vitest-environment node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * Two arbitrary Tailwind utilities for one CSS property, in one class list, do not resolve in the
 * order they are written.
 *
 * This is the guard for the worst defect the 2026-09-04 coach visual audit found. The Inbox's
 * agent toggle -- "Take over", the single most important action on the coach side by the
 * simplification spec's own reckoning -- rendered with `color` and `background-color` at the same
 * computed value, `lab(10.85 -0.29 -8.37)`. Contrast 1:1. It was a black slab with no readable
 * label, and it had been shipping.
 *
 * The cause is a shared shape constant plus a callsite override:
 *
 *   const BUTTON_CLASS = "... bg-[var(--card)] ... text-[color:var(--ink)] ...";
 *   <button className={`${BUTTON_CLASS} bg-[var(--ink)] text-[color:var(--card)]`} />
 *
 * Every author reads that as "the later one wins", the way an inline style would. It does not.
 * Tailwind emits each candidate exactly once, ordered by its own sort, and the cascade then picks
 * whichever rule landed later in the emitted sheet -- which has nothing to do with the order the
 * two classes appear in the attribute. Here it happened to pick the *later* `bg-` and the
 * *earlier* `text-`, which is the one combination that produces ink on ink.
 *
 * Three things make this worth a guard rather than a fix:
 *
 *   1. Nothing else catches it. `tsc` sees two strings. jsdom records both classes on the element
 *      and reports no computed colour at all, so a render test asserting the class is present
 *      passes on a button nobody can read. Review reads the intent, not the emitted sheet.
 *   2. It is silent in the good case. Most collisions in this repo resolve the way the author
 *      meant, so the pattern looks safe everywhere it is used until the day it is not.
 *   3. It is a fix with no cost. A base constant that sets no colour, plus one named variant per
 *      colour pair, cannot collide with itself.
 *
 * The properties checked are the three that carry a visible colour or size and are routinely
 * overridden this way: `color`, `background-color`, and `font-size`. `bg-[image:...]` and
 * `bg-[linear-gradient(...)]` are deliberately not treated as `background-color` -- they set a
 * different property and layering a fill over a colour is a real technique, not a mistake.
 */

const ROOT = process.cwd();
const SOURCE_ROOT = resolve(ROOT, "src");

function sourceFiles(): string[] {
  return readdirSync(SOURCE_ROOT, { recursive: true, encoding: "utf8" })
    .map((entry) => resolve(SOURCE_ROOT, entry))
    .filter((path) => statSync(path).isFile())
    .filter((path) => /\.tsx?$/u.test(path) && !/\.test\.tsx?$/u.test(path));
}

/**
 * The CSS property an arbitrary utility sets, or null for one this rule has nothing to say about.
 *
 * Matched on the utility's own spelling rather than by resolving it, because the point is to
 * recognise two spellings of one property, and a resolver would need Tailwind's whole config to
 * tell `bg-[var(--ink)]` from `bg-[image:var(--accent-fill)]` -- which is exactly the distinction
 * that must not be got wrong here.
 */
function property(token: string): string | null {
  if (/^text-\[color:/u.test(token)) return "color";
  if (/^text-\[(?:length:)?[\d.]/u.test(token) || /^text-\[length:var/u.test(token)) return "font-size";
  if (/^bg-\[(?!image:|linear-gradient|radial-gradient|url)/u.test(token)) return "background-color";
  return null;
}

function declarations(classList: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const token of classList.split(/\s+/u).filter(Boolean)) {
    const key = property(token);
    // First spelling wins the slot: a constant that sets one property twice is its own problem,
    // and reporting it here would blame the callsite for it.
    if (key && !found.has(key)) found.set(key, token);
  }
  return found;
}

/** `const NAME = "..." + "..." ;` -- the shared class constants, flattened to their class text. */
function classConstants(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(
    /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*((?:"[^"]*"|`[^`${]*`|\s|\+)+);/gu,
  )) {
    found.set(match[1], match[2].replaceAll(/["`+]/gu, " "));
  }
  return found;
}

type Collision = { file: string; constant: string; base: string; appended: string; property: string };

function collisions(): Collision[] {
  const found: Collision[] = [];

  for (const path of sourceFiles()) {
    const source = readFileSync(path, "utf8");
    const constants = classConstants(source);
    if (constants.size === 0) continue;

    for (const match of source.matchAll(/`\$\{([A-Z][A-Z0-9_]*)\}([^`]*)`/gu)) {
      const base = constants.get(match[1]);
      if (!base) continue;

      const baseProperties = declarations(base);
      for (const [key, appended] of declarations(match[2])) {
        const existing = baseProperties.get(key);
        if (existing && existing !== appended) {
          found.push({
            appended,
            base: existing,
            constant: match[1],
            file: relative(ROOT, path),
            property: key,
          });
        }
      }
    }
  }

  return found;
}

/**
 * What was already colliding when this guard landed, and whose lane each one is in.
 *
 * Every row is asserted to still be a collision, so fixing one without deleting its row fails the
 * suite. A stale allow-list is how the 12px coach eyebrow survived three review rounds.
 *
 * None of these is the ink-on-ink defect -- each resolves to something legible today -- but each
 * is the same loaded gun, and each sits in a file owned by another lane of the coach redesign, so
 * they are recorded here rather than edited across an ownership boundary.
 */
const DEBT: Record<string, string> = {
  "src/components/workspace/live/account-security-settings.tsx":
    "MONO_VALUE_CLASS: --body under an appended --ink",
  "src/components/workspace/live/coach-billing.tsx":
    "PANEL_SUB_CLASS: --muted under --body, and --coach-body under an appended 15px",
  "src/components/workspace/rehaul/affiliate-home.tsx":
    "TD_CLASS: 16px under an appended 14px",
  "src/components/workspace/rehaul/coach-billing.tsx":
    "MONO_META_CLASS: --muted under an appended --faint (billing lane)",
};

describe("no class list spells one CSS property twice", () => {
  it("reads enough constants to be able to find one", () => {
    // The positive control. A regex that stopped matching would leave the assertion below
    // iterating an empty list and passing green, which is how two guards in this repo went blind.
    const constants = sourceFiles()
      .map((path) => classConstants(readFileSync(path, "utf8")).size)
      .reduce((total, count) => total + count, 0);

    expect(constants).toBeGreaterThan(100);
  });

  it("finds the shape constants the coach Inbox now uses, and no collision in them", () => {
    const source = readFileSync(
      resolve(ROOT, "src/components/workspace/rehaul/coach-inbox.tsx"),
      "utf8",
    );
    const constants = classConstants(source);

    // The base carries the shape and no colour, which is what makes the three variants safe.
    const shape = constants.get("BUTTON_SHAPE_CLASS");
    expect(shape, "BUTTON_SHAPE_CLASS is the colourless base the toggle fix depends on").toBeDefined();
    expect(declarations(shape!).has("color")).toBe(false);
    expect(declarations(shape!).has("background-color")).toBe(false);
  });

  it("has no collision outside the recorded debt", () => {
    const unexpected = collisions()
      .filter((collision) => !(collision.file in DEBT))
      .map(
        (collision) =>
          `${collision.file}: ${collision.constant} sets ${collision.base} and the callsite `
          + `appends ${collision.appended} (both are ${collision.property})`,
      )
      .sort();

    expect(
      unexpected,
      "two arbitrary utilities for one CSS property in one class list resolve by Tailwind's emit "
        + "order, not by the order they are written. Split the constant into a colourless shape and "
        + "one named variant per pair, the way `coach-inbox.tsx` does.",
    ).toEqual([]);
  });

  it("keeps no debt row for a file that is already clean", () => {
    const stillColliding = new Set(collisions().map((collision) => collision.file));

    expect(
      Object.keys(DEBT).filter((file) => !stillColliding.has(file)),
      "these rows name files that no longer collide -- delete them",
    ).toEqual([]);
  });
});
