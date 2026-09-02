import { render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { describe, expect, it, vi } from "vitest"

import { TrendPanel, type TrendData } from "@/components/kit/trend-panel"

const readyData: TrendData = {
  minPeriods: 2,
  periodLabel: "Monthly",
  points: [
    { at: "July 2026", value: 18 },
    { at: "August 2026", value: 24 },
  ],
}

describe("TrendPanel", () => {
  it("shows the stated reason without a line below the required periods", () => {
    const emptyReason =
      "A qualification-rate line needs two months carrying leads; this workspace has one"
    const { container } = render(
      <TrendPanel
        data={{ ...readyData, points: readyData.points.slice(0, 1) }}
        emptyReason={emptyReason}
        title="Qualification rate"
      />
    )

    expect(screen.getByText(emptyReason)).toBeInTheDocument()
    expect(container.querySelector("path")).not.toBeInTheDocument()
    expect(container.querySelector(".trend__chart")).toHaveClass(
      "h-[calc(var(--s-12)*2+var(--s-6))]"
    )
  })

  it("keeps a zero-only series in the teaching state", () => {
    const emptyReason = "A trend appears after this period records activity"
    const { container } = render(
      <TrendPanel
        data={{
          ...readyData,
          points: readyData.points.map((point) => ({ ...point, value: 0 })),
        }}
        emptyReason={emptyReason}
        title="Qualification rate"
      />
    )

    expect(screen.getByText(emptyReason)).toBeInTheDocument()
    expect(container.querySelector("path")).not.toBeInTheDocument()
  })

  it("renders a line and a hidden data row for every available point", () => {
    const { container } = render(
      <TrendPanel
        data={readyData}
        emptyReason="Two monthly readings are required"
        title="Qualification rate"
      />
    )

    expect(container.querySelector("path")).toBeInTheDocument()
    const table = container.querySelector("table.sr-only")
    expect(table).toBeInTheDocument()
    expect(within(table as HTMLTableElement).getAllByRole("row")).toHaveLength(
      readyData.points.length
    )
    expect(within(table as HTMLTableElement).getByText("24")).toBeInTheDocument()
  })


  it("scrolls the period axis with the plot rather than beside it", () => {
    const { container } = render(
      <TrendPanel
        data={readyData}
        emptyReason="Two monthly readings are required"
        title="Qualification rate"
      />
    )

    const scroller = container.querySelector<HTMLElement>(".trend__chart")
    const axis = container.querySelector<HTMLElement>(".trend__axis")
    expect(scroller).not.toBeNull()
    expect(axis).not.toBeNull()
    // One scroller holds both, so a label cannot part company with the marker above it.
    expect(scroller?.contains(axis as Node)).toBe(true)
    expect(scroller?.contains(container.querySelector("svg") as Node)).toBe(true)
  })

  it("places each period label at its own point rather than spreading them evenly", () => {
    const { container } = render(
      <TrendPanel
        data={readyData}
        emptyReason="Two monthly readings are required"
        title="Qualification rate"
      />
    )

    const dots = Array.from(container.querySelectorAll("circle.dot"), (dot) =>
      Number(dot.getAttribute("cx"))
    )
    const labels = Array.from(
      container.querySelectorAll<HTMLElement>(".trend__axis span"),
      (label) => Number.parseFloat(label.style.left)
    )

    expect(labels).toEqual(dots)
  })

  it("keeps zero bars at zero height in a mixed series and emphasizes the endpoint", () => {
    const mixedData: TrendData = {
      ...readyData,
      points: [
        { at: "June 2026", value: 0 },
        { at: "July 2026", value: 18 },
        { at: "August 2026", value: 24 },
      ],
    }
    const { container } = render(
      <TrendPanel
        data={mixedData}
        emptyReason="Two monthly readings are required"
        title="Qualification rate"
      />
    )

    const bars = Array.from(container.querySelectorAll("rect.bar"))
    expect(bars).toHaveLength(mixedData.points.length)
    expect(bars[0]).toHaveAttribute("height", "0")
    expect(Number(bars[1]?.getAttribute("height"))).toBeGreaterThan(0)
    expect(bars[0]).toHaveClass("fill-[var(--color-chart-2)]")
    expect(bars.at(-1)).toHaveClass("fill-[var(--color-chart-1)]")
    expect(bars.at(-1)).not.toHaveClass("fill-[var(--color-chart-2)]")
  })

  it("renders one axis label for every available period", () => {
    const periodData: TrendData = {
      ...readyData,
      points: [
        { at: "May 2026", value: 12 },
        { at: "June 2026", value: 16 },
        { at: "July 2026", value: 18 },
        { at: "August 2026", value: 24 },
      ],
    }
    const { container } = render(
      <TrendPanel
        data={periodData}
        emptyReason="Two monthly readings are required"
        title="Qualification rate"
      />
    )

    const labels = Array.from(
      container.querySelectorAll(".trend__axis span"),
      (label) => label.textContent
    )
    expect(labels).toEqual(periodData.points.map((point) => point.at))
  })

  it("contains horizontal overscroll only when the chart is wider than its viewport", () => {
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(320)
    const scrollWidth = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockReturnValue(640)

    const { container } = render(
      <TrendPanel
        data={readyData}
        emptyReason="Two monthly readings are required"
        title="Qualification rate"
      />
    )

    const chart = container.querySelector<HTMLElement>(".trend__chart")
    expect(chart).toHaveStyle({ overscrollBehaviorX: "contain" })
    expect(chart).toHaveAttribute("tabindex", "0")
    expect(chart).toHaveClass("overflow-x-auto")
    expect(chart).toHaveAttribute("role", "region")
    expect(chart).toHaveAccessibleName("Qualification rate")

    clientWidth.mockRestore()
    scrollWidth.mockRestore()
  })

  it("does not make a chart focusable when its content fits", () => {
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(640)
    const scrollWidth = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockReturnValue(320)

    const { container } = render(
      <TrendPanel
        data={readyData}
        emptyReason="Two monthly readings are required"
        title="Qualification rate"
      />
    )

    const chart = container.querySelector<HTMLElement>(".trend__chart")
    expect(chart).not.toHaveAttribute("tabindex")
    expect(chart).not.toHaveAttribute("role")
    expect(chart).not.toHaveClass("overflow-x-auto")
    expect(chart).not.toHaveStyle({ overscrollBehaviorX: "contain" })

    clientWidth.mockRestore()
    scrollWidth.mockRestore()
  })
})
