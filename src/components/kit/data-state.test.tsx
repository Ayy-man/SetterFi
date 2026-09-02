import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { DataState } from "@/components/kit/data-state"
import { FAILURE_BODY } from "@/lib/copy/failure"

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

// Motion reads the reduced-motion media query once per module load and caches it, so the setup
// file's matchMedia stub cannot be flipped mid-file. The hook is stubbed instead: the assertion
// that matters is that the component branches on it, not that Motion can read a media query.
const { reducedMotion } = vi.hoisted(() => ({ reducedMotion: { current: false as boolean } }))

vi.mock("motion/react", async () => ({
  ...(await vi.importActual<typeof import("motion/react")>("motion/react")),
  useReducedMotion: () => reducedMotion.current,
}))

describe("DataState", () => {
  it("renders an unavailable read with the shared no-action sentence", async () => {
    const user = userEvent.setup()
    render(
      <DataState
        body="The platform overview could not load."
        kind="unavailable"
        title="Overview could not load"
      />,
    )

    expect(screen.getByRole("main")).toHaveTextContent(FAILURE_BODY.platform)
    expect(screen.getByRole("main")).toHaveTextContent("Overview could not load")

    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(refresh).toHaveBeenCalledOnce()
  })

  it("renders an error retry and keeps its code in a closed technical disclosure", () => {
    const retry = vi.fn()
    render(
      <DataState
        body="The saved view could not load. No client action was completed."
        code="PLATFORM_PREVIEW_READ_FAILED"
        kind="error"
        retry={retry}
        title="Saved view could not load"
      />,
    )

    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    const disclosure = screen.getByText("Technical detail").closest("details")
    expect(disclosure).not.toHaveAttribute("open")
    expect(disclosure).toContainElement(screen.getByText("PLATFORM_PREVIEW_READ_FAILED"))
    expect(screen.getByText("The saved view could not load. No client action was completed."))
      .not.toHaveTextContent("PLATFORM_PREVIEW_READ_FAILED")
  })

  it("renders the requested skeleton rows and marks loading as busy", () => {
    render(<DataState kind="loading" rows={3} />)

    const state = screen.getByRole("main", { name: "Loading content" })
    expect(state).toHaveAttribute("aria-busy", "true")
    const rows = within(state).getAllByTestId("skeleton-row")
    expect(rows).toHaveLength(3)
    // A bone stands at the height of the row that replaces it, not at the density toggle's --row-h.
    expect(rows[0]).toHaveClass("h-[var(--d-row)]")
    expect(within(state).getAllByTestId("skeleton-bone")).toHaveLength(15)
  })

  it.each([
    <DataState key="loading" kind="loading" />,
    <DataState body="Create one to begin." key="empty" kind="empty" title="No corrections in this period" />,
    <DataState body={FAILURE_BODY.client} key="unavailable" kind="unavailable" title="Client details could not load" />,
    <DataState body="The request failed." key="error" kind="error" retry={() => undefined} title="Request could not finish" />,
  ])("never renders Unavailable as the only content", (state) => {
    const { container } = render(state)

    expect(container.textContent?.trim()).not.toBe("Unavailable")
  })
  it("frames an empty result as a dashed block with one sentence and one outlined action", () => {
    render(
      <DataState
        action={{ label: "Add a correction", onClick: () => undefined }}
        body="Corrections you post will show up here."
        kind="empty"
        title="No corrections in this period"
      />,
    )

    const block = document.querySelector<HTMLElement>('[data-slot="empty-state"]')

    expect(block?.className).toContain("border-dashed")
    expect(block?.className).toContain("items-center")
    expect(screen.getByRole("heading", { name: "No corrections in this period" })).toBeInTheDocument()
    expect(screen.getByText("Corrections you post will show up here.")).toBeInTheDocument()
    expect(within(block!).getAllByRole("button")).toHaveLength(1)
  })

  it("draws the escalations empty state in, and leaves it still under reduced motion", () => {
    render(
      <DataState
        body="Nothing has been escalated to you."
        kind="empty"
        title="No open escalations"
        variant="escalations"
      />,
    )

    expect(document.querySelector('[data-slot="empty-state"]')).toHaveAttribute("data-motion", "draw-in")

    cleanup()
    reducedMotion.current = true

    render(
      <DataState
        body="Nothing has been escalated to you."
        kind="empty"
        title="No open escalations"
        variant="escalations"
      />,
    )

    expect(document.querySelector('[data-slot="empty-state"]')).toHaveAttribute("data-motion", "none")
    reducedMotion.current = false
  })
})
