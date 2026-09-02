import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CHART_ACCENT,
  CHART_AXIS_LABEL_CLASS,
  CHART_BASELINE_COLOR,
  CHART_BASELINE_WIDTH,
  CHART_EMPHASIS_COLOR,
  CHART_EMPHASIS_WIDTH,
  CHART_LEGEND_SWATCH_PX,
  CHART_SERIES,
  ChartAxisEnds,
  ChartBaseline,
  ChartLegend,
  ChartTooltip,
  areaPath,
  axisEnds,
  chartExtent,
  chartGeometry,
  seriesColor,
  smoothPath,
} from "@/components/kit/chart-theme";

describe("chart theme tokens", () => {
  it("offers exactly the three data tokens as the series palette, in order", () => {
    expect(CHART_SERIES).toEqual([
      "var(--t-data-1)",
      "var(--t-data-2)",
      "var(--t-data-3)",
    ]);
    expect(CHART_ACCENT).toBe("var(--t-data-1)");
  });

  it("picks a series by index and wraps rather than blanking an over-budget chart", () => {
    expect(seriesColor(0)).toBe("var(--t-data-1)");
    expect(seriesColor(2)).toBe("var(--t-data-3)");
    expect(seriesColor(3)).toBe("var(--t-data-1)");
    expect(seriesColor(-1)).toBe("var(--t-data-3)");
  });

  it("keeps the baseline a hairline and the current-period emphasis a 2px accent ring", () => {
    expect(CHART_BASELINE_COLOR).toBe("var(--line)");
    expect(CHART_BASELINE_WIDTH).toBe(1);
    expect(CHART_EMPHASIS_WIDTH).toBe(2);
    // Emphasis is the same hue as the series it emphasises, never a fourth colour.
    expect(CHART_EMPHASIS_COLOR).toBe(CHART_ACCENT);
  });

  it("styles axis labels as mono 10 faint", () => {
    expect(CHART_AXIS_LABEL_CLASS).toContain("var(--font-mono)");
    expect(CHART_AXIS_LABEL_CLASS).toContain("text-[10px]");
    expect(CHART_AXIS_LABEL_CLASS).toContain("text-[var(--faint)]");
  });
});

describe("chart geometry helpers", () => {
  it("never divides by a zero range, so a flat series still draws", () => {
    expect(chartExtent([5, 5, 5])).toEqual({ minimum: 5, maximum: 5, range: 1 });
    expect(chartExtent([])).toEqual({ minimum: 0, maximum: 0, range: 1 });

    const flat = chartGeometry([5, 5, 5], { height: 20, width: 100 });
    for (const point of flat) expect(Number.isFinite(point.y)).toBe(true);
  });

  it("lays points out in CSS pixels across the padded box, y inverted for SVG", () => {
    const points = chartGeometry([0, 10], { height: 20, padX: 4, padY: 4, width: 100 });

    expect(points[0]).toEqual({ x: 4, y: 16 });
    expect(points[1]).toEqual({ x: 96, y: 4 });
  });

  it("centres a single point instead of pinning it to the left edge", () => {
    const [only] = chartGeometry([3], { height: 20, width: 100 });
    expect(only?.x).toBe(50);
  });

  it("smooths with cubics that start and end on the real points", () => {
    const path = smoothPath([
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 20, y: 10 },
    ]);

    expect(path.startsWith("M 0 10")).toBe(true);
    expect(path).toContain("C");
    expect(path.trimEnd().endsWith("20 10")).toBe(true);
  });

  it("degrades to a move for a single point and to nothing for an empty series", () => {
    expect(smoothPath([{ x: 3, y: 4 }])).toBe("M 3 4");
    expect(smoothPath([])).toBe("");
    expect(areaPath([], 10)).toBe("");
  });

  it("closes the area down to the baseline it is given", () => {
    const area = areaPath([{ x: 0, y: 10 }, { x: 20, y: 2 }], 20);

    expect(area.endsWith("L 20 20 L 0 20 Z")).toBe(true);
  });

  it("names only the two ends of the range", () => {
    expect(axisEnds(["Jan", "Feb", "Mar"])).toEqual({ start: "Jan", end: "Mar" });
    expect(axisEnds([])).toBeNull();
  });
});

describe("chart theme components", () => {
  it("renders a legend as words with an 8px square per series", () => {
    render(<ChartLegend items={[{ label: "Booked", series: 0 }, { label: "Replied", series: 1 }]} />);

    expect(screen.getByText("Booked")).toBeVisible();
    const swatches = document.querySelectorAll('[data-slot="chart-legend-swatch"]');
    expect(swatches).toHaveLength(2);
    expect((swatches[0] as HTMLElement).style.width).toBe(`${CHART_LEGEND_SWATCH_PX}px`);
    expect((swatches[0] as HTMLElement).style.backgroundColor).toBe("var(--t-data-1)");
    expect((swatches[1] as HTMLElement).style.backgroundColor).toBe("var(--t-data-2)");
  });

  it("draws one baseline hairline across the width it is given", () => {
    render(
      <svg>
        <ChartBaseline width={100} y={20} />
      </svg>,
    );

    const baseline = document.querySelector('[data-slot="chart-baseline"]');
    expect(baseline).toHaveAttribute("stroke", CHART_BASELINE_COLOR);
    expect(baseline).toHaveAttribute("stroke-width", String(CHART_BASELINE_WIDTH));
    expect(baseline).toHaveAttribute("x2", "100");
    expect(baseline).toHaveAttribute("y1", "20");
    expect(baseline).toHaveAttribute("y2", "20");
  });

  it("labels the range at its two ends only", () => {
    render(<ChartAxisEnds labels={["Jan", "Feb", "Mar", "Apr"]} />);

    const ends = document.querySelector('[data-slot="chart-axis-ends"]');
    expect(ends?.children).toHaveLength(2);
    expect(ends).toHaveTextContent("Jan");
    expect(ends).toHaveTextContent("Apr");
    // The middle of the range is left to the sr-only table each chart carries.
    expect(ends?.textContent).not.toContain("Feb");
  });

  it("styles the tooltip on the card tokens", () => {
    render(<ChartTooltip label="Mar 2026">42</ChartTooltip>);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveClass("border-[var(--line)]", "bg-[var(--raised)]");
    expect(tooltip).toHaveClass("rounded-[var(--r-card)]");
    expect(tooltip).toHaveTextContent("Mar 2026");
    expect(tooltip).toHaveTextContent("42");
  });
});
