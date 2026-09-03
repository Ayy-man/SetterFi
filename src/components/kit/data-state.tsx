"use client"

import { CircleAlert, Inbox } from "@/components/kit/icons";

import { motion, useReducedMotion } from "motion/react"
import { useRouter } from "next/navigation"
import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { FAILURE_BODY } from "@/lib/copy/failure"
import { cn } from "@/lib/utils"

export type DataStateAction = {
  label: string
  onClick?: () => void
  href?: string
}

export type DataStateKind =
  | { kind: "loading"; rows?: number }
  | {
      kind: "empty"
      title: string
      body?: string
      action?: DataStateAction
      /**
       * `escalations` is the one empty state worth animating: an empty escalations queue is good
       * news arriving, so the block draws itself in rather than being there already. Every other
       * empty state is a plain fact and appears without ceremony.
       */
      variant?: EmptyVariant
    }
  | { kind: "unavailable"; title: string; body: string; retry?: () => void }
  | { kind: "error"; title: string; body: string; retry: () => void; code?: string }

export type EmptyVariant = "default" | "escalations"

const FAILURE_SENTENCE = /No [^.]*action was completed(?: by this error state)?\./i

function ActionControl({ action }: { action: DataStateAction }): ReactElement {
  if (action.href) {
    return (
      <Button
        nativeButton={false}
        render={<a href={action.href} onClick={action.onClick} />}
        size="sm"
        variant="outline"
      >
        {action.label}
      </Button>
    )
  }

  return (
    <Button
      disabled={!action.onClick}
      onClick={action.onClick}
      size="sm"
      type="button"
      variant="outline"
    >
      {action.label}
    </Button>
  )
}

/**
 * Loading rows at `--d-row`, which is the height DataTable renders a body row at. They stood at
 * `--row-h` -- the density-toggle contract, 4px taller -- so a table swapping its skeleton for its
 * rows shifted every row down the page as it landed.
 */
function SkeletonRows({ rows }: { rows: number }): ReactElement {
  return (
    <div aria-hidden="true" className="w-full min-w-0">
      {Array.from({ length: rows }, (_, index) => (
        <div
          className="grid h-[var(--d-row)] min-w-0 grid-cols-[calc(var(--s-6)_+_var(--s-1))_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(var(--s-10),auto)] items-center gap-[var(--s-3)] border-b border-[var(--line)] px-[var(--cell-x)]"
          data-testid="skeleton-row"
          key={index}
        >
          <Skeleton
            className="size-[var(--s-5)] rounded-[var(--r-full)]"
            data-testid="skeleton-bone"
          />
          <Skeleton className="h-[var(--s-3)] w-[70%]" data-testid="skeleton-bone" />
          <Skeleton className="h-[var(--s-3)] w-[60%]" data-testid="skeleton-bone" />
          <Skeleton className="h-[var(--s-3)] w-1/2" data-testid="skeleton-bone" />
          <Skeleton
            className="h-[var(--s-5)] w-[calc(var(--s-10)_+_var(--s-4))] max-w-full justify-self-end rounded-[var(--r-input)]"
            data-testid="skeleton-bone"
          />
        </div>
      ))}
    </div>
  )
}

function FailureState({
  body,
  className,
  code,
  critical,
  retry,
  title,
}: {
  body: string
  className?: string
  code?: string
  critical: boolean
  retry: () => void
  title: string
}): ReactElement {
  return (
    <main
      className={cn(
        "flex w-full max-w-[var(--measure-prose)] min-w-0 items-start gap-[var(--s-3)] rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] p-[var(--s-4)]",
        className,
      )}
      data-tone={critical ? "critical" : "neutral"}
    >
      <span
        aria-hidden="true"
        className="grid size-[calc(var(--s-6)_+_var(--s-1))] shrink-0 place-items-center rounded-[var(--r-input)] bg-[var(--quiet)] text-[var(--muted)]"
      >
        <CircleAlert className="size-[var(--s-4)]" />
      </span>
      <div className="min-w-0 flex-1">
        {/*
          `.t-row` declares `color: var(--ink)` in `tokens.css`, which is unlayered and so beats any
          Tailwind utility whatever the specificity looks like. Without the `!` the critical state
          drew its heading in ordinary ink and nothing marked it as critical. Deliberate override,
          not a stray -- leave it until `.t-row` gains a tone variant to say this properly.
        */}
        <h2 className={cn("t-row", critical && "text-[var(--critical)]!")}>{title}</h2>
        <p className="t-muted mt-[var(--s-1)] max-w-[var(--measure-prose)]">{body}</p>
        <div className="mt-[var(--s-2)] flex flex-wrap gap-[var(--s-2)]">
          <Button onClick={retry} size="sm" type="button" variant="outline">
            Retry
          </Button>
        </div>
        {code ? (
          <details className="t-faint mt-[var(--s-2)] max-w-full">
            <summary className="w-fit cursor-pointer select-none">Technical detail</summary>
            <code className="t-id mt-[var(--s-1)] block max-w-full break-all">{code}</code>
          </details>
        ) : null}
      </div>
    </main>
  )
}

/**
 * The empty block: a dashed hairline, centred, one title, one sentence, one outlined button. The
 * dash is the whole signal -- a solid card would read as a record that happens to be blank, and a
 * dashed one reads as a place where records will go.
 */
function EmptyState({
  action,
  body,
  className,
  title,
  variant,
}: {
  action?: DataStateAction
  body?: string
  className?: string
  title: string
  variant: EmptyVariant
}): ReactElement {
  const reduced = useReducedMotion()
  // Reduced motion means the block is simply already there. globals.css owns the single
  // prefers-reduced-motion block in the app, and it cannot reach a Motion animation, so the
  // hook is how this component honours it.
  const animated = variant === "escalations" && !reduced

  return (
    <motion.main
      animate={animated ? { opacity: 1, scale: 1 } : undefined}
      className={cn(
        "flex w-full max-w-[var(--measure-tight)] min-w-0 flex-col items-center gap-[var(--s-2)] rounded-[var(--r-card)] border border-dashed border-[var(--line-strong)] px-[var(--d-card-p)] py-[var(--s-8)] text-center",
        className,
      )}
      data-motion={animated ? "draw-in" : "none"}
      data-slot="empty-state"
      data-variant={variant}
      initial={animated ? { opacity: 0, scale: 0.98 } : false}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
    >
      <span
        aria-hidden="true"
        className="grid size-[var(--s-8)] place-items-center rounded-[var(--r-card)] bg-[var(--quiet)] text-[var(--muted)]"
      >
        <Inbox className="size-[var(--s-4)]" />
      </span>
      <h2 className="text-[length:var(--t-body)] leading-[1.35] font-semibold text-[var(--ink)]">
        {title}
      </h2>
      {body ? <p className="t-muted max-w-[var(--measure-tight)]">{body}</p> : null}
      {action ? (
        <div className="mt-[var(--s-1)] flex max-w-full flex-wrap">
          <ActionControl action={action} />
        </div>
      ) : null}
    </motion.main>
  )
}

export function DataState(
  props: DataStateKind & { className?: string },
): ReactElement {
  const router = useRouter()

  if (props.kind === "loading") {
    const rows = Math.max(1, Math.floor(props.rows ?? 4))

    return (
      <main
        aria-busy="true"
        aria-label="Loading content"
        className={cn("w-full min-w-0 overflow-hidden", props.className)}
      >
        <SkeletonRows rows={rows} />
      </main>
    )
  }

  if (props.kind === "empty") {
    return (
      <EmptyState
        action={props.action}
        body={props.body}
        className={props.className}
        title={props.title}
        variant={props.variant ?? "default"}
      />
    )
  }

  const retry = props.retry ?? (() => router.refresh())

  if (props.kind === "unavailable") {
    const body = FAILURE_SENTENCE.test(props.body)
      ? props.body
      : `${props.body} ${FAILURE_BODY.platform}`

    return (
      <FailureState
        body={body}
        className={props.className}
        critical={false}
        retry={retry}
        title={props.title}
      />
    )
  }

  return (
    <FailureState
      body={props.body}
      className={props.className}
      code={props.code}
      critical
      retry={retry}
      title={props.title}
    />
  )
}
