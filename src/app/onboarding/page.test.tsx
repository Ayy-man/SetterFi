import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import OnboardingPage from "./page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: "a" }));

/**
 * The go-live headline against the strip standing directly above it.
 *
 * The page shipped the artboard's "You are one button away from your agent answering" as an
 * unconditional string while the first three boxes of its own setup strip read "(still to do)".
 * Two statements about the same fact, on the same screen, disagreeing -- which is the honest-states
 * rule in `CLAUDE.md` broken at the exact moment a coach is most inclined to believe the flattering
 * half. `artboard-conformance.test.ts` beside this file could not have caught it: it compares the
 * page to the drawing, and the drawing is where the sentence came from.
 *
 * So this reads the rendered DOM rather than the source, and asserts the pairing rather than the
 * string: while any step box renders as still to do, the heading must not be the drawing's
 * readiness sentence. Rewording the headline to something softer does not satisfy it, because the
 * check below also refuses the other ways a heading can claim to be finished.
 */

const READINESS_CLAIM = /one button away|ready to go|all set|you are live|you're live|100%/iu;

/**
 * The `<h1>` the drawing gives this page. Recorded from the OnboardingGoLive artboard as drawn on
 * 2026-09-02; the artboards are not part of this repository, so a redraw has to be carried here
 * by hand.
 */
function drawnReadinessTitle() {
  return "You are one button away from your agent answering";
}

describe("the go-live headline against its own setup strip", () => {
  it("does not claim the agent is one press away while any setup step is still to do", async () => {
    render(await OnboardingPage());

    const outstanding = document.querySelectorAll(
      '[data-slot="setup-step"][data-state="upcoming"]',
    );
    // The positive control. With no outstanding step the assertions below would hold on a page
    // that was entitled to the readiness sentence, and would report agreement on nothing.
    expect(
      outstanding.length,
      "no setup step rendered as still to do, so this render cannot test the disagreement",
    ).toBeGreaterThan(0);

    const heading = screen.getByRole("heading", { level: 1 }).textContent ?? "";
    expect(heading.length, "the page rendered no heading text").toBeGreaterThan(0);

    const drawn = drawnReadinessTitle();
    expect(drawn.length, "the drawing's title came back empty").toBeGreaterThan(0);
    expect(heading).not.toBe(drawn);
    expect(heading).not.toMatch(READINESS_CLAIM);
  });

  /**
   * The other half: the strip and the heading are drawn from one evidence set, so the words a
   * screen reader gets out of the strip agree with the heading by construction rather than by two
   * authors happening to say the same thing.
   */
  it("says the same thing in the strip that it says in the heading", async () => {
    render(await OnboardingPage());

    const steps = Array.from(document.querySelectorAll('[data-slot="setup-step"]'));
    expect(steps.length, "the strip did not render, so there was nothing to compare").toBe(4);
    expect(steps.some((step) => (step.textContent ?? "").includes("still to do"))).toBe(true);
    expect(steps.some((step) => (step.textContent ?? "").includes("done"))).toBe(false);
  });
});
