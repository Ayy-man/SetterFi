// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * One focus ring, on the element a reader would point at.
 *
 * `tokens.css` declares the product's focus indicator once, unlayered, on `:focus-visible`, and
 * that rule is the accessibility floor for every control the app draws: buttons, links, menu items,
 * checkboxes, tabs, the reveal button inside a password field. Almost none of them have a wrapper,
 * so the rule has to stay a bare `:focus-visible` and it has to stay unlayered, because a Tailwind
 * utility cannot override an unlayered declaration and `outline-none` sits in `@layer utilities`
 * (see `unlayered-cascade.test.ts` for the general form of that trap).
 *
 * `FieldShell` is the single exception, and it is an exception about geometry rather than about
 * colour or width. The shell is the control a reader sees; the `<input>` inside it is one flex
 * child, inset by the shell's padding, sharing the row with an optional leading glyph and with
 * whatever `trailing` holds, and raised to `--coach-target` by `coach.css` even where the shell is
 * the kit's 34px console default. Focusing it therefore drew a second rounded rectangle at a
 * different radius, inset from the shell on the left and right and standing proud of it top and
 * bottom. That is the ring a product owner reported as escaping the field on /access and /login.
 *
 * The fix moves the ring rather than deleting it, so both halves are pinned here: the shell takes
 * the same 2px `--focus-ring` at the same 2px offset, and the input inside a shell takes none.
 * Deleting either half regresses something real. Without the first, a keyboard reader is left with
 * `--accent-wash-strong`, a 17%-alpha film that measures nowhere near the 3:1 WCAG 2.4.11 asks of
 * a focus indicator. Without the second, the doubling comes straight back.
 */

const source = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");
const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, "");

/** The declarations of the first rule opened by an anchored selector. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^[ \\t]*${escaped}\\s*\\{([^}]*)\\}`, "mu").exec(withoutComments);
  if (!match) throw new Error(`tokens.css declares no rule for: ${selector}`);
  return match[1].replace(/\s+/gu, " ").trim();
}

function declaration(body: string, property: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "u").exec(body);
  return match ? match[1].trim() : null;
}

const GLOBAL = ":focus-visible";
const SHELL = '[data-slot="field-shell"]:has([data-slot="kit-input"]:focus-visible)';
const INPUT = '[data-slot="field-shell"] [data-slot="kit-input"]:focus-visible';

describe("the focus ring", () => {
  it("keeps one unlayered global rule, which is what every control without a shell wears", () => {
    const body = ruleBody(GLOBAL);
    expect(declaration(body, "outline")).toBe("2px solid var(--focus-ring)");
    expect(declaration(body, "outline-offset")).toBe("2px");

    // Unlayered, or a `@layer utilities` class would silently win and the ring would vanish from
    // whichever control last received an `outline-none`.
    const before = withoutComments.slice(0, withoutComments.indexOf(`${GLOBAL} {`));
    const depth = (before.match(/\{/gu) ?? []).length - (before.match(/\}/gu) ?? []).length;
    expect(depth, "the global :focus-visible rule sits inside a block, so it may be layered")
      .toBe(0);
  });

  it("hands the shell the ring, at the geometry and colour the global rule defines", () => {
    const shell = ruleBody(SHELL);
    const global = ruleBody(GLOBAL);
    expect(declaration(shell, "outline")).toBe(declaration(global, "outline"));
    expect(declaration(shell, "outline-offset")).toBe(declaration(global, "outline-offset"));

    // The shell must NOT restate the global rule's `border-radius: var(--r-control)`. It never
    // matches `:focus-visible` itself, so it keeps its own 9px (10px under `AUTH_FIELDS_CLASS`)
    // frame and the ring follows that instead of squaring off to the 4px control radius.
    expect(declaration(shell, "border-radius")).toBeNull();
  });

  it("takes the ring off the input inside a shell, and only there", () => {
    expect(declaration(ruleBody(INPUT), "outline")).toBe("none");

    /*
     * The suppression is scoped to a `kit-input` under a shell. Anything broader would reach the
     * reveal button that sits beside it, and that button's own ring is the only thing telling a
     * keyboard reader focus moved from the field to Show. So: no rule in this stylesheet may kill
     * an outline for a selector that is not shell-scoped.
     */
    const killers = Array.from(
      withoutComments.matchAll(/^[ \t]*([^{}]*:focus[^{}]*)\{([^}]*)\}/gmu),
    )
      .filter(([, , body]) => /outline\s*:\s*(none|0)/u.test(body))
      .map(([, selector]) => selector.trim());
    expect(killers).toEqual([INPUT]);
  });
});
