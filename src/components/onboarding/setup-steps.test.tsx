import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { outstandingSetupSteps, SetupSteps } from "@/components/onboarding/setup-steps";

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
 * The function a page's headline branches on, tested from both sides.
 *
 * One side is the bug it exists for -- a page must be able to see that it is still waiting on
 * something -- and the other is the arm that lets a page say so when it genuinely is finished. A
 * function that always reported outstanding work would satisfy the first alone, and the go-live
 * headline would then be stuck on its cautious sentence forever without anybody noticing.
 */
describe("outstandingSetupSteps", () => {
  it("counts every step with no evidence, wherever it sits relative to the current one", () => {
    expect(outstandingSetupSteps([], "go_live")).toEqual(["connect", "offer", "meet"]);
    expect(outstandingSetupSteps(["connect"], "go_live")).toEqual(["offer", "meet"]);
    // Position proves nothing: `go_live` is not ticked by standing on `offer`, and it is not
    // outstanding there either, because a coach on step two is not waiting on step four.
    expect(outstandingSetupSteps(["connect"], "offer")).toEqual(["meet", "go_live"]);
  });

  it("reports nothing outstanding once every other step is proved", () => {
    expect(outstandingSetupSteps(["connect", "offer", "meet"], "go_live")).toEqual([]);
  });

  it("does not count the step the reader is standing on", () => {
    expect(outstandingSetupSteps(["connect", "offer", "meet"], "go_live")).not.toContain("go_live");
  });
});
