import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * White-alpha fills do not survive a palette flip, and this is the test that says so.
 *
 * Every one of these surfaces was drawn against the dark canvas, where `rgba(255,255,255,0.02)`
 * over a near-black ground is a visible plane and `rgba(255,255,255,0.06)` is a chat bubble. The
 * light palette landed on 2026-09-01 and composited all of them to nothing: the strip stating what
 * SetterFi manages stopped reading as its own surface, the billing correction frame stopped being
 * a frame, and the test-agent transcript stopped distinguishing the agent from the lead, which
 * makes it not a transcript. None of that is a tuning problem -- a literal that was right for one
 * ground is exactly what produced it -- so the fix is a token read and the rule is that there are
 * no literals here to re-tune.
 *
 * The one allowance is the accent fill's inset highlight, which sits on the accent gradient rather
 * than on the page and is white on purpose in both palettes. It is already tracked: the kit owns
 * the recipe as `ACCENT_FILL_SHADOW_CLASS` and `src/components/kit/atomics/button-class.test.ts`
 * carries these two files on its exception list, so adopting the constant is a change that has to
 * happen there and here together.
 */
const SURFACES = [
  "src/components/workspace/live/coach-offer.tsx",
  "src/components/workspace/live/coach-billing.tsx",
  "src/components/workspace/live/coach-measurement.tsx",
  "src/components/workspace/live/coach-conversations.tsx",
  "src/components/workspace/live/coach-contacts.tsx",
  "src/components/workspace/live/coach-pipeline.tsx",
  "src/components/workspace/live/coach-deck.tsx",
  "src/components/workspace/live/leads-surface.tsx",
];

/** The accent fill's own highlight, allowed by name so nothing else can hide behind it. */
const ACCENT_FILL_HIGHLIGHT = "shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_20px_-8px_var(--accent)]";

describe("the coach surfaces paint from tokens, not from white alpha", () => {
  it("carries no hard-coded white-alpha fill on any coach surface", () => {
    const offenders = SURFACES.flatMap((path) => {
      const text = readFileSync(resolve(process.cwd(), path), "utf8")
        .replaceAll(ACCENT_FILL_HIGHLIGHT, "");
      return text
        .split("\n")
        .flatMap((line, index) =>
          /rgba\(\s*255\s*,\s*255\s*,\s*255/u.test(line) ? [`${path}:${index + 1}`] : [],
        );
    });

    expect(
      offenders,
      "a white-alpha literal composites to nothing on the light palette; read --control-fill, --well, --band or --shadow-card instead",
    ).toEqual([]);
  });

  /**
   * The transcript's own case, asserted separately because it is the one where the fill carries
   * meaning rather than depth: two speakers, two grounds, and if they resolve to the same paint a
   * reader cannot tell who said what.
   */
  it("gives the test-agent transcript two distinguishable speaker grounds", () => {
    const text = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/coach-offer.tsx"),
      "utf8",
    );
    const grounds = [...text.matchAll(/data-from="(agent|lead)"/gu)].map((match) => match[1]);
    expect(grounds.sort(), "the transcript must mark both speakers").toEqual(["agent", "lead"]);
    // The agent's bubble takes the tinted band, the lead's the sunk well with its own hairline.
    // Both are tokens, so both survive a palette flip, and they are different tokens, which is the
    // whole point of the assertion.
    expect(text).toContain("rounded-[13px_13px_13px_4px] bg-[var(--band)]");
    expect(text).toContain("rounded-[13px_13px_4px_13px] border border-[var(--line-input)] bg-[var(--well)]");
  });
});
