import "@testing-library/jest-dom/vitest"

import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import {
  CommandPalette,
  canonicalInternalPath,
  MONEY_DESTINATION_PREFIXES,
  type CommandPaletteDestination,
  type PaletteClient,
} from "@/components/kit/command-palette"

/**
 * Motion resolves `prefers-reduced-motion` once, at import, so a `matchMedia` spy installed inside
 * a test arrives too late. The hook itself is the seam: everything else in `motion/react`, the
 * real `motion.div` included, stays untouched.
 */
const motionPreference = vi.hoisted(() => ({ reduced: false }))

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>()
  return { ...actual, useReducedMotion: () => motionPreference.reduced }
})

const clients: readonly PaletteClient[] = [
  { href: "/admin/clients/lumen", id: "lumen", label: "Lumen Credit (demo)" },
  {
    href: "/admin/clients/northgate",
    id: "northgate",
    kind: "Coach",
    label: "Northgate Funding (demo)",
  },
]

/** cmdk stamps its group headings; "Clients" is also a page name, so match the heading, not text. */
function groupHeadings() {
  return Array.from(document.querySelectorAll("[cmdk-group-heading]")).map(
    (heading) => heading.textContent
  )
}

function paletteInput() {
  const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')
  if (!input) throw new Error("The palette rendered no search input.")
  return input
}

function searchClients(query: string): readonly PaletteClient[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return clients
  return clients.filter((client) => client.label.toLowerCase().includes(needle))
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe("CommandPalette", () => {
  it("does not list money destinations for the success role", () => {
    render(
      <CommandPalette
        defaultOpen
        recent={MONEY_DESTINATION_PREFIXES.map((href) => ({
          allowedRoles: ["success"],
          href,
          label: `Recent ${href}`,
        }))}
        role="success"
      />
    )

    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href): href is string => href !== null)

    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) {
      expect(
        MONEY_DESTINATION_PREFIXES.some((prefix) => href.startsWith(prefix))
      ).toBe(false)
    }
  })

  /**
   * A money row used to reach a role that may not see money whenever its href was spelled with a
   * different case, a trailing slash, a doubled slash, or a query, because every gate compared raw
   * strings. These are the same four destinations in every spelling the router accepts.
   */
  it("does not list money destinations dressed up as a different path", () => {
    const disguises = MONEY_DESTINATION_PREFIXES.flatMap((href) => [
      `${href}/`,
      `${href}?tenant=t1`,
      `${href}#costs`,
      href.toUpperCase(),
      href.replace("/admin/", "/admin//"),
      href.replace("/admin/", "/admin/clients/../"),
    ])

    render(
      <CommandPalette
        defaultOpen
        recent={disguises.map((href) => ({
          allowedRoles: ["success" as const],
          href,
          label: `Recent ${href}`,
        }))}
        role="success"
      />
    )

    for (const href of disguises) {
      expect(screen.queryByText(`Recent ${href}`)).not.toBeInTheDocument()
    }
  })

  it("keeps a workspace gate on a path dressed up as a different path", () => {
    render(
      <CommandPalette
        defaultOpen
        recent={[
          {
            allowedRoles: ["affiliate"],
            href: "/ADMIN//system/private/",
            label: "Admin recent",
          },
        ]}
        role="affiliate"
      />
    )

    expect(screen.queryByText("Admin recent")).not.toBeInTheDocument()
  })

  it("canonicalizes an internal path and refuses anything that is not one", () => {
    expect(canonicalInternalPath("/admin/billing/")).toBe("/admin/billing")
    expect(canonicalInternalPath("/admin//billing")).toBe("/admin/billing")
    expect(canonicalInternalPath("/Admin/Billing?tab=costs#top")).toBe("/admin/billing")
    expect(canonicalInternalPath("/admin/clients/../billing")).toBe("/admin/billing")
    expect(canonicalInternalPath("/admin/./billing")).toBe("/admin/billing")
    expect(canonicalInternalPath("/../../admin/billing")).toBe("/admin/billing")
    expect(canonicalInternalPath("/")).toBe("/")
    expect(canonicalInternalPath("https://example.test/admin/billing")).toBeNull()
    expect(canonicalInternalPath("//example.test/admin/billing")).toBeNull()
    expect(canonicalInternalPath("admin/billing")).toBeNull()
  })

  it("denies recent destinations without role metadata", () => {
    const recentWithoutRoles = {
      href: "/admin/system/private",
      label: "Unscoped recent",
    } as unknown as CommandPaletteDestination

    render(
      <CommandPalette
        defaultOpen
        recent={[recentWithoutRoles]}
        role="success"
      />
    )

    expect(screen.queryByText("Unscoped recent")).not.toBeInTheDocument()
  })

  it("keeps affiliate recents inside the affiliate workspace", () => {
    render(
      <CommandPalette
        defaultOpen
        recent={[
          {
            allowedRoles: ["affiliate"],
            href: "/admin/system/private",
            label: "Admin recent",
          },
        ]}
        role="affiliate"
      />
    )

    expect(screen.queryByText("Admin recent")).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Partner earnings/ })).toHaveAttribute(
      "href",
      "/affiliate"
    )
  })

  it("groups destinations under Pages", () => {
    render(<CommandPalette defaultOpen role="admin" />)

    expect(groupHeadings()).toContain("Pages")
  })

  it("lists clients from the pluggable search source under a Clients group", () => {
    render(<CommandPalette defaultOpen role="admin" searchClients={searchClients} />)

    expect(groupHeadings()).toContain("Clients")
    expect(screen.getByRole("link", { name: /Lumen Credit/ })).toHaveAttribute(
      "href",
      "/admin/clients/lumen"
    )
  })

  it("re-asks the client source as the query changes", () => {
    render(<CommandPalette defaultOpen role="admin" searchClients={searchClients} />)

    expect(screen.getByRole("link", { name: /Northgate Funding/ })).toBeInTheDocument()

    fireEvent.change(paletteInput(), { target: { value: "lumen" } })

    expect(screen.queryByRole("link", { name: /Northgate Funding/ })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Lumen Credit/ })).toBeInTheDocument()
  })

  it("offers no Clients group when no source is plugged in", () => {
    render(<CommandPalette defaultOpen role="admin" />)

    expect(groupHeadings()).not.toContain("Clients")
  })

  it("role-gates client results the source returns", () => {
    render(
      <CommandPalette
        defaultOpen
        role="coach_member"
        searchClients={() => [
          { href: "/admin/clients/lumen", id: "lumen", label: "Lumen Credit (demo)" },
          { href: "/admin/billing/lumen", id: "billing", label: "Lumen billing" },
        ]}
      />
    )

    expect(screen.queryByText("Lumen Credit (demo)")).not.toBeInTheDocument()
    expect(screen.queryByText("Lumen billing")).not.toBeInTheDocument()
  })

  it("shows each row's kind in faint right-aligned mono", () => {
    render(<CommandPalette defaultOpen role="admin" searchClients={searchClients} />)

    const client = screen.getByRole("link", { name: /Northgate Funding/ })
    const kind = within(client).getByText("Coach")
    expect(kind).toHaveClass("font-mono")
    expect(kind).toHaveClass("text-right")
    expect(kind).toHaveClass("ml-auto")
    expect(kind).toHaveClass("text-[var(--faint)]")
    expect(kind).toHaveClass("text-[length:var(--t-mono-crumb)]")

    // A client with no kind of its own still lands in the same column.
    const fallback = screen.getByRole("link", { name: /Lumen Credit/ })
    expect(within(fallback).getByText("Client")).toHaveClass("font-mono")
  })

  it("opens with a transition, and reduced motion starts it at its end state", () => {
    const { unmount } = render(<CommandPalette defaultOpen role="admin" />)

    const panel = document.querySelector('[data-slot="palette-motion"]')
    expect(panel).not.toBeNull()
    // It arrives: transparent and slightly high, then settles under Motion's own clock.
    expect(panel).toHaveStyle({ opacity: "0" })
    unmount()

    motionPreference.reduced = true
    try {
      render(<CommandPalette defaultOpen role="admin" />)

      // No travel to reduce: the panel is simply already where it belongs.
      expect(document.querySelector('[data-slot="palette-motion"]')).toHaveStyle({
        opacity: "1",
      })
    } finally {
      motionPreference.reduced = false
    }
  })

  it("opens on the modal rung with a scrim behind it", () => {
    // The palette covers the console while it is open, so it takes the top rung and the backdrop
    // that says the page is out of reach. On --shadow-raised it read as a large dropdown.
    render(<CommandPalette role="admin" />)
    fireEvent.keyDown(window, { key: "k", metaKey: true })

    expect(screen.getByRole("dialog")).toHaveClass(
      "bg-[var(--raised)]",
      "shadow-[var(--shadow-modal)]"
    )
    expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull()
  })

  it("closes on escape and hands focus back to whatever opened it", async () => {
    render(
      <>
        <button type="button">Opener</button>
        <CommandPalette role="admin" />
      </>
    )

    const opener = screen.getByRole("button", { name: "Opener" })
    opener.focus()
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    fireEvent.keyDown(window, { key: "Escape" })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(document.activeElement).toBe(opener)
  })
})
