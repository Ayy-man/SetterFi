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

  it("renders nothing for an empty series", () => {
    const { container } = render(<BarChart label="Empty" labels={[]} values={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
