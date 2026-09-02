import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The overline is 9.5px and the badge is 10px, and they are different roles.
 *
 * `docs/DESIGN.md:333` defines the Overline as "mono 500, 9.5px, 0.09em, uppercase, --overline"
 * and the Badge/count on the next line as "mono 500, 10px, 0.08em". The kit shipped `Overline` at
 * 10px -- the badge's size wearing the overline's name -- with a docstring asserting that 10px was
 * "the arrangement `docs/DESIGN.md` describes". It was not, and the assertion is why the mistake
 * survived being read repeatedly: every reader who checked the claim found a claim rather than a
 * measurement.
 *
 * The artifact could not settle it. `500 10px 'IBM Plex Mono'` appears 44 times across the drawn
 * screens and `500 9.5px` appears 21, so both are genuinely drawn. When the
 * markup is ambiguous the named rule is the authority, which is the whole reason `docs/DESIGN.md`
 * has a Type Roles section at all.
 *
 * This pins the size at its source so the next conflation is a red test rather than a docstring.
 */

const SRC = new URL("../", import.meta.url).pathname;

const OVERLINE_PX = "9.5px";

describe("the overline size", () => {
  it("is 9.5px in the atomic, per DESIGN.md's type roles", () => {
    const type = readFileSync(`${SRC}components/kit/atomics/type.tsx`, "utf8");
    expect(type).toContain(`text-[${OVERLINE_PX}]`);
    expect(type).not.toContain("text-[10px]");
  });

  /**
   * The table header is an overline too, and it is written inline rather than through the atomic
   * because the header is a grid cell. That makes it the one place the size can drift unnoticed.
   */
  it("is the same 9.5px on the grid-table header, which hand-rolls the same role", () => {
    const grid = readFileSync(`${SRC}components/kit/atomics/grid-table.tsx`, "utf8");
    const header = grid.split("\n").find((line) => line.includes("uppercase text-[color:var(--overline)]"));
    expect(header).toBeDefined();
    expect(header).toContain(`text-[${OVERLINE_PX}]`);
  });

  /**
   * The consumer chat, which is now a coach-scale surface and therefore has no overline at all.
   *
   * This assertion used to run the other way: it required the four labels here -- the day divider,
   * the suggested-replies label, the brand panel's eyebrow and the booking card's lead-in -- to be
   * the console's 9.5px overline, because they had drifted onto `--t-over`, the legacy scale's
   * 11px sans version, and two different overlines on the one surface a lead actually sees was the
   * conflation this file exists to stop.
   *
   * `docs/DESIGN.md`'s Hierarchy section is now scoped to the owner console, and this surface is
   * not that. So the role is gone here rather than resized: the replacement is the coach scale's
   * 12px sentence-case eyebrow, and what this test pins is the absence. That is a stronger claim
   * than the one it replaces -- it forbids both overlines rather than choosing between them -- and
   * it is why moving the rule did not mean deleting an assertion.
   */
  it("carries no overline at all in the consumer stylesheet, which is coach scale now", () => {
    const consumer = readFileSync(`${SRC}app/consumer/consumer.css`, "utf8");

    // Neither the console's 9.5px mono overline nor the legacy 11px sans one, under any name.
    expect(consumer).not.toContain(`font-size: ${OVERLINE_PX}`);
    expect(consumer).not.toContain("var(--t-over)");
    expect(
      consumer,
      "an uppercase micro-label is the role itself, whatever size it is set at",
    ).not.toMatch(/text-transform:\s*uppercase/u);
  });

  /**
   * Meet Your Agent, the other stylesheet-driven surface, for the same reason.
   *
   * Six labels across the shell -- the restart control, the trace heading, the trace legend, the
   * receipt eyebrow, the technical-seams keys and the go-live kicker -- each wrote `--t-over` out
   * by hand. The sheet cannot reach the atomic, so the role was declared once and pinned here.
   *
   * A coach is the reader of this screen, so it moved to the coach scale with the rest of their
   * surfaces and the overline went with the console. The sheet runs to roughly 1500 lines, so
   * "nobody will retype it" is not a guarantee -- hence pinning the absence rather than trusting
   * it.
   */
  it("carries no overline at all under .agent-shell, which is coach scale now", () => {
    const globals = readFileSync(`${SRC}app/globals.css`, "utf8");
    const sheet = globals.slice(globals.indexOf(".agent-shell,"), globals.indexOf("@keyframes thinking-blip"));

    // The positive control: this slice is the sheet, not an empty string from a moved marker.
    expect(sheet.length, "the .agent-shell block was not found, so nothing below was checked")
      .toBeGreaterThan(500);

    expect(sheet).not.toContain(`font-size: ${OVERLINE_PX}`);
    expect(sheet).not.toContain("var(--t-over)");
  });

  /**
   * The authority itself, so a doc edit that moves the rule fails here rather than silently.
   *
   * It now pins the scoping as well as the size. The recipe alone is no longer the whole rule:
   * without the sentence saying which surface it governs, a reader would take the console's
   * density for the product's, which is exactly the mistake that put thirteen 9.5px labels on
   * coach Home.
   */
  it("matches the rule it cites in docs/DESIGN.md, including which surface it governs", () => {
    const design = readFileSync(`${SRC}../docs/DESIGN.md`, "utf8");
    expect(design).toContain("**Overline** (mono 500, 9.5px, `0.09em`");
    expect(
      design,
      "the Hierarchy section must say it is the console's, or the two scales collapse again",
    ).toContain("governs the owner console, and only the owner console");
  });
});
