// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The surfaces that are read at the coach density, and the one way they reach it.
 *
 * `docs/REDESIGN-CANVAS.md` puts coach, affiliate, consumer and onboarding in one density column
 * -- 16px body, 46px page title, a 44px floor under anything pressable -- against the owner
 * console's 13.5px and 30px. Every rule that implements that column is written under
 * `[data-shell-role="coach"]` in `coach.css`, and the *only* thing that stamps that attribute
 * outside the workspace shell is `CoachScale`. A page on this list that stops rendering through it
 * silently falls back to the console's scale, and nothing else in the suite notices: the page still
 * compiles, still passes its own tests, and simply gets smaller.
 *
 * That is not hypothetical. Before this file existed, `not-found.tsx` was made of stock shadcn
 * semantic classes -- `bg-background`, `bg-card`, `bg-primary` -- so it was drawing at 14px system
 * font in a product that is Geist and navy everywhere else, and no test in the tree had an opinion.
 */

const SRC = new URL("../", import.meta.url).pathname;

/** Every surface outside `AppShell` that is read by a coach or a lead, and its root file. */
const COACH_DENSITY_SURFACES = {
  "/opt-in/[tenantSlug]": "components/onboarding/optin-artifact.tsx",
  "/ (marketing, flagged)": "components/marketing/landing-page.tsx",
  "not-found": "app/not-found.tsx",
  "meet your agent": "components/meet-your-agent.tsx",
} as const;

/*
 * Comments are stripped before anything is matched. Every one of these files documents the defect
 * it fixed in prose that names the banned thing -- `not-found.tsx`'s docstring says it was made of
 * `bg-background`, `bg-card` and `bg-primary` -- so a matcher reading the raw source finds the
 * offence inside the explanation of why it is gone. This test failed on exactly that on its first
 * run, and stripping is the fix rather than softening the pattern.
 */
function read(file: string) {
  return readFileSync(join(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
}

describe("the surfaces read at the coach density", () => {
  /**
   * The positive assertion, and the one that actually says a page is on the language. Its negative
   * twin below passes against a page that renders nothing at all, which is precisely the shape
   * that let a reverted `/access` sail through the entry-surface guards mid-session.
   */
  it("all reach it through CoachScale rather than retyping the sizes", () => {
    const off = Object.entries(COACH_DENSITY_SURFACES)
      // Matched delimited, because a substring match would accept `coach-scalex`. That near-miss
      // is recorded in the ledger as the "green while asserting nothing" shape.
      .filter(([, file]) => !/["']@\/components\/coach-scale["']/u.test(read(file)))
      .map(([surface]) => surface);

    expect(off).toEqual([]);
  });

  /**
   * shadcn's semantic classes name a palette this product does not use: they resolve through
   * `--background`, `--card` and `--primary`, which are the theme bridge's names, not the design
   * system's. A page written in them cannot be moved by a token change, which is what makes it a
   * guard rather than a preference.
   */
  it("name none of stock shadcn's semantic surfaces", () => {
    const offenders = Object.entries(COACH_DENSITY_SURFACES)
      .map(([surface, file]) => ({
        hits: read(file).match(/\b(?:bg|text|border)-(?:background|card|primary|muted-foreground|primary-foreground)\b/gu),
        surface,
      }))
      .filter((entry) => entry.hits !== null)
      .map((entry) => `${entry.surface}: ${entry.hits!.join(", ")}`);

    expect(offenders).toEqual([]);
  });

  /**
   * A hex literal on one of these pages is the same second palette in its most obvious form.
   * `src/app/entry-surfaces.test.ts` holds this line for the five signed-out pages; these are the
   * four it does not cover.
   */
  it("name no colour of their own", () => {
    const offenders = Object.entries(COACH_DENSITY_SURFACES)
      .map(([surface, file]) => ({ hits: read(file).match(/#[0-9a-fA-F]{3,8}\b/gu), surface }))
      .filter((entry) => entry.hits !== null)
      .map((entry) => `${entry.surface}: ${entry.hits!.join(", ")}`);

    expect(offenders).toEqual([]);
  });
});

/**
 * The Meet Your Agent density block, which is the largest single thing this port moved and the
 * easiest to lose: it lives in a component stylesheet rather than in `globals.css`, so a future
 * reader tidying "duplicate" agent rules would find every one of these selectors already declared
 * next door at the console's sizes.
 */
describe("the Meet Your Agent density block", () => {
  const SHEET = readFileSync(join(SRC, "components/meet-your-agent.css"), "utf8");

  it("keys on the attribute CoachScale stamps, so it cannot reach a surface that did not opt in", () => {
    expect(SHEET).toContain('[data-shell-role="coach"].agent-shell');
    // The attribute and the class have to be the same element. `[...] .agent-shell` with a space
    // would be a descendant selector, which matches nothing here and fails silently.
    expect(SHEET).not.toMatch(/\[data-shell-role="coach"\]\s+\.agent-shell/u);
  });

  it("raises the conversation to the coach body size, which is the point of the whole block", () => {
    const bubble = SHEET.split(/\n\s*\n/u)
      .find((block) => block.includes('[data-shell-role="coach"].agent-shell .message-bubble'));

    expect(bubble, "the bubble recipe is gone").toBeDefined();
    expect(bubble).toContain("font-size: var(--coach-body)");
  });

  /**
   * The 44px floor, on the three controls that were 29 and 30px. `coach.css` raises most things
   * from its own `:where()` rule, but these carry an explicit `min-height` in `globals.css` at
   * equal specificity, so order would decide -- and order between a global sheet and a component
   * import is not something to rely on.
   */
  it("puts the chrome controls and the suggested openers on the 44px floor explicitly", () => {
    for (const selector of [".segmented-control button, .seams-button, .restart-button", ".chip"]) {
      const block = SHEET.split(/\n\s*\n/u)
        .find((entry) => entry.includes(`.agent-shell :where(${selector})`)
          || entry.includes(`.agent-shell ${selector} {`));

      expect(block, `no floor declared for ${selector}`).toBeDefined();
      expect(block).toContain("min-height: var(--coach-target)");
    }
  });
});
