import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BAR_CHART_PAST_OPACITY, BarChart } from "@/components/kit/bar-chart";

describe("BarChart", () => {
  it("draws one solid current bar, translucent past bars, one baseline and no gridlines", () => {
    const { container } = render(
      <BarChart label="Signups by month" labels={["Apr", "May", "Jun"]} values={[1, 3, 2]} />,
    );
    const bars = container.querySelectorAll('rect[data-slot="bar"]');
    const current = container.querySelectorAll('rect[data-slot="bar-current"]');
    expect(bars).toHaveLength(2);
    expect(current).toHaveLength(1);
    expect(bars[0]?.getAttribute("fill-opacity")).toBe(String(BAR_CHART_PAST_OPACITY));
    expect(current[0]?.getAttribute("fill-opacity")).toBe("1");
    expect(current[0]?.getAttribute("rx")).toBe("4");
    expect(container.querySelectorAll("line")).toHaveLength(1);
  });

  it("labels only the two ends and puts every figure in the table", () => {
    render(<BarChart label="Signups by month" labels={["Apr", "May", "Jun"]} values={[1, 3, 2]} />);
    expect(screen.getByRole("img", { name: "Signups by month" })).toBeTruthy();
    expect(screen.getAllByText("Apr")).toHaveLength(2);
    expect(screen.getAllByText("May")).toHaveLength(1);
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("prints the latest bar's own reading above it, and keeps it clear of the top", () => {
    const { container } = render(
      <BarChart
        currentValueLabel="$2,982"
        height={72}
        label="Gross MRR by period"
        labels={["Jul", "Aug"]}
        values={[210_000, 298_200]}
        width={400}
      />,
    );

    const value = container.querySelector('[data-slot="bar-current-value"]');
    expect(value?.textContent).toBe("$2,982");
    // The label is anchored at the current bar's right edge, so a long figure cannot run off the
    // end of the box, and it sits inside the box rather than clipping out of the top of it.
    expect(value?.getAttribute("text-anchor")).toBe("end");
    expect(Number(value?.getAttribute("x"))).toBeLessThanOrEqual(400);
    expect(Number(value?.getAttribute("y"))).toBeGreaterThanOrEqual(14);
  });

  it("reads a value in the caller's units in the sr-only table, not in its raw unit", () => {
    render(
      <BarChart
        label="Gross MRR by period"
        labels={["Jul", "Aug"]}
        valueText={(value) => `$${value / 100}`}
        values={[210_000, 298_200]}
      />,
    );

    // The table is all a screen reader has, so a series carried in cents must not put "298200" in
    // front of the one reader who cannot see the label saying $2,982.
    const table = screen.getByRole("table");
    expect(table.textContent).toContain("$2982");
    expect(table.textContent).not.toContain("298200");
  });

  it("reserves no headroom when there is no value label to draw", () => {
    const { container } = render(
      <BarChart label="Signups by month" labels={["Apr", "May"]} values={[1, 3]} />,
    );

    expect(container.querySelector('[data-slot="bar-current-value"]')).toBeNull();
    // The tallest bar still runs to the 4px padding rather than to a band nothing occupies.
    const current = container.querySelector('rect[data-slot="bar-current"]');
    expect(Number(current?.getAttribute("y"))).toBeCloseTo(4, 5);
  });

  it("renders nothing for an empty series", () => {
    const { container } = render(<BarChart label="Empty" labels={[]} values={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
