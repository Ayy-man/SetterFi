import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Callout } from "@/components/kit/callout";

const TONE_VARIABLES = {
  good: "var(--good)",
  warning: "var(--warning)",
  critical: "var(--critical)",
} as const;

function calloutElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="callout"]');
  if (!element) throw new Error("No callout rendered");
  return element;
}

describe("Callout", () => {
  it("carries its tone on the dot before the title", () => {
    render(
      <Callout
        body="Both numbers passed carrier vetting."
        title="SMS is live"
        tone="good"
      />,
    );

    const callout = calloutElement();
    const dot = callout.querySelector<HTMLElement>('[data-slot="callout-dot"]');
    const title = screen.getByText("SMS is live");

    expect(callout).toHaveAttribute("data-tone", "good");
    expect(dot).toBeInTheDocument();
    expect(dot?.className).toContain(TONE_VARIABLES.good);
    expect(dot!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(["good", "warning", "critical"] as const)(
    "keeps the %s tone colour on the dot alone, so no edge can be tinted",
    (tone) => {
      render(<Callout body="One sentence of context." title="A state" tone={tone} />);

      const callout = calloutElement();
      const variable = TONE_VARIABLES[tone];
      const tinted = [callout, ...callout.querySelectorAll<HTMLElement>("*")].filter((element) =>
        element.className.includes(variable),
      );

      // Exactly one element wears the tone, and it is the dot. A left-edge accent stripe would
      // put the tone on the container's border and land a second element in this list -- which
      // is precisely the "vibe code giveaway" the client rejected by name.
      expect(tinted).toHaveLength(1);
      expect(tinted[0]).toHaveAttribute("data-slot", "callout-dot");
      expect(callout.className).toContain("border-[var(--line)]");
    },
  );

  it("renders a whole-day count in the right-hand mono slot", () => {
    render(
      <Callout
        body="The carrier is still reviewing this registration. Nothing is needed from you."
        day={11}
        title="SMS registration in progress"
        tone="warning"
      />,
    );

    const day = document.querySelector<HTMLElement>('[data-slot="callout-day"]');

    expect(day).toHaveTextContent("day 11");
    expect(day!.className).toContain("t-mono-meta");
    // The day slot follows the copy, so the card reads title, then sentence, then count.
    const body = screen.getByText(/still reviewing this registration/);
    expect(body.compareDocumentPosition(day!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves the counter out when nothing is being waited on", () => {
    render(<Callout body="Everything on this account is current." title="Nothing pending" tone="good" />);

    expect(calloutElement().textContent).toBe("Nothing pendingEverything on this account is current.");
  });
});
