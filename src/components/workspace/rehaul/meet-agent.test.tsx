import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RehaulMeetAgent } from "./meet-agent";

/**
 * The rehaul body of `/meet-agent`.
 *
 * The rules fixture is the only interesting input: the ledger row that checks it is the one place
 * on the screen that makes a claim about the coach's own configuration, so both the published and
 * the unpublished shapes are asserted rather than only the happy one.
 */
describe("RehaulMeetAgent", () => {
  it("draws the title, one row per turn and the coach's own floor", () => {
    render(
      <RehaulMeetAgent
        coachName="Reid"
        rules={{ creditFloor: 700, minimumRaiseCents: 2_500_000 }}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Meet your agent" }),
    ).toBeInTheDocument();

    // Six scripted turns, six rows, and the count is read off the turns rather than written.
    expect(screen.getByText("6 turns")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("Turn 1")).toBeInTheDocument();
    expect(screen.getByText("Turn 6")).toBeInTheDocument();

    // The published floor, printed as the coach's own number and not an invented one.
    expect(screen.getByText("700 or more")).toBeInTheDocument();
    expect(
      screen.getByText("Checked your own rules, 720 and $60,000 clear both"),
    ).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Try it yourself" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to your agent" })).toHaveAttribute(
      "href",
      "/coach/agent",
    );
  });

  it("says no rules are published rather than printing a floor of somebody else's", () => {
    render(<RehaulMeetAgent rules={{ creditFloor: null, minimumRaiseCents: null }} />);

    expect(screen.getByText("none published")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Looked for your credit floor and smallest raise, and you have published neither",
      ),
    ).toBeInTheDocument();
  });

  it("prints none of the explainer sentences the shipped preview carried", () => {
    const { container } = render(
      <RehaulMeetAgent rules={{ creditFloor: 700, minimumRaiseCents: 2_500_000 }} />,
    );

    const text = container.textContent ?? "";
    for (const sentence of [
      "Both sides of this conversation are written",
      "Nothing here reaches anyone",
      "A written demonstration, not a recording of your own agent",
      "Your real conversations are in your inbox",
      "That knowledge is kept current for you",
      "Going live turns your agent on",
    ]) {
      expect(text).not.toContain(sentence);
    }
  });
});
