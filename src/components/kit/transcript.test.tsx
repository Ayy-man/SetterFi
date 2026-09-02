import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  Transcript,
  type TranscriptMessage,
} from "@/components/kit/transcript"

describe("Transcript", () => {
  let style: HTMLStyleElement

  beforeEach(() => {
    style = document.createElement("style")
    style.textContent = ".text-read { font-size: 15px; }"
    document.head.append(style)
  })

  afterEach(() => style.remove())

  it("puts its skip link on the same rung as the shell's", () => {
    // Also a genuine overlay -- focus-revealed, absolutely positioned over the message list --
    // so it keeps the shadow. What it should not do is wear that shadow over --card, the page's
    // own material, while the shell's identical skip link sits on --raised.
    render(<Transcript messages={[]} variant="coach" />)

    expect(screen.getByRole("link", { name: "Skip to message composer" })).toHaveClass(
      "bg-[var(--raised)]",
      "shadow-[var(--shadow-raised)]"
    )
  })

  it("shows one author name for a consecutive run", () => {
    const messages: TranscriptMessage[] = [
      { id: "one", author: "agent", authorName: "Avery", body: "First", at: "9:41 AM" },
      { id: "two", author: "agent", body: "Second", at: "9:42 AM" },
      { id: "three", author: "agent", body: "Third", at: "9:43 AM" },
    ]

    render(<Transcript messages={messages} variant="coach" />)

    expect(screen.getAllByText("Avery")).toHaveLength(1)
  })

  it("uses the readable transcript type role", () => {
    render(
      <Transcript
        messages={[
          { id: "one", author: "lead", body: "Readable message", at: "9:41 AM" },
        ]}
        variant="consumer"
      />,
    )

    const message = screen.getByText("Readable message")
    expect(message).toHaveClass("text-read")
    expect(getComputedStyle(message).fontSize).toBe("15px")
  })

  it("keeps consumer team messages with the agent on the left", () => {
    render(
      <Transcript
        messages={[
          { id: "lead", author: "lead", body: "Lead reply", at: "9:41 AM" },
          { id: "agent", author: "agent", body: "Agent reply", at: "9:42 AM" },
          { id: "human", author: "human", body: "Team reply", at: "9:43 AM" },
        ]}
        variant="consumer"
      />,
    )

    expect(screen.getByText("Lead reply").closest("article")).toHaveAttribute(
      "data-side",
      "right",
    )
    expect(screen.getByText("Agent reply").closest("article")).toHaveAttribute(
      "data-side",
      "left",
    )
    expect(screen.getByText("Team reply").closest("article")).toHaveAttribute(
      "data-side",
      "left",
    )
    expect(screen.getByText("You")).toBeVisible()
    expect(screen.getByText("Team")).toBeVisible()
  })

  it("shows failed delivery only", () => {
    render(
      <Transcript
        messages={[
          {
            id: "delivered",
            author: "agent",
            body: "Delivered body",
            at: "9:41 AM",
            delivery: "delivered",
          },
          {
            id: "failed",
            author: "human",
            body: "Failed body",
            at: "9:42 AM",
            delivery: "failed",
          },
        ]}
        variant="coach"
      />,
    )

    expect(screen.queryByText("Delivered", { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText("Failed", { exact: true })).toBeInTheDocument()
  })

  it("draws the stop callout in the message flow, after the last turn", () => {
    // `Inbox.dc.html` puts the reason inside the transcript. It rendered on the list row and in a
    // collapsed accordion before this, which is everywhere except the place it explains.
    render(
      <Transcript
        messages={[
          { id: "one", author: "lead", body: "Do I lose the money I pay you?", at: "11:48 AM" },
        ]}
        stop={{
          reason: "The Brain had no grounded answer.",
          behaviour: "Nothing in the brain answered closely enough.",
        }}
        variant="coach"
      />,
    )

    const callout = screen.getByText(/Your agent stopped here/u).closest("[data-slot='transcript-stop']")
    expect(callout).not.toBeNull()
    expect(callout).toHaveClass("bg-[var(--warning-wash)]", "border-[var(--warning-line)]")
    expect(callout).toHaveTextContent("The Brain had no grounded answer.")
    expect(callout).toHaveTextContent("Nothing in the brain answered closely enough.")

    const items = screen.getAllByRole("listitem")
    expect(items.at(-1)).toBe(callout)
  })

  it("draws no stop callout when the agent has not stopped", () => {
    render(
      <Transcript
        messages={[{ id: "one", author: "agent", body: "Still working", at: "11:49 AM" }]}
        variant="coach"
      />,
    )

    expect(screen.queryByText(/Your agent stopped here/u)).toBeNull()
  })

  it("keeps the timestamp on a system event", () => {
    render(
      <Transcript
        messages={[
          {
            id: "paused",
            author: "system",
            body: "Automation paused",
            at: "10:02 AM",
          },
        ]}
        variant="coach"
      />,
    )

    expect(screen.getByText("10:02 AM")).toBeVisible()
  })

  it("keeps the log quiet and announces updates in a dedicated region", () => {
    const { container } = render(
      <Transcript
        messages={[
          { id: "one", author: "agent", body: "A new reply", at: "10:03 AM" },
        ]}
        variant="consumer"
      />,
    )

    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "off")
    expect(
      screen.getByRole("link", { name: "Skip to message composer" }),
    ).toHaveAttribute("href", "#message-composer")
    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument()
  })
})
