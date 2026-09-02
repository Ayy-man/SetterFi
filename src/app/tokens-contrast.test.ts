// @vitest-environment node

/**
 * The contrast floor for every colour the console draws data and state in.
 *
 * The chart series and the semantic hues are the two places this product puts colour to work, and
 * `tokens.css` carries a ratio in a comment beside most of them, which is exactly the kind of claim
 * that goes stale the first time somebody nudges a lightness by 0.02 and does not recompute. This
 * recomputes.
 *
 * Two floors, from WCAG:
 *
 *  - **3:1** for a chart series, a status dot, or a disqualifier dash -- non-text graphical objects
 *    (1.4.11). These are read as shapes and as position, never as prose.
 *  - **4.5:1** for pill text on its own wash, which is small text (1.4.3).
 *
 * The values below are transcribed from `tokens.css` rather than parsed out of it. Parsing would
 * make the test self-fulfilling: it would read whatever the stylesheet says and compare it to
 * itself. Transcribed, a token change that lowers contrast fails here until somebody re-reads the
 * number and agrees to it, which is the point.
 *
 * **The cost of transcribing is that it drifts silently, so re-measure when the palette moves.**
 * This is not hypothetical. Before the artifact palette landed, `dark.canvas` here still read
 * `[0.155, 0.013, 264]` against an actual `oklch(0.177 0.034 270)` -- the test was green while
 * describing a ground no browser rendered, which buys false confidence rather than coverage. If you
 * change a colour in `tokens.css`, change it here too, or this file stops being able to see.
 *
 * ## Two palettes, because there are now two
 *
 * This file said "there is no light palette" until 2026-09-01, and it was right when it was
 * written: all four blocks of `tokens.css` carried the artifact's dark values. Then Alec asked for
 * "the white and blue colors" back, a real light palette landed in the bare `:root` block and the
 * forced-light island, and the two dark blocks kept theirs. The paragraph stayed, the table stayed
 * dark, and the test stayed green -- measuring the two blocks that had not moved while the default
 * palette every browser renders had zero contrast coverage. That is exactly the failure the
 * paragraph above predicts, in the same file, for the second time.
 *
 * So both palettes are transcribed and every assertion runs against both.
 *
 * **The worst-case ground flips between them, and that is not cosmetic.** In the dark palette the
 * pill text is light and sits on a card face that is a gradient, so the lit upper stop
 * (`--card-top`) is the hardest ground to read on. In the light palette the text is dark, so the
 * near-white card face is the easiest ground and the shell (`--canvas`) is the hardest. Measuring
 * light pill text against `--card-top` would have reported the best case as if it were the floor,
 * which is a guard that cannot see in a different costume. Each palette therefore names the ground
 * its own text-on-wash assertions run against.
 */

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** An opaque token, as authored in `tokens.css`. */
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

/**
 * A wash is what a pill is actually drawn on, and every wash in the artifact palette but one is
 * translucent, so the wash alone is not a colour anybody sees. Compositing it over the ground makes
 * the measurement answer the question the pill poses -- "can I read this label where it sits" --
 * rather than the question the old opaque transcription answered, which nobody asked.
 */
function over(wash: Rgba | Oklch, ground: Oklch): readonly [number, number, number] {
  if (wash.length === 3) return srgb(wash);
  const [r, g, b, alpha] = wash;
  const base = srgb(ground);
  return [r / 255, g / 255, b / 255].map(
    (channel, index) => base[index] + alpha * (channel - base[index]),
  ) as unknown as readonly [number, number, number];
}

/**
 * The two dark blocks of `src/app/tokens.css` (`@media (prefers-color-scheme: dark)` and
 * `[data-theme="dark"]`), which carry identical values.
 * Opaque values are the authored OKLCH triples; translucent ones are the authored rgba.
 */
const DARK = {
  canvas: [0.1342, 0.0172, 262.2],
  card: [0.1802, 0.0325, 266.6],
  /** The lit upper stop of the card gradient, and so the worst case for anything drawn on a card. */
  "card-top": [0.2196, 0.0421, 263.2],
  "t-data-1": [0.8148, 0.085, 264],
  "t-data-2": [0.7, 0.028, 262],
  "t-data-3": [0.78, 0.12, 75],
  good: [0.6718, 0.066, 164.1],
  "good-text": [0.8074, 0.0468, 162.2],
  warning: [0.6633, 0.0955, 71.2],
  "warning-text": [0.7971, 0.0738, 69.8],
  critical: [0.74, 0.14, 25],
  "critical-text": [0.74, 0.14, 25],
  /* Not the retired teal at hue 209.4. This entry described a colour no block carried from the
     day the accent moved to blue, and it is the drift the docstring above warns about. */
  "accent-text": [0.8586, 0.062, 265],
  negative: [0.5334, 0.0774, 34.8],
  waiting: [0.7135, 0.0843, 271.1],
  "waiting-text": [0.8167, 0.0525, 270.7],
  draft: [0.6315, 0.1143, 291.7],
  "draft-text": [0.7747, 0.0715, 295.7],
  failure: [0.6848, 0.0854, 31.4],
  "failure-text": [0.7733, 0.0642, 33.3],
  /** The sentence under the numeral -- "Card declined, retry 2 of 4" -- not the numeral itself. */
  "failure-body": [0.747, 0.0304, 39.3],
  /** The two text roles a group band prints in: its label and its annotation. */
  muted: [0.7709, 0.0342, 262.7],
  faint: [0.687, 0.0466, 262.3],
} as const satisfies Record<string, Oklch>;

const DARK_WASHES = {
  "good-wash": [111, 163, 139, 0.11],
  "warning-wash": [184, 137, 78, 0.14],
  "accent-wash": [70, 110, 215, 0.14],
  "waiting-wash": [143, 160, 216, 0.1],
  "draft-wash": [139, 124, 201, 0.13],
  "failure-wash": [201, 134, 121, 0.14],
  /** The one opaque wash left: --critical is not a hue the artifact spends, so it kept its value. */
  "critical-wash": [0.26, 0.06, 22],
  /** The group / header band inside a table. Translucent so it lifts off both ends of the card
      gradient by the same amount; the alias it replaced (--quiet) lifted 1.02:1 off --card. */
  band: [143, 170, 220, 0.09],
} as const satisfies Record<string, Rgba | Oklch>;

/**
 * The bare `:root` block of `src/app/tokens.css` and the `[data-theme="light"]` island, which
 * carry identical values. This is the palette a browser renders by default, so it is the one an
 * uncovered contrast failure would actually ship in.
 */
const LIGHT = {
  canvas: [0.9612, 0.0042, 262],
  card: [0.9905, 0.0026, 262],
  /** The lit upper stop of the card gradient. Up here it is the near-white end, so for the dark
      foregrounds this palette draws in it is the easiest ground rather than the worst case. */
  "card-top": [0.9975, 0.0016, 262],
  "t-data-1": [0.47, 0.16, 264],
  "t-data-2": [0.56, 0.03, 262],
  "t-data-3": [0.56, 0.12, 75],
  good: [0.6237, 0.095, 164],
  "good-text": [0.4992, 0.09, 164],
  warning: [0.6409, 0.115, 71],
  "warning-text": [0.5183, 0.105, 71],
  critical: [0.6537, 0.155, 25],
  "critical-text": [0.5244, 0.15, 25],
  "accent-text": [0.44, 0.165, 264],
  negative: [0.585, 0.135, 32],
  waiting: [0.6398, 0.115, 271],
  "waiting-text": [0.5152, 0.105, 271],
  draft: [0.6466, 0.135, 292],
  "draft-text": [0.5212, 0.125, 292],
  failure: [0.6503, 0.135, 32],
  "failure-text": [0.5239, 0.125, 32],
  "failure-body": [0.47, 0.075, 39],
  muted: [0.3604, 0.036, 262],
  faint: [0.4349, 0.039, 262],
} as const satisfies Record<string, Oklch>;

const LIGHT_WASHES = {
  "good-wash": [36, 132, 96, 0.09],
  "warning-wash": [176, 116, 32, 0.1],
  "accent-wash": [46, 92, 200, 0.07],
  "waiting-wash": [92, 110, 196, 0.09],
  "draft-wash": [124, 96, 204, 0.1],
  "failure-wash": [196, 86, 66, 0.1],
  /** Opaque here too: a callout ground rather than a film over a card. */
  "critical-wash": [0.956, 0.024, 25],
  /** Darker channels than the dark palette's, because a band over a near-white card has to darken
      it -- the periwinkle at 0.1 measures 1.096:1 here, just under the floor below. The alpha is
      solved so this band RENDERS at dark's ratio (1.155 against 1.142) rather than reusing dark's
      number, which over the opposite ground would draw a visibly heavier band. */
  band: [60, 90, 150, 0.1],
} as const satisfies Record<string, Rgba | Oklch>;

/**
 * The two palettes, each with the ground its own text-on-wash worst case lands on.
 *
 * `textGround` is the whole reason this is a table rather than two copies of the same loop. Dark
 * pill text is light and reads worst against the card gradient's lit stop; light pill text is dark
 * and reads worst against the shell, which is the darkest ground it can sit on. Pointing both at
 * one ground would make one of the two measure its best case and report it as the floor.
 */
const PALETTES = [
  { name: "dark", tokens: DARK, washes: DARK_WASHES, textGround: "card-top" },
  { name: "light", tokens: LIGHT, washes: LIGHT_WASHES, textGround: "canvas" },
] as const;

const GROUNDS = ["canvas", "card"] as const;
/** The dash answers to the gradient's lit end too, so it is held to every ground it can land on. */
const NEGATIVE_GROUNDS = ["canvas", "card", "card-top"] as const;
/**
 * The three state hues the fifteen extracted screens added. Their dots sit inside cards as often as
 * on the pane, so like the dash they are held to the gradient's lit end as well.
 */
const STATE_GROUNDS = NEGATIVE_GROUNDS;
const GRAPHICAL_FLOOR = 3;
const SMALL_TEXT_FLOOR = 4.5;

describe.each(PALETTES)("token contrast, $name palette", ({ tokens, washes, textGround }) => {
  it.each(
    GROUNDS.flatMap((ground) =>
      (["t-data-1", "t-data-2", "t-data-3"] as const).map((series) => ({ ground, series })),
    ),
  )("draws --$series legibly on --$ground", { timeout: 15_000 }, ({ ground, series }) => {
    const ratio = contrast(srgb(tokens[series]), srgb(tokens[ground]));
    expect(ratio, `--${series} on --${ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      GRAPHICAL_FLOOR,
    );
  });

  it.each(
    GROUNDS.flatMap((ground) =>
      (["good", "warning", "critical"] as const).map((hue) => ({ ground, hue })),
    ),
  )("keeps the --$hue dot visible on --$ground", { timeout: 15_000 }, ({ ground, hue }) => {
    const ratio = contrast(srgb(tokens[hue]), srgb(tokens[ground]));
    expect(ratio, `--${hue} on --${ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      GRAPHICAL_FLOOR,
    );
  });

  /**
   * Pill text sits on its wash, and the wash sits on a ground. Which ground is the worst case
   * depends on the palette, so `textGround` decides: `--card-top` in the dark, where the text is
   * light and the card gradient's lit stop is the hardest thing to be read against, and
   * `--canvas` in the light, where the text is dark and the shell is the darkest ground it lands
   * on.
   */
  it.each(
    (["good", "warning", "critical", "accent", "waiting", "draft", "failure"] as const).map(
      (hue) => ({ hue }),
    ),
  )(
    "reads --$hue-text as small text on its wash",
    { timeout: 15_000 },
    ({ hue }) => {
      const ground = over(washes[`${hue}-wash`], tokens[textGround]);
      const ratio = contrast(srgb(tokens[`${hue}-text`]), ground);
      expect(
        ratio,
        `--${hue}-text on --${hue}-wash over --${textGround} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(SMALL_TEXT_FLOOR);
    },
  );

  /**
   * --negative is a shape token and must never be used for text. It draws one thing: the 14x2px
   * rounded disqualifier dash (ARTIFACT-SPEC.md section 6), which is a non-text graphical object and
   * so answers to 1.4.11's 3:1 rather than 1.4.3's 4.5:1. As text it would fail AA instantly.
   *
   * All three grounds are asserted, --card-top included, because the card face is a gradient and a
   * dash may land anywhere down it. That is why the token deviates from the artifact: the authored
   * #8a5548 measured 2.87:1 on --card-top, so keeping it would have meant a placement rule saying
   * "fine as long as nobody moves this into the top of a card" -- a constraint with no enforcement,
   * guarding a failure invisible to whoever ships it. The hue is walked until every ground it
   * could land on clears, which costs a barely perceptible shift in a 14x2px bar.
   */
  it.each(NEGATIVE_GROUNDS.map((ground) => ({ ground })))(
    "keeps the --negative dash visible as a shape on --$ground",
    { timeout: 15_000 },
    ({ ground }) => {
      const ratio = contrast(srgb(tokens.negative), srgb(tokens[ground]));
      expect(ratio, `--negative on --${ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        GRAPHICAL_FLOOR,
      );
    },
  );

  /**
   * --waiting, --draft and --failure each draw a 5-6px dot, and the dot is what carries the state
   * before the label is read. They land inside cards as often as on the pane, so --card-top is
   * asserted alongside the two flat grounds.
   */
  it.each(
    STATE_GROUNDS.flatMap((ground) =>
      (["waiting", "draft", "failure"] as const).map((hue) => ({ ground, hue })),
    ),
  )("keeps the --$hue dot visible on --$ground", { timeout: 15_000 }, ({ ground, hue }) => {
    const ratio = contrast(srgb(tokens[hue]), srgb(tokens[ground]));
    expect(ratio, `--${hue} on --${ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      GRAPHICAL_FLOOR,
    );
  });

  /**
   * --failure-body is the sentence under a failure numeral ("Card declined, retry 2 of 4"), softer
   * than --failure-text on purpose. Softer still has to be readable, so it answers to 1.4.3 too.
   */
  it("reads --failure-body as small text on the failure wash", () => {
    const ground = over(washes["failure-wash"], tokens[textGround]);
    const ratio = contrast(srgb(tokens["failure-body"]), ground);
    expect(
      ratio,
      `--failure-body on --failure-wash over --${textGround} is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(SMALL_TEXT_FLOOR);
  });

  /**
   * A group band is a fill whose only job is to be seen as a band, so the thing to assert is the
   * step, not a text ratio: --quiet drew it at 1.02:1 off --card, which is to say the band shipped
   * invisible and the client read the table as one undifferentiated block. The card face is a
   * gradient, so the step is measured at both of its stops -- an opaque band clears one end and
   * vanishes at the other, which is why --band carries alpha. The light palette needs its own
   * channels for this: the dark palette's periwinkle at 0.1 measures 1.04:1 over a near-white
   * card, the same measured-into-invisibility failure one step further on.
   */
  it.each((["card", "card-top"] as const).map((ground) => ({ ground })))(
    "draws the --band fill as a visible step off --$ground",
    ({ ground }) => {
      const banded = over(washes.band, tokens[ground]);
      const step = contrast(banded, srgb(tokens[ground]));
      expect(step, `--band on --${ground} is ${step.toFixed(3)}:1`).toBeGreaterThanOrEqual(1.1);
    },
  );

  /** The band prints a label in --muted and an annotation in --faint, both small text. */
  it.each(
    (["card", "card-top"] as const).flatMap((ground) =>
      (["muted", "faint"] as const).map((role) => ({ ground, role })),
    ),
  )("reads --$role on the band over --$ground", ({ ground, role }) => {
    const banded = over(washes.band, tokens[ground]);
    const ratio = contrast(srgb(tokens[role]), banded);
    expect(
      ratio,
      `--${role} on --band over --${ground} is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(SMALL_TEXT_FLOOR);
  });

  /**
   * The clay text pair and the clay dash are the same hue family and two different roles, and the
   * cheap mistake is to collapse them -- to point --failure-text at --negative because "they are
   * both the red one". --negative is the value it is because a 14x2px bar only answers to 3:1, and
   * at that value it is nowhere near readable as text: this asserts it stays under the text floor,
   * so an alias in either direction fails here rather than shipping unreadable numerals. The
   * two-directional shape is what survives the palette move: it held in the dark and it still
   * holds in the light, where --negative measures 3.90 as text and --failure-text measures 5.03.
   */
  it("keeps --negative unusable as text, which is why --failure-text exists", () => {
    const wash = over(washes["failure-wash"], tokens[textGround]);
    const asText = contrast(srgb(tokens.negative), wash);
    expect(
      asText,
      `--negative on --failure-wash over --${textGround} is ${asText.toFixed(2)}:1, which must stay below the small-text floor`,
    ).toBeLessThan(SMALL_TEXT_FLOOR);

    const proper = contrast(srgb(tokens["failure-text"]), wash);
    expect(proper, `--failure-text is ${proper.toFixed(2)}:1 on the same ground`).toBeGreaterThanOrEqual(
      SMALL_TEXT_FLOOR,
    );
  });
});

/**
 * The transcription itself, reconciled against `tokens.css`.
 *
 * Everything above measures a copy of the palette rather than the palette, and the docstring at the
 * top of this file defends that: parsing the stylesheet and comparing it to itself would make every
 * ratio assertion self-fulfilling, so a human has to re-read a number and agree to it. That
 * reasoning is right and none of it changes here.
 *
 * What the docstring also says is that the cost of transcribing is silent drift, and it has now
 * been paid three times in this one file -- `dark.canvas` describing a ground no browser rendered,
 * `accent-text` left on the retired teal, `t-data-1` at hue 208.9 against a live 264 -- each found
 * by a person reading the two side by side, which is not a guard. On 2026-09-01 I set the light
 * `--faint` to a lightness of 0.78 over a near-white ground, roughly 1.5:1, and all 78 assertions
 * stayed green: the suite could not see a change to the thing it exists to measure.
 *
 * So this reconciles the copy against the source. It asserts no ratio and lowers no floor. If a
 * token moves in `tokens.css` and nobody updates the table, this fails and names both values --
 * and the fix is still to re-measure and agree, never to paste the new number in to get green.
 */
/*
 * Comments first, or the block index above the palette -- which lists `:root` and
 * `:root[data-theme="dark"]` as prose -- matches the marker and points every lookup at the first
 * real brace after it, which is the light block. Both palettes then reconcile against light and
 * the dark one fails for a reason that has nothing to do with the tokens.
 */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

const source = stripComments(readFileSync(new URL("./tokens.css", import.meta.url), "utf8"));

/** Every declaration in `body`, in the order it is authored. */
function declarations(body: string) {
  return new Map(
    Array.from(body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi), ([, name, value]) => [
      name,
      value.trim(),
    ]),
  );
}

/** The body of the first block after `marker` in `text` whose declarations satisfy `accept`. */
function blockBody(text: string, marker: string, accept: (body: string) => boolean) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = Array.from(text.matchAll(new RegExp(`^[ \\t]*${escaped}(?=[,{\\s])`, "gm")));

  for (const match of matches) {
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

  throw new Error(`No block matching: ${marker}`);
}

/** The declarations of the first block after `marker` that declares `--canvas`. */
function paletteBlock(marker: string) {
  return declarations(blockBody(source, marker, (body) => /--canvas\s*:/.test(body)));
}

/** `oklch(l c h)` or `rgba(r, g, b, a)` to the tuple shape the tables above are authored in. */
function parse(value: string): readonly number[] | null {
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (oklch) return oklch.slice(1, 4).map(Number);

  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value);
  return rgba ? rgba.slice(1, 5).map(Number) : null;
}

describe("the transcribed palettes still match tokens.css", () => {
  describe.each([
    { palette: "dark", marker: ':root[data-theme="dark"]', tables: [DARK, DARK_WASHES] },
    { palette: "light", marker: ":root", tables: [LIGHT, LIGHT_WASHES] },
  ] as const)("$palette", ({ marker, tables }) => {
    const declared = paletteBlock(marker);
    const transcribed = Object.entries(Object.assign({}, ...tables) as Record<string, readonly number[]>);

    it.each(transcribed)("--%s matches what tokens.css declares", (name, expected) => {
      const value = declared.get(`--${name}`);
      expect(value, `--${name} must be declared in the ${marker} palette`).toBeDefined();

      const actual = parse(value ?? "");
      expect(
        actual,
        `--${name} is authored as "${value}", which this test cannot parse -- teach it the new form rather than dropping the entry`,
      ).not.toBeNull();
      expect(
        actual,
        `--${name} is transcribed as [${expected.join(", ")}] but tokens.css declares ${value}. Re-measure the ratios that depend on it and agree to the new number.`,
      ).toEqual([...expected]);
    });
  });
});

/**
 * The drenched panel, which is a third ground and until 2026-09-01 had no coverage at all.
 *
 * A drenched panel paints its own gradient and drops the card face, so nothing on it is measured by
 * anything above: `--canvas` and `--card` are the two grounds this file knew about, and a drench is
 * neither. `console.css` redeclares the text ramp for that subtree and carries the ratios in a
 * comment, which is exactly the kind of claim the docstring at the top of this file exists to stop
 * trusting -- and the claim was half true. It covered `--ink`, `--body`, `--muted` and `--faint`,
 * the four the Overview hero prints, and the other four roles kept whatever the page palette handed
 * them: in the light theme `--glyph` measured 1.53:1 on the drench and `--meta` 1.05:1, and in the
 * dark theme they were worse still at 1.11 and 1.79, because the dark palette's tail is mid slate
 * rather than light. The live casualty was the "Most clients" dot on the drenched plan card.
 *
 * **The drench answers to no theme.** It is a dark ground in every palette, so the override is one
 * unconditional block and this describe runs once rather than per palette. What varies is which
 * stop of which gradient is the worst case, so every stop of both drenches is asserted.
 */
const DRENCH_STOPS = {
  /** The info drench. Its lighter stop is the lightest ground either drench presents, so it is the
      worst case for everything below and the number quoted in `console.css`'s comment. */
  "console-drench-info": [
    [0.5, 0.15, 264],
    [0.385, 0.128, 261],
  ],
  "console-drench-live": [
    [0.28, 0.08, 262],
    [0.17, 0.04, 265],
  ],
} as const satisfies Record<string, readonly Oklch[]>;

/** Every role as `console.css` redeclares it inside `.coach-panel[data-drench]`. */
const ON_DRENCH = {
  ink: [0.99, 0.012, 265],
  body: [0.955, 0.012, 265],
  muted: [0.925, 0.012, 265],
  faint: [0.9, 0.012, 265],
  /* Level with --faint rather than below it, and deliberately: white measures 6.0:1 on the info
     drench's lighter stop, so the ramp has one octave, four steps already spend it, and a visible
     fifth step would be under 1.4.3's floor. On a drench the ramp bottoms out at faint. */
  meta: [0.9, 0.012, 265],
  overline: [0.9, 0.012, 265],
  /* The two roles the base palette already holds to 1.4.11 rather than 1.4.3 -- weekend letters and
     icon strokes, 3.8 and 3.6 on the page. They keep that floor and that order here. */
  dim: [0.82, 0.012, 265],
  glyph: [0.8, 0.012, 265],
  /* The tone roles, transcribed 2026-09-01. The neutral ramp above was the second of three passes
     over this block; the third is these. `TONE_TEXT` resolves `good` and `failure` to
     `--good-text` and `--failure-text`, nothing redeclared them, and the drenched MRR hero on
     Revenue prints five signed money figures through that map -- they measured 2.56:1 on the live
     drench this panel paints and 1.07:1 on the info drench, with the dark palette failing too at
     2.93. The chroma is low because white measures only 6.15:1 on the info drench's lighter stop,
     so a tone that clears 4.5 sits near white and its hue survives as a tint; the `-body` roles
     land ON their `-text` roles for the same reason --meta and --overline land on --faint. */
  "on-accent": [0.99, 0.012, 265],
  "accent-text": [0.945, 0.026, 265],
  "good-text": [0.945, 0.05, 164],
  "warning-text": [0.945, 0.041, 71],
  "waiting-text": [0.945, 0.026, 271],
  "draft-text": [0.945, 0.028, 292],
  "failure-text": [0.945, 0.027, 32],
  "critical-text": [0.945, 0.027, 25],
  /* Not a dot here. Eight components print --critical as a text colour, so on a drench it answers
     to 1.4.3 and lands on --critical-text rather than on the mark stop below. */
  critical: [0.945, 0.027, 25],
  "warning-body": [0.945, 0.04, 74],
  "failure-body": [0.945, 0.027, 39],
  "accent-bright": [0.82, 0.089, 264],
  good: [0.82, 0.11, 164],
  warning: [0.82, 0.11, 71],
  waiting: [0.82, 0.089, 271],
  draft: [0.82, 0.098, 292],
  failure: [0.82, 0.101, 32],
} as const satisfies Record<string, Oklch>;

/** Prose, so 1.4.3. Everything else is a shape and answers to 1.4.11. */
const ON_DRENCH_TEXT = [
  "ink",
  "body",
  "muted",
  "faint",
  "meta",
  "overline",
  "on-accent",
  "accent-text",
  "good-text",
  "warning-text",
  "waiting-text",
  "draft-text",
  "failure-text",
  "critical-text",
  "critical",
  "warning-body",
  "failure-body",
] as const;
const ON_DRENCH_SHAPE = [
  "dim",
  "glyph",
  "accent-bright",
  "good",
  "warning",
  "waiting",
  "draft",
  "failure",
] as const;

/**
 * The grounds and hairlines the same block redeclares, transcribed alongside the foregrounds.
 *
 * Separate from `ON_DRENCH` because these are alphas rather than opaque triples, and separate in
 * kind: a foreground is measured against the drench, a ground is what a foreground is measured
 * ON. Two of them exist because `--critical-wash` and `--info-wash` are the only tone washes the
 * palette authors opaque, so inside a drench they kept whichever page palette was live -- and
 * under the light palette that is near-white, which put `--critical-text` on `--critical-wash` at
 * 1.03:1 with every role correctly redeclared. They darken rather than lighten because a wash sits
 * behind text that is already near-white on a drench; a 14% white wash drops `--critical-text` to
 * 3.84:1.
 */
const ON_DRENCH_GROUND = {
  "critical-wash": [0, 0, 0, 0.18],
  "info-wash": [0, 0, 0, 0.18],
  "critical-line": [255, 255, 255, 0.32],
  "info-line": [255, 255, 255, 0.32],
  "line-strong": [255, 255, 255, 0.38],
} as const satisfies Record<string, Rgba>;

const CONSOLE_CSS = stripComments(
  readFileSync(new URL("./(workspace)/admin/console.css", import.meta.url), "utf8"),
);

/** The declarations of the drench override block -- the bare `[data-drench]`, not `="live"` and not
    one of its descendant rules, which is what the `--ink` test picks out. */
const DRENCH_BLOCK = declarations(
  blockBody(CONSOLE_CSS, '[data-shell-role="admin"] .coach-panel[data-drench]', (body) =>
    /--ink\s*:/.test(body),
  ),
);

const COACH_CSS = stripComments(
  readFileSync(new URL("./(workspace)/coach/coach.css", import.meta.url), "utf8"),
);

/**
 * The two stylesheets that drench a panel, and they are the same rule twice.
 *
 * `coach.css` declares `--coach-drench-info` and `--coach-drench-live` as the same two gradients
 * `console.css` declares, so a role that reads on one ground reads on the other and a value that
 * differs between the two files is a divergence rather than a decision. One guard covers both,
 * which is the whole reason the console side and the coach side stopped being fixed separately.
 */
const DRENCHED_STYLESHEETS = [
  { file: "console.css", css: CONSOLE_CSS, shell: "admin" },
  { file: "coach.css", css: COACH_CSS, shell: "coach" },
] as const;

function drenchBlock(css: string, shell: string) {
  return declarations(
    blockBody(css, `[data-shell-role="${shell}"] .coach-panel[data-drench]`, (body) =>
      /--ink\s*:/.test(body),
    ),
  );
}

/**
 * Which roles a foreground inside a drench can resolve to, discovered rather than listed.
 *
 * The test this replaces was named "redeclares every role on the tokens.css text ramp" and its
 * docstring promised that adding a ninth role to the run would fail it. It computed the run as
 * `slice(indexOf("--ink"), indexOf("--glyph") + 1)` -- eight contiguous declarations -- and every
 * tone role in `tokens.css` sits below that boundary, so no addition to the tone palette could
 * ever trip it. A positional slice decides membership by where a token sits in a file rather than
 * by what the token is, which is the same defect as a candidate filter keyed on the property under
 * test: the guard's scope excluded the thing the guard was judging, and `--good-text` and
 * `--failure-text` shipped at 2.56:1 underneath a green run.
 *
 * So membership is now derived from what a role is, out of three sources, none of them a list
 * anybody has to remember to extend:
 *
 *  1. `TONE_TEXT` in `tone.ts` -- every colour an atomic paints a toned label or numeral in.
 *  2. `TONE_MARK` in the same file -- every colour it paints a dot, a bar fill or a gradient edge
 *     in. Shapes, so 1.4.11 rather than 1.4.3, but a drench has to carry them all the same.
 *  3. Every token any component under `src/` names as a text colour, whether in a Tailwind
 *     `text-[color:var(--x)]` or in a `color:` style property.
 *
 * The result is intersected with the tokens the `:root` palette actually declares, which drops the
 * shell-local `--console-on-drench-sub` and `--coach-on-drench-sub` -- those are authored against
 * the drench already and have no page value to inherit.
 *
 * Adding a tone to `tone.ts`, or pointing one more component's text at a palette token, extends
 * this set on its own and fails both drench blocks until they carry it.
 */
const TONE_SOURCE = readFileSync(
  new URL("../components/kit/atomics/tone.ts", import.meta.url),
  "utf8",
);

/** The `var(--x)` names on the right-hand side of one `as const satisfies Record<Tone, string>` map. */
function toneMapRoles(map: string): string[] {
  const start = TONE_SOURCE.indexOf(`export const ${map} = {`);
  if (start === -1) throw new Error(`tone.ts no longer exports ${map} as an object literal`);
  const end = TONE_SOURCE.indexOf("\n}", start);
  const body = TONE_SOURCE.slice(start, end);
  return Array.from(body.matchAll(/var\((--[a-z0-9-]+)\)/gi), ([, name]) => name);
}

/** Every `.ts`/`.tsx` file under `src/`, which is where a component names a colour. */
function sourceFiles(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

/** The tokens components name as a text colour: `text-[color:var(--x)]` and `color: "var(--x)"`. */
function textColourRoles(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(new URL("../", import.meta.url))) {
    const text = readFileSync(file, "utf8");
    for (const [, name] of text.matchAll(/text-\[color:var\((--[a-z0-9-]+)\)\]/g)) found.add(name);
    for (const [, name] of text.matchAll(/(?:^|[\s{,;(])color:\s*["'`]var\((--[a-z0-9-]+)\)["'`]/gm)) {
      found.add(name);
    }
  }
  return Array.from(found);
}

const PALETTE_ROLES = new Set(paletteBlock(":root").keys());
const TONE_TEXT_ROLES = toneMapRoles("TONE_TEXT");
const TONE_MARK_ROLES = toneMapRoles("TONE_MARK");
const TEXT_COLOUR_ROLES = textColourRoles();
const FOREGROUND_ROLES = Array.from(
  new Set([...TONE_TEXT_ROLES, ...TONE_MARK_ROLES, ...TEXT_COLOUR_ROLES]),
)
  .filter((role) => PALETTE_ROLES.has(role))
  .sort();

/**
 * Which floor each discovered role answers to.
 *
 * `TONE_MARK` is a shape contract by its own docstring -- "dots, bar fills, the leading edge of a
 * progress gradient" -- so its members take 1.4.11's 3:1 even where a component paints one on an
 * icon through `text-[color:...]`, because an icon is a shape too. `--dim` is the one role outside
 * that map with the same standing, and `tokens.css` says why beside it: weekend letters, held to
 * 3.8 on the page rather than to 4.5. This picks a floor; it excludes nothing from the run above,
 * which is the distinction the replaced test got wrong.
 */
const SHAPE_ROLES = new Set([...TONE_MARK_ROLES, "--dim"]);

describe("the drenched panel", () => {
  const grounds = Object.entries(DRENCH_STOPS).flatMap(([drench, stops]) =>
    stops.map((stop, index) => ({ ground: `--${drench} stop ${index + 1}`, stop })),
  );

  it.each(grounds.flatMap(({ ground, stop }) => ON_DRENCH_TEXT.map((role) => ({ ground, stop, role }))))(
    "reads --$role as small text on $ground",
    ({ ground, stop, role }) => {
      const ratio = contrast(srgb(ON_DRENCH[role]), srgb(stop));
      expect(ratio, `--${role} on ${ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        SMALL_TEXT_FLOOR,
      );
    },
  );

  it.each(grounds.flatMap(({ ground, stop }) => ON_DRENCH_SHAPE.map((role) => ({ ground, stop, role }))))(
    "keeps --$role visible as a shape on $ground",
    ({ ground, stop, role }) => {
      const ratio = contrast(srgb(ON_DRENCH[role]), srgb(stop));
      expect(ratio, `--${role} on ${ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        GRAPHICAL_FLOOR,
      );
    },
  );

  /**
   * The transcription covers the whole block, not the part somebody transcribed.
   *
   * The ratios above measure `ON_DRENCH`, and `ON_DRENCH` is a copy. A role redeclared in
   * `console.css` but missing from the table would be a role nothing above measures, which is the
   * transcription failure the file's own docstring has now paid for three times -- so the two sets
   * have to be equal in both directions rather than one being a subset of the other.
   */
  it("measures every role the console drench block declares", () => {
    expect(DRENCH_BLOCK.size, "the console drench block declares nothing").toBeGreaterThan(0);
    expect(
      new Set([...Object.keys(ON_DRENCH), ...Object.keys(ON_DRENCH_GROUND)].map((r) => `--${r}`)),
    ).toEqual(new Set(DRENCH_BLOCK.keys()));
  });

  /**
   * The two washes the block redeclares are the ones the palette authors opaque, and an opaque
   * value inside a drench is not a tint of the drench -- it is a different ground entirely. So
   * these are asserted as grounds: `--critical-text` has to read on `--critical-wash`, and the
   * callout has to be visible as a region against the drench at all.
   *
   * **What draws the region is the hairline, not the fill, and that is measured rather than
   * assumed.** A 0.18 black wash is a 1.32:1 step off the info drench and only 1.02:1 off the live
   * drench's darker stop, which is where the fill stops carrying a region on its own -- the
   * darkest ground has the least room left to darken. `--critical-line` at 0.32 white steps 1.97
   * to 2.84 across all four stops and 2.59 or better off its own wash, so the boundary is what a
   * reader sees on every ground. Asserting the fill's step alone would have failed the correct
   * design; asserting neither would have let a callout ship as an unmarked paragraph.
   */
  it.each(grounds.map(({ ground, stop }) => ({ ground, stop })))(
    "reads --critical-text on the redeclared --critical-wash over $ground",
    ({ ground, stop }) => {
      const washed = over(ON_DRENCH_GROUND["critical-wash"], stop);
      const ratio = contrast(srgb(ON_DRENCH["critical-text"]), washed);
      expect(
        ratio,
        `--critical-text on --critical-wash over ${ground} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(SMALL_TEXT_FLOOR);
    },
  );

  it.each(grounds.map(({ ground, stop }) => ({ ground, stop })))(
    "draws the critical callout's boundary against $ground",
    ({ ground, stop }) => {
      const line = over(ON_DRENCH_GROUND["critical-line"], stop);
      const washed = over(ON_DRENCH_GROUND["critical-wash"], stop);

      const offDrench = contrast(line, srgb(stop));
      expect(
        offDrench,
        `--critical-line is ${offDrench.toFixed(3)}:1 off ${ground}, so the callout has no edge on the panel`,
      ).toBeGreaterThanOrEqual(1.5);

      const offWash = contrast(line, washed);
      expect(
        offWash,
        `--critical-line is ${offWash.toFixed(3)}:1 off its own wash over ${ground}`,
      ).toBeGreaterThanOrEqual(1.5);
    },
  );
});

/**
 * The structural half, and the one that catches the next occurrence rather than this one.
 *
 * The ratios above only measure roles somebody remembered to redeclare. The defect was a role
 * nobody redeclared, three times running, and no ratio assertion can see one of those: it is the
 * absence of a declaration, not a bad value. So every role a foreground inside a drench can
 * resolve to is discovered from `tone.ts` and from the components (see `FOREGROUND_ROLES`), and
 * both drenched stylesheets have to carry all of them.
 *
 * **Which side of the transcription this sits on, deliberately.** The ratio suite above reads a
 * hand-transcribed copy of the palette and reconciles it against the source, so that lowering a
 * contrast costs a person re-reading a number and agreeing to it. These assertions sit on the
 * SOURCE side instead, and they can do that without becoming self-fulfilling because they compare
 * the stylesheet against something outside it -- the presence of a role discovered elsewhere, a
 * floor from WCAG, and the other stylesheet's value for the same role. None of the three is a
 * number the file under test gets to choose. The floors here are a net under the transcription
 * rather than a replacement for it: `coach.css` has no transcription and would otherwise have no
 * ratio coverage at all.
 */
describe("both drenched stylesheets", () => {
  it("discovers the roles a foreground inside a drench can resolve to", () => {
    expect(TONE_TEXT_ROLES.length, "TONE_TEXT parsed out of tone.ts").toBeGreaterThan(0);
    expect(TONE_MARK_ROLES.length, "TONE_MARK parsed out of tone.ts").toBeGreaterThan(0);
    expect(TEXT_COLOUR_ROLES.length, "tokens named as a text colour under src/").toBeGreaterThan(0);
    expect(
      FOREGROUND_ROLES.length,
      "no role survived the intersection with the :root palette, and an empty set passes every loop below as if it were coverage",
    ).toBeGreaterThan(0);
  });

  describe.each(DRENCHED_STYLESHEETS)("$file", ({ file, css, shell }) => {
    const block = drenchBlock(css, shell);

    it.each(FOREGROUND_ROLES.map((role) => ({ role })))("redeclares $role", ({ role }) => {
      expect(
        block.get(role),
        `${role} is a colour a figure, a control or a label inside a drench resolves to, and ${file} does not redeclare it for the drenched subtree -- so it keeps the page palette's value against a ground that is dark in every theme.`,
      ).toBeDefined();
    });

    it.each(
      FOREGROUND_ROLES.flatMap((role) =>
        Object.entries(DRENCH_STOPS).flatMap(([drench, stops]) =>
          stops.map((stop, index) => ({ role, ground: `--${drench} stop ${index + 1}`, stop })),
        ),
      ),
    )("holds $role to its floor on $ground", ({ role, ground, stop }) => {
      const value = parse(block.get(role) ?? "");
      expect(value, `${role} must be declared in ${file}'s drench block`).not.toBeNull();

      const floor = SHAPE_ROLES.has(role) ? GRAPHICAL_FLOOR : SMALL_TEXT_FLOOR;
      const ratio = contrast(srgb(value as Oklch), srgb(stop));
      expect(
        ratio,
        `${role} on ${ground} is ${ratio.toFixed(2)}:1 in ${file}, under the ${floor}:1 floor`,
      ).toBeGreaterThanOrEqual(floor);
    });

    /**
     * The pair, not the role, which is the failure one level in from the one this file was
     * rewritten for.
     *
     * The assertions above enumerate roles individually, and a role that is present and correct
     * against the drench passes them. But a toned label sits on its own wash, and a wash inside a
     * drench resolves the same way every other token does: if the block redeclares it, the panel
     * gets the drench's value, and if it does not, the panel gets whichever page palette is live.
     * Five of the seven tone washes are alphas, so they tint the drench and the pairing survives
     * on its own. `--critical-wash` and `--info-wash` are opaque in BOTH palettes, so under the
     * light palette a drenched panel painted a near-white patch and put `--critical-text` on it at
     * 1.03:1 -- every role redeclared, every value right against the drench, and the pair
     * invisible. So the ground is resolved the way the cascade resolves it and the text is measured
     * where it actually lands.
     */
    const pairs = FOREGROUND_ROLES.flatMap((role) => {
      const family = role.replace(/^--/, "").replace(/-(text|body)$/, "");
      const wash = `--${family}-wash`;
      return PALETTE_ROLES.has(wash) ? [{ role, wash }] : [];
    });

    it("finds tone text paired with a wash", () => {
      expect(pairs.length, `no --*-wash pair was derived from ${file}'s role set`).toBeGreaterThan(
        0,
      );
    });

    it.each(
      pairs.flatMap(({ role, wash }) =>
        Object.entries(DRENCH_STOPS).flatMap(([drench, stops]) =>
          stops.flatMap((stop, index) =>
            // How the cascade resolves the wash: the drench's own value if it redeclares it,
            // otherwise BOTH page palettes, because a drenched panel renders under either.
            (block.has(wash)
              ? [{ source: "the drench block", value: block.get(wash) }]
              : PALETTES.map(({ name }) => ({
                source: `the ${name} palette`,
                value: paletteBlock(name === "dark" ? ':root[data-theme="dark"]' : ":root").get(wash),
              }))
            ).map(({ source, value }) => ({
              role,
              wash,
              source,
              value,
              ground: `--${drench} stop ${index + 1}`,
              stop,
            })),
          ),
        ),
      ),
    )("reads $role on $wash from $source over $ground", ({ role, wash, source, value, ground, stop }) => {
      const washValue = parse(value ?? "");
      expect(washValue, `${wash} must be parseable from ${source}`).not.toBeNull();

      const washed = over(washValue as Rgba | Oklch, stop);
      const floor = SHAPE_ROLES.has(role) ? GRAPHICAL_FLOOR : SMALL_TEXT_FLOOR;
      const ratio = contrast(srgb(parse(block.get(role) ?? "") as Oklch), washed);
      expect(
        ratio,
        `${role} on ${wash} taken from ${source} over ${ground} is ${ratio.toFixed(2)}:1 in ${file}, under the ${floor}:1 floor. A wash the drench does not redeclare keeps the page palette's value, and the two opaque ones are a different ground rather than a tint of this one.`,
      ).toBeGreaterThanOrEqual(floor);
    });
  });

  /**
   * The two files draw the same two gradients, so a role that differs between them is drift rather
   * than a decision -- and the half that is wrong will be the half nobody was looking at, which is
   * how the coach side ended up four roles behind the console side in the first place.
   */
  it.each(FOREGROUND_ROLES.map((role) => ({ role })))(
    "declares the same $role in both files",
    ({ role }) => {
      const [console_, coach] = DRENCHED_STYLESHEETS.map(({ css, shell }) =>
        drenchBlock(css, shell).get(role),
      );
      expect(
        coach,
        `${role} is declared as "${console_}" on the drench in console.css and "${coach}" in coach.css, against the same two gradients.`,
      ).toEqual(console_);
    },
  );
});

/**
 * The drench transcription, reconciled against `console.css` for the same reason the palettes are
 * reconciled against `tokens.css`: everything above measures a copy.
 *
 * **Each drench must be declared exactly once, and that is asserted rather than worked around.**
 * `--console-drench-info` was declared twice until 2026-09-01 -- the retired teal in the base block,
 * the blue that replaced it in the theme-light lane 450 lines below, at equal specificity -- and the
 * first version of this test read the last declaration, because the last one is what a browser
 * paints. That rule is right today and silently wrong the day someone adds a third declaration
 * above the one they meant to change: the test keeps passing, against a ground the page no longer
 * paints, which is the same class of blindness as measuring a stale transcription. So the teal was
 * deleted and this now expects one declaration and fails on two, whichever would have won.
 */
describe("the transcribed drench still matches console.css", () => {
  function declaredOnce(name: string) {
    const matches = Array.from(CONSOLE_CSS.matchAll(new RegExp(`--${name}\\s*:\\s*([^;]+);`, "g")));
    expect(
      matches.map(([, value]) => value.trim()),
      `--${name} must be declared exactly once in console.css. A duplicate at equal specificity leaves a value nothing paints where the next reader looks first, and lets this test measure a ground the page has left.`,
    ).toHaveLength(1);
    return matches[0][1].trim();
  }

  it.each(Object.entries(DRENCH_STOPS))("--%s declares the stops measured above", (name, stops) => {
    const value = declaredOnce(name);
    const declared = Array.from(value.matchAll(/oklch\([^)]*\)/g), ([stop]) => parse(stop));
    expect(
      declared,
      `--${name} is transcribed as ${JSON.stringify(stops)} but console.css declares ${value}. Re-measure every role on it and agree to the new ground.`,
    ).toEqual(stops.map((stop) => [...stop]));
  });

  it.each([
    ...Object.entries(ON_DRENCH),
    ...Object.entries(ON_DRENCH_GROUND),
  ] as [string, readonly number[]][])("--%s matches what the drench block declares", (role, expected) => {
    const value = DRENCH_BLOCK.get(`--${role}`);
    expect(value, `--${role} must be declared in the drench override`).toBeDefined();
    expect(
      parse(value ?? ""),
      `--${role} is transcribed as [${expected.join(", ")}] but console.css declares ${value}. Re-measure and agree to the new number.`,
    ).toEqual([...expected]);
  });
});
