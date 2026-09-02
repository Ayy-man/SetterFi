import { fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { StepJourney, type JourneyStep } from "@/components/kit/step-journey"

const CALENDAR_DATE =
  /\b(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/i

const STEPS: readonly JourneyStep[] = [
  {
    body: "Your workspace was created.",
    key: "workspace",
    owner: "setterfi",
    receipt: { at: "2026-08-12T16:00:00.000Z", label: "Workspace confirmed" },
    state: "done",
    title: "Create your workspace",
  },
  {
    action: { label: "Connect calendar" },
    body: "Connect a calendar so your agent can offer real times.",
    key: "calendar",
    owner: "you",
    state: "current",
    title: "Connect your calendar",
  },
  {
    body: "Carriers are reviewing your registration by hand.",
    key: "carrier",
    owner: "carrier",
    state: "waiting",
    title: "Carrier review",
    wait: { since: "2026-08-14T16:00:00.000Z", typicalDays: [14, 21] },
  },
]

describe("StepJourney", () => {
  afterEach(() => vi.useRealTimers())

  it("renders exactly one current treatment and keeps waiting visually separate", () => {
    render(<StepJourney steps={STEPS} />)

    const current = document.querySelectorAll('[aria-current="step"]')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveAttribute("data-state", "current")
    expect(current[0].querySelector('[data-slot="state-badge"]')).toHaveTextContent("Ready for you")

    const waiting = document.querySelector('[data-state="waiting"]')
    expect(waiting).not.toBeNull()
    expect(within(waiting as HTMLElement).queryByText("Current")).not.toBeInTheDocument()
    expect(within(waiting as HTMLElement).getByText("Waiting on the carrier")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Connect calendar" })).toBeInTheDocument()
  })

  it("rejects a done step without its provider receipt", () => {
    const invalid: readonly JourneyStep[] = [
      { ...STEPS[0], receipt: undefined },
      STEPS[1],
    ]

    expect(() => render(<StepJourney steps={invalid} />)).toThrow(
      "A done journey step requires a valid provider receipt",
    )
  })

  it.each([
    { at: "2026-08-12T16:00:00.000Z", label: "" },
    { at: "2026-08-12T16:00:00.000Z", label: "   " },
    { at: "invalid", label: "Workspace confirmed" },
  ])("rejects a malformed provider receipt", (receipt) => {
    const invalid: readonly JourneyStep[] = [
      { ...STEPS[0], receipt },
      STEPS[1],
    ]

    expect(() => render(<StepJourney steps={invalid} />)).toThrow(
      "A done journey step requires a valid provider receipt",
    )
  })

  it("renders no action button for a carrier-owned step", () => {
    const carrierStep: JourneyStep = {
      action: { label: "Try again" },
      body: "Carriers are reviewing your registration by hand.",
      key: "carrier",
      owner: "carrier",
      state: "current",
      title: "Carrier review",
      wait: { since: "2026-08-14T16:00:00.000Z", typicalDays: [14, 21] },
    }

    render(<StepJourney steps={[carrierStep]} />)

    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByText("Nothing for you to do")).toBeInTheDocument()
  })

  it("keeps retry secondary even when it belongs to the current step", () => {
    const retryStep: JourneyStep = {
      action: { label: "Try again" },
      body: "Try the calendar check again when you are ready.",
      key: "calendar-check",
      owner: "you",
      state: "current",
      title: "Check your calendar",
    }

    render(<StepJourney steps={[retryStep]} />)

    expect(screen.getByRole("button", { name: "Try again" })).toHaveClass("border-border")
  })

  it("disables an action without a target", () => {
    render(<StepJourney steps={STEPS} />)

    expect(screen.getByRole("button", { name: "Connect calendar" })).toBeDisabled()
  })

  it("preserves the callback on a linked action", () => {
    const onClick = vi.fn()
    const linkedStep: JourneyStep = {
      action: { href: "#calendar", label: "Connect calendar", onClick },
      body: "Connect a calendar so your agent can offer real times.",
      key: "calendar",
      owner: "you",
      state: "current",
      title: "Connect your calendar",
    }

    render(<StepJourney steps={[linkedStep]} />)
    const action = screen.getByRole("button", { name: "Connect calendar" })
    expect(action.tagName).toBe("A")
    expect(action).toHaveAttribute("href", "#calendar")
    fireEvent.click(action)

    expect(onClick).toHaveBeenCalledOnce()
  })

  it("sequences a target-less upcoming action instead of hiding it", () => {
    const steps: readonly JourneyStep[] = [
      STEPS[1],
      {
        action: { label: "Choose plan" },
        body: "You pick a plan once the carrier clears you.",
        key: "subscription",
        owner: "you",
        state: "waiting",
        title: "Subscription",
      },
    ]

    render(<StepJourney steps={steps} />)

    const upcoming = document.querySelector('[data-state="waiting"]')
    expect(upcoming).not.toBeNull()
    const action = within(upcoming as HTMLElement).getByRole("button", { name: "Choose plan" })
    expect(action).toBeDisabled()
    expect(action).toHaveAttribute("aria-disabled", "true")
    expect(within(upcoming as HTMLElement).getByText("after step 1")).toBeInTheDocument()
    expect(within(upcoming as HTMLElement).queryByText("Nothing for you to do"))
      .not.toBeInTheDocument()
  })

  it("renders the day count without percentage or a future date", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-23T16:00:00.000Z"))

    render(<StepJourney steps={STEPS} />)

    const dayCounter = document.querySelector(".daycount")

    expect(dayCounter).not.toBeNull()
    expect(screen.getByText("Day 9")).toBeInTheDocument()
    expect(dayCounter).not.toHaveTextContent("%")
    expect(dayCounter).not.toHaveTextContent(CALENDAR_DATE)
    expect(within(dayCounter as HTMLElement).queryByRole("progressbar")).not.toBeInTheDocument()
  })

  it("keeps a sequenced action visible, disabled, and named after the step that holds it", () => {
    const gated: readonly JourneyStep[] = [
      STEPS[0],
      STEPS[1],
      {
        action: { label: "Choose plan" },
        body: "You pick a plan once the carrier clears you.",
        key: "subscription",
        owner: "you",
        state: "waiting",
        title: "Subscription",
      },
    ]

    render(<StepJourney steps={gated} />)

    const action = screen.getByRole("button", { name: "Choose plan" })
    expect(action).toBeDisabled()
    expect(action.parentElement).toHaveTextContent("after step 2")
  })

  it("emphasises only the current step and quiets what is still ahead", () => {
    render(<StepJourney steps={STEPS} />)

    const current = document.querySelector('[data-state="current"] .step__title')
    const waiting = document.querySelector('[data-state="waiting"] .step__title')

    expect(current?.className).toContain("text-[length:var(--t-section)]")
    expect(waiting?.className).not.toContain("text-[length:var(--t-section)]")
    expect(waiting?.className).toContain("text-[color:var(--muted)]")
  })
})
