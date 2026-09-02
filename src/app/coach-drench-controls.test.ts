// @vitest-environment node

/**
 * What a control and a tone can resolve to inside a coach drenched panel.
 *
 * `tokens-contrast.test.ts` measures the roles a drench redeclares, and `fix-admin-drench` owns the
 * guard in there that asserts the *set* of redeclared roles is complete across both stylesheets.
 * This file is the other half and deliberately a different question: given the values the drench
 * does declare, does a control painted on that ground still read as a control, and is the ground a
 * tone lands on actually the ground its colour was authored against. Two writers in one file is why
 * this is here rather than appended there; the contrast maths below is the same technique as that
 * file's, restated rather than imported because its helpers are module-local.
 *
 * ## The two defects this exists for, both found on 2026-09-01
 *
 * **The accent pair.** The drench block redeclared the four text roles, then the grounds, and never
 * the accent pair, so the go-live primary in `coach-agent-preview.tsx` painted `--accent-fill` --
 * the drench's own blue -- onto the drench at 1.10:1 against the panel. The quiet control beside it
 * takes `--well`, which the drench remaps to a white alpha, and measured 1.24:1. The loud control
 * was the harder of the two to see.
 *
 * So the assertion is the **ordering**, not a floor. A floor alone was satisfiable by nudging the
 * blue and cannot express what was wrong: a primary that reads as less of a control than the
 * secondary beside it. Both faces composite over both stops of both coach drenches, and the primary
 * has to be further off the ground than the quiet control on every one of them.
 *
 * **The opaque ground.** The tone text roles the drench redeclares are near-white, authored against
 * the drench. Six of the seven tone washes are alphas, so they tint the drench and the text stays
 * legible on them. `--critical-wash` and `--info-wash` are opaque in both palettes, so inside a
 * drench they keep the *page* palette's ground -- near-white under the light palette -- and put
 * near-white text on it at 1.03:1. A role can therefore be redeclared, correct in isolation, and
 * still land on a ground that makes it invisible, which no completeness check over the role set can
 * see. This measures the pairing.
 *
 * ## Which side of the transcription line this sits on
 *
 * The palette tables in `tokens-contrast.test.ts` are transcribed on purpose: parsing a token and
 * comparing it to itself proves nothing. This is the other case. Every value here is read out of
 * `tokens.css` and `coach.css`, but each assertion measures a *relationship between two independent
 * declarations* -- a face against the ground under it, a text role against the wash under it -- and
 * reading both sides is exactly what makes that real. A transcribed face would go stale the first
 * time somebody restyles the button, which is the event this exists to catch.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** An opaque token, as authored. */
type Oklch = readonly [l: number, c: number, h: number];
/** A translucent token: 8-bit sRGB channels plus alpha, as authored. */
type Rgba = readonly [r: number, g: number, b: number, a: number];

/** OKLCH to gamma-encoded sRGB, each channel 0..1. */
function srgb([L, C, hDeg]: Oklch): readonly [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((linear) => {
    const clamped = Math.min(1, Math.max(0, linear));
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  }) as unknown as readonly [number, number, number];
}

function luminance(colour: readonly [number, number, number]): number {
  const [r, g, b] = colour.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** A translucent value composited over the ground it is painted on. Opaque values pass through. */
function over(colour: Rgba | Oklch, ground: Oklch): readonly [number, number, number] {
  if (colour.length === 3) return srgb(colour);
  const [r, g, b, alpha] = colour;
  const base = srgb(ground);
  return [r / 255, g / 255, b / 255].map(
    (channel, index) => base[index] + alpha * (channel - base[index]),
  ) as unknown as readonly [number, number, number];
}

/** `oklch(l c h)` or `rgba(r, g, b, a)` as authored, to a tuple. */
function parse(value: string): Rgba | Oklch | null {
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  if (oklch) return oklch.slice(1, 4).map(Number) as unknown as Oklch;

  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value.trim());
  return rgba ? (rgba.slice(1, 5).map(Number) as unknown as Rgba) : null;
}

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

const GRAPHICAL_FLOOR = 3;
const SMALL_TEXT_FLOOR = 4.5;

const COACH_CSS = stripComments(
  readFileSync(new URL("./(workspace)/coach/coach.css", import.meta.url), "utf8"),
);
const TOKENS_CSS = stripComments(readFileSync(new URL("./tokens.css", import.meta.url), "utf8"));
const COACH_AGENT_PREVIEW = readFileSync(
  new URL("../components/workspace/live/coach-agent-preview.tsx", import.meta.url),
  "utf8",
);

/** Every declaration in `body`, in the order it is authored. */
function declarations(body: string) {
  return new Map(
    Array.from(body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi), ([, name, value]) => [
      name,
      value.trim(),
    ]),
  );
}

/** The body of the first block after `marker` whose declarations satisfy `accept`. */
function blockBody(text: string, marker: string, accept: (body: string) => boolean) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of text.matchAll(new RegExp(`^[ \\t]*${escaped}(?=[,{\\s])`, "gm"))) {
    const open = text.indexOf("{", (match.index ?? 0) + match[0].length);
    let depth = 0;
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      if (text[index] === "}") depth -= 1;
      if (depth !== 0) continue;

      const body = text.slice(open + 1, index);
      if (accept(body)) return body;
      break;
    }
  }
  return "";
}

/** The stops of a coach drench gradient, read from its one declaration. */
function coachDrenchStops(name: string): Oklch[] {
  const matches = Array.from(COACH_CSS.matchAll(new RegExp(`--${name}\\s*:\\s*([^;]+);`, "g")));
  expect(
    matches,
    `--${name} must be declared exactly once in coach.css. A duplicate at equal specificity leaves a value nothing paints where the next reader looks first.`,
  ).toHaveLength(1);
  const stops = Array.from(matches[0][1].matchAll(/oklch\([^)]*\)/g), ([stop]) => parse(stop));
  expect(stops.length, `--${name} declares gradient stops`).toBeGreaterThan(1);
  return stops as Oklch[];
}

const STOPS = [
  ...coachDrenchStops("coach-drench-info").map((stop, index) => ({
    ground: `--coach-drench-info stop ${index + 1}`,
    stop,
  })),
  ...coachDrenchStops("coach-drench-live").map((stop, index) => ({
    ground: `--coach-drench-live stop ${index + 1}`,
    stop,
  })),
];

/** The token overrides the drenched subtree carries. */
const DRENCH_BLOCK = declarations(
  blockBody(COACH_CSS, '[data-shell-role="coach"] .coach-panel[data-drench]', (body) =>
    /--well\s*:/.test(body),
  ),
);

describe("the coach drench does not invert its own emphasis", () => {
  /** The token the quiet control beside the primary paints, as the drench remaps it. */
  const quietFace = parse(DRENCH_BLOCK.get("--well") ?? "");

  /** The rules that invert an accent-painted control inside the drench. */
  const inversions = Array.from(COACH_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)).filter(
    ([, selector]) =>
      selector.includes(".coach-panel[data-drench]") && selector.includes("--accent-fill"),
  );

  it("finds the drench, its quiet control, and the inversion rule to measure", () => {
    // Every assertion below is vacuous if any of these is missing, so none of them is assumed.
    expect(STOPS.length, "coach drench gradient stops").toBe(4);
    expect(quietFace, "--well as the drench remaps it").not.toBeNull();
    expect(inversions, "rules inverting an accent face inside a coach drench").toHaveLength(1);
  });

  const [[, selector, body]] = inversions;
  const face = parse(/background\s*:\s*([^;]+);/.exec(`${body};`)?.[1] ?? "");
  const ink = parse(/(?:^|[;{\s])color\s*:\s*([^;]+);/.exec(`${body};`)?.[1] ?? "");
  const border = parse(/border-color\s*:\s*([^;]+);/.exec(`${body};`)?.[1] ?? "");

  it("paints a face, an ink and an edge the rule can be measured on", () => {
    expect(face, `${selector.trim()} declares a background`).not.toBeNull();
    expect(ink, `${selector.trim()} declares a colour`).not.toBeNull();
    expect(border, `${selector.trim()} declares a border-color`).not.toBeNull();
  });

  /*
   * The selector matches on the class string, which is matching on what a thing is called rather
   * than on what it is -- see the tradeoff written out at the rule in `coach.css`. This is the half
   * of that tradeoff a stylesheet cannot carry: if the utility is renamed on either side, the rule
   * silently stops reaching the button, and nothing about the CSS would say so.
   */
  it("matches the class the go-live primary actually writes", () => {
    const matched = Array.from(selector.matchAll(/\[class\*="([^"]+)"\]/g), ([, text]) => text);
    expect(matched.length, "class substrings the selector matches on").toBeGreaterThan(0);

    const primary = /const PRIMARY_BUTTON_CLASS =([\s\S]*?);\n/.exec(COACH_AGENT_PREVIEW)?.[1];
    expect(primary, "PRIMARY_BUTTON_CLASS in coach-agent-preview.tsx").toBeDefined();
    expect(
      matched.filter((text) => (primary ?? "").includes(text)),
      `coach.css inverts ${matched.map((text) => `\`${text}\``).join(" and ")} inside a drench, but the go-live primary writes none of them, so the rule reaches nothing. Its class is: ${primary?.trim()}`,
    ).not.toHaveLength(0);
  });

  it.each(STOPS)("reads as a control on $ground", ({ ground, stop }) => {
    const ratio = contrast(over(face as Rgba, stop), srgb(stop));
    expect(
      ratio,
      `the inverted primary on ${ground} is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(GRAPHICAL_FLOOR);
  });

  it.each(STOPS)("prints its own label legibly on $ground", ({ ground, stop }) => {
    const ratio = contrast(srgb(ink as Oklch), over(face as Rgba, stop));
    expect(
      ratio,
      `the primary's label on its face over ${ground} is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(SMALL_TEXT_FLOOR);
  });

  /**
   * The assertion the original defect fails. A primary that sits closer to the ground than the
   * quiet control beside it is the emphasis inverted, whatever its absolute ratio is.
   */
  it.each(STOPS)("stands further off $ground than the quiet control does", ({ ground, stop }) => {
    const loud = contrast(over(face as Rgba, stop), srgb(stop));
    const quiet = contrast(over(quietFace as Rgba, stop), srgb(stop));
    expect(
      loud,
      `on ${ground} the primary is ${loud.toFixed(2)}:1 off the panel and the quiet control beside it is ${quiet.toFixed(2)}:1. The loud control has to be the louder one.`,
    ).toBeGreaterThan(quiet);
  });

  it.each(STOPS)("keeps an edge that is visible on $ground", ({ ground, stop }) => {
    const ratio = contrast(over(border as Rgba, stop), srgb(stop));
    expect(ratio, `the primary's edge on ${ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThan(1.2);
  });
});

/**
 * A tone inside a drench lands on a ground its colour was authored against.
 *
 * The drench redeclares the tone text roles near-white, because the ground is dark in both palettes.
 * A wash that is an alpha tints that ground and the pairing holds. A wash that is *opaque* does not:
 * it keeps whichever palette is live, and under the light palette `--critical-wash` and
 * `--info-wash` are near-white, so a redeclared near-white text role lands on them at 1.03:1.
 *
 * This is the failure a completeness check over the role set cannot see -- every role present, every
 * value right on its own, and the pair still illegible -- so it is measured as a pair.
 */
describe("a tone inside the coach drench lands on a ground it was authored against", () => {
  /** The tone pairs `tone.ts` maps, as token names. */
  const TONES = ["accent", "good", "warning", "waiting", "draft", "failure", "critical"] as const;

  /** The light palette, which is where an opaque wash is near-white and so the worst case. */
  const LIGHT = declarations(
    blockBody(TOKENS_CSS, ":root", (body) => /--canvas\s*:/.test(body)),
  );

  /** What a token resolves to inside the drench: the override if there is one, else the palette. */
  function inDrench(name: string) {
    return DRENCH_BLOCK.get(name) ?? LIGHT.get(name);
  }

  it("finds the palette and the drench overrides to pair up", () => {
    expect(LIGHT.size, "declarations in the light palette").toBeGreaterThan(50);
    expect(DRENCH_BLOCK.size, "declarations in the coach drench block").toBeGreaterThan(4);
    for (const tone of TONES) {
      expect(inDrench(`--${tone}-text`), `--${tone}-text resolves inside the drench`).toBeDefined();
      expect(inDrench(`--${tone}-wash`), `--${tone}-wash resolves inside the drench`).toBeDefined();
    }
  });

  it.each(TONES.flatMap((tone) => STOPS.map(({ ground, stop }) => ({ tone, ground, stop }))))(
    "reads --$tone-text on --$tone-wash over $ground",
    ({ tone, ground, stop }) => {
      const text = parse(inDrench(`--${tone}-text`) ?? "");
      const wash = parse(inDrench(`--${tone}-wash`) ?? "");
      expect(text, `--${tone}-text is a colour this can measure`).not.toBeNull();
      expect(wash, `--${tone}-wash is a colour this can measure`).not.toBeNull();

      const ratio = contrast(over(text as Rgba, stop), over(wash as Rgba, stop));
      expect(
        ratio,
        `--${tone}-text on --${tone}-wash over ${ground} is ${ratio.toFixed(2)}:1. An opaque wash keeps the page palette's ground inside a drench, so a text role authored against the drench lands on a ground from the other palette.`,
      ).toBeGreaterThanOrEqual(SMALL_TEXT_FLOOR);
    },
  );
});
