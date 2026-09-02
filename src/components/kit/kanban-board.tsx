"use client"

import { ArrowDown, ChevronLeft, ChevronRight } from "@/components/kit/icons";

import * as React from "react"

import {
  KanbanCard,
  type KanbanCardData,
  type KanbanMoveTarget,
} from "@/components/kit/kanban-card"
import type { Result } from "@/components/kit/confirm-flow"
import { Button } from "@/components/ui/button"

export type StateTone = "neutral" | "good" | "warning" | "critical" | "info"

export type KanbanColumn = {
  key: string
  label: string
  count: number
  tone: StateTone
  /**
   * Lifts one column out of the neutral set, or drops one below it. `LeadsBoard.dc.html` gives
   * Call booked an accent dot, an accent-edge border, an accent tint and an accent count pill --
   * it is the column the whole board is for -- and drops both lost columns to `--faint` with the
   * stage name in `--muted`, because a lost lead is finished rather than urgent. Neither is a
   * `StateTone`: this is emphasis inside one board, not a state anything else reads.
   */
  emphasis?: "accent" | "quiet"
}

export type { Result } from "@/components/kit/confirm-flow"
export type { KanbanCardData }

export type KanbanBoardProps = {
  columns: readonly KanbanColumn[]
  cards: readonly KanbanCardData[]
  allowedMoves: (from: string) => readonly string[]
  onMove?: (cardId: string, to: string) => Promise<Result>
  onOpen: (cardId: string) => void
}

const TONE_CLASS: Record<StateTone, string> = {
  neutral: "bg-[var(--neutral)]",
  good: "bg-[var(--good)]",
  warning: "bg-[var(--warning)]",
  critical: "bg-[var(--critical)]",
  info: "bg-[var(--info)]",
}

function readableStageKey(key: string) {
  const words = key.replaceAll("_", " ").trim()

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Another stage"
}

type PointerDragSession = {
  active: boolean
  card: KanbanCardData
  originX: number
  originY: number
  pointerId: number
}

const DRAG_START_DISTANCE = 6

export function KanbanBoard({
  columns,
  cards,
  allowedMoves,
  onMove,
  onOpen,
}: KanbanBoardProps) {
  const [expandedEmpty, setExpandedEmpty] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [draggingCardId, setDraggingCardId] = React.useState<string | null>(null)
  const [dropTarget, setDropTarget] = React.useState<string | null>(null)
  const [landingCardId, setLandingCardId] = React.useState<string | null>(null)
  const [scrollEdges, setScrollEdges] = React.useState({ left: false, right: false })
  const cardRefs = React.useRef(new Map<string, HTMLDivElement>())
  const pointerDragRef = React.useRef<PointerDragSession | null>(null)
  const allowedDropTargetsRef = React.useRef<ReadonlySet<string>>(new Set())
  const activeDropTargetRef = React.useRef<string | null>(null)
  const dragPreviewRef = React.useRef<HTMLDivElement | null>(null)
  const dragPreviewLabelRef = React.useRef<HTMLDivElement | null>(null)
  const dragPointerOffsetRef = React.useRef({ x: 0, y: 0 })
  const latestPointerRef = React.useRef({ x: 0, y: 0 })
  const dragFrameRef = React.useRef<number | null>(null)
  const suppressOpenCardIdRef = React.useRef<string | null>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const updateScrollEdges = React.useCallback((track: HTMLDivElement) => {
    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth)
    const next = {
      left: track.scrollLeft > 1,
      right: track.scrollLeft < maxScroll - 1,
    }

    setScrollEdges((current) =>
      current.left === next.left && current.right === next.right ? current : next
    )
  }, [])

  const cardsByStage = React.useMemo(() => {
    const grouped = new Map<string, KanbanCardData[]>()

    for (const column of columns) grouped.set(column.key, [])
    for (const card of cards) grouped.get(card.stage)?.push(card)

    return grouped
  }, [cards, columns])

  const columnByKey = React.useMemo(
    () => new Map(columns.map((column) => [column.key, column])),
    [columns]
  )

  const visibleDropTargets = React.useMemo(() => {
    if (!draggingCardId) return new Set<string>()

    const card = cards.find((candidate) => candidate.id === draggingCardId)
    return new Set(card ? allowedMoves(card.stage) : [])
  }, [allowedMoves, cards, draggingCardId])

  function setCardRef(cardId: string, node: HTMLDivElement | null) {
    if (node) cardRefs.current.set(cardId, node)
    else cardRefs.current.delete(cardId)
  }

  function moveFocus(
    card: KanbanCardData,
    direction: "up" | "down" | "left" | "right"
  ) {
    const columnIndex = columns.findIndex((column) => column.key === card.stage)
    const currentCards = cardsByStage.get(card.stage) ?? []
    const cardIndex = currentCards.findIndex((candidate) => candidate.id === card.id)

    if (direction === "up" || direction === "down") {
      const nextIndex = direction === "up" ? cardIndex - 1 : cardIndex + 1
      const nextCard = currentCards[nextIndex]

      if (nextCard) cardRefs.current.get(nextCard.id)?.focus()
      return
    }

    const step = direction === "left" ? -1 : 1

    for (
      let nextColumnIndex = columnIndex + step;
      nextColumnIndex >= 0 && nextColumnIndex < columns.length;
      nextColumnIndex += step
    ) {
      const nextCards = cardsByStage.get(columns[nextColumnIndex].key) ?? []

      if (!nextCards.length) continue

      const nextCard = nextCards[Math.min(cardIndex, nextCards.length - 1)]
      cardRefs.current.get(nextCard.id)?.focus()
      return
    }
  }

  function toggleEmptyColumn(columnKey: string) {
    setExpandedEmpty((current) => {
      const next = new Set(current)

      if (next.has(columnKey)) next.delete(columnKey)
      else next.add(columnKey)

      return next
    })
  }

  function removeDragPreview() {
    dragPreviewRef.current?.remove()
    dragPreviewRef.current = null
    dragPreviewLabelRef.current = null
  }

  function positionDragPreview(clientX: number, clientY: number) {
    const preview = dragPreviewRef.current
    if (!preview) return

    preview.style.transform = `translate3d(${clientX - dragPointerOffsetRef.current.x}px, ${clientY - dragPointerOffsetRef.current.y}px, 0)`
  }

  function describePreview(columnKey: string | null, allowed: boolean) {
    const preview = dragPreviewRef.current
    const label = dragPreviewLabelRef.current
    if (!preview || !label) return

    preview.dataset.valid = String(allowed)
    label.textContent = columnKey
      ? allowed
        ? `Drop in ${columnByKey.get(columnKey)?.label ?? readableStageKey(columnKey)}`
        : "That move is not available"
      : "Moving lead"
  }

  function createDragPreview(
    event: React.PointerEvent<HTMLDivElement>,
    card: KanbanCardData
  ) {
    removeDragPreview()

    const bounds = event.currentTarget.getBoundingClientRect()
    const preview = document.createElement("div")
    const previewCard = event.currentTarget.cloneNode(true) as HTMLDivElement
    const label = document.createElement("div")

    dragPointerOffsetRef.current = {
      x: Math.max(12, Math.min(event.clientX - bounds.left, bounds.width - 12)),
      y: Math.max(12, Math.min(event.clientY - bounds.top, bounds.height - 12)),
    }

    preview.className = "kanban-drag-preview"
    preview.setAttribute("aria-hidden", "true")
    preview.inert = true
    preview.dataset.valid = "false"
    preview.dataset.cardId = card.id
    preview.style.width = `${bounds.width}px`
    previewCard.classList.add("kanban-drag-preview-card")
    previewCard.removeAttribute("aria-grabbed")
    previewCard.removeAttribute("data-dragging")
    previewCard.removeAttribute("draggable")
    previewCard.removeAttribute("role")
    previewCard.removeAttribute("tabindex")
    label.className = "kanban-drag-preview-label"
    label.textContent = "Moving lead"
    preview.append(previewCard, label)
    document.body.append(preview)

    dragPreviewRef.current = preview
    dragPreviewLabelRef.current = label
    positionDragPreview(event.clientX, event.clientY)
  }

  function finishDrag() {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = null
    }

    removeDragPreview()
    document.body.classList.remove("is-kanban-pointer-dragging")
    pointerDragRef.current = null
    allowedDropTargetsRef.current = new Set()
    activeDropTargetRef.current = null
    setDraggingCardId(null)
    setDropTarget(null)
  }

  function scrollTrackAtEdge(clientX: number) {
    const track = scrollRef.current
    if (!track) return false

    const bounds = track.getBoundingClientRect()
    const edge = Math.min(96, bounds.width / 4)
    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth)
    let velocity = 0

    if (clientX < bounds.left + edge) {
      const pressure = Math.min(1, (bounds.left + edge - clientX) / edge)
      velocity = -Math.max(3, Math.round(24 * pressure * pressure))
    } else if (clientX > bounds.right - edge) {
      const pressure = Math.min(1, (clientX - (bounds.right - edge)) / edge)
      velocity = Math.max(3, Math.round(24 * pressure * pressure))
    }

    if (!velocity) return false

    const next = Math.max(0, Math.min(maxScroll, track.scrollLeft + velocity))
    if (next === track.scrollLeft) return false

    track.scrollLeft = next
    updateScrollEdges(track)
    return true
  }

  function updateDropTarget(clientX: number, clientY: number) {
    const hovered = document.elementFromPoint(clientX, clientY)
    const column = hovered?.closest<HTMLElement>("[data-kanban-column]")
    const columnKey =
      column && scrollRef.current?.contains(column)
        ? column.dataset.kanbanColumn ?? null
        : null
    const allowed = Boolean(
      columnKey && allowedDropTargetsRef.current.has(columnKey)
    )
    const nextTarget = allowed ? columnKey : null

    describePreview(columnKey, allowed)
    if (activeDropTargetRef.current === nextTarget) return

    activeDropTargetRef.current = nextTarget
    setDropTarget(nextTarget)
  }

  function runDragFrame() {
    const { x, y } = latestPointerRef.current
    positionDragPreview(x, y)
    updateDropTarget(x, y)

    if (scrollTrackAtEdge(x) && pointerDragRef.current?.active) {
      dragFrameRef.current = requestAnimationFrame(() => {
        dragFrameRef.current = null
        runDragFrame()
      })
    }
  }

  function queueDragFrame(clientX: number, clientY: number) {
    latestPointerRef.current = { x: clientX, y: clientY }
    if (dragFrameRef.current !== null) return

    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null
      runDragFrame()
    })
  }

  function beginPointerDrag(
    event: React.PointerEvent<HTMLDivElement>,
    card: KanbanCardData
  ) {
    const interactive =
      event.target instanceof Element &&
      event.target.closest("button, a, input, select, textarea")

    if (!onMove || event.isPrimary === false || event.button !== 0 || interactive) {
      return
    }

    pointerDragRef.current = {
      active: false,
      card,
      originX: event.clientX,
      originY: event.clientY,
      pointerId: event.pointerId,
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is an enhancement; movement still works while the pointer stays on-card.
    }
  }

  function movePointerDrag(event: React.PointerEvent<HTMLDivElement>) {
    const session = pointerDragRef.current
    if (!session || session.pointerId !== event.pointerId) return

    if (!session.active) {
      const distance = Math.hypot(
        event.clientX - session.originX,
        event.clientY - session.originY
      )

      if (distance < DRAG_START_DISTANCE) return

      session.active = true
      allowedDropTargetsRef.current = new Set(allowedMoves(session.card.stage))
      latestPointerRef.current = { x: event.clientX, y: event.clientY }
      createDragPreview(event, session.card)
      document.body.classList.add("is-kanban-pointer-dragging")
      setDraggingCardId(session.card.id)
    }

    event.preventDefault()
    queueDragFrame(event.clientX, event.clientY)
  }

  function endPointerDrag(event: React.PointerEvent<HTMLDivElement>) {
    const session = pointerDragRef.current
    if (!session || session.pointerId !== event.pointerId) return

    if (!session.active) {
      pointerDragRef.current = null
      return
    }

    event.preventDefault()
    event.stopPropagation()

    latestPointerRef.current = { x: event.clientX, y: event.clientY }
    updateDropTarget(event.clientX, event.clientY)
    const target = activeDropTargetRef.current
    suppressOpenCardIdRef.current = session.card.id
    window.setTimeout(() => {
      if (suppressOpenCardIdRef.current === session.card.id) {
        suppressOpenCardIdRef.current = null
      }
    }, 0)

    if (target) setLandingCardId(session.card.id)
    const cardId = session.card.id
    finishDrag()

    if (target) void onMove?.(cardId, target)
  }

  function cancelPointerDrag(event: React.PointerEvent<HTMLDivElement>) {
    const session = pointerDragRef.current
    if (!session || session.pointerId !== event.pointerId) return

    finishDrag()
  }

  function losePointerCapture(event: React.PointerEvent<HTMLDivElement>) {
    const session = pointerDragRef.current
    if (!session || session.pointerId !== event.pointerId) return

    finishDrag()
  }

  function openCard(cardId: string) {
    if (suppressOpenCardIdRef.current === cardId) {
      suppressOpenCardIdRef.current = null
      return
    }

    onOpen(cardId)
  }

  React.useEffect(() => {
    if (!landingCardId) return

    const card = cardRefs.current.get(landingCardId)
    if (!card) {
      setLandingCardId(null)
      return
    }

    const clearLanding = (event: AnimationEvent) => {
      if (event.target === card && event.animationName === "kanban-card-land") {
        setLandingCardId(null)
      }
    }
    card.addEventListener("animationend", clearLanding)

    return () => card.removeEventListener("animationend", clearLanding)
  }, [landingCardId])

  React.useEffect(() => {
    function cancelWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !pointerDragRef.current?.active) return

      event.preventDefault()
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current)
        dragFrameRef.current = null
      }

      dragPreviewRef.current?.remove()
      dragPreviewRef.current = null
      dragPreviewLabelRef.current = null
      document.body.classList.remove("is-kanban-pointer-dragging")
      pointerDragRef.current = null
      allowedDropTargetsRef.current = new Set()
      activeDropTargetRef.current = null
      setDraggingCardId(null)
      setDropTarget(null)
    }

    document.addEventListener("keydown", cancelWithEscape)
    return () => document.removeEventListener("keydown", cancelWithEscape)
  }, [])

  React.useLayoutEffect(() => {
    const track = scrollRef.current
    if (!track) return

    const sync = () => updateScrollEdges(track)
    sync()
    window.addEventListener("resize", sync)

    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(sync)
    observer?.observe(track)
    if (track.firstElementChild) observer?.observe(track.firstElementChild)

    return () => {
      window.removeEventListener("resize", sync)
      observer?.disconnect()
    }
  }, [columns, expandedEmpty, updateScrollEdges])

  React.useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current)
      }

      dragPreviewRef.current?.remove()
      document.body.classList.remove("is-kanban-pointer-dragging")
    }
  }, [])

  return (
    <section
      aria-label="Pipeline board"
      className="min-w-0 max-w-full overflow-hidden"
    >
      {/* The stage totals as one line above the track. The columns carry the same two facts in
          their own headers, and this row is what a reader gets before the track scrolls sideways
          -- the seventh stage is off-screen on a narrow window and its count is not. Sizes are the
          coach side's: 16px for the stage, 17px for the number beside it. */}
      <dl
        aria-label="Stage overview"
        className="mb-4 flex max-w-full flex-wrap items-center gap-x-5 gap-y-2 border-y border-[var(--line)] py-3"
      >
        {columns.map((column) => (
          <div className="flex min-w-0 items-center gap-2" key={column.key}>
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${TONE_CLASS[column.tone]}`}
            />
            <dt className="truncate text-[16px] leading-[1.4] text-[color:var(--muted)]">
              {column.label}
            </dt>
            <dd className="text-[17px] leading-[1.35] font-[500] text-[color:var(--ink)] tabular">
              {column.count}
            </dd>
          </div>
        ))}
      </dl>

      {!onMove ? (
        <p
          className="mb-3 text-[16px] leading-[1.5] text-[color:var(--muted)]"
          data-kanban-read-only="true"
        >
          Stage changes are not available yet.
        </p>
      ) : null}

      <div className="relative min-w-0 max-w-full" data-kanban-scroll-frame="true">
        <div
          className="w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain pb-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
          data-kanban-scroll="true"
          onScroll={(event) => updateScrollEdges(event.currentTarget)}
          ref={scrollRef}
          tabIndex={0}
        >
          {/* Stages share the width evenly down to a 228px floor; below that the track outgrows
              this wrapper and it scrolls horizontally instead of squeezing the cards. */}
          <div
            className="flex w-full items-start gap-[14px]"
            data-drag-active={draggingCardId ? "true" : undefined}
          >
            {columns.map((column) => {
            const columnCards = cardsByStage.get(column.key) ?? []
            const isEmpty = columnCards.length === 0
            const isAllowedDrop = Boolean(
              draggingCardId && visibleDropTargets.has(column.key)
            )
            const isActiveDrop = dropTarget === column.key
            const isCollapsed = isEmpty && !expandedEmpty.has(column.key)

            if (isCollapsed) {
              return (
                <section
                  aria-label={`${column.label} column`}
                  className="w-11 shrink-0 grow-0 basis-11 self-start rounded-[15px] border border-[var(--line)] bg-[var(--well)]"
                  data-drop-allowed={isAllowedDrop ? "true" : undefined}
                  data-drop-target={isActiveDrop ? "true" : undefined}
                  data-emphasis={column.emphasis}
                  data-kanban-column={column.key}
                  data-state="collapsed"
                  key={column.key}
                >
                  <button
                    aria-expanded="false"
                    aria-label={`Expand ${column.label}`}
                    className="flex min-h-130 w-11 items-center justify-center gap-2 rounded-[15px] py-3 text-[16px] leading-[1.4] font-medium text-[color:var(--ink)] outline-none [writing-mode:vertical-rl] hover:bg-[var(--row-hover)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)]"
                    onClick={() => toggleEmptyColumn(column.key)}
                    type="button"
                  >
                    <ChevronRight aria-hidden="true" className="size-3 rotate-90" />
                    <span>{column.label}</span>
                    <span className="tabular">{column.count}</span>
                    <span
                      aria-hidden="true"
                      className={`size-1.5 rounded-full ${
                        column.emphasis === "accent"
                          ? "bg-[var(--accent-text)]"
                          : column.emphasis === "quiet"
                            ? "bg-[var(--faint)]"
                            : TONE_CLASS[column.tone]
                      }`}
                    />
                  </button>
                </section>
              )
            }

            return (
              // The canvas's stage column: a well with the deck's asymmetric corners, larger on
              // top, and 14px of padding so the cards inside never touch its edge.
              <section
                aria-label={`${column.label} column`}
                className={`flex min-h-130 min-w-57 shrink grow basis-0 flex-col gap-3 rounded-[22px_22px_15px_15px] border p-[14px] ${
                  isActiveDrop
                    ? "border-[var(--focus-ring)] bg-[var(--accent-wash)] ring-2 ring-[var(--focus-ring)] ring-offset-2 ring-offset-[var(--canvas)]"
                    : isAllowedDrop
                      ? "border-[var(--line-strong)] bg-[var(--row-hover)]"
                      : column.emphasis === "accent"
                    ? "border-[var(--accent-edge)] bg-[var(--accent-wash)]"
                    : "border-[var(--line)] bg-[var(--well)]"
                }`}
                data-drop-allowed={isAllowedDrop ? "true" : undefined}
                data-drop-target={isActiveDrop ? "true" : undefined}
                data-emphasis={column.emphasis}
                data-kanban-column={column.key}
                data-state="expanded"
                key={column.key}
              >
                <header className="flex shrink-0 items-center gap-[10px] border-b border-[var(--line-soft)] px-1 pt-1 pb-3">
                  <span
                    aria-hidden="true"
                    className={`size-[9px] shrink-0 rounded-full ${
                      column.emphasis === "accent"
                        ? "bg-[var(--accent-text)]"
                        : column.emphasis === "quiet"
                          ? "bg-[var(--faint)]"
                          : TONE_CLASS[column.tone]
                    }`}
                  />
                  <h3
                    className={`min-w-0 flex-1 truncate text-[17px] leading-[1.3] font-semibold ${
                      column.emphasis === "quiet"
                        ? "text-[color:var(--muted)]"
                        : "text-[color:var(--ink)]"
                    }`}
                  >
                    {column.label}
                  </h3>
                  {/* The count as a pill rather than a bare numeral. It is the one figure in the
                      header and the pill is what keeps it from reading as part of the stage's
                      name once the name is set at 17px beside it. */}
                  <span
                    className={`mono grid h-[26px] min-w-[30px] shrink-0 place-items-center rounded-full border px-2 text-[14px] tabular-nums ${
                      column.emphasis === "accent"
                        ? "border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] text-[color:var(--accent-text)]"
                        : "border-[var(--line)] bg-[var(--control-fill)] text-[color:var(--muted)]"
                    }`}
                  >
                    {column.count}
                  </span>
                  {isEmpty ? (
                    <Button
                      aria-expanded="true"
                      aria-label={`Collapse ${column.label}`}
                      onClick={() => toggleEmptyColumn(column.key)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <ChevronLeft aria-hidden="true" />
                    </Button>
                  ) : null}
                </header>

                <div className="flex flex-1 flex-col gap-[10px]">
                  {isEmpty ? (
                    <p className={`flex items-center justify-center gap-2 rounded-[15px] border border-dashed p-4 text-center text-[16px] leading-[1.5] ${
                      isActiveDrop
                        ? "border-[var(--focus-ring)] bg-[var(--accent-wash-strong)] text-[color:var(--ink)]"
                        : "border-[var(--line-strong)] bg-[var(--card)] text-[color:var(--muted)]"
                    }`}>
                      {isAllowedDrop ? (
                        <>
                          <ArrowDown aria-hidden="true" className="size-4 shrink-0" />
                          {isActiveDrop ? "Release to move" : `Drop in ${column.label}`}
                        </>
                      ) : "No leads in this stage."}
                    </p>
                  ) : (
                    columnCards.map((card) => {
                      const moveTargets: KanbanMoveTarget[] = allowedMoves(
                        card.stage
                      ).map((key) => ({
                        key,
                        label: columnByKey.get(key)?.label ?? readableStageKey(key),
                      }))

                      return (
                        <KanbanCard
                          canMove={Boolean(onMove)}
                          card={card}
                          cardRef={(node) => setCardRef(card.id, node)}
                          dragEnabled={Boolean(onMove)}
                          dragging={draggingCardId === card.id}
                          landed={landingCardId === card.id}
                          key={card.id}
                          moveTargets={moveTargets}
                          onLostPointerCapture={losePointerCapture}
                          onMove={onMove}
                          onNavigate={(direction) => moveFocus(card, direction)}
                          onOpen={openCard}
                          onPointerCancel={cancelPointerDrag}
                          onPointerDown={(event) => beginPointerDrag(event, card)}
                          onPointerMove={movePointerDrag}
                          onPointerUp={endPointerDrag}
                          stageLabel={column.label}
                        />
                      )
                    })
                  )}
                </div>

                <p
                  className="shrink-0 border-t border-[var(--line-soft)] px-1 pt-3 text-[15px] leading-[1.4] font-normal text-[color:var(--muted)] tabular"
                  data-kanban-column-total={column.key}
                >
                  {columnCards.length === 1 ? "1 lead" : `${columnCards.length} leads`}
                </p>
              </section>
            )
            })}
          </div>
        </div>
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-12 backdrop-blur-[2px] transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-out)] ${
            scrollEdges.left ? "opacity-100" : "opacity-0"
          }`}
          data-kanban-scroll-fade="left"
          data-visible={scrollEdges.left ? "true" : "false"}
          style={{
            background:
              "linear-gradient(90deg, var(--canvas) 0%, color-mix(in oklab, var(--canvas) 72%, transparent) 46%, transparent 100%)",
          }}
        />
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-12 backdrop-blur-[2px] transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-out)] ${
            scrollEdges.right ? "opacity-100" : "opacity-0"
          }`}
          data-kanban-scroll-fade="right"
          data-visible={scrollEdges.right ? "true" : "false"}
          style={{
            background:
              "linear-gradient(270deg, var(--canvas) 0%, color-mix(in oklab, var(--canvas) 72%, transparent) 46%, transparent 100%)",
          }}
        />
      </div>
    </section>
  )
}
