import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { ActionMenu } from "@/components/kit/action-menu"
import {
  ConfirmFlow,
  type ConfirmFlowProps,
  type Result,
} from "@/components/kit/confirm-flow"
import { LoggedButton } from "@/components/kit/logged-button"
import { AUDIT_ACTIONS } from "@/lib/audit/actions"

const impact = [
  { label: "Contact", value: "Jamie Rivera" },
  { label: "Workspace", value: "Reid Funding Group" },
] as const

function renderFlow(overrides: Partial<ConfirmFlowProps> = {}) {
  const onOpenChange = vi.fn()
  const onConfirm = vi.fn(async (): Promise<Result> => ({
    ok: true,
    receipt: { auditId: 42, actionKey: "contact.delete" },
  }))

  render(
    <ConfirmFlow
      action="contact.delete"
      confirmLabel="Delete permanently"
      destructive
      impact={impact}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open
      reason={{
        required: true,
        label: "Deletion reason",
        hint: "Explain why this contact must be removed.",
      }}
      title="Delete contact"
      {...overrides}
    />
  )

  return { onConfirm, onOpenChange }
}

describe("ConfirmFlow", () => {
  it("does not confirm a reason-required action with a blank reason", async () => {
    const user = userEvent.setup()
    const { onConfirm } = renderFlow()
    const confirm = screen.getByRole("button", {
      name: /Delete permanently/i,
    })

    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText("Deletion reason"), "   ")
    expect(confirm).toBeDisabled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("marks and disables the confirm button while the promise is pending", async () => {
    let resolve!: (result: Result) => void
    const pending = new Promise<Result>((next) => {
      resolve = next
    })
    const onConfirm = vi.fn(() => pending)
    const user = userEvent.setup()

    renderFlow({ onConfirm })
    await user.type(screen.getByLabelText("Deletion reason"), "Privacy request")
    await user.click(
      screen.getByRole("button", { name: /Delete permanently/i })
    )

    const busyButton = screen.getByRole("button", { name: /Deleting permanently/i })
    expect(busyButton).toHaveAttribute("aria-busy", "true")
    expect(busyButton).toBeDisabled()

    await act(async () => {
      resolve({
        ok: true,
        receipt: { auditId: 43, actionKey: "contact.delete" },
      })
      await pending
    })
  })

  it("renders a refusal message and confirms that nothing changed", async () => {
    const user = userEvent.setup()
    renderFlow({
      onConfirm: vi.fn(async (): Promise<Result> => ({
        ok: false,
        message: "This contact is protected by an active review.",
      })),
    })

    await user.type(screen.getByLabelText("Deletion reason"), "Duplicate record")
    await user.click(
      screen.getByRole("button", { name: /Delete permanently/i })
    )

    expect(
      await screen.findByText(
        "This contact is protected by an active review. Nothing changed."
      )
    ).toBeInTheDocument()
  })

  it("renders a partial outcome without claiming nothing changed", async () => {
    const user = userEvent.setup()
    renderFlow({
      onConfirm: vi.fn(async (): Promise<Result> => ({
        ok: false,
        partial: true,
        message: "The provider confirmed the deletion, but the local record could not be updated.",
      })),
    })

    // The dialog body mounts a beat after the alertdialog itself, so both lookups wait. A
    // synchronous getByRole here failed roughly one run in three -- and reported "Unable to find
    // an accessible element", which reads as a missing button rather than as a slow one.
    await user.type(await screen.findByLabelText("Deletion reason"), "Duplicate record")
    await user.click(
      await screen.findByRole("button", { name: /Delete permanently/i })
    )

    expect(
      await screen.findByText(
        /Some steps completed before it stopped\. The record shows what ran\./
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/Nothing changed\./)).not.toBeInTheDocument()
    expect(
      await screen.findByRole("button", { name: /Delete permanently/i })
    ).toBeEnabled()
  })

  it("does not close the destructive variant on an outside click", () => {
    const { onOpenChange } = renderFlow()
    const overlay = document.querySelector(
      '[data-slot="alert-dialog-overlay"]'
    )

    expect(overlay).not.toBeNull()
    fireEvent.pointerDown(overlay!)
    fireEvent.mouseDown(overlay!)
    fireEvent.click(overlay!)

    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  })

  it("puts the destructive dialog on the modal rung, over a scrimmed page", () => {
    // A confirm that blocks the page is the most-elevated thing in the product, so it must not
    // borrow the popover rung the action menu behind it already uses -- if the dialog and the
    // dropdown carry the same shadow, nothing on screen encodes which one owns the page.
    renderFlow()

    expect(screen.getByRole("alertdialog")).toHaveClass(
      "bg-[var(--raised)]",
      "shadow-(--shadow-modal)"
    )
    expect(
      document.querySelector('[data-slot="alert-dialog-overlay"]')
    ).not.toBeNull()
  })

  it("keeps the non-destructive variant on the drawer rung", () => {
    // Side panels are a rung below a centred dialog on purpose: the page stays visible beside
    // them, so they get the drawer shadow rather than the modal one.
    renderFlow({ destructive: false })

    expect(screen.getByRole("dialog")).toHaveClass(
      "bg-[var(--raised)]",
      "shadow-(--shadow-drawer)"
    )
  })

  it("resets transient state after a controlled close", async () => {
    const user = userEvent.setup()

    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button onClick={() => setOpen(false)} type="button">
            Close externally
          </button>
          <button onClick={() => setOpen(true)} type="button">
            Reopen
          </button>
          <ConfirmFlow
            action="contact.delete"
            confirmLabel="Delete permanently"
            destructive
            impact={impact}
            onConfirm={async () => ({
              ok: true,
              receipt: {
                auditId: 44,
                actionKey: "contact.delete",
              },
            })}
            onOpenChange={setOpen}
            open={open}
            reason={{
              required: true,
              label: "Deletion reason",
              hint: "Explain why this contact must be removed.",
            }}
            title="Delete contact"
          />
        </>
      )
    }

    render(<Harness />)
    await user.type(screen.getByLabelText("Deletion reason"), "Privacy request")
    await user.click(screen.getByRole("button", { name: /Delete permanently/i }))
    expect(await screen.findByText(/Audit receipt #44/)).toBeInTheDocument()
    // Colour budget: success is the word plus a dot, never a green fill or check.
    const receipt = document.querySelector('[data-slot="logged-receipt"]')
    expect(receipt).not.toBeNull()
    expect(receipt?.className).not.toContain("good-wash")
    expect(receipt?.querySelector("svg")).toBeNull()
    fireEvent.click(screen.getByText("Close externally"))
    await user.click(screen.getByRole("button", { name: "Reopen" }))
    expect(screen.queryByText(/Audit receipt #44/)).not.toBeInTheDocument()
    expect(screen.getByLabelText("Deletion reason")).toHaveValue("")
  })

  it("resets a receipt when the scoped action changes", async () => {
    const user = userEvent.setup()

    function Harness() {
      const [action, setAction] = useState<
        "appointment.attendance_set" | "calendar.connected"
      >("appointment.attendance_set")

      return (
        <>
          <button onClick={() => setAction("calendar.connected")} type="button">
            Change action
          </button>
          <ConfirmFlow
            action={action}
            confirmLabel="Set attendance"
            impact={impact}
            onConfirm={async () => ({
              ok: true,
              receipt: { auditId: 45, actionKey: action },
            })}
            onOpenChange={vi.fn()}
            open
            title="Set attendance"
          />
        </>
      )
    }

    render(<Harness />)
    await user.click(screen.getByRole("button", { name: /Set attendance/i }))
    expect(await screen.findByText(/Audit receipt #45/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("Change action"))

    expect(screen.queryByText(/Audit receipt #45/)).not.toBeInTheDocument()
  })

  it("uses a valid progressive pending label", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn(() => new Promise<Result>(() => undefined))

    renderFlow({ confirmLabel: "Submit request", onConfirm })
    await user.type(screen.getByLabelText("Deletion reason"), "Privacy request")
    await user.click(screen.getByRole("button", { name: /Submit request/i }))

    expect(
      screen.getByRole("button", { name: /Submitting request/i })
    ).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByText(/Submiting/)).not.toBeInTheDocument()
  })
})

describe("ActionMenu", () => {
  it("selects an action from the keyboard", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()

    render(
      <ActionMenu
        items={[
          { label: "Open record", onSelect: vi.fn() },
          { label: "Archive record", onSelect },
        ]}
      />
    )

    screen.getByRole("button", { name: "Open actions" }).focus()
    await user.keyboard("{ArrowDown}")
    expect(await screen.findByRole("menu")).toBeInTheDocument()
    await user.keyboard("{End}{Enter}")

    expect(onSelect).toHaveBeenCalledOnce()
  })
})

describe("LoggedButton", () => {
  it("renders accountability copy and its label from the audit registry", () => {
    const accountability = AUDIT_ACTIONS["appointment.attendance_set"]

    render(
      <LoggedButton actionKey="appointment.attendance_set">
        Set attendance
      </LoggedButton>
    )

    expect(screen.getByText(accountability.microcopy)).toBeInTheDocument()
    expect(screen.getByLabelText(accountability.ariaLabel)).toBeInTheDocument()
  })
})
