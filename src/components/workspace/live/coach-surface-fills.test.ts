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
  // The rehaul took the agent, Home and Inbox routes; `coach-offer.tsx`, `coach-measurement.tsx`
  // and `coach-conversations.tsx` were deleted with them, and their replacements are listed in
  // their place so the rule keeps reaching every coach screen rather than shrinking to the ones
  // that happened to survive.
  "src/components/workspace/rehaul/coach-agent.tsx",
  "src/components/workspace/rehaul/coach-dashboard.tsx",
  "src/components/workspace/rehaul/coach-inbox.tsx",
  // Added 2026-09-04 with the surface itself. `coach-integrations.tsx` was never on this list and
  // was deleted the same day, so Setup is not a replacement for a row here -- it is a coach screen
  // that paints a panel face, two button faces and four row tiles, which is exactly the shape this
  // rule exists for, and the list is meant to reach every coach screen rather than the ones that
  // happened to be written before it.
  "src/components/workspace/rehaul/coach-setup.tsx",
  "src/components/workspace/live/coach-billing.tsx",
  "src/components/workspace/live/coach-contacts.tsx",
  "src/components/workspace/live/coach-pipeline.tsx",
  "src/components/workspace/live/coach-deck.tsx",
  "src/components/workspace/live/leads-surface.tsx",
];

/*
 * White alpha that is correct where it is written, each allowed by its exact string.
 *
 * The rule is about a literal that composites to nothing on the light palette, and the one shape
 * left here is outside that: a raised panel's top-edge highlight is white-on-white by design and
 * reads as a bevel. `coach-dashboard.tsx` came under this guard when the rehaul replaced the live
 * Home surface, which is when three of these arrived; the two that were its dark panel's own
 * hairline and meter track went when the Home rebuild deleted that panel, and their rows went with
 * them. The comments below record what each was, so a literal cannot creep back in unnoticed.
 *
 * By exact string rather than by file, for the reason the accent highlight is: a file-level
 * exemption hides the next literal somebody adds to it.
 */
const ALLOWED_WHITE_ALPHA = [
  // `shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_20px_-8px_var(--accent)]`, the accent
  // fill's own highlight, sat here until the rehaul deleted the two surfaces that retyped it. It
  // is `ACCENT_FILL_SHADOW_CLASS` in the kit now and no coach surface spells it out.
  "shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_1px_2px_rgba(28,42,82,0.04),0_8px_20px_-14px_rgba(28,42,82,0.16)]",
  // `dark ? "border-[rgba(255,255,255,0.12)]" : "border-[var(--line)]"` sat here for
  // `coach-dashboard.tsx`'s own dark panel class, which the Home rebuild deleted: the drenched
  // panels are `DeckPanel` with a drench variant now, and the variant paints its hairline from
  // `--line` remapped for the dark subtree rather than from a literal chosen per theme.
  // `className="mt-2 h-1.5 rounded-full bg-[rgba(255,255,255,0.14)]"` was the same panel's meter
  // track and went with it in the same rebuild. Nothing draws a meter on Home now: the setup rail
  // counts its rungs in words, which says the same thing without a bar that has to be read.
];

describe("the coach surfaces paint from tokens, not from white alpha", () => {
  it("carries no hard-coded white-alpha fill on any coach surface", () => {
    const offenders = SURFACES.flatMap((path) => {
      const text = ALLOWED_WHITE_ALPHA.reduce(
        (source, allowed) => source.replaceAll(allowed, ""),
        readFileSync(resolve(process.cwd(), path), "utf8"),
      );
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

  it("keeps no allowance for a literal that has left the surfaces", () => {
    // The exemption list may only shrink by the literal genuinely going, never by rotting into
    // strings nobody writes any more -- which is how an allow-list stops meaning anything.
    const sources = SURFACES.map((path) => readFileSync(resolve(process.cwd(), path), "utf8"));
    for (const allowed of ALLOWED_WHITE_ALPHA) {
      expect(
        sources.some((text) => text.includes(allowed)),
        `no coach surface writes \`${allowed}\` any more -- delete its row`,
      ).toBe(true);
    }
  });

  /**
   * The transcript's own case, asserted separately because it is the one where the fill carries
   * meaning rather than depth: two speakers, two grounds, and if they resolve to the same paint a
   * reader cannot tell who said what.
   */
  it("gives a speaker-marked transcript two distinguishable grounds", () => {
    /*
     * Written against `coach-offer.tsx`'s test-agent transcript, and kept as a rule about any
     * transcript rather than that one.
     *
     * The rehaul dropped the transcript when it dropped that file: no coach surface marks a
     * speaker today, so this finds nothing and the assertions below run over an empty set. That is
     * the honest state -- pinning the two class strings to a file that no longer renders them
     * would be a guard about nothing wearing the name of one that worked. Written this way it arms
     * itself again the moment a transcript comes back, on whichever surface draws it.
     */
    const transcripts = SURFACES
      .map((path) => [path, readFileSync(resolve(process.cwd(), path), "utf8")] as const)
      .filter(([, text]) => /data-from="(?:agent|lead)"/u.test(text));

    for (const [path, text] of transcripts) {
      const grounds = [...text.matchAll(/data-from="(agent|lead)"/gu)].map((match) => match[1]);
      expect([...new Set(grounds)].sort(), `${path} must mark both speakers`)
        .toEqual(["agent", "lead"]);
      // Both grounds are tokens, so both survive a palette flip, and they are different tokens,
      // which is the whole point: a reader has to be able to tell who said what.
      const fills = [...text.matchAll(/data-from="(?:agent|lead)"[^>]*?bg-\[(var\(--[a-z-]+\))\]/gu)]
        .map((match) => match[1]);
      expect(new Set(fills).size, `${path} paints both speakers from one token`)
        .toBeGreaterThan(1);
    }
  });
});
