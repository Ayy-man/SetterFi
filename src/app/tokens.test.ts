import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const TOKENS_PATH = fileURLToPath(new URL("./tokens.css", import.meta.url));
const source = readFileSync(TOKENS_PATH, "utf8");

function stripComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Find the rule a selector opens, and return its body.
 *
 * A marker is a selector, and a selector only means itself when it stands alone: at the start of its
 * line, and ended by a comma, a brace or whitespace. Matched as a bare substring -- which is what
 * this did -- it silently resolves inside a longer selector. `[data-theme="light"]` landed inside
 * `:root:not([data-theme="light"])`, so the block this file called `lightIsland` was the system-dark
 * block read a second time and the forced-light island went unchecked by every guard that named it.
 * `:root` is a prefix of both `:root:not(...)` and `:root[data-theme="dark"]` and was correct only
 * because the bare block happens to sit first in the file; a `:root:not(...)` rule added above it
 * would have pointed every light-labelled assertion at the dark palette. The failure is silent in
 * both cases: you get a real block full of real tokens, so the assertions run and mostly pass.
 *
 * So the match is anchored, and ambiguity throws instead of quietly taking the first hit. A guard
 * helper that cannot say it is confused is how the island stayed unguarded.
 */
function blockAfter(css: string, marker: string, options: { declaring?: string } = {}) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = Array.from(css.matchAll(new RegExp(`^[ \\t]*${escaped}(?=[,{\\s])`, "gm")));
  const lineOf = (index: number) => css.slice(0, index).split("\n").length;

  const bodyAt = (matchIndex: number, matchLength: number) => {
    const openIndex = css.indexOf("{", matchIndex + matchLength);
    if (openIndex < 0) throw new Error(`Missing opening brace after: ${marker}`);

    let depth = 0;
    for (let index = openIndex; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") depth -= 1;
      if (depth === 0) return css.slice(openIndex + 1, index);
    }

    throw new Error(`Missing closing brace after: ${marker}`);
  };

  const candidates = matches
    .map((match) => ({ line: lineOf(match.index ?? 0), body: bodyAt(match.index ?? 0, match[0].length) }))
    .filter(({ body }) =>
      options.declaring ? new RegExp(`${options.declaring}\\s*:`).test(body) : true,
    );

  const named = options.declaring ? `${marker} declaring ${options.declaring}` : marker;
  if (candidates.length === 0) throw new Error(`Missing CSS marker: ${named}`);
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous CSS marker: ${named} opens ${candidates.length} rules, at lines ` +
        `${candidates.map(({ line }) => line).join(", ")}. Name the one you mean, with a ` +
        "`declaring` token if the selector alone cannot, rather than letting the first win.",
    );
  }

  return candidates[0].body;
}

/**
 * `tokens.css` opens two `:root` rules: the palette, and the type scale several hundred lines below
 * it. Both are legitimately `:root`, so the selector alone cannot say which one a palette assertion
 * means -- the old helper answered "whichever is first", which is a fact about file order rather
 * than about intent. Naming a token only the palette declares makes the choice explicit and survives
 * either block moving.
 */
const PALETTE_ROOT = { declaring: "--canvas" } as const;

function tokenNames(css: string) {
  return new Set(Array.from(css.matchAll(/(--[a-z0-9-]+)\s*:/gi), ([, name]) => name));
}

type Oklch = readonly [lightness: number, chroma: number, hue: number];

function tokenValues(css: string) {
  return new Map(
    Array.from(
      css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi),
      ([, name, value]) => [name, value.trim()] as const,
    ),
  );
}

function oklch(tokens: ReadonlyMap<string, string>, name: string): Oklch {
  const value = tokens.get(name);
  const match = value?.match(
    /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/[^)]*)?\s*\)$/i,
  );

  if (!match) throw new Error(`${name} must be a literal OKLCH colour, received ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance([lightness, chroma, hue]: Oklch): number {
  const hueRadians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (channel: number) => Math.max(0, Math.min(1, channel));
  const red = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: Oklch, background: Oklch): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

describe("design tokens contract", () => {
  it("defines every dark-theme token in the bare root palette", () => {
    const uncommentedSource = stripComments(source);
    const bareRoot = tokenNames(blockAfter(uncommentedSource, ":root", PALETTE_ROOT));
    const systemDark = tokenNames(
      blockAfter(
        blockAfter(uncommentedSource, "@media (prefers-color-scheme: dark)"),
        ":root:not([data-theme=\"light\"])",
      ),
    );
    const explicitDark = tokenNames(blockAfter(uncommentedSource, ":root[data-theme=\"dark\"]"));

    for (const token of new Set([...systemDark, ...explicitDark])) {
      expect(bareRoot, `${token} must exist in bare :root`).toContain(token);
    }
  });

  it("keeps raw hex literals inside comments", () => {
    expect(stripComments(source)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("keeps every pixel-valued type token at or above 11px", () => {
    /*
     * `--t-` marks a root scale that each shell re-authors, and type is almost all of it but not
     * all of it: `--t-target` is the minimum pressable target, a control metric that would be
     * judged here by prefix and has no business being read as a type size. Named the way
     * `coach-type-floor.test.ts:165` names its own, and for the reason given there -- listing what
     * to *check* omits silently, so the non-type ones are listed instead and anything new is
     * judged by default until someone declares otherwise.
     */
    const NOT_TYPE = ["--t-target"];

    const typeSizes = Array.from(
      source.matchAll(/(--t-[a-z-]+):\s*([0-9.]+)px\b/g),
      ([, declaration, value]) => ({ declaration, value: Number(value) }),
    ).filter(({ declaration }) => !NOT_TYPE.includes(declaration));

    // Counting them is what forces a new type token to be looked at rather than added quietly;
    // --t-hero (44px) is the sixteenth.
    expect(typeSizes).toHaveLength(16);
    for (const { declaration, value } of typeSizes) {
      expect(value, `${declaration} must be at least 11px`).toBeGreaterThanOrEqual(11);
    }
  });

  it("carries no font aliases now that the real faces are loaded", () => {
    // layout.tsx loads Geist / Geist Mono under exactly these variable names and
    // globals.css maps them onto --font-sans/--font-mono, so tokens.css must not
    // shadow either with an alias to another family.
    expect(source).not.toContain("--font-geist-sans:");
    expect(source).not.toContain("--font-geist-mono:");
    expect(source).not.toMatch(/geist/i);
  });

  it("orders all four text roles in both palettes with distinct contrast steps", () => {
    const uncommentedSource = stripComments(source);
    const palettes = {
      light: tokenValues(blockAfter(uncommentedSource, ":root", PALETTE_ROOT)),
      dark: tokenValues(blockAfter(uncommentedSource, ":root[data-theme=\"dark\"]")),
    };

    for (const [paletteName, palette] of Object.entries(palettes)) {
      const background = oklch(palette, "--canvas");
      const ratios = ["--ink", "--body", "--muted", "--faint"].map((role) => ({
        role,
        ratio: contrast(oklch(palette, role), background),
      }));

      for (let index = 0; index < ratios.length - 1; index += 1) {
        const louder = ratios[index];
        const quieter = ratios[index + 1];
        expect(
          louder.ratio - quieter.ratio,
          `${paletteName} ${louder.role} (${louder.ratio.toFixed(2)}) must exceed ${quieter.role} (${quieter.ratio.toFixed(2)}) by at least 1.3`,
        ).toBeGreaterThanOrEqual(1.3);
      }
    }
  });

  it("keeps every vertical-rhythm step on the 4px grid by aliasing a spacing rung", () => {
    // The three gap steps are named so a template can say *why* it leaves 12, 20 or 32px between
    // two blocks instead of repeating one anonymous number. They stay aliases on purpose: a raw
    // pixel value here is how a rhythm quietly drifts off the grid one screen at a time.
    const tokens = tokenValues(blockAfter(stripComments(source), ":root", PALETTE_ROOT));

    for (const step of ["--d-stack-gap", "--d-head-gap", "--d-section-gap"]) {
      expect(tokens.get(step), `${step} must alias a --s-* rung`).toMatch(/^var\(--s-\d+\)$/);
    }
  });

  it("keeps the two dark blocks byte-identical after comments and indentation", () => {
    // The toggle has to win in both directions, which only holds while the system-dark block and
    // the explicit-dark block declare the same tokens at the same values. Adding a token to one
    // and forgetting the other is the failure this catches; it is how --shadow-modal was added.
    const uncommentedSource = stripComments(source);
    const systemDark = tokenValues(
      blockAfter(
        blockAfter(uncommentedSource, "@media (prefers-color-scheme: dark)"),
        ':root:not([data-theme="light"])',
      ),
    );
    const explicitDark = tokenValues(blockAfter(uncommentedSource, ':root[data-theme="dark"]'));

    expect(Object.fromEntries(explicitDark)).toEqual(Object.fromEntries(systemDark));
  });

  it("defines every elevation rung in all four palettes", () => {
    // Elevation only encodes "temporarily over your work" if a surface can reach for the right
    // rung in whichever palette it renders under. A rung missing from one palette silently falls
    // back to the inherited value and the overlay reads flat in exactly one theme.
    const uncommentedSource = stripComments(source);
    const palettes = {
      light: blockAfter(uncommentedSource, ":root", PALETTE_ROOT),
      systemDark: blockAfter(
        blockAfter(uncommentedSource, "@media (prefers-color-scheme: dark)"),
        ':root:not([data-theme="light"])',
      ),
      explicitDark: blockAfter(uncommentedSource, ':root[data-theme="dark"]'),
      lightIsland: blockAfter(uncommentedSource, '[data-theme="light"]'),
    };

    for (const [name, block] of Object.entries(palettes)) {
      const names = tokenNames(block);
      for (const rung of ["--shadow-card", "--shadow-raised", "--shadow-drawer", "--shadow-modal", "--shadow-toast"]) {
        expect(names, `${rung} must be defined in the ${name} palette`).toContain(rung);
      }
      expect(names, `--scrim must be defined in the ${name} palette`).toContain("--scrim");
    }
  });

  it("defines every semantic state family in all four palettes", () => {
    // A state hue missing from one palette block does not fall back to a neutral, it falls back to
    // whatever the cascade last set, so a Draft pill would render in some other role's colour in
    // exactly one theme. The four families are declared together for the same reason the shadows
    // are: the forced-light island carries the dark palette today, and half-porting it is the bug.
    const uncommentedSource = stripComments(source);
    const palettes = {
      light: blockAfter(uncommentedSource, ":root", PALETTE_ROOT),
      systemDark: blockAfter(
        blockAfter(uncommentedSource, "@media (prefers-color-scheme: dark)"),
        ':root:not([data-theme="light"])',
      ),
      explicitDark: blockAfter(uncommentedSource, ':root[data-theme="dark"]'),
      lightIsland: blockAfter(uncommentedSource, '[data-theme="light"]'),
    };

    const families = [
      ["--warning", "--warning-text", "--warning-wash", "--warning-line"],
      ["--good", "--good-text", "--good-wash", "--good-line"],
      ["--waiting", "--waiting-text", "--waiting-wash", "--waiting-line"],
      ["--draft", "--draft-text", "--draft-wash", "--draft-line"],
      ["--failure", "--failure-text", "--failure-body", "--failure-wash", "--failure-line"],
    ];

    for (const [name, block] of Object.entries(palettes)) {
      const names = tokenNames(block);
      for (const token of families.flat()) {
        expect(names, `${token} must be defined in the ${name} palette`).toContain(token);
      }
    }
  });

  it("dresses the three modal backdrops in the scrim rather than a flat black", () => {
    // Base UI's sheet, dialog and alert-dialog each hardcode `bg-black/10`, which is invisible on
    // the navy dark canvas, so nothing ever read as above the page. The rule that overrides it has
    // to stay unlayered: a utility inside @layer utilities beats a layered element rule.
    const scrimRule = stripComments(source).match(
      /\[data-slot="sheet-overlay"\],\s*\[data-slot="dialog-overlay"\],\s*\[data-slot="alert-dialog-overlay"\]\s*\{([^}]*)\}/,
    );

    expect(scrimRule, "the modal backdrops must share one scrim rule").not.toBeNull();
    expect(scrimRule?.[1]).toContain("background: var(--scrim)");
    expect(scrimRule?.index).toBeGreaterThan(0);
  });

  it("keeps the scrim opaque enough to retire the page behind it in both themes", () => {
    const uncommentedSource = stripComments(source);
    const alphaOf = (block: string) => {
      const value = tokenValues(block).get("--scrim");
      const alpha = value?.match(/\/\s*([0-9.]+)\s*\)/);
      if (!alpha) throw new Error(`--scrim must carry an alpha, received ${value}`);
      return Number(alpha[1]);
    };

    // Anything under ~0.2 is the flat bg-black/10 problem again: a backdrop you cannot see is a
    // backdrop that does not say the page is out of reach. Dark needs more because it is dimming
    // a canvas that is already near-black.
    expect(alphaOf(blockAfter(uncommentedSource, ":root", PALETTE_ROOT))).toBeGreaterThanOrEqual(0.25);
    expect(
      alphaOf(blockAfter(uncommentedSource, ':root[data-theme="dark"]')),
    ).toBeGreaterThanOrEqual(0.45);
  });

  it("keeps the hairline tokens thin, and translucent over the card gradient", () => {
    // WCAG 1.4.11's 3:1 floor applies to meaningful component boundaries, not decorative
    // dividers and table rules, which is what --line draws. A previous version of this test
    // forced --line to oklch(0.620) and turned the artifact's thin-ruled surfaces into heavy
    // grey boxes on every screen. Inputs remain perceivable through their focus ring, labels,
    // and placeholder text. The design artifact (SetterFi Redesign) is the authority here.
    //
    // That artifact is now turn 3, "Navy, with depth", option 3c, and it draws every hairline
    // as one translucent slate over a card that is itself a --card-top to --card gradient. An
    // opaque line cannot do that job: it would sit at one lightness while the face beneath it
    // changes down the card, which is the seam the gradient exists to avoid. So the pin moves
    // from an exact OKLCH triple to the thing the old pin was actually protecting -- that the
    // hairline stays thin. Alpha is capped rather than fixed, and the channels are the
    // artifact's own slate, so making a rule heavy still fails here.
    // The two palettes cross opposite grounds, so one pair of numbers cannot pin both. A
    // hairline is a DARKENING of the face it crosses; the periwinkle at 0.14 lifts 1.209:1 off a
    // near-black card and 1.017:1 off a near-white one, which is to say it draws nothing on
    // light. So the light blocks take a darker slate, at an alpha solved to RENDER at the same
    // ratio -- 0.13 measures 1.208 -- and the pin holds each palette to its own value rather than
    // averaging them into a rule that fits neither.
    //
    // A previous revision of this comment put the dark hairline at 2.44:1 and set the light
    // alphas as high as 0.34 to "compensate". That figure was computed by compositing in linear
    // light; browsers composite in gamma-encoded sRGB, which is what tokens-contrast.test.ts's
    // over() does, and 0.34 there renders 1.692:1 -- so the pass that was meant to soften the
    // product shipped rules noticeably heavier than the ones it softened. Alpha is a means; the
    // measured lift is the thing, and it is measured in tokens-contrast.test.ts.
    const uncommentedSource = stripComments(source);
    const DARK_HAIRLINES = {
      channels: [120, 150, 200],
      cap: 0.2,
      alphas: { "--line": 0.14, "--line-soft": 0.07, "--line-input": 0.16, "--line-strong": 0.16 },
    } as const;
    const LIGHT_HAIRLINES = {
      channels: [60, 90, 150],
      cap: 0.2,
      alphas: { "--line": 0.13, "--line-soft": 0.06, "--line-input": 0.15, "--line-strong": 0.15 },
    } as const;

    for (const [marker, rule] of [
      [":root", LIGHT_HAIRLINES],
      ['[data-theme="light"]', LIGHT_HAIRLINES],
      [':root[data-theme="dark"]', DARK_HAIRLINES],
    ] as const) {
      const palette = tokenValues(blockAfter(uncommentedSource, marker, PALETTE_ROOT));
      for (const [token, alpha] of Object.entries(rule.alphas)) {
        // --line-strong is declared as an alias of --line-input, which is the role it plays:
        // the border an input carries. Follow one level of indirection rather than banning the
        // alias, so the two cannot drift apart by being written out twice.
        const declared = palette.get(token);
        expect(declared, `${marker} ${token} must be declared`).toBeDefined();
        const alias = /^var\((--[a-z-]+)\)$/.exec(declared ?? "");
        const value = alias ? palette.get(alias[1]) : declared;
        expect(value, `${marker} ${token} resolves to a declared token`).toBeDefined();
        const parsed = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value ?? "");
        expect(parsed, `${marker} ${token} must be a translucent rgba, received ${value}`).not.toBeNull();
        const [red, green, blue, parsedAlpha] = (parsed ?? []).slice(1).map(Number);
        expect([red, green, blue], `${marker} ${token} channels`).toEqual([...rule.channels]);
        expect(parsedAlpha, `${marker} ${token} alpha`).toBeCloseTo(alpha, 3);
        expect(parsedAlpha, `${marker} ${token} must stay a hairline`).toBeLessThanOrEqual(rule.cap);
      }
    }
  });
  /**
   * Alec's 2026-09-01 reversal, held rather than asserted.
   *
   * He asked for "the white and blue colors" back and for the product to look softer. Two things
   * came out of that call and neither had a test until this one: the accent moved from teal at
   * hue 218 to blue at 264, and the bare `:root` block plus the forced-light island became a real
   * light palette instead of the dark values they had carried deliberately.
   *
   * The accent assertion covers all four palettes on purpose. The teal existed precisely so one
   * accent could serve both design languages, so walking one palette back to 218 while the others
   * stay at 264 splits the accent in exactly the way the single hue was chosen to avoid -- and
   * that is a change nothing else in this file would notice, because every existing guard checks
   * contrast and ordering, both of which a hue rotation leaves intact.
   *
   * The lightness assertion is what stops the light palette quietly reverting. `tokens.css` used
   * to carry the dark values in all four blocks by design, and the comment saying so is still in
   * the file's history; pasting them back would restore a state this file once considered correct
   * and would pass every other assertion here, since a palette that is dark everywhere is
   * perfectly self-consistent. So the two light blocks are held above a ground floor and the two
   * dark ones below a ceiling, with a gap between the bounds wide enough that no legitimate
   * tuning trips it.
   */
  it("keeps the accent one blue across all four palettes, and the light palettes light", () => {
    const uncommentedSource = stripComments(source);
    const palettes = {
      ":root": blockAfter(uncommentedSource, ":root", PALETTE_ROOT),
      'system dark': blockAfter(
        blockAfter(uncommentedSource, "@media (prefers-color-scheme: dark)"),
        ':root:not([data-theme="light"])',
      ),
      'explicit dark': blockAfter(uncommentedSource, ':root[data-theme="dark"]'),
      'forced light': blockAfter(uncommentedSource, '[data-theme="light"]'),
    } as const;

    for (const [name, body] of Object.entries(palettes)) {
      const [, , hue] = oklch(tokenValues(body), "--accent");
      expect(hue, `${name} --accent must stay the blue at hue 264, not the retired teal at 218`)
        .toBeGreaterThan(255);
      expect(hue, `${name} --accent must stay the blue at hue 264`).toBeLessThan(275);
    }

    for (const name of [":root", "forced light"] as const) {
      const [lightness] = oklch(tokenValues(palettes[name]), "--canvas");
      expect(lightness, `${name} --canvas must be a light ground, per Alec's 2026-09-01 call`)
        .toBeGreaterThan(0.8);
    }

    for (const name of ["system dark", "explicit dark"] as const) {
      const [lightness] = oklch(tokenValues(palettes[name]), "--canvas");
      expect(lightness, `${name} --canvas must stay dark so the toggle wins in both directions`)
        .toBeLessThan(0.4);
    }
  });
});
