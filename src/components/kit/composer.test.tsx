import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { Composer } from "@/components/kit/composer"

describe("Composer", () => {
  it("keeps the field enabled while sending and disables Send", () => {
    render(
      <Composer
        onSend={vi.fn(async () => undefined)}
        placeholder="Write a reply"
        sending
      />,
    )

    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
  })

  it("names where the send lands in the foot, left of Send", () => {
    render(
      <Composer
        hint="Sends as you on Instagram"
        onSend={vi.fn(async () => undefined)}
        placeholder="Write a reply"
        sending={false}
      />,
    )

    const hint = screen.getByText("Sends as you on Instagram")
    expect(hint).toBeVisible()

    const foot = hint.parentElement
    expect(foot).not.toBeNull()
    expect(foot!.lastElementChild).toBe(screen.getByRole("button", { name: "Send" }))
  })

  it("replaces a genuinely gated field with its reason and resolving action", () => {
    const resolveGate = vi.fn()

    render(
      <Composer
        disabled={{
          reason: "Take over this conversation to reply.",
          action: { label: "Take over", onClick: resolveGate },
        }}
        onSend={vi.fn(async () => undefined)}
        placeholder="Write a reply"
        sending={false}
      />,
    )

    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument()
    expect(screen.getByText("Take over this conversation to reply.")).toBeVisible()
    screen.getByRole("button", { name: "Take over" }).click()
    expect(resolveGate).toHaveBeenCalledOnce()
  })
})
