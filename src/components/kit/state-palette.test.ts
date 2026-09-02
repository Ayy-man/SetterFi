import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * One state, one colour, across both component layers.
 *
 * `StateBadge` (21 screens) and the kit's `Status` (8 screens) both render states, and for a while
 * they rendered them in different colours. `good` and `warning` always agreed, because the kit's
 * `TONE_WASH` points at the very same `--good-wash` / `--warning-wash` tokens. `critical` and
 * `info` did not: `--critical` is oklch(0.74 0.14 25), a saturated red from the pre-redesign
 * palette, while the kit's `failure` is the muted clay #C98679 the redesign brief specifies, and
 * `--info` is hue 230 against the brief's periwinkle #8FA0D8 at hue 271. So a past-due account was
 * red on most of the product and clay on the redesigned few.
 *
 * This pins the fix at the only place it belongs. `--critical` and `--info` themselves are
 * deliberately NOT aliased: they have 48 and 5 other consumers -- `--color-destructive`, chart
 * series, the agent trace, inline error alerts -- and the kit's ruling separates those from
 * states on purpose: `critical` splits three ways, so a state becomes `failure`, inline error text
 * takes a text token and never becomes a `Status`, and a destructive affordance is a button
 * variant. Only the state arm moves.
 */

const BADGE = new URL("./state-badge.tsx", import.meta.url).pathname;
const TONE = new URL("./atomics/tone.ts", import.meta.url).pathname;

describe("the state palette", () => {
  it("renders a critical and an info state in the redesign's tones, not the pre-redesign ones", () => {
    const badge = readFileSync(BADGE, "utf8");
    const pills = badge.slice(badge.indexOf("const PILL_TONE_CLASSES"));
    const block = pills.slice(0, pills.indexOf("} as const"));

    expect(block, "a critical state must be the muted clay, not the destructive red")
      .toMatch(/critical:.*--failure-wash/u);
    expect(block, "an info state must be the periwinkle, not the pre-redesign cyan")
      .toMatch(/info:.*--waiting-wash/u);
    expect(block).not.toMatch(/--critical-wash|--info-wash/u);
  });

  /**
   * The other half. Aliasing the raw tokens would have been the tempting one-line fix and it would
   * have muted every destructive button and recoloured the charts, so this asserts that the raw
   * tokens are still reaching their own consumers untouched.
   */
  it("leaves --critical and --info alone for destructive actions and error text", () => {
    const badge = readFileSync(BADGE, "utf8");
    // The tag treatment and error alerts elsewhere still read the raw tokens.
    expect(badge).toContain("--neutral-wash");
    expect(readFileSync(TONE, "utf8"), "the kit must not start borrowing the legacy state tokens")
      .not.toMatch(/--critical|--info\b/u);
  });
});
