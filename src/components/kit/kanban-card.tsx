"use client"

import { MoreHorizontal } from "@/components/kit/icons";

import * as React from "react"

import { ActionMenu } from "@/components/kit/action-menu"
import {
  ConfirmFlow,
  type Result,
} from "@/components/kit/confirm-flow"

export type KanbanCardFlag = {
  label: string
  tone: "warning" | "critical"
}

export type KanbanCardData = {
  id: string
  name: string
  stage: string
  meta: readonly string[]
  /**
   * A glyph for the first meta entry. `LeadsBoard.dc.html` leads the meta line with the channel's
   * own icon and then its name, so the card says where the lead came from before it is read. It
   * is decorative -- the channel's name is beside it -- so it is hidden from assistive technology.
   */
  metaIcon?: React.ReactNode
  reason?: string
  /** Rendered only on cards that need the coach, so an unflagged card reads as quiet. */
  flag?: KanbanCardFlag
}

export type KanbanMoveTarget = {
  key: string
  label: string
}

export type KanbanCardProps = {
  card: KanbanCardData
  stageLabel: string
  moveTargets: readonly KanbanMoveTarget[]
  canMove: boolean
  dragging?: boolean
  dragEnabled?: boolean
  landed?: boolean
  onLostPointerCapture?: React.PointerEventHandler<HTMLDivElement>
  onPointerCancel?: React.PointerEventHandler<HTMLDivElement>
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>
  onPointerMove?: React.PointerEventHandler<HTMLDivElement>
  onPointerUp?: React.PointerEventHandler<HTMLDivElement>
  onMove?: (cardId: string, to: string) => Promise<Result>
  onOpen: (cardId: string) => void
  onNavigate: (direction: "up" | "down" | "left" | "right") => void
  cardRef?: React.Ref<HTMLDivElement>
}

const PIPELINE_ACTION_KEY = "contact.pipeline_stage.set"

export function KanbanCard({
  card,
  stageLabel,
  moveTargets,
  canMove,
  dragging = false,
  dragEnabled = false,
  landed = false,
  onLostPointerCapture,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onMove,
  onOpen,
  onNavigate,
  cardRef,
}: KanbanCardProps) {
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [selectedTarget, setSelectedTarget] =
    React.useState<KanbanMoveTarget | null>(null)
  const menuRootRef = React.useRef<HTMLDivElement>(null)

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return

    if (event.key === "Enter") {
      event.preventDefault()
      onOpen(card.id)
      return
    }

    if (event.key.toLowerCase() === "m") {
      event.preventDefault()
      menuRootRef.current?.querySelector("button")?.click()
      return
    }

    const directionByKey = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    } as const
    const direction = directionByKey[event.key as keyof typeof directionByKey]

    if (direction) {
      event.preventDefault()
      onNavigate(direction)
    }
  }

  function chooseMove(target: KanbanMoveTarget) {
    if (!canMove) return

    setSelectedTarget(target)
    setConfirmOpen(true)
  }

  async function move(target: KanbanMoveTarget): Promise<Result> {
    if (!onMove) {
      return { ok: false, message: "Stage changes are not available yet." }
    }

    return onMove(card.id, target.key)
  }

  return (
    <>
      <div
        aria-label={`Open ${card.name}`}
        /*
         * The canvas's lead card: 15px corners, the same `--card-top` to `--card` gradient every
         * other panel on the coach side wears, and the card's own shadow rather than one that
         * arrives on hover. `cursor-grab` because the card is draggable -- `cursor-pointer` said
         * "this opens", which is only half of what pressing and holding it does.
         *
         * Status belongs to the compact flag beneath the lead's name. Keeping the card surface
         * neutral avoids saying the same thing with a coloured border, a coloured wash, and a
         * coloured badge, while the badge remains visible before the reason is read.
         *
         * The padding is `16px 16px 14px`, not the uniform `p-4` this shipped as.
         * `LeadsBoard.dc.html:142` takes two pixels off the bottom, which is what stops a card
         * whose last line is the small `--faint` source row from sitting low in its own box: the
         * line's descenders and its 15px leading already read as space under the text, so an equal
         * 16px measured the same on all four sides and looked bottom-heavy on every card.
         */
        aria-grabbed={dragging}
        className={`group relative flex min-h-[88px] flex-col gap-[10px] rounded-[15px] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] px-4 pt-4 pb-[14px] text-left shadow-[var(--shadow-card)] outline-none transition-[border-color,box-shadow,opacity,transform] duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)] hover:border-[var(--line-strong)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)] ${
          dragEnabled ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default"
        }`}
        data-card-id={card.id}
        data-drag-enabled={dragEnabled ? "true" : undefined}
        data-dragging={dragging ? "true" : undefined}
        data-kanban-card="true"
        data-landed={landed ? "true" : undefined}
        draggable={false}
        onClick={(event) => {
          if (
            (event.target as HTMLElement).closest(
              "button, a, input, select, textarea"
            )
          ) {
            return
          }

          onOpen(card.id)
        }}
        onKeyDown={handleKeyDown}
        onLostPointerCapture={onLostPointerCapture}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        ref={cardRef}
        role="group"
        tabIndex={0}
      >
        <div
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2"
          data-slot="kanban-card-header"
        >
          <div className="min-w-0" data-slot="kanban-card-identity">
            <span
              className="block min-w-0 break-words text-[17px] leading-[1.3] font-semibold text-[color:var(--ink)] [overflow-wrap:anywhere]"
              data-slot="kanban-card-name"
            >
              {card.name}
            </span>
            {card.flag ? (
              /*
               * The flag sits inside the identity block so it reads as the lead's current state,
               * not as a detached second heading. Its tint is the card's only semantic colour.
               */
              <span
                className={`mt-[7px] inline-flex max-w-full items-center gap-[7px] rounded-full border px-[9px] py-[3px] text-[14px] leading-[1.3] font-medium ${
                  card.flag.tone === "critical"
                    ? "border-[color-mix(in_oklab,var(--critical)_34%,transparent)] bg-[color-mix(in_oklab,var(--critical)_8%,transparent)] text-[color:var(--critical-text)]"
                    : "border-[color-mix(in_oklab,var(--warning)_34%,transparent)] bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] text-[color:var(--warning-text)]"
                }`}
                data-card-flag={card.flag.tone}
              >
                <span
                  aria-hidden="true"
                  className={`size-[7px] shrink-0 rounded-full ${
                    card.flag.tone === "critical"
                      ? "bg-[var(--critical)]"
                      : "bg-[var(--warning)]"
                    }`}
                />
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {card.flag.label}
                </span>
              </span>
            ) : null}
          </div>
          <div className="shrink-0" ref={menuRootRef}>
            <ActionMenu
              disabled={!canMove}
              items={moveTargets.map((target) => ({
                label: target.label,
                onSelect: () => chooseMove(target),
              }))}
              label={`Move ${card.name}`}
              trigger={<MoreHorizontal aria-hidden="true" />}
            />
          </div>
        </div>
        {card.reason ? (
          <p
            className="break-words text-[15px] leading-[1.45] font-normal text-[color:var(--muted)] [overflow-wrap:anywhere]"
            data-slot="kanban-card-reason"
          >
            {card.reason}
          </p>
        ) : null}
        {card.meta.length ? (
          <div
            className={`grid min-w-0 items-center gap-x-[10px] gap-y-[5px] border-t border-[var(--line-soft)] pt-[10px] text-[14px] leading-[1.35] font-normal text-[color:var(--faint)] tabular ${
              card.metaIcon
                ? "grid-cols-[auto_minmax(0,1fr)]"
                : "grid-cols-[minmax(0,1fr)_auto]"
            }`}
            data-slot="kanban-card-meta"
          >
            {card.meta.map((entry, index) => (
              <span
                className={`flex min-w-0 items-start gap-[6px] ${
                  index === 0 && card.metaIcon
                    ? "size-7 items-center justify-center rounded-[8px] border border-[var(--line)] bg-[color-mix(in_oklab,var(--card-top)_72%,transparent)] text-[color:var(--muted)]"
                    : index === 1
                    ? "justify-self-end text-right"
                    : index > 1
                      ? "col-span-2"
                      : ""
                }`}
                data-meta-index={index}
                key={`${index}-${entry}`}
                title={index === 0 && card.metaIcon ? entry : undefined}
              >
                {index === 0 && card.metaIcon ? (
                  <span aria-hidden="true" className="flex shrink-0 items-center">
                    {card.metaIcon}
                  </span>
                ) : null}
                <span
                  className={
                    index === 0 && card.metaIcon
                      ? "sr-only"
                      : "min-w-0 break-words [overflow-wrap:anywhere]"
                  }
                >
                  {entry}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {selectedTarget ? (
        <ConfirmFlow
          action={PIPELINE_ACTION_KEY}
          confirmLabel="Move lead"
          impact={[
            { label: "From", value: stageLabel },
            { label: "To", value: selectedTarget.label },
          ]}
          onConfirm={() => move(selectedTarget)}
          onOpenChange={setConfirmOpen}
          open={confirmOpen}
          title={`Move ${card.name}?`}
        />
      ) : null}
    </>
  )
}
