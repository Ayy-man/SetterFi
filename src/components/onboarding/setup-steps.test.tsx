import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  currentSetupStep,
  SETUP_STEP_KEYS,
  setupHeadline,
  SetupSteps,
  setupStepsRemaining,
} from "@/components/onboarding/setup-steps";

function states() {
  return screen.getAllByRole("listitem").map((node) => ({
    label: node.textContent?.replace(/\s*\(.*$/, "").replace(/^\d/, "").trim(),
    state: node.dataset.state,
  }));
}

describe("SetupSteps", () => {
  it("names all four steps in the artboard's order", () => {
    render(<SetupSteps current="connect" />);
    expect(states().map((step) => step.label)).toEqual([
      "Connect channels",
      "Tell us about your offer",
      "Meet your agent",
      "Go live",
    ]);
  });

  it("marks the current step and leaves every unproved step still to do", () => {
    render(<SetupSteps current="offer" />);
    expect(states().map((step) => step.state)).toEqual([
      "upcoming",
      "current",
      "upcoming",
      "upcoming",
    ]);
  });

  it("does not tick an earlier step merely because a later one is current", () => {
    render(<SetupSteps current="go_live" />);
    expect(states().every((step) => step.state !== "done")).toBe(true);
  });

  it("ticks only the steps the caller can prove", () => {
    render(<SetupSteps completed={["connect"]} current="offer" />);
    expect(states().map((step) => step.state)).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
    ]);
  });

  it("keeps the tick on a proved step the coach is revisiting", () => {
    render(<SetupSteps completed={["connect"]} current="connect" />);
    expect(states()[0].state).toBe("done");
  });

  it("says which step the reader is on without relying on colour", () => {
    render(<SetupSteps completed={["connect"]} current="offer" />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("done");
    expect(items[1].textContent).toContain("you are here");
    expect(items[2].textContent).toContain("still to do");
    expect(items[1]).toHaveAttribute("aria-current", "step");
  });

  it("offers no link out of a step the coach has not reached", () => {
    render(<SetupSteps current="connect" />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});

/**
 * The three derivations a page draws its rail and its headline from, tested from both sides.
 *
 * One side is the bug they exist for -- a page must be able to see that it is still waiting on
 * something, and say how much. The other is the arm that lets a page speak when it genuinely is
 * finished: a set of functions that always reported outstanding work would satisfy the first alone,
 * and the go-live headline would be stuck on a cautious sentence forever without anybody noticing.
 */
describe("currentSetupStep", () => {
  it("stands the reader on the first step nobody has proved", () => {
    expect(currentSetupStep([])).toBe("connect");
    expect(currentSetupStep(["connect"])).toBe("offer");
    expect(currentSetupStep(["connect", "offer"])).toBe("meet");
  });

  it("does not skip an unproved step because a later one is proved", () => {
    expect(currentSetupStep(["offer", "meet"])).toBe("connect");
  });

  it("reaches the final action only once every earlier step is proved", () => {
    expect(currentSetupStep(["connect", "offer", "meet"])).toBe("go_live");
  });
});

describe("setupStepsRemaining", () => {
  it("counts every unproved step before the button, and never the button", () => {
    expect(setupStepsRemaining([])).toEqual(["connect", "offer", "meet"]);
    expect(setupStepsRemaining(["offer"])).toEqual(["connect", "meet"]);
    expect(setupStepsRemaining(["connect", "offer", "meet"])).toEqual([]);
  });

  it("does not count go_live as something to do first, proved or not", () => {
    expect(setupStepsRemaining(["go_live"])).toEqual(["connect", "offer", "meet"]);
    expect(setupStepsRemaining([])).not.toContain("go_live");
  });
});

describe("setupHeadline", () => {
  it("says how many steps are left rather than only that something is", () => {
    expect(setupHeadline([])).toBe("Three steps before your agent answers");
    expect(setupHeadline(["connect"])).toBe("Two steps before your agent answers");
    expect(setupHeadline(["connect", "offer"])).toBe("One step left before your agent answers");
  });

  it("claims the agent is one press away only once nothing is left to do first", () => {
    expect(setupHeadline(["connect", "offer", "meet"]))
      .toBe("You are one button away from your agent answering");
  });

  it("makes no readiness claim while any step is unproved", () => {
    for (const completed of [[], ["connect"], ["connect", "offer"], ["offer", "meet"]] as const) {
      expect(setupHeadline(completed)).not.toMatch(/one button away|ready|all set|live/iu);
    }
  });

  it("counts only steps the strip has left unticked", () => {
    // The pairing rather than either sentence alone. Two authors can write agreeing words once;
    // this fails the moment the headline counts a step the strip is drawing as done.
    const completed = ["connect"] as const;
    render(<SetupSteps completed={completed} current={currentSetupStep(completed)} />);
    const states = screen.getAllByRole("listitem").map((node) => node.dataset.state);
    const byKey = new Map(SETUP_STEP_KEYS.map((key, index) => [key, states[index]]));

    const remaining = setupStepsRemaining(completed);
    expect(remaining, "nothing was left to count, so the pairing was not tested").not.toHaveLength(0);
    for (const key of remaining) expect(byKey.get(key)).not.toBe("done");
    expect(setupHeadline(completed)).toContain("Two steps");
    expect(remaining).toHaveLength(2);
  });
});
