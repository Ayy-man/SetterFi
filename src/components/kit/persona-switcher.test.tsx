import "@testing-library/jest-dom/vitest"

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { PersonaSwitcher } from "@/components/kit/persona-switcher"
import { WorkspaceEnvProvider } from "@/components/workspace/workspace-env"
import { demoReviewPersonas, demoViewTargets } from "@/lib/workspace-navigation"

function renderSwitcher() {
  render(
    <WorkspaceEnvProvider
      demoAccountSwitching
      demoViews={demoViewTargets}
      mode="supabase"
    >
      <PersonaSwitcher current={demoReviewPersonas[0].id} targets={demoViewTargets} />
    </WorkspaceEnvProvider>
  )

  fireEvent.click(screen.getByRole("button", { name: "Switch demo persona" }))
  // The dropdown is a Base UI popup and mounts into a portal on an effect, so the menu is not in
  // the document on the tick the click returns. `fireEvent` does not flush that the way
  // `userEvent` does, which left this helper handing back whatever happened to be there.
  return screen.findByRole("menu")
}

describe("PersonaSwitcher", () => {
  it("dresses its menu in the kit's popover rung rather than the primitive's default", async () => {
    // Left undressed, the Base UI dropdown falls back to Tailwind's `shadow-md` and a generic
    // ring: a black shadow that neither theme's palette produced, sitting on the same plane as
    // every other menu in the console. A popover is genuinely above the page, so it takes
    // --raised and --shadow-raised like the action menu and the export menu already do.
    expect(await renderSwitcher()).toHaveClass(
      "bg-[var(--raised)]",
      "shadow-[var(--shadow-raised)]",
      "border-[var(--line)]"
    )
  })

  it("takes no scrim, because a menu never claims the page", async () => {
    // Elevation has to stay a signal. Only the three modal backdrops dim the page; a menu that
    // dismisses on the next click must not, or "above your work" stops meaning anything.
    await renderSwitcher()

    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
    expect(document.querySelector('[data-slot="alert-dialog-overlay"]')).toBeNull()
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull()
  })
})
