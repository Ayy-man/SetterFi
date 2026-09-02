import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  KanbanBoard,
  type KanbanBoardProps,
  type KanbanColumn,
} from "@/components/kit/kanban-board"

const columns: readonly KanbanColumn[] = [
  { key: "new_lead", label: "New Lead", count: 2, tone: "neutral" },
  { key: "qualifying", label: "Qualification Active", count: 1, tone: "info" },
  { key: "booked", label: "Booked", count: 0, tone: "good" },
  { key: "qualified_no_buy", label: "Qualified No Buy", count: 0, tone: "critical" },
  { key: "long_term_followup", label: "Long-Term Follow-Up", count: 0, tone: "warning" },
  { key: "no_show", label: "No Show", count: 0, tone: "warning" },
  { key: "disqualified", label: "Disqualified", count: 0, tone: "critical" },
]

const cards = [
  {
    id: "lead-1",
    name: "Avery Stone",
    stage: "new_lead",
    meta: ["Instagram", "Today"],
    reason: "$50K to $100K goal",
    flag: { label: "Needs you", tone: "critical" },
  },
  { id: "lead-2", name: "Jordan Bell", stage: "new_lead", meta: ["Text messages", "Yesterday"] },
  { id: "lead-3", name: "Morgan Reed", stage: "qualifying", meta: ["Facebook", "Today"] },
] as const

const allowedMoves = (stage: string) =>
  stage === "new_lead" ? (["qualifying", "booked"] as const) : (["booked"] as const)

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, "elementFromPoint")
})

function props(overrides: Partial<KanbanBoardProps> = {}): KanbanBoardProps {
  return {
    allowedMoves,
    cards,
    columns,
    onMove: vi.fn(async () => ({
      ok: true as const,
      receipt: {
        auditId: 42,
        actionKey: "contact.pipeline_stage.set" as const,
      },
    })),
    onOpen: vi.fn(),
    ...overrides,
  }
}

/*
 * The card's box, read off the artboard rather than typed here.
 *
 * `p-4` shipped on this card and a round-4 audit recorded it as matched, quoting
 * "`16px 16px 14px`" -- the drawing's padding, written into a sentence whose subject was the
 * code. Four of the five numbers in that sentence had been checked and the padding was carried
 * across from the other column, which is a failure a test can prevent and a reader cannot: the
 * expectation below cannot be satisfied by the number appearing somewhere, only by the element
 * carrying it.
 */
describe("the lead card's box, against LeadsBoard.dc.html:142", () => {
  // LeadsBoard.dc.html:142, recorded verbatim on 2026-09-02. The artboards are not part of this
  // repository, so the line is carried here and parsed exactly as the drawing was.
  const DRAWN_LINE =
    '<div style="display: flex; flex-direction: column; gap: 10px; min-height: 88px; padding: 16px 16px 14px; border-radius: 15px; border: 1px solid var(--line); background: linear-gradient(180deg, var(--card-top), var(--card)); box-shadow: var(--shadow-card); cursor: grab;">'
  const drawn = (property: string) => {
    const line = DRAWN_LINE
    // The premise first: a moved citation must fail loudly rather than compare against undefined.
    expect(line, "LeadsBoard.dc.html:142 is no longer the draggable card").toContain("cursor: grab")
    const value = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(line)?.[1].trim()
    expect(value, `${property} is gone from LeadsBoard.dc.html:142`).toBeDefined()
    return value!
  }

  it("pads 16px at the top and sides and two pixels less at the bottom", () => {
    const [top, sides, bottom] = drawn("padding").split(/\s+/u)
    expect([top, sides, bottom], "the drawing no longer uses three padding values").toHaveLength(3)

    const { container } = render(<KanbanBoard {...props()} />)
    const card = container.querySelector<HTMLElement>("[data-kanban-card]")!

    expect(card.className, `top drawn at ${top}`).toContain(`pt-[${top}]`.replace("pt-[16px]", "pt-4"))
    expect(card.className, `sides drawn at ${sides}`).toContain(`px-[${sides}]`.replace("px-[16px]", "px-4"))
    expect(card.className, `bottom drawn at ${bottom}`).toContain(`pb-[${bottom}]`)
    // And not the uniform padding it shipped as, which the three assertions above would still
    // tolerate if `p-4` were left beside them -- Tailwind would resolve the conflict at build
    // time and this suite would never see it.
    expect(card.className, "the uniform p-4 is still on the card").not.toMatch(/(?:^|\s)p-4(?:\s|$)/u)
  })

  it("holds the rest of the box the same line draws", () => {
    const { container } = render(<KanbanBoard {...props()} />)
    const card = container.querySelector<HTMLElement>("[data-kanban-card]")!

    expect(card.className).toContain(`min-h-[${drawn("min-height")}]`)
    expect(card.className).toContain(`rounded-[${drawn("border-radius")}]`)
    expect(card.className).toContain(`gap-[${drawn("gap")}]`)
  })
})

describe("KanbanBoard", () => {
  function pointerFrame(target: Element) {
    let frame: FrameRequestCallback | null = null

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target),
    })
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback
      return 1
    })
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined)

    return () => {
      const callback = frame
      frame = null
      act(() => callback?.(0))
    }
  }

  function beginPointerDrag(card: HTMLElement, flushFrame: () => void) {
    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 100,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    })
    fireEvent.pointerMove(card, {
      buttons: 1,
      clientX: 120,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    })
    flushFrame()
  }

  it("gives every rendered card an interactive keyboard path", () => {
    const { container } = render(<KanbanBoard {...props()} />)
    const renderedCards = container.querySelectorAll<HTMLElement>("[data-kanban-card]")

    expect(renderedCards).toHaveLength(cards.length)
    for (const card of renderedCards) {
      expect(
        card.matches("[tabindex]:not([tabindex='-1'])") ||
          card.querySelector("button, select, a, [tabindex]:not([tabindex='-1'])")
      ).toBeTruthy()
    }
  })

  it("moves a dragged card through a visible allowed drop target", () => {
    const onMove = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        auditId: 45,
        actionKey: "contact.pipeline_stage.set" as const,
      },
    }))
    render(<KanbanBoard {...props({ onMove })} />)

    const card = screen.getByRole("group", { name: "Open Avery Stone" })
    const booked = screen.getByRole("region", { name: "Booked column" })
    const flushFrame = pointerFrame(booked)

    expect(card).toHaveAttribute("draggable", "false")
    expect(card).toHaveAttribute("data-drag-enabled", "true")
    expect(card).toHaveAttribute("data-card-id", "lead-1")

    beginPointerDrag(card, flushFrame)
    expect(card).toHaveAttribute("data-dragging", "true")

    expect(booked).toHaveAttribute("data-state", "collapsed")
    expect(booked).toHaveAttribute("data-drop-allowed", "true")
    expect(booked).toHaveAttribute("data-drop-target", "true")
    expect(document.querySelector(".kanban-drag-preview-label")).toHaveTextContent(
      "Drop in Booked"
    )
    expect(document.querySelector(".kanban-drag-preview")).toHaveAttribute(
      "aria-hidden",
      "true"
    )

    fireEvent.pointerUp(card, {
      button: 0,
      clientX: 120,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    })
    expect(onMove).toHaveBeenCalledOnce()
    expect(onMove).toHaveBeenCalledWith("lead-1", "booked")
    expect(card).not.toHaveAttribute("data-dragging")
    expect(card).toHaveAttribute("data-landed", "true")
    expect(document.querySelector(".kanban-drag-preview")).toBeNull()
  })

  it("does not turn a forbidden stage into a drop target", () => {
    const onMove = vi.fn(async () => ({ ok: false as const, message: "No" }))
    render(<KanbanBoard {...props({ onMove })} />)

    const card = screen.getByRole("group", { name: "Open Avery Stone" })
    const disqualified = screen.getByRole("region", {
      name: "Disqualified column",
    })
    const flushFrame = pointerFrame(disqualified)

    beginPointerDrag(card, flushFrame)
    fireEvent.pointerUp(card, {
      button: 0,
      clientX: 120,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    })

    expect(disqualified).not.toHaveAttribute("data-drop-target")
    expect(document.querySelector(".kanban-drag-preview")).toBeNull()
    expect(onMove).not.toHaveBeenCalled()
  })

  it("uses the final pointer position when released before the next paint", () => {
    const onMove = vi.fn(async () => ({ ok: false as const, message: "No" }))
    render(<KanbanBoard {...props({ onMove })} />)
    const card = screen.getByRole("group", { name: "Open Avery Stone" })
    const booked = screen.getByRole("region", { name: "Booked column" })

    pointerFrame(booked)
    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 100,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    })
    fireEvent.pointerMove(card, {
      buttons: 1,
      clientX: 120,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    })
    fireEvent.pointerUp(card, {
      button: 0,
      clientX: 120,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    })

    expect(onMove).toHaveBeenCalledWith("lead-1", "booked")
  })

  it("auto-scrolls continuously with pointer pressure at the track edge", () => {
    render(<KanbanBoard {...props()} />)
    const card = screen.getByRole("group", { name: "Open Avery Stone" })
    const booked = screen.getByRole("region", { name: "Booked column" })
    const track = document.querySelector<HTMLElement>("[data-kanban-scroll]")!
    const flushFrame = pointerFrame(booked)

    Object.defineProperties(track, {
      clientWidth: { configurable: true, value: 600 },
      scrollWidth: { configurable: true, value: 1400 },
    })
    track.scrollLeft = 300
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 600,
      toJSON: () => ({}),
      top: 0,
      width: 600,
      x: 0,
      y: 0,
    })

    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 100,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    })
    fireEvent.pointerMove(card, {
      buttons: 1,
      clientX: 590,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    })
    flushFrame()

    expect(track.scrollLeft).toBeGreaterThan(300)
  })

  it("softens only the viewport edges that have more stages beyond them", () => {
    render(<KanbanBoard {...props()} />)
    const track = document.querySelector<HTMLElement>("[data-kanban-scroll]")!
    const leftFade = document.querySelector<HTMLElement>(
      '[data-kanban-scroll-fade="left"]'
    )!
    const rightFade = document.querySelector<HTMLElement>(
      '[data-kanban-scroll-fade="right"]'
    )!

    Object.defineProperties(track, {
      clientWidth: { configurable: true, value: 600 },
      scrollWidth: { configurable: true, value: 1400 },
    })

    track.scrollLeft = 0
    fireEvent.scroll(track)
    expect(leftFade).toHaveAttribute("data-visible", "false")
    expect(rightFade).toHaveAttribute("data-visible", "true")

    track.scrollLeft = 800
    fireEvent.scroll(track)
    expect(leftFade).toHaveAttribute("data-visible", "true")
    expect(rightFade).toHaveAttribute("data-visible", "false")
  })

  it("keeps a click when movement stays below the drag threshold", () => {
    const onOpen = vi.fn()
    render(<KanbanBoard {...props({ onOpen })} />)
    const card = screen.getByRole("group", { name: "Open Avery Stone" })

    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 100,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
    })
    fireEvent.pointerMove(card, {
      buttons: 1,
      clientX: 103,
      clientY: 102,
      isPrimary: true,
      pointerId: 1,
    })
    fireEvent.pointerUp(card, {
      button: 0,
      clientX: 103,
      clientY: 102,
      isPrimary: true,
      pointerId: 1,
    })
    fireEvent.click(card)

    expect(onOpen).toHaveBeenCalledOnce()
    expect(document.querySelector(".kanban-drag-preview")).toBeNull()
  })

  it("cancels an active pointer drag with Escape", () => {
    const onMove = vi.fn(async () => ({ ok: false as const, message: "No" }))
    render(<KanbanBoard {...props({ onMove })} />)
    const card = screen.getByRole("group", { name: "Open Avery Stone" })
    const booked = screen.getByRole("region", { name: "Booked column" })

    beginPointerDrag(card, pointerFrame(booked))
    fireEvent.keyDown(document, { key: "Escape" })

    expect(card).not.toHaveAttribute("data-dragging")
    expect(document.body).not.toHaveClass("is-kanban-pointer-dragging")
    expect(document.querySelector(".kanban-drag-preview")).toBeNull()
    expect(onMove).not.toHaveBeenCalled()
  })

  it("collapses an empty column into an expandable strip", async () => {
    const user = userEvent.setup()
    render(<KanbanBoard {...props()} />)

    const bookedColumn = screen.getByRole("region", { name: "Booked column" })
    expect(bookedColumn).toHaveAttribute("data-state", "collapsed")

    await user.click(within(bookedColumn).getByRole("button", { name: "Expand Booked" }))
    expect(screen.getByRole("region", { name: "Booked column" })).toHaveAttribute("data-state", "expanded")
    expect(screen.getByText("No leads in this stage.")).toBeInTheDocument()
  })

  it("opens the exact allowed move list when M is pressed on a card", async () => {
    render(<KanbanBoard {...props()} />)
    const card = screen.getByRole("group", { name: "Open Avery Stone" })

    card.focus()
    fireEvent.keyDown(card, { key: "m" })

    const menu = await screen.findByRole("menu")
    const items = within(menu).getAllByRole("menuitem")
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.textContent)).toEqual(["Qualification Active", "Booked"])
  })

  it("reviews and confirms a selected move", async () => {
    const user = userEvent.setup()
    const onMove = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        auditId: 43,
        actionKey: "contact.pipeline_stage.set" as const,
      },
    }))
    render(<KanbanBoard {...props({ onMove })} />)
    const card = screen.getByRole("group", { name: "Open Avery Stone" })

    card.focus()
    await user.keyboard("M")
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Booked",
      })
    )

    const dialog = await screen.findByRole("dialog")
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText("New Lead")).toBeInTheDocument()
    expect(within(dialog).getByText("Logged")).toHaveClass("text-over")
    await user.click(screen.getByRole("button", { name: /Move lead/i }))

    expect(onMove).toHaveBeenCalledWith("lead-1", "booked")
    expect(await screen.findByText(/Audit receipt #43/)).toHaveTextContent(
      "Logged. Audit receipt #43."
    )
  })

  it("reads a card as name, then why it is here, then where it came from", () => {
    const { container } = render(<KanbanBoard {...props()} />)
    const card = container.querySelector<HTMLElement>("[data-kanban-card]")

    expect(card).not.toBeNull()
    const lines = Array.from(card!.children).map((child) => child.textContent?.trim())
    expect(lines[0]).toContain("Avery Stone")
    expect(lines[1]).toBe("$50K to $100K goal")
    expect(lines[2]).toBe("InstagramToday")
  })

  it("flags only the cards that carry one", () => {
    const { container } = render(<KanbanBoard {...props()} />)
    const flags = container.querySelectorAll("[data-card-flag]")

    expect(flags).toHaveLength(1)
    expect(flags[0]).toHaveTextContent("Needs you")
  })

  it("preserves every decision-critical field when card copy is unusually long", () => {
    const longCard = {
      ...cards[0],
      flag: {
        label: "Needs your review before this lead can move forward",
        tone: "critical" as const,
      },
      metaIcon: <svg data-testid="channel-glyph" />,
      meta: [
        "Facebook Messenger from a partner referral campaign",
        "September 30, 11:59 PM",
      ],
      name: "Alexandria Montgomery-Sinclair and the North Coast Funding Company",
      reason:
        "Seeking a substantial working-capital facility for a multi-location expansion this quarter.",
    }
    const { container } = render(
      <KanbanBoard {...props({ cards: [longCard] })} />
    )

    const card = container.querySelector<HTMLElement>("[data-kanban-card]")!
    const name = card.querySelector<HTMLElement>('[data-slot="kanban-card-name"]')!
    const reason = card.querySelector<HTMLElement>('[data-slot="kanban-card-reason"]')!
    const flag = card.querySelector<HTMLElement>("[data-card-flag]")!
    const metaRail = card.querySelector<HTMLElement>('[data-slot="kanban-card-meta"]')!
    const meta = Array.from(
      card.querySelectorAll<HTMLElement>("[data-meta-index]")
    )

    expect(name).toHaveTextContent(longCard.name)
    expect(name).not.toHaveClass("truncate")
    expect(name).toHaveClass("[overflow-wrap:anywhere]")
    expect(flag).toHaveTextContent(longCard.flag.label)
    expect(flag.closest('[data-slot="kanban-card-identity"]')).not.toBeNull()
    expect(card).toHaveClass("border-[var(--line)]")
    expect(card.className).not.toContain("var(--critical)_9%")
    expect(reason).toHaveTextContent(longCard.reason)
    expect(reason).toHaveClass("[overflow-wrap:anywhere]")
    expect(metaRail).toHaveClass("border-t")
    expect(metaRail.className).toContain("grid-cols-[auto_minmax(0,1fr)]")
    expect(meta.map((entry) => entry.textContent?.trim())).toEqual(longCard.meta)
    expect(meta.every((entry) => !entry.classList.contains("truncate"))).toBe(true)
    expect(meta[0]).toHaveAttribute("title", longCard.meta[0])
    expect(meta[0].querySelector("span:last-child")).toHaveClass("sr-only")
  })

  it("closes each open stage with the number of cards it holds", () => {
    const { container } = render(<KanbanBoard {...props()} />)

    expect(
      container.querySelector('[data-kanban-column-total="new_lead"]')
    ).toHaveTextContent("2 leads")
    expect(
      container.querySelector('[data-kanban-column-total="qualifying"]')
    ).toHaveTextContent("1 lead")
  })

  it("renders one board-level read-only notice when moving is unavailable", () => {
    const { container } = render(<KanbanBoard {...props({ onMove: undefined })} />)

    expect(container.querySelectorAll("[data-kanban-read-only]")).toHaveLength(1)
    expect(screen.getAllByText("Stage changes are not available yet.")).toHaveLength(1)
  })

  it("opens a record with Enter and moves focus with arrow keys", () => {
    const onOpen = vi.fn()
    render(<KanbanBoard {...props({ onOpen })} />)
    const first = screen.getByRole("group", { name: "Open Avery Stone" })
    const second = screen.getByRole("group", { name: "Open Jordan Bell" })
    const across = screen.getByRole("group", { name: "Open Morgan Reed" })

    first.focus()
    fireEvent.keyDown(first, { key: "Enter" })
    expect(onOpen).toHaveBeenCalledWith("lead-1")

    fireEvent.keyDown(first, { key: "ArrowDown" })
    expect(second).toHaveFocus()

    fireEvent.keyDown(second, { key: "ArrowRight" })
    expect(across).toHaveFocus()
  })
})
