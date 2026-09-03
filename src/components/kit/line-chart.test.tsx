import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LineChart } from "@/components/kit/line-chart";

const labels = ["Apr", "May", "Jun", "Jul"];
const series = [
  { name: "Leads", values: [10, 14, 12, 20] },
  { name: "Booked", values: [1, 2, 2, 4] },
];

describe("LineChart", () => {
  it("draws one 2px line per series, an area under the first, a legend and one baseline", () => {
    const { container } = render(<LineChart label="Leads vs booked" labels={labels} series={series} />);
    const lines = container.querySelectorAll('path[data-slot="line-chart-line"]');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.getAttribute("stroke-width")).toBe("2");
    expect(container.querySelectorAll('path[data-slot="line-chart-area"]')).toHaveLength(1);
    expect(container.querySelectorAll("svg line")).toHaveLength(1);
    // Legend words plus the table's column headers.
    expect(screen.getAllByText("Leads")).toHaveLength(2);
    expect(screen.getAllByText("Booked")).toHaveLength(2);
  });

  it("shows a crosshair and tooltip for the hovered period", () => {
    const { container } = render(<LineChart label="Leads vs booked" labels={labels} series={series} width={300} />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 200, right: 300, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(svg, { clientX: 299 });
    expect(container.querySelector('[data-slot="line-chart-crosshair"]')).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toContain("Jul");
    expect(screen.getByRole("tooltip").textContent).toContain("Leads 20");
    fireEvent.pointerLeave(svg);
    expect(container.querySelector('[data-slot="line-chart-crosshair"]')).toBeNull();
  });

  it("caps at three series and skips one-point series", () => {
    const { container } = render(
      <LineChart
        label="Four"
        labels={labels}
        series={[...series, { name: "C", values: [1, 1, 1, 1] }, { name: "D", values: [2, 2, 2, 2] }, { name: "E", values: [3] }]}
      />,
    );
    expect(container.querySelectorAll('path[data-slot="line-chart-line"]')).toHaveLength(3);
  });
});
