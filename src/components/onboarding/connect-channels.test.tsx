import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectChannels } from "@/components/onboarding/connect-channels";
import type { ConnectCard } from "@/components/onboarding/connect-view-models";

/**
 * The connect step's carrier wait, which had a fix and no test.
 *
 * `connect-channels.tsx` mounts `DayCounter` on the SMS card, and the coach-scale lift added in
 * `7fec543f` reaches it through `.daycount` in `coach.css`. That mount was found only because a
 * vitest run was given nine paths and ran eight files -- this file did not exist. A fix nothing
 * asserts is a fix that survives exactly until somebody refactors the card.
 *
 * What this can and cannot check: jsdom applies no stylesheet, so it cannot measure the rendered
 * size, and a `getComputedStyle` assertion here would read `var(--coach-body)` straight back and
 * pass against any value at all. What it can prove is the two conditions the scoped rule needs --
 * the hook it selects on is on the element, and this surface reaches the root the rule is scoped
 * to -- plus the honest-states claims the sentence itself has to keep. The size half is asserted
 * where the sheet can be read, in `day-counter.test.tsx`.
 */
function card(overrides: Partial<ConnectCard> = {}): ConnectCard {
  return {
    action: null,
    body: "Your agent answers every DM.",
    detail: null,
    eyebrow: "Direct messages",
    key: "instagram",
    name: "Instagram",
    note: "Answering within a day of you connecting it.",
    provedAt: null,
    status: null,
    wait: null,
    ...overrides,
  };
}

const SMS = card({
  eyebrow: "Text messages",
  key: "sms",
  name: "Text messages",
  note: "The carriers vet every business before it can send texts.",
  wait: { since: "2026-08-14T16:00:00.000Z" },
});

describe("ConnectChannels carrier wait", () => {
  it("renders the day counter with the hook the coach scale rule selects on", () => {
    const { container } = render(<ConnectChannels cards={[SMS]} nextEnabled={false} />);

    // The positive control: the card itself has to be on screen, or the queries below are
    // asserting about a component that rendered nothing.
    expect(screen.getByRole("heading", { name: "Text messages" })).toBeInTheDocument();

    const counter = container.querySelector(".daycount");
    expect(counter, "the SMS card rendered no .daycount, so coach.css reaches nothing here")
      .not.toBeNull();
    expect(counter).toHaveTextContent(/typical \d+ to \d+ days/u);
  });

  it("is reached by the same scoped rule the other three coach mounts are", () => {
    const coachCss = readFileSync(
      resolve(process.cwd(), "src/app/(workspace)/coach/coach.css"),
      "utf8",
    );

    /*
     * This surface renders inside `OnboardingStage`, which wraps `CoachScale`, which stamps
     * `data-shell-role="coach"`. That is what makes the scoped rule apply here at all, and it is
     * asserted at the stage rather than mocked: a rule that never matches fails silently and looks
     * identical to a fix.
     */
    const stage = readFileSync(
      resolve(process.cwd(), "src/components/onboarding/onboarding-stage.tsx"),
      "utf8",
    );
    expect(stage).toContain("CoachScale");
    expect(coachCss).toContain('[data-shell-role="coach"] .daycount');
  });

  /**
   * The claim the A2P sentence exists to make, on the surface a coach meets it first.
   *
   * `CLAUDE.md` is explicit: SMS registration takes two to three weeks per coach, and that gets a
   * real day counter -- never a percentage, never a predicted finish date. `DayCounter` keeps that
   * promise in its own tests; this pins that the card around it does not undo it in copy.
   */
  it("states the wait as a day count, with no percentage and no predicted date", () => {
    const { container } = render(<ConnectChannels cards={[SMS]} nextEnabled={false} />);

    expect(container).toHaveTextContent(/Day \d+/u);
    expect(container).not.toHaveTextContent("%");
    expect(container).not.toHaveTextContent(/\bby (Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/u);
    expect(container).not.toHaveTextContent(/all set|ready to send|complete/iu);
  });

  /**
   * The card carrying a three-week wait is never the one the eye lands on first. The component's
   * own docstring says so; without a test it is a comment. `accentKey` picks the first card that
   * is genuinely waiting on the coach, and SMS is excluded by key.
   */
  it("never spends the accent on the card a coach cannot act on", () => {
    const withAction = card({ action: { href: "/connect/instagram", label: "Connect Instagram" } });
    const smsWithAction = { ...SMS, action: { href: "/connect/sms", label: "Start texting" } };

    const { container } = render(
      <ConnectChannels cards={[smsWithAction, withAction]} nextEnabled={false} />,
    );

    /*
     * Matched on `--accent-fill`, which is what the fill actually is, not on the word "primary".
     * The first version of this looked for `a[class*="primary"]` -- and `kitButtonClass` emits no
     * class containing that string, so the query returned null on every input and the assertion
     * could not fail. The positive control below is what makes the negative one mean anything:
     * the fill has to be found somewhere before "not on this card" is a claim about placement
     * rather than about a selector that matches nothing.
     */
    const filled = (slot: string) =>
      container.querySelector(`[data-slot="${slot}"] a[class*="--accent-fill"]`);

    expect(filled("connect-card-instagram"), "no card took the fill, so the query proves nothing")
      .not.toBeNull();
    expect(filled("connect-card-sms"), "the SMS card took the page's one fill").toBeNull();
  });
});
