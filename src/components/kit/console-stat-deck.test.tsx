import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConsoleStatDeck } from "@/components/kit/console-stat-deck";
import type { StatStripItem } from "@/components/kit/stat-strip";

function panels() {
  return [...document.querySelectorAll('[data-slot="console-stat-panel"]')];
}

function panelFor(label: string) {
  return screen.getByText(label).closest('[data-slot="console-stat-panel"]') as HTMLElement;
}

const value = (label: string, n: number): StatStripItem => ({
  label,
  availability: { kind: "value", value: n, format: "count" },
});

describe("ConsoleStatDeck", () => {
  it("draws one panel per item, each naming its own figure", () => {
    render(
      <ConsoleStatDeck
        ariaLabel="Figures"
        items={[value("Live", 21), value("Draft", 2), value("Paused", 1)]}
      />,
    );

    expect(panels()).toHaveLength(3);
    expect(within(panelFor("Live")).getByText("21")).toBeInTheDocument();
    expect(within(panelFor("Draft")).getByText("2")).toBeInTheDocument();
  });

  /**
   * The drift this catches is a second lane adding a drench to a console screen that already has
   * one. `console.css` allows exactly one saturated panel per console screen -- a screen that
   * already spends attention on a nineteen-item rail, a topbar and a banded table has nothing left
   * to rank a second fill against -- and this component is the one place that decides.
   */
  it("drenches only the named hero, and only one of them", () => {
    render(
      <ConsoleStatDeck
        ariaLabel="Figures"
        heroLabel="Booked"
        items={[value("Measured", 12), value("Booked", 342), value("Per client", 28)]}
      />,
    );

    const drenched = panels().filter((panel) => panel.getAttribute("data-drench"));
    expect(drenched).toHaveLength(1);
    expect(drenched[0]).toHaveTextContent("Booked");
    expect(drenched[0].getAttribute("data-hero")).toBe("true");
  });

  it("spends no fill at all when no hero is named", () => {
    render(<ConsoleStatDeck ariaLabel="Figures" items={[value("Live", 21), value("Draft", 2)]} />);

    expect(panels().filter((panel) => panel.getAttribute("data-drench"))).toHaveLength(0);
  });

  /**
   * A hero label that matches nothing must draw a plain strip rather than throw. A console strip
   * whose leading figure became unavailable is a normal Tuesday, and the page still has to render.
   */
  it("renders a plain strip when the hero label matches no item", () => {
    render(<ConsoleStatDeck ariaLabel="Figures" heroLabel="Gone" items={[value("Live", 21)]} />);

    expect(panels()).toHaveLength(1);
    expect(panels()[0].getAttribute("data-drench")).toBeNull();
  });

  /**
   * The honest-states rule, rendered. Each of these is a different claim and the panel has to make
   * the difference visible: a measured window with nothing in it is a real zero, and a read that
   * did not answer is not a zero at all.
   */
  it("separates a measured zero from a figure that could not be read", () => {
    render(
      <ConsoleStatDeck
        ariaLabel="Figures"
        items={[
          { label: "Bookings", availability: { kind: "no-events", note: "No calls in this window" } },
          { label: "Margin", availability: { kind: "unavailable", note: "The cost rollup did not answer" } },
        ]}
      />,
    );

    expect(within(panelFor("Bookings")).getByText("0")).toBeInTheDocument();
    expect(within(panelFor("Bookings")).getByText("No calls in this window")).toBeInTheDocument();

    expect(within(panelFor("Margin")).getByText("not yet")).toBeInTheDocument();
    expect(within(panelFor("Margin")).queryByText("0")).toBeNull();
    expect(within(panelFor("Margin")).getByText("The cost rollup did not answer")).toBeInTheDocument();
  });

  /**
   * A provisioning figure states a day counter and never a percentage or a predicted date. The
   * rule is `CLAUDE.md`'s, it is why `Callout` has no percentage prop, and a larger console panel
   * is exactly where somebody would be tempted to draw a progress bar instead.
   */
  it("states a needs-history figure as a day count, never as a percentage", () => {
    render(
      <ConsoleStatDeck
        ariaLabel="Figures"
        items={[{ label: "Reply rate", availability: { kind: "needs-history", days: 4, needs: 30 } }]}
      />,
    );

    const panel = panelFor("Reply rate");
    expect(within(panel).getByText("not yet")).toBeInTheDocument();
    expect(panel).toHaveTextContent("Day 4 of about 30 needed");
    expect(panel.textContent).not.toMatch(/%/u);
  });

  /**
   * The two renderers of `StatStripItem` must agree on decimals. A strip reading "6%" over a table
   * reading "6.0%" for the same number is the kind of mismatch a reader resolves by trusting
   * neither, which is why `figureText` is shared rather than reimplemented here.
   */
  it("honours the item's fixed precision", () => {
    render(
      <ConsoleStatDeck
        ariaLabel="Figures"
        items={[{
          label: "Booked per client",
          availability: { kind: "value", value: 28.25, format: "count" },
          precision: 1,
        }]}
      />,
    );

    expect(within(panelFor("Booked per client")).getByText("28.3")).toBeInTheDocument();
  });

  it("prefers the item's own note over the availability's", () => {
    render(
      <ConsoleStatDeck
        ariaLabel="Figures"
        items={[{
          label: "Margin",
          availability: { kind: "unavailable", note: "Rollup did not answer" },
          note: "Margin is platform-only and never reaches a coach's screen.",
        }]}
      />,
    );

    const panel = panelFor("Margin");
    expect(panel).toHaveTextContent("Margin is platform-only");
    expect(panel).not.toHaveTextContent("Rollup did not answer");
  });
});
