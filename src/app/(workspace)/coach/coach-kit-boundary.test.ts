// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * The three rules `coach.css` applies to every kit component mounted under the coach shell,
 * whether or not the screen that mounted it asked.
 *
 * These are the shared-kit findings from `docs/plans/2026-09-04-coach-visual-audit.md` -- the
 * ones the audit measured on more than one screen, so that the per-screen rebuilds do not each
 * re-fix them. Each is a stylesheet rule rather than a component change, because the audit's
 * root cause in all three cases is opt-in: `COACH_READING_CLASS`, `placement="header"` and the
 * 44px target were all available and all forgotten, on six screens, in three lanes.
 *
 * The assertions read the stylesheet's text rather than a rendered page. That is a real limit and
 * it is the same one every CSS guard in this repo lives with: jsdom computes no cascade, so no
 * unit test in this suite can measure a font size or a hit box. What a text assertion can do is
 * fail the moment a rule is deleted or a selector stops naming the thing it was written for, and
 * the geometry was measured in Chrome against the dev server when the rules landed.
 */

const ROOT = process.cwd();
const COACH_CSS = readFileSync(resolve(ROOT, "src/app/(workspace)/coach/coach.css"), "utf8");
const COACH_SCOPE = '[data-shell-role="coach"]';

/** The stylesheet with its comments removed, so a selector scan cannot read prose as CSS. */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, " ");
}

/**
 * Every selector in the file, one per entry, with at-rule preludes and keyframe stops dropped.
 *
 * Written as a walk rather than a regex because both things this has to get right defeat one: a
 * selector list spans lines, and `:is(a, b)` holds commas that are not list separators. A regex
 * that split on every comma reported the inside of the 44px rule as eleven escaped selectors.
 */
function topLevelSelectors(source: string): string[] {
  const css = withoutComments(source);
  const found: string[] = [];
  let start = 0;
  let depth = 0;

  for (let index = 0; index < css.length; index += 1) {
    if (css[index] === "{") {
      if (depth === 0) found.push(css.slice(start, index));
      depth += 1;
    } else if (css[index] === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) start = index + 1;
    } else if (depth === 1 && css[index] === "{") {
      depth += 1;
    }
  }

  return found
    .flatMap((prelude) => {
      const text = prelude.trim();
      if (text.startsWith("@")) {
        // An at-rule's own body is scanned by recursing on it, so `@media` blocks are not a hole.
        const body = css.slice(css.indexOf(text) + text.length);
        return topLevelSelectors(body.slice(body.indexOf("{") + 1, body.lastIndexOf("}")));
      }
      return splitSelectorList(text);
    })
    .map((selector) => selector.trim())
    .filter(Boolean)
    // Keyframe stops (`from`, `to`, `0%, 45%`) are not selectors.
    .filter((selector) => !/^(?:from|to|[\d.]+%)$/u.test(selector));
}

/** A selector list split on its own commas, never on one inside `:is()`, `:not()` or `:has()`. */
function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const character of list) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  parts.push(current);
  return parts;
}

/** The declarations inside the first rule whose selector list contains `needle`. */
function ruleBodyContaining(needle: string): string | null {
  const index = COACH_CSS.indexOf(needle);
  if (index === -1) return null;
  const open = COACH_CSS.indexOf("{", index);
  const close = COACH_CSS.indexOf("}", open);
  return open === -1 || close === -1 ? null : COACH_CSS.slice(open + 1, close);
}

describe("the coach stylesheet reaches the shared kit at all", () => {
  it("is scoped to the coach shell everywhere, so the console cannot be reached", () => {
    /*
     * The safety argument for every rule in the file, asserted rather than trusted. A selector
     * that escaped this scope would move the owner console, which runs 13.5px body and 30-34px
     * controls for a different audience and must not move.
     */
    const escaped = topLevelSelectors(COACH_CSS)
      // The kanban drag preview is portalled to `document.body`, outside the shell root, and
      // carries its own `.kanban-drag-preview` namespace. It is the file's one documented escape.
      .filter((selector) => !selector.includes("kanban-drag-preview"))
      .filter((selector) => !selector.startsWith("body."))
      .filter((selector) => !selector.includes(COACH_SCOPE));

    expect(escaped).toEqual([]);
  });
});

describe("the type floor applies at the kit boundary, not at the callsite", () => {
  /*
   * The token half. Re-authoring the console's `--t-*` scale under the coach root is what carries
   * every kit component that draws through `.t-body`, `.t-muted`, `.t-overline`, `.t-mono-meta`,
   * `--t-label` and `--t-badge` onto the coach floor without a component being edited.
   */
  const FLOOR = 14;
  const CONSOLE_SIZES: Record<string, number> = {
    "--t-badge": 12,
    "--t-body": 13,
    "--t-label": 11,
    "--t-mono-crumb": 11.5,
    "--t-mono-meta": 12,
    "--t-nav": 13.5,
    "--t-over": 11,
    "--t-read": 15,
    "--t-section-title": 14,
  };

  it("still finds the console values these overrides exist to raise", () => {
    // The premise. If somebody raises the console scale, these overrides may be redundant and
    // this test says so rather than silently enforcing a rule with nothing left to protect.
    const tokens = readFileSync(resolve(ROOT, "src/app/tokens.css"), "utf8");

    for (const [token, size] of Object.entries(CONSOLE_SIZES)) {
      const declared = new RegExp(`${token}:\\s*([\\d.]+)px`, "u").exec(tokens);
      expect(declared, `${token} is no longer declared in tokens.css`).not.toBeNull();
      expect(Number(declared![1]), `${token} in tokens.css`).toBe(size);
    }
  });

  it("re-authors every console type token that sits under the coach floor", () => {
    const scope = COACH_CSS.slice(COACH_CSS.indexOf("1. The type floor"));

    const missing = Object.entries(CONSOLE_SIZES)
      .filter(([, size]) => size < FLOOR)
      .map(([token]) => token)
      .filter((token) => !new RegExp(`${token}:`, "u").test(scope));

    expect(
      missing,
      "SIMPLIFICATION-SPEC §5 puts the coach floor at 14px. These console tokens are under it and "
        + "are not re-authored under the coach root, so a kit component reading one renders below "
        + "the floor on a coach page.",
    ).toEqual([]);
  });

  it("raises the re-authored tokens to the floor and no lower", () => {
    const scope = COACH_CSS.slice(COACH_CSS.indexOf("1. The type floor"));
    const under = [...scope.matchAll(/(--t-[a-z-]+):\s*([\d.]+)px/gu)]
      .filter((match) => Number(match[2]) < FLOOR)
      .map((match) => `${match[1]}: ${match[2]}px`);

    expect(under, "a coach override may not itself be under the floor").toEqual([]);
  });

  it("binds the coach body and reading roles to the coach's own token, not to a retyped 16", () => {
    const scope = COACH_CSS.slice(COACH_CSS.indexOf("1. The type floor"));

    // The eyebrow spent a whole redesign pass two pixels under the floor because one number lived
    // in two places and only one of them was ever read. Same rule, same reason.
    expect(scope).toMatch(/--t-body:\s*var\(--coach-body\)/u);
    expect(scope).toMatch(/--t-read:\s*var\(--coach-body\)/u);
    expect(scope).toMatch(/--t-row:\s*var\(--coach-row-name\)/u);
  });
});

describe("the support bubble's corner is reserved rather than shared", () => {
  it("reserves the launcher's box plus its offset plus air", () => {
    const bubble = readFileSync(
      resolve(ROOT, "src/components/workspace/live/coach-support-bubble.tsx"),
      "utf8",
    );

    // The reserve is only correct while it is the launcher's real geometry, so both numbers are
    // read off the component rather than trusted. 60px launcher, 32px from the bottom edge.
    expect(bubble).toContain("h-[60px] w-[60px]");
    expect(bubble).toContain("sm:bottom-[32px]");
    expect(COACH_CSS).toMatch(/--coach-bubble-reserve:\s*calc\(32px \+ 60px \+ 16px\)/u);
  });

  it("pads the coach content pane by the reserve", () => {
    const body = ruleBodyContaining(`${COACH_SCOPE} main#main {`);

    expect(body, "no rule pads the coach content pane").not.toBeNull();
    expect(body).toMatch(/padding-bottom:\s*calc\(var\(--s-6\) \+ var\(--coach-bubble-reserve\)\)/u);
  });

  it("reserves inside the scroll regions of a page that owns the viewport instead", () => {
    /*
     * A `data-layout="fixed"` page -- the Inbox is the coach's only one -- runs its panes edge to
     * edge and undoes `<main>`'s padding with a negative margin, so padding `<main>` there would
     * leave a strip of bare pane under the grid rather than clearing anything. The panes reserve
     * the corner where their content actually ends.
     */
    expect(COACH_CSS).toContain(`${COACH_SCOPE} main#main:has([data-layout="fixed"])`);
    expect(COACH_CSS).toContain(`${COACH_SCOPE} [data-layout="fixed"] [class*="overflow-y-auto"]::after`);
  });

  it("leaves the bubble in its corner", () => {
    // The fix must not be "move the launcher". A help launcher that is not in the corner is not a
    // help launcher, and `context-eye.tsx` already took the other half of this decision.
    expect(COACH_CSS).not.toMatch(/data-slot="coach-support-bubble"[^{]*\{[^}]*(bottom|right):/u);
  });
});

describe("every interactive kit primitive under the coach shell clears 44px", () => {
  it("declares the floor as the coach's own target token", () => {
    const body = ruleBodyContaining("::after {\n  content: \"\";\n  position: absolute;");

    expect(body, "no hit-box rule found").not.toBeNull();
    expect(body).toMatch(/min-width:\s*var\(--coach-target\)/u);
    expect(body).toMatch(/min-height:\s*var\(--coach-target\)/u);
    expect(body).toMatch(/pointer-events:\s*auto/u);
    expect(COACH_CSS).toMatch(/--coach-target:\s*44px/u);
  });

  it("covers the roles the audit measured under the floor", () => {
    /*
     * Each entry is a primitive the audit measured below 44px on a coach screen, named by the
     * selector that now has to reach it: `DataTable`'s sort trigger at 8px wide and a kanban
     * card's menu at 28px are `button`, a checkbox indicator at 16x16 is `[role="checkbox"]`, and
     * `Button size="sm"` is 26px tall.
     */
    for (const role of ["button", "summary", '[role="button"]', '[role="checkbox"]', '[role="switch"]', '[role="menuitem"]', '[role="tab"]']) {
      expect(COACH_CSS, `${role} has no 44px hit box under the coach shell`).toContain(`  ${role},\n`);
    }
  });

  it("excludes the two elements that draw their own ::after", () => {
    // The rule claims `::after`, so anything already using it on a coach surface has to be named.
    // Both were found by reading the file rather than assumed: the kanban card's landing ring and
    // the support launcher, which is already 60px and needs no help.
    expect(COACH_CSS).toContain(':not([data-kanban-card], [data-slot="coach-support-launcher"])::after');
  });
});
