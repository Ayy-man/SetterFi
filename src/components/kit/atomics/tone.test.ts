import { describe, expect, it } from "vitest";

import {
  TONE_GLOWS,
  TONE_LINE,
  TONE_MARK,
  TONE_ROW_TINT,
  TONE_TEXT,
  TONE_WASH,
  TONES,
  toneGlow,
  type Tone,
} from "@/components/kit/atomics/tone";

/**
 * The tone contract is the thing every other atomic reads, so a tone that is missing a role
 * fails here rather than rendering `undefined` into a style attribute on eight screens at once.
 */
describe("tone contract", () => {
  it("declares the seven tones the artifact actually spends", () => {
    expect([...TONES]).toEqual([
      "neutral",
      "accent",
      "good",
      "warning",
      "waiting",
      "draft",
      "failure",
    ]);
  });

  it.each(TONES)("gives %s every role a primitive can ask for", (tone) => {
    for (const map of [TONE_MARK, TONE_TEXT, TONE_WASH, TONE_LINE, TONE_ROW_TINT]) {
      expect(map[tone]).toBeTruthy();
      expect(map[tone]).not.toContain("undefined");
    }
  });

  it("resolves every colour through a token or a color-mix of one, never a hex literal", () => {
    const values = [TONE_MARK, TONE_TEXT, TONE_WASH, TONE_LINE, TONE_ROW_TINT].flatMap((map) =>
      Object.values(map),
    );
    for (const value of values) {
      expect(value).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  /**
   * Which tones a caller *may* ask to glow. A glowing sage "Resolved" dot is the specific defect
   * this pins -- there must be no way to ask for one.
   *
   * This is not the No-Glow Rule itself. That is a budget of one across the whole product and it
   * lives in `src/app/glow-budget.test.ts`; passing here only means no caller can request a halo
   * on a tone that should never carry one.
   */
  it("permits a halo on the two attention tones and on no others", () => {
    const glowing = TONES.filter((tone: Tone) => TONE_GLOWS[tone]);
    expect(glowing).toEqual(["warning", "failure"]);
  });

  it("returns a halo only for a tone that may glow", () => {
    expect(toneGlow("warning")).toBe("0 0 var(--distance-base) var(--warning)");
    expect(toneGlow("failure")).toBe("0 0 var(--distance-base) var(--failure)");
    expect(toneGlow("good")).toBeUndefined();
    expect(toneGlow("neutral")).toBeUndefined();
    expect(toneGlow("waiting")).toBeUndefined();
    expect(toneGlow("draft")).toBeUndefined();
    expect(toneGlow("accent")).toBeUndefined();
  });

  it("keeps a row tint below the hover wash, so hovering a tinted row never reads as untinting it", () => {
    // --row-hover is rgba(255,255,255,0.03); every tint is a 5% color-mix of a saturated hue,
    // which lands under it in perceived lift while still being visible as a tint.
    for (const tone of TONES) {
      if (tone === "neutral") continue;
      if (tone === "accent") {
        expect(TONE_ROW_TINT[tone]).toBe("var(--accent-wash)");
        continue;
      }
      expect(TONE_ROW_TINT[tone]).toMatch(/color-mix\(in oklab, var\(--[a-z]+\) 5%, transparent\)/);
    }
  });
});
