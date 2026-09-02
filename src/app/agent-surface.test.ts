// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function sheet(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

const GLOBALS = sheet("src/app/globals.css");
const CONSUMER = sheet("src/app/consumer/consumer.css");
const MEET_YOUR_AGENT = sheet("src/components/meet-your-agent.css");

// The agent surface starts where the shared palette aliases are declared; everything above it
// is the Tailwind theme bridge, which legitimately names --color-* on :root.
const AGENT_SURFACE = GLOBALS.slice(GLOBALS.indexOf(".agent-shell,"));

/**
 * The system's own translucent-white overlay, which is not a palette.
 *
 * `docs/DESIGN.md` specifies three component recipes by literal value: the neutral chip is
 * `rgba(255,255,255,.03)`, the secondary button `rgba(255,255,255,.04)`, and the managed strip
 * `rgba(255,255,255,.02)`. They are written that way on purpose - white at a low alpha picks up
 * whatever face is beneath it, which is the same reason the hairlines are translucent slate rather
 * than an opaque line. A colour, hardcoded or not, is what this test is about; a neutral veil over
 * the card gradient is not a second palette and cannot drift out of step with one.
 */
const NEUTRAL_VEIL = /rgba\(255,\s*255,\s*255,\s*[0-9.]+\)/gu;

describe("agent surface palette", () => {
  it("carries no second hardcoded palette", () => {
    const literals = AGENT_SURFACE.replace(NEUTRAL_VEIL, "")
      .match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/gu) ?? [];
    expect(literals, literals.join(", ")).toEqual([]);
  });

  it("never shadows a product token on the subtree", () => {
    // --card is a surface, --muted is a text role, --accent is a fill. Redefining any of them
    // below :root hands nested kit components the wrong role - a surface value where they
    // expect ink - which is what the hardcoded midnight block used to do.
    for (const source of [AGENT_SURFACE, MEET_YOUR_AGENT, CONSUMER]) {
      for (const token of ["--card", "--muted", "--accent"]) {
        expect(source).not.toMatch(new RegExp(`^\\s*${token}:`, "mu"));
      }
    }
  });
});

/**
 * The 11px Floor Rule, quoted rather than paraphrased.
 *
 * `docs/DESIGN.md` reads: "No `--t-*` pixel token drops below 11px... The 9.5px overline and 10px
 * badge are utility classes on a mono face at wide tracking, not type tokens, and they carry no
 * prose." This file used to assert the floor with no exemption at all, citing the artifact's
 * shorter "Nothing below 11px" instead of the rule the design system actually settled on, and by
 * 2026-08-31 that had gone red on two sheets at once: the consumer stylesheet and the Meet Your
 * Agent sheet each declare the overline at 9.5px, both pinned there by `overline-size.test.ts`.
 * Two guards asserting opposite things is one guard too many, and the doc-backed, more specific
 * one is the survivor.
 *
 * So the floor now applies to prose sizes and exempts the label face by its own definition: mono,
 * uppercase, at one of the two sizes the rule names. A 9.5px sentence in Archivo still fails,
 * which is the thing the floor was ever protecting against.
 */
const LABEL_FACE_SIZES = new Set(["9.5", "10"]);

/** Split on braces so a size can be read together with the rest of its declaration block. */
function undersizedDeclarations(source: string): string[] {
  return source.split("}").flatMap((block) => {
    const found = /font-size:\s*([0-9.]+)px/u.exec(block);
    if (!found) return [];
    const size = found[1];
    if (Number.parseFloat(size) >= 11) return [];

    const isLabelFace = LABEL_FACE_SIZES.has(size)
      && /font-family:\s*var\(--font-mono\)/u.test(block)
      && /text-transform:\s*uppercase/u.test(block);

    return isLabelFace ? [] : [`font-size: ${size}px`];
  });
}

/**
 * Every stylesheet in the tree, found rather than listed.
 *
 * The floor used to be asserted against three sheets named by hand, which is how
 * `src/app/onboarding/onboarding.css` came to carry 24 declarations under it, four of them at 8 to
 * 8.5px, with a green type-floor test beside them. Both sheets that row named have since been
 * deleted in the stylesheet fold, so the declarations are gone; what has to not come back is a new
 * sheet arriving outside the list. Walking for them means a stylesheet is covered by existing.
 */
function stylesheets(directory: string): string[] {
  return readdirSync(resolve(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

const SHEETS = stylesheets("src").map(
  (path) => [relative("src", path), sheet(path)] as const,
);

describe("type floor", () => {
  it("finds every stylesheet in the tree, so none is guarded only by being listed", () => {
    const names = SHEETS.map(([name]) => name);
    // The three the floor used to name by hand, which the walk has to still be reaching.
    expect(names).toContain("app/globals.css");
    expect(names).toContain("app/consumer/consumer.css");
    expect(names).toContain("components/meet-your-agent.css");
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  it.each(SHEETS)("keeps every prose size in %s at 11px or above", (_name, source) => {
    const undersized = undersizedDeclarations(source);

    expect(
      undersized.map((match) => match[0]),
      undersized.map((match) => match[0]).join(", "),
    ).toEqual([]);
  });

  /** The exemption is for the label face only, so it has to be checkable in both directions. */
  it("still fails an undersized size that is not the mono label face", () => {
    expect(undersizedDeclarations(".x { font-size: 9.5px; }")).toEqual(["font-size: 9.5px"]);
    expect(undersizedDeclarations(
      ".x { font-family: var(--font-mono); font-size: 9.5px; text-transform: uppercase; }",
    )).toEqual([]);
    // 8px is nobody's label face.
    expect(undersizedDeclarations(
      ".x { font-family: var(--font-mono); font-size: 8px; text-transform: uppercase; }",
    )).toEqual(["font-size: 8px"]);
  });
});
