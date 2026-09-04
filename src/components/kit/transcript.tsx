"use client"

import { Bot, Info, TriangleAlert } from "@/components/kit/icons";

import type { CSSProperties, ReactElement } from "react"
import { useLayoutEffect, useMemo, useRef } from "react"

import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import { displayName, displayText } from "@/lib/format/display-name"

export type TranscriptMessage = {
  id: string
  author: "lead" | "agent" | "human" | "system"
  authorName?: string
  body: string
  at: string
  delivery?: "sent" | "delivered" | "failed"
  grounding?: { label: string; href?: string }
}

export type TranscriptTyping = boolean | { label?: string }

/**
 * The stop callout `Inbox.dc.html` draws inside the message flow: an amber icon-led block saying
 * the agent stopped and why. It is a property of the conversation -- `convo_status_reason` is one
 * column on the thread, not a marker on a turn -- so it renders at the foot of the flow, which is
 * where the stop actually happened: the agent has said nothing since. Placing it against an
 * earlier turn would mean guessing which turn, and nothing stored says.
 */
export type TranscriptStop = {
  /** Why the agent stopped, in the coach's words. Never a lifecycle value. */
  reason: string
  /** What the platform does about it, when the handoff rule publishes one. */
  behaviour?: string
}

export type TranscriptProps = {
  messages: readonly TranscriptMessage[]
  variant: "coach" | "consumer" | "tester"
  onReachTop?: () => void
  typing?: TranscriptTyping
  /** Rendered after the last message when the agent has handed the thread over. */
  stop?: TranscriptStop | null
}

type RunMessage = {
  message: TranscriptMessage
  runName: string
  startsRun: boolean
  endsRun: boolean
}

const scrollerMask: CSSProperties = {
  WebkitMaskImage:
    "linear-gradient(to bottom, transparent, var(--card) var(--s-4), var(--card))",
  maskImage:
    "linear-gradient(to bottom, transparent, var(--card) var(--s-4), var(--card))",
}

function defaultAuthorName(
  author: TranscriptMessage["author"],
  variant: TranscriptProps["variant"],
): string {
  if (author === "system") return "System"

  if (variant === "consumer") {
    if (author === "lead") return "You"
    if (author === "agent") return "Assistant"
    return "Team"
  }

  if (variant === "tester") {
    if (author === "lead") return "Lead"
    if (author === "agent") return "Agent"
    return "Human"
  }

  if (author === "lead") return "Lead"
  if (author === "agent") return "Agent"
  if (author === "human") return "You"
  return "System"
}

function groupIntoRuns(
  messages: readonly TranscriptMessage[],
  variant: TranscriptProps["variant"],
): RunMessage[] {
  const grouped: RunMessage[] = []
  let runStart = 0

  while (runStart < messages.length) {
    const author = messages[runStart].author
    let explicitName = messages[runStart].authorName
    let runEnd = runStart + 1

    if (!explicitName) {
      for (let index = runEnd; index < messages.length; index += 1) {
        if (messages[index].author !== author) break
        if (messages[index].authorName) {
          explicitName = messages[index].authorName
          break
        }
      }
    }

    const runName = explicitName ? displayName(explicitName) : defaultAuthorName(author, variant)

    while (runEnd < messages.length && messages[runEnd].author === author) {
      const nextName = messages[runEnd].authorName
      if (nextName && nextName !== runName) break
      runEnd += 1
    }

    for (let index = runStart; index < runEnd; index += 1) {
      grouped.push({
        message: messages[index],
        runName,
        startsRun: index === runStart,
        endsRun: index === runEnd - 1,
      })
    }

    runStart = runEnd
  }

  return grouped
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

function messageSide(
  author: TranscriptMessage["author"],
  variant: TranscriptProps["variant"],
): "left" | "right" {
  if (variant === "coach") return author === "lead" ? "left" : "right"
  if (variant === "consumer") {
    return author === "agent" || author === "human" ? "left" : "right"
  }
  return author === "agent" ? "left" : "right"
}

function MessageAvatar({
  author,
  name,
  hidden,
}: {
  author: TranscriptMessage["author"]
  name: string
  hidden: boolean
}): ReactElement {
  return (
    <Avatar
      aria-hidden="true"
      className={cn(
        "size-[var(--s-8)] border border-[var(--line)] bg-[var(--card)]",
        hidden && "invisible",
      )}
    >
      <AvatarFallback className="bg-[var(--quiet)] text-[length:var(--t-badge)] font-[var(--t-badge-w)] text-[color:var(--muted)]">
        {author === "agent" ? (
          <Bot className="size-[var(--s-4)]" />
        ) : (
          initials(name)
        )}
      </AvatarFallback>
    </Avatar>
  )
}

function GroundingReceipt({
  grounding,
}: {
  grounding: NonNullable<TranscriptMessage["grounding"]>
}): ReactElement {
  const className =
    "msg__ground inline-flex items-center gap-[var(--s-1)] text-[length:var(--t-badge)] font-normal leading-[var(--t-body-lh)] text-[color:var(--faint)]"
  const content = (
    <>
      <Info aria-hidden="true" className="size-[var(--s-3)]" />
      <span>{grounding.label}</span>
    </>
  )

  return grounding.href ? (
    <a className={className} href={grounding.href}>
      {content}
    </a>
  ) : (
    <span className={className}>{content}</span>
  )
}

function SystemMessage({ message }: { message: TranscriptMessage }): ReactElement {
  return (
    <div
      className="sysline flex w-full items-center gap-[var(--s-3)] text-body text-[color:var(--faint)] before:flex-1 before:border-t before:border-[var(--line)] after:flex-1 after:border-t after:border-[var(--line)]"
      data-author="system"
      data-slot="transcript-message"
      role="listitem"
    >
      <span className="flex max-w-[var(--measure-wide)] flex-wrap items-baseline justify-center gap-x-[var(--s-2)] text-center">
        <strong className="font-[var(--t-row-w)] text-[color:var(--muted)]">System</strong>
        <span>{displayText(message.body)}</span>
        <time>{message.at}</time>
      </span>
    </div>
  )
}

function StopCallout({ stop }: { stop: TranscriptStop }): ReactElement {
  return (
    <div
      className="msg-stop flex w-full max-w-[var(--measure-wide)] items-start gap-[var(--s-3)] self-start rounded-[var(--r-card)] border border-[var(--warning-line)] bg-[var(--warning-wash)] px-[var(--s-4)] py-[var(--s-3)]"
      data-slot="transcript-stop"
      role="listitem"
    >
      <TriangleAlert aria-hidden="true" className="mt-[2px] size-[var(--s-4)] shrink-0 text-[color:var(--warning-text)]" />
      <p className="text-read m-0 text-[color:var(--warning-text)]">
        <strong className="font-[var(--t-row-w)]">Your agent stopped here.</strong>{" "}
        {stop.reason}
        {stop.behaviour ? ` ${stop.behaviour}` : null}
      </p>
    </div>
  )
}

function TranscriptRow({
  item,
  variant,
}: {
  item: RunMessage
  variant: TranscriptProps["variant"]
}): ReactElement {
  const { message, runName, startsRun, endsRun } = item

  if (message.author === "system") return <SystemMessage message={message} />

  const side = messageSide(message.author, variant)
  const right = side === "right"
  const messageCap = variant === "consumer" ? "max-w-[var(--measure-tight)]" : "max-w-[var(--measure-wide)]"
  /*
   * The bubble surfaces, the same two the owner inbox thread uses, because a reader who moves
   * between the two support surfaces should not have to relearn what a message looks like.
   *
   * The bubbles sit on a --card face, and the incoming side used to be painted at --card or at
   * --quiet, which is the recessed ground: one was the exact value of the face behind it and the
   * other is a step down from it in the light palette, so a message read as text inside a faint
   * rectangle rather than as a surface of its own. --raised is the only surface token that sits
   * above --card in both palettes, so it is the one value that lifts the bubble whichever theme
   * the reader has on, and the hairline moves to --line-strong and the bubble takes
   * --shadow-card, the page's own material, so that the edge and the shadow agree with the lift.
   *
   * The reader's own side takes the accent wash instead of the neutral lift, which is what makes
   * the column read as a conversation with a speaker on each side rather than as one stack of
   * identical boxes. Who wrote a message on that side, the agent or a person, is still carried by
   * the bot avatar and the run name above the bubble, so nothing is lost by giving both the same
   * ground. The square corner still points down at the avatar on the speaker's side.
   */
  const messageClassName = [
    "msg__text text-read m-0 whitespace-pre-wrap break-words rounded-[var(--r-card)] px-[var(--s-4)] py-[var(--s-3)] text-[color:var(--ink)] shadow-[var(--shadow-card)]",
    messageCap,
    side === "left"
      ? "rounded-bl-[var(--r-control)] border border-[var(--line-strong)] bg-[var(--raised)]"
      : "rounded-br-[var(--r-control)] border border-[var(--accent-edge)] bg-[var(--accent-wash-strong)]",
  ]
    .filter(Boolean)
    .join(" ")
  const metadataClassName = [
    "msg__meta flex items-baseline gap-[var(--s-2)] text-body text-[color:var(--faint)]",
    !endsRun && message.delivery !== "failed"
      ? "h-0 overflow-visible opacity-0 transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-out)] group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 motion-reduce:transition-none"
      : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <article
      className={cn(
        "group/msg msg grid w-full grid-cols-[var(--s-8)_minmax(0,1fr)] items-start gap-[var(--s-3)]",
        right && "grid-cols-[minmax(0,1fr)_var(--s-8)]",
      )}
      data-author={message.author}
      data-side={side}
      data-slot="transcript-message"
      role="listitem"
    >
      <div
        className={cn(
          "msg__body col-start-2 flex min-w-0 flex-col items-start gap-[var(--s-1)]",
          right && "col-start-1 row-start-1 items-end",
        )}
      >
        {startsRun ? (
          <span className="msg__who text-body font-[var(--t-row-w)] text-[color:var(--muted)]">
            {runName}
          </span>
        ) : null}

        <p
          className={messageClassName}
          data-slot="message-text"
        >
          {/*
            The seeders staple a trailing `(demo)` onto every body they write, so provenance is
            legible in a query. On screen the audit counted it twenty times on one coach pane. It
            is stripped here, at the one component every transcript renders through, rather than
            by each screen: `displayName` already made this decision for names and the screens
            that inherited it are the ones that stopped repeating themselves.
          */}
          {displayText(message.body)}
        </p>

        {message.grounding ? <GroundingReceipt grounding={message.grounding} /> : null}

        <div
          className={metadataClassName}
        >
          <time>{message.at}</time>
          {message.delivery === "failed" ? (
            <span className="font-[var(--t-row-w)] text-[color:var(--critical)]">Failed</span>
          ) : null}
        </div>
      </div>

      <div className={cn("col-start-1 row-start-1", right && "col-start-2")}>
        <MessageAvatar author={message.author} hidden={!startsRun} name={runName} />
      </div>
    </article>
  )
}

function typingLabel(typing: TranscriptTyping): string {
  if (typeof typing === "object") return typing.label ?? "Agent is typing"
  return "Agent is typing"
}

export function Transcript({
  messages,
  variant,
  onReachTop,
  typing = false,
  stop = null,
}: TranscriptProps): ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null)
  const reachedTopRef = useRef(false)
  const runs = useMemo(() => groupIntoRuns(messages, variant), [messages, variant])
  const latest = messages.at(-1)
  const latestMessageId = latest?.id
  const typingActive = Boolean(typing)
  const announcement = typing
    ? typingLabel(typing)
    : latest
      ? `${latest.authorName ?? defaultAuthorName(latest.author, variant)} sent a message`
      : ""

  useLayoutEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    bottomRef.current?.scrollIntoView?.({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "end",
    })
  }, [latestMessageId, typingActive])

  return (
    <section className="relative flex h-full min-h-0 flex-col" data-slot="transcript">
      <a
        // A focus-revealed skip link genuinely is over the page for as long as it is focused, so it
        // keeps the raised rung -- but it was wearing that rung's shadow over --card, which is the
        // page's own material. Matches the shell's skip link now; there was no reason for the two
        // to differ.
        className="sr-only z-[var(--z-rail)] rounded-[var(--r-control)] bg-[var(--raised)] px-[var(--s-3)] py-[var(--s-2)] text-body text-[color:var(--accent-text)] shadow-[var(--shadow-raised)] focus:not-sr-only focus:absolute focus:left-[var(--s-3)] focus:top-[var(--s-3)]"
        href="#message-composer"
      >
        Skip to message composer
      </a>

      <div
        aria-label="Conversation messages"
        aria-live="off"
        className="min-h-0 flex-1 overflow-y-auto px-[var(--s-4)] pb-[var(--s-4)] pt-[var(--s-4)] focus-visible:outline focus-visible:outline-[var(--focus-ring)]"
        tabIndex={0}
        onScroll={(event) => {
          const atTop = event.currentTarget.scrollTop <= 0
          if (atTop && !reachedTopRef.current) onReachTop?.()
          reachedTopRef.current = atTop
        }}
        role="log"
        style={scrollerMask}
      >
        <div
          className="transcript mx-auto flex w-full max-w-3xl flex-col gap-[var(--s-4)]"
          role="list"
        >
          {runs.map((item) => (
            <TranscriptRow item={item} key={item.message.id} variant={variant} />
          ))}

          {stop ? <StopCallout stop={stop} /> : null}

          {typing ? (
            <div className="flex items-start gap-[var(--s-3)]" data-slot="typing-row">
              <MessageAvatar author="agent" hidden={false} name="Agent" />
              <div
                aria-hidden="true"
                className="typing inline-flex w-max gap-[var(--s-1)] rounded-[var(--r-card)] rounded-bl-[var(--r-control)] bg-[var(--quiet)] px-[var(--s-4)] py-[var(--s-3)]"
              >
                {[0, 1, 2].map((dot) => (
                  <i
                    aria-hidden="true"
                    className={cn(
                      "size-[var(--distance-small)] rounded-[var(--r-full)] bg-[var(--muted)] motion-safe:animate-pulse [animation-duration:var(--duration-fast)] [animation-timing-function:var(--ease-out)] motion-reduce:animate-none",
                      dot === 1 && "[animation-delay:var(--duration-stagger)]",
                      dot === 2 &&
                        "[animation-delay:calc(var(--duration-stagger)*2)]",
                    )}
                    key={dot}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <div aria-hidden="true" className="h-0 scroll-mb-[var(--s-4)]" ref={bottomRef} />
        </div>
      </div>

      <p aria-atomic="true" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  )
}
