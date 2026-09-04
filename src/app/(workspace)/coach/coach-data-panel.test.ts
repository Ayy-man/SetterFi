import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

/*
 * The wide data panel, held to the two things that separate it from the shapes it sits next to.
 *
 * It is the third card shape in the canvas and the last one to get a component, which is why it
 * needs a guard the other two did not: both discriminators are a single number away from a shape
 * that already exists, and a number that close drifts back the first time somebody edits one side
 * without the other in view.
 *
 * **The census behind the claim.** All 55 design artboards were parsed into a DOM and every
 * full-width panel examined, on 2026-09-01. Three carry this shape -- the company trend chart and
 * the keyword table on the coach main screen, and the referrals table on the affiliate screen --
 * across two drawings and two surfaces. All three are identical property for property, which is
 * what makes it a shape rather than three drawings that happen to agree. The trigger is a
 * full-width panel whose *body is a data surface*: a chart, a table, a board. It is not "the
 * biggest panel on the screen", which is a size and would pull in any card that happens to span
 * its column.
 *
 * The design canvas is not part of this repository, so the assertions below read the stylesheet
 * rather than the drawings: a token move is a failure here rather than a comment that goes stale.
 */

const ROOT = process.cwd()
const SHEET = "src/app/(workspace)/coach/coach.css"
/**
 * Every surface that mounts the arm, and the drawing or the reason it does.
 *
 * A registry rather than a scan-and-allow, for the reason the arm's own doc gives: `coach.css` is
 * scoped to `[data-shell-role="coach"]`, so a caller mounted outside that root renders an unstyled
 * band and nothing anywhere goes red. The list is what makes "it was walked once" into something
 * that stays true.
 */
const CALLERS: Record<string, string> = {
  "src/app/(workspace)/coach/home/loading.tsx":
    "Loading.dc.html -- the same Leads by month band, drawn over a sentence while the read is in flight, under the coach AppShell",
  "src/components/workspace/live/affiliate-money.tsx":
    "Affiliate.dc.html:163-168 -- the referrals table, under the CoachScale this file wraps its content in",
  "src/components/workspace/rehaul/coach-home-keywords.tsx":
    "Main.dc.html:298-345 -- the keyword table on coach Home, mounted by coach-dashboard.tsx under the coach AppShell",
  "src/components/workspace/rehaul/coach-home-months.tsx":
    "Main.dc.html:271-296 -- the leads-by-month chart on coach Home, mounted by coach-dashboard.tsx under the coach AppShell",
}

/** The one file allowed to hold the recipe's numbers. */
const RECIPE_HOME = SHEET

function sourceFiles(): string[] {
  const absolute = resolve(ROOT, "src")
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .map((entry) => resolve(absolute, entry))
    .filter((path) => statSync(path).isFile() && /\.tsx?$/u.test(path))
    .map((path) => relative(ROOT, path))
}

function sheet(): string {
  return readFileSync(resolve(ROOT, SHEET), "utf8")
}

/** One CSS rule body, by selector, with comments stripped so prose cannot satisfy a match. */
function ruleBody(selector: string): string {
  const css = sheet().replace(/\/\*[\s\S]*?\*\//gu, " ")
  const index = css.indexOf(selector)
  expect(index, `${selector} is not declared in ${SHEET} at all`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf("{", index)
  const close = css.indexOf("}", open)
  return css.slice(open + 1, close)
}

describe("the wide data panel is a shape, held apart from the two it sits beside", () => {
  it("draws the band the canvas draws, at the padding that identifies it", () => {
    const band = ruleBody('[data-shell-role="coach"] .coach-data-panel__header')

    // Both numbers, because the pair is the discriminator and half of it is not one. `22px` alone
    // is a hair off the deck panel's 19 and would read as a rounding difference; `26px` alone
    // matches nothing else either. Together they are what the census found on all three drawings
    // and on nothing else.
    expect(band, "the band's padding is what separates this from the deck panel's 19px 20px")
      .toMatch(/padding:\s*22px\s+26px\s*;/u)
  })

  it("takes no header floor, which is the other half of the discriminator", () => {
    const band = ruleBody('[data-shell-role="coach"] .coach-data-panel__header')

    /*
     * The deck panel's `min-height: 78px` exists so three cards in a row print their names at one
     * height. A data panel is alone on its row and has nothing to line up with, so a floor here
     * would be a number copied from a shape whose reason does not apply -- and it would show, as a
     * band 78px tall around a single line of text.
     */
    expect(band, "a data panel is alone on its row, so a header floor has nothing to align to")
      .not.toMatch(/min-height/u)
  })

  it("keeps the deck panel's floor, so this test can tell the two apart", () => {
    // The control. Without it, deleting the deck panel's floor would make the assertion above
    // vacuously true and the discriminator would be gone with nothing to say so.
    const deck = ruleBody('[data-shell-role="coach"] .coach-panel__header')

    expect(deck, "the deck panel's 78px floor is the thing a data panel is defined as not having")
      .toMatch(/min-height:\s*78px\s*;/u)
    expect(deck, "the deck panel's band is 19px 20px; if it moved, this file's contrast is stale")
      .toMatch(/padding:\s*19px\s+20px\s*;/u)
  })

  it("names the panel at 22px and weight 500, not the title-led card's 600", () => {
    const name = ruleBody('[data-shell-role="coach"] .coach-data-panel__name')

    /*
     * The size the two shapes share is exactly why the weight is asserted beside it. A title-led
     * card is also 22px, in a `div`, as the body's first line with no band above it; this is an
     * `h2` at 500 inside a band, under an eyebrow that already carries the category. Reading the
     * size alone would call them one shape, which is the mistake `deck-panel.tsx` shipped a claim
     * about in both directions.
     */
    expect(name).toMatch(/font-size:\s*22px\s*;/u)
    expect(name, "500 against the title-led card's 600 -- the eyebrow above pays for the lighter weight")
      .toMatch(/font-weight:\s*500\s*;/u)
    expect(name).toMatch(/letter-spacing:\s*-0\.015em\s*;/u)
  })

  it("reads the eyebrow's size off the token rather than repeating 14px", () => {
    const eyebrow = ruleBody('[data-shell-role="coach"] .coach-data-panel__eyebrow')

    // `--coach-eyebrow` shipped at 12px against a 14px token for a whole redesign pass, because
    // two places held one number and only one was ever read. A literal here would be that again.
    expect(eyebrow, "the eyebrow is --coach-eyebrow, the same role the deck panel wears")
      .toMatch(/font-size:\s*var\(--coach-eyebrow\)/u)
    expect(eyebrow, "the 4px above the name is what the canvas draws on all three")
      .toMatch(/margin-bottom:\s*4px\s*;/u)
  })

  /*
   * The per-artboard attestation check that used to sit here read the design canvas, which is not
   * part of this repository. It validated only that drawing, so it was removed rather than
   * weakened; the CSS-derived assertions above are the checks that describe the shipped product.
   */

  it("holds every caller of the arm, because the sheet that styles it is scoped", () => {
    const found = sourceFiles().filter(
      (file) => !/\.test\.tsx?$/u.test(file) && readFileSync(resolve(ROOT, file), "utf8").includes('scale="coach-data"'),
    )

    expect(
      found.filter((file) => !(file in CALLERS)),
      "this surface mounts the wide data panel but is not registered here. Add it with the "
        + "artboard it is drawn on, and confirm it renders under [data-shell-role=\"coach\"] -- "
        + "outside that root coach.css reaches nothing and the band renders unstyled, with no "
        + "error anywhere.",
    ).toEqual([])

    // The register may only shrink by a caller genuinely leaving, never by rotting into a list of
    // files that stopped using the arm years ago.
    for (const file of Object.keys(CALLERS)) {
      expect(found, `${file} no longer mounts the arm -- delete its CALLERS row`).toContain(file)
    }
  })

  it("keeps the recipe in one place, with no component respelling its numbers", () => {
    /*
     * The hole this closes is real and it is in the neighbouring guard.
     * `coach-type-floor.test.ts` buckets headings that carry `leading-[1.25]` by size and weight,
     * and its branches are 22px/600, 20px-or-token/500, and 20px-or-token/anything. A hand-spelled
     * 22px/500 matches none of them and falls through all three silently -- so the recipe this
     * file owns is exactly the one that guard cannot see. Scanning for it here is what makes the
     * single home enforceable rather than merely intended.
     */
    const offenders = sourceFiles()
      .filter((file) => !/\.test\.tsx?$/u.test(file))
      .filter((file) => {
        const source = readFileSync(resolve(ROOT, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//gu, " ")
          .replace(/(?<!:)\/\/[^\n]*/gu, " ")
        return [...source.matchAll(/"[^"]*"/gu)].some(
          (match) =>
            match[0].includes("text-[22px]")
            && match[0].includes("font-[500]")
            && match[0].includes("leading-[1.25]"),
        )
      })

    expect(
      offenders,
      `the wide data panel's name is declared in ${RECIPE_HOME} as .coach-data-panel__name. A `
        + "component spelling 22px/500/1.25 by hand is a second home for a number one shape uses, "
        + "and it is invisible to coach-type-floor.test.ts, whose buckets do not cover 22px/500.",
    ).toEqual([])
  })
})
