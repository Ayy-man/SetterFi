import { fireEvent, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  HeadlineStat,
  type MetricAvailability,
} from "@/components/kit/headline-stat";
import { StatStrip } from "@/components/kit/stat-strip";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("HeadlineStat", () => {
  let style: HTMLStyleElement;

  beforeAll(() => {
    style = document.createElement("style");
    style.textContent = `.text-metric { font-size: 30px; }`;
    document.head.append(style);
  });

  afterAll(() => style.remove());

  it("renders a valid no-events result as the figure character 0", () => {
    const { container } = render(
      <HeadlineStat
        availability={{ kind: "no-events", note: "No qualified leads yet" }}
        label="Qualified leads"
      />,
    );

    const stat = container.querySelector('[data-slot="headline-stat"]') as HTMLElement;
    const figure = stat.querySelector('[data-slot="headline-stat-figure"]');
    expect(figure).toHaveTextContent(/^0$/);
    expect(stat).toHaveTextContent("No qualified leads yet");
  });

  it("renders history as a day counter with no percentage", () => {
    const { container } = render(
      <HeadlineStat
        availability={{ kind: "needs-history", days: 12, needs: 60 }}
        label="Retention"
      />,
    );

    const stat = container.querySelector('[data-slot="headline-stat"]') as HTMLElement;
    expect(stat).toHaveTextContent("Day 12");
    expect(stat).toHaveTextContent("of about 60 needed");
    expect(stat).not.toHaveTextContent("%");
    expect(stat.querySelector('[data-slot="headline-stat-figure"]')).toBeNull();
    expect(stat.querySelector('[data-slot="headline-stat-counter"]')).toHaveTextContent(
      "Day 12",
    );
  });

  it.each<[string, MetricAvailability]>([
    ["value", { kind: "value", value: 41, format: "count" }],
    ["no events", { kind: "no-events", note: "No qualified leads yet" }],
  ])("renders the %s figure at the metric size", (label, availability) => {
    const { container } = render(<HeadlineStat availability={availability} label={label} />);

    const figure = container.querySelector('[data-slot="headline-stat-figure"]');
    expect(figure).not.toBeNull();
    expect(figure).toHaveClass("text-metric");
    expect(getComputedStyle(figure as Element).fontSize).toBe("30px");
  });

  it("renders the history counter at the metric size without making it a figure", () => {
    const { container } = render(
      <HeadlineStat
        availability={{ kind: "needs-history", days: 12, needs: 60 }}
        label="Retention"
      />,
    );

    const counter = container.querySelector('[data-slot="headline-stat-counter"]');
    expect(counter).not.toBeNull();
    expect(counter).toHaveClass("text-metric");
    expect(getComputedStyle(counter as Element).fontSize).toBe("30px");
    expect(container.querySelector('[data-slot="headline-stat-figure"]')).toBeNull();
  });

  it("puts a strip tile's day counter on the note line, not in the figure slot", () => {
    const { container } = render(
      <StatStrip
        items={[
          {
            availability: { kind: "needs-history", days: 12, needs: 60 },
            label: "Retention",
          },
        ]}
      />,
    );

    // The strip's figure slot always holds the figure, and a metric still building history has
    // none: it says "not yet" there and puts the real day count on the note line under it. A day
    // counter, never a percentage and never a predicted date.
    expect(container.querySelector('[data-slot="stat-strip-figure"]')).toHaveTextContent("not yet");
    expect(container.querySelector('[data-slot="stat-strip-day-counter"]')).toHaveTextContent(
      "day 12",
    );
  });

  it("does not apply deltas to designed absence states", () => {
    const { container } = render(
      <HeadlineStat
        availability={{ kind: "needs-history", days: 12, needs: 60 }}
        delta={{ direction: "down", goodDirection: "up", value: 3 }}
        label="Retention"
      />,
    );

    const stat = container.querySelector('[data-slot="headline-stat"]');
    expect(stat).toHaveAttribute("data-tone", "neutral");
    expect(stat?.querySelector('[data-slot="headline-stat-delta"]')).toBeNull();
  });

  it("renders a bad-direction delta with the critical tone", () => {
    const { container } = render(
      <HeadlineStat
        availability={{ kind: "value", value: 64, format: "count" }}
        delta={{ direction: "down", goodDirection: "up", value: 3 }}
        label="Booked calls"
      />,
    );

    const stat = container.querySelector('[data-slot="headline-stat"]') as HTMLElement;
    expect(stat).toHaveAttribute("data-tone", "critical");
    expect(stat.querySelector('[data-slot="headline-stat-figure"]')).toHaveAttribute(
      "data-tone",
      "critical",
    );
    expect(stat.querySelector('[data-slot="headline-stat-delta"]')).toHaveAttribute(
      "data-tone",
      "critical",
    );
  });

  it("keeps connection and read failures out of the figure slot", () => {
    const retry = vi.fn();
    const { container, rerender } = render(
      <HeadlineStat
        availability={{
          action: { href: "/settings", label: "Connect Calendar" },
          kind: "not-connected",
          source: "Calendar",
        }}
        label="Booked calls"
      />,
    );

    let stat = container.querySelector('[data-slot="headline-stat"]') as HTMLElement;
    expect(stat.querySelector('[data-slot="headline-stat-figure"]')).toBeNull();
    expect(stat.querySelector("a")).toHaveAttribute(
      "href",
      "/settings",
    );

    rerender(
      <HeadlineStat
        availability={{ kind: "read-failed", retry }}
        label="Booked calls"
      />,
    );
    stat = container.querySelector('[data-slot="headline-stat"]') as HTMLElement;
    expect(stat.querySelector('[data-slot="headline-stat-figure"]')).toBeNull();
    expect(stat.querySelector("main")).toHaveAttribute("data-tone", "critical");
    expect(stat).toHaveTextContent("We couldn't read this metric");
    fireEvent.click(stat.querySelector("button") as HTMLButtonElement);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("explains which recorded periods will populate an empty trend", () => {
    const { container } = render(
      <HeadlineStat
        availability={{ kind: "value", value: 18, format: "count" }}
        label="Active clients"
        trend={{
          minPeriods: 3,
          periodLabel: "the last three months",
          points: [{ at: "2026-08", value: 18 }],
        }}
      />,
    );

    const emptyTrend = container.querySelector('[data-slot="headline-stat-trend-empty"]');
    expect(emptyTrend).toHaveTextContent("1 of 3 periods recorded");
    expect(emptyTrend).toHaveTextContent("Trend over the last three months");
  });

  it("keeps methodology in a closed inline disclosure", () => {
    const { container } = render(
      <HeadlineStat
        availability={{ kind: "value", value: 18, format: "count" }}
        label="Active clients"
        methodology={{
          detail: <p>Only active subscription mirror rows count.</p>,
          summary: "How this is measured",
        }}
      />,
    );

    const details = container.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("How this is measured");
  });
});
