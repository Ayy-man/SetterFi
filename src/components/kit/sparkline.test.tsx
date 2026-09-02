import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CHART_ACCENT, seriesColor } from "@/components/kit/chart-theme";
import { ProportionBar, Sparkline } from "@/components/kit/sparkline";

describe("Sparkline", () => {
  it("draws a labelled line, a fading area and an endpoint dot in the accent series", () => {
    render(<Sparkline label="Booked calls, last 14 days" points={[2, 5, 3, 9]} />);

    const svg = screen.getByRole("img", { name: "Booked calls, last 14 days" });
    expect(svg).toHaveAttribute("data-slot", "sparkline");

    const line = svg.querySelector('[data-slot="sparkline-line"]');
    expect(line).toHaveAttribute("stroke", CHART_ACCENT);
    expect(line).toHaveAttribute("fill", "none");

    // The fill is a gradient defined in this instance's own <defs>, so two sparklines on one
    // screen cannot end up sharing the first one's fill.
    const area = svg.querySelector('[data-slot="sparkline-area"]');
    const fill = area?.getAttribute("fill") ?? "";
    const gradientId = /^url\(#(.+)\)$/.exec(fill)?.[1];
    expect(gradientId).toBeTruthy();
    const stops = svg.querySelectorAll(`#${CSS.escape(gradientId as string)} stop`);
    expect(stops).toHaveLength(2);
    expect(stops[0]).toHaveAttribute("stop-color", CHART_ACCENT);
    // It fades to nothing rather than to a second colour or a hard edge.
    expect(stops[1]).toHaveAttribute("stop-opacity", "0");

    expect(svg.querySelector('[data-slot="sparkline-endpoint"]')).toHaveAttribute(
      "fill",
      CHART_ACCENT,
    );
  });

  it("gives each instance its own gradient so a strip of tiles keeps its fills apart", () => {
    render(
      <>
        <Sparkline label="First" points={[1, 4, 2]} />
        <Sparkline label="Second" points={[3, 1, 5]} />
      </>,
    );

    const first = screen
      .getByRole("img", { name: "First" })
      .querySelector('[data-slot="sparkline-area"]')
      ?.getAttribute("fill");
    const second = screen
      .getByRole("img", { name: "Second" })
      .querySelector('[data-slot="sparkline-area"]')
      ?.getAttribute("fill");

    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("puts the endpoint dot on the last point, at the drawn size in CSS pixels", () => {
    render(<Sparkline height={24} label="Rising" points={[0, 10]} width={96} />);

    const svg = screen.getByRole("img", { name: "Rising" });
    // viewBox matches the drawn box one-to-one: no preserveAspectRatio stretch turning the
    // 1.5px stroke into a wedge and the dot into an ellipse.
    expect(svg).toHaveAttribute("viewBox", "0 0 96 24");

    const dot = svg.querySelector('[data-slot="sparkline-endpoint"]');
    // Padding is 4px, so a two-point rising series ends at the right edge and the top.
    expect(Number(dot?.getAttribute("cx"))).toBeCloseTo(92, 5);
    expect(Number(dot?.getAttribute("cy"))).toBeCloseTo(4, 5);
  });

  it("draws no axes, no gridlines and no baseline", () => {
    const { container } = render(<Sparkline label="Quiet" points={[1, 2, 3, 4]} />);

    expect(container.querySelectorAll("line")).toHaveLength(0);
    expect(container.querySelectorAll("text")).toHaveLength(0);
    expect(container.querySelector('[data-slot="chart-baseline"]')).toBeNull();
  });

  it("renders nothing rather than a one-point 'trend'", () => {
    const { container } = render(<Sparkline label="Too short" points={[7]} />);

    // One reading is a dot, not a direction. The tile's note carries the reason instead.
    expect(container.querySelector('[data-slot="sparkline"]')).toBeNull();
  });

  it("stays inside its own data on a spike instead of overshooting below it", () => {
    render(<Sparkline height={24} label="Spike" points={[0, 0, 40]} width={96} />);

    const path = screen
      .getByRole("img", { name: "Spike" })
      .querySelector('[data-slot="sparkline-line"]')
      ?.getAttribute("d") ?? "";
    // Every y in the path, control points included, sits within the padded box. An unclamped
    // Catmull-Rom curve dips past the baseline here and draws a value the series never held.
    // Every command in the path writes coordinate pairs in order, so the numbers alternate x, y.
    const ys = (path.match(/-?\d+(?:\.\d+)?/g) ?? [])
      .map(Number)
      .filter((_, index) => index % 2 === 1);
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(4 - 0.001);
      expect(y).toBeLessThanOrEqual(20 + 0.001);
    }
  });
});

describe("ProportionBar", () => {
  function widths(container: HTMLElement) {
    return [...container.querySelectorAll('[data-slot="proportion-segment"]')].map((node) =>
      (node as HTMLElement).style.width,
    );
  }

  it("draws each segment at its exact share of the total, in the theme's series order", () => {
    const { container } = render(
      <ProportionBar
        label="Cost against revenue: model 25%, messaging 15%"
        segments={[
          { label: "Model", value: 250 },
          { label: "Messaging", value: 150 },
        ]}
        total={1000}
      />,
    );

    expect(widths(container)).toEqual(["25%", "15%"]);
    const [model, messaging] = [
      ...container.querySelectorAll('[data-slot="proportion-segment"]'),
    ] as HTMLElement[];
    expect(model.style.backgroundColor).toBe(seriesColor(0));
    expect(messaging.style.backgroundColor).toBe(seriesColor(1));
    // The shape is not the number: the shares have to be readable without seeing the bar.
    expect(screen.getByRole("img", { name: /model 25%, messaging 15%/ })).toBeInTheDocument();
  });

  it("renders nothing when the denominator was never measured", () => {
    const { container } = render(
      <ProportionBar
        label="Share of revenue"
        segments={[{ label: "Model", value: 250 }]}
        total={Number.NaN}
      />,
    );

    // A share of an unknown whole is not a share, so there is no track to read a shape off.
    expect(container.querySelector('[data-slot="proportion-bar"]')).toBeNull();
  });

  it("renders nothing rather than an empty track when no segment carries a value", () => {
    const { container } = render(
      <ProportionBar
        label="Share of revenue"
        segments={[{ label: "Model", value: 0 }, { label: "Messaging", value: 0 }]}
        total={1000}
      />,
    );

    // An empty track reads as "measured, and it was none of it" -- a different fact.
    expect(container.querySelector('[data-slot="proportion-bar"]')).toBeNull();
  });

  it("fills the track against the sum when the segments run past the total", () => {
    const { container } = render(
      <ProportionBar
        label="Cost is above revenue"
        segments={[{ label: "Model", value: 900 }, { label: "Messaging", value: 600 }]}
        total={1000}
      />,
    );

    // Clamping to 100% would draw a client losing money the same as one breaking even; scaling
    // against the sum keeps the two slices in their real ratio and leaves no remainder showing.
    expect(widths(container)).toEqual(["60%", "40%"]);
  });
});
