"use client"

import { CircleX, ShieldCheck } from "@/components/kit/icons";

import {
  type FormEvent,
  type ReactNode,
  useId,
  useState,
  useTransition,
} from "react"

import { Overline } from "@/components/kit/atomics"
import { LoggedButton } from "@/components/kit/logged-button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import {
  AUDIT_ACTIONS,
  type AuditActionKey,
} from "@/lib/audit/actions"

export type Result =
  | {
      ok: true
      receipt: { auditId: number; actionKey: AuditActionKey }
    }
  | { ok: false; message: string; partial?: true }

/**
 * Privileged-action receipt. Success is the word plus a lifecycle dot, never a
 * green fill or a green check: the colour budget allows good only as a 6px dot
 * on neutral chrome.
 */
export function LoggedReceipt({
  actionKey,
  auditId,
}: {
  actionKey: AuditActionKey
  auditId: number
}) {
  return (
    <div
      aria-live="polite"
      className="flex items-start gap-(--s-2) rounded-(--r-card) border border-[var(--line)] bg-[var(--quiet)] p-(--s-3) text-badge font-normal leading-(--t-body-lh) text-[color:var(--muted)]"
      data-slot="logged-receipt"
    >
      <span
        aria-hidden
        className="mt-(--s-2) size-(--distance-small) shrink-0 rounded-(--r-full) bg-[var(--good)]"
      />
      <p>
        <span className="font-medium text-[color:var(--ink)]">
          {AUDIT_ACTIONS[actionKey].microcopy}.
        </span>{" "}
        Audit receipt #{auditId}.
      </p>
    </div>
  )
}

/**
 * The neutral "Logged" microcopy pill: shield plus the audit microcopy, no
 * semantic fill. Use wherever a surface shows that a record already exists.
 */
export function LoggedPill({ actionKey }: { actionKey: AuditActionKey }) {
  const accountability = AUDIT_ACTIONS[actionKey]

  return (
    <span
      aria-label={accountability.ariaLabel}
      className="text-over inline-flex w-fit items-center gap-(--s-1) rounded-(--r-input) border border-[var(--line)] px-(--s-2) py-(--s-1) text-[color:var(--muted)]"
      data-slot="logged-pill"
    >
      <ShieldCheck aria-hidden className="size-(--s-3)" />
      {accountability.microcopy}
    </span>
  )
}

/** One line of the impact table: what the record is, and what happens to it. */
export type ImpactRow = { label: string; value: string }

/**
 * A named band of impact rows. Deletion is the case this exists for: "what this deletes" and
 * "what survives -- on purpose" are two different claims about the same action, and a single
 * undifferentiated list makes the survivors read like more casualties. `note` carries the
 * sentence that explains why the band is what it is.
 */
export type ImpactGroup = { title: string; rows: readonly ImpactRow[]; note?: string }

export type ConfirmFlowImpact = readonly ImpactRow[] | readonly ImpactGroup[]

function isGroupedImpact(impact: ConfirmFlowImpact): impact is readonly ImpactGroup[] {
  return impact.length > 0 && "rows" in impact[0]
}

export type ConfirmFlowProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  action: AuditActionKey
  title: string
  impact: ConfirmFlowImpact
  reason?: { required: boolean; label: string; hint: string }
  /**
   * One sentence saying what confirming actually changes, above the reason field.
   *
   * It is deliberately narrower than the impact rows: those are the record being acted on, this is
   * the consequence of acting. Say only what the write really does -- an unblock returns a step to
   * pending, it does not complete it -- because this is the last sentence anybody reads before a
   * privileged write.
   */
  consequence?: string
  expiry?: {
    label: string
    value: string | null
    onChange: (value: string | null) => void
  }
  confirmLabel: string
  destructive?: boolean
  /**
   * A second, deliberate gate for an action that cannot be undone: the operator types the word
   * before the confirm button will fire. It sits alongside the recorded reason rather than
   * replacing it -- the reason is what the audit row keeps, the typed word is what stops a
   * mis-aimed click.
   */
  typeToConfirm?: { word: string; label: string; hint: string }
  onConfirm: (input: {
    reason?: string
    expiry?: string | null
  }) => Promise<Result>
}

function pendingLabel(label: string) {
  const [verb = "", ...rest] = label.trim().split(/\s+/)
  const progressiveVerbs: Record<string, string> = {
    add: "Adding",
    approve: "Approving",
    archive: "Archiving",
    cancel: "Canceling",
    close: "Closing",
    connect: "Connecting",
    correct: "Correcting",
    create: "Creating",
    delete: "Deleting",
    disconnect: "Disconnecting",
    export: "Exporting",
    import: "Importing",
    invite: "Inviting",
    mark: "Marking",
    merge: "Merging",
    pause: "Pausing",
    publish: "Publishing",
    record: "Recording",
    reject: "Rejecting",
    release: "Releasing",
    remove: "Removing",
    resend: "Resending",
    resume: "Resuming",
    retry: "Retrying",
    revoke: "Revoking",
    rollback: "Rolling back",
    run: "Running",
    save: "Saving",
    send: "Sending",
    set: "Setting",
    start: "Starting",
    stop: "Stopping",
    submit: "Submitting",
    suspend: "Suspending",
    switch: "Switching",
    take: "Taking",
    unblock: "Unblocking",
    undo: "Undoing",
    update: "Updating",
  }
  const progressive = progressiveVerbs[verb.toLowerCase()]

  if (!progressive) return "Working..."

  return `${progressive}${rest.length ? ` ${rest.join(" ")}` : ""}...`
}

/**
 * The impact rows themselves. One bordered block whichever shape the caller passed, so a grouped
 * flow and a flat one read as the same object with a heading added rather than as two designs.
 */
function ImpactList({ rows }: { rows: readonly ImpactRow[] }) {
  return (
    <dl className="overflow-hidden rounded-(--r-card) border border-[var(--line)]">
      {rows.map((row) => (
        <div
          className="grid grid-cols-[minmax(var(--sidebar-w-collapsed),1fr)_2fr] gap-(--s-3) border-b border-[var(--line)] px-(--s-3) py-(--s-2) text-body last:border-b-0"
          key={`${row.label}:${row.value}`}
        >
          <dt className="text-[color:var(--muted)]">{row.label}</dt>
          <dd className="min-w-0 break-words text-[color:var(--ink)]">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

type FlowBodyProps = {
  action: AuditActionKey
  title: string
  impact: ConfirmFlowProps["impact"]
  reason: ConfirmFlowProps["reason"]
  consequence: ConfirmFlowProps["consequence"]
  typeToConfirm: ConfirmFlowProps["typeToConfirm"]
  typedValue: string
  onTypedChange: (value: string) => void
  expiry: ConfirmFlowProps["expiry"]
  confirmLabel: string
  destructive: boolean
  isPending: boolean
  result: Result | null
  reasonValue: string
  onReasonChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  closeControl: ReactNode
  titleId: string
  descriptionId: string
}

function FlowBody({
  action,
  title,
  impact,
  reason,
  consequence,
  typeToConfirm,
  typedValue,
  onTypedChange,
  expiry,
  confirmLabel,
  destructive,
  isPending,
  result,
  reasonValue,
  onReasonChange,
  onSubmit,
  closeControl,
  titleId,
  descriptionId,
}: FlowBodyProps) {
  const reasonId = `${titleId}-reason`
  const reasonHintId = `${reasonId}-hint`
  const expiryId = `${titleId}-expiry`
  const reasonRequired = AUDIT_ACTIONS[action].reasonRequired
  const reasonConfig =
    reason ??
    (reasonRequired
      ? {
          required: true,
          label: "Reason",
          hint: "Explain why this change is needed.",
        }
      : undefined)
  const typedId = `${titleId}-typed`
  const typedHintId = `${typedId}-hint`
  const typedMatches = !typeToConfirm || typedValue.trim() === typeToConfirm.word
  const canConfirm = (!reasonRequired || Boolean(reasonValue.trim())) && typedMatches

  return (
    <form
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onSubmit}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex flex-col gap-(--s-1) px-(--s-5) pb-(--s-3) pt-(--s-5)">
          <h2 className="text-section text-[color:var(--ink)]" id={titleId}>
            {title}
          </h2>
          <p className="text-body text-[color:var(--muted)]" id={descriptionId}>
            Review exactly what will change before you confirm.
          </p>
        </div>

        <div className="flex flex-col gap-(--s-4) px-(--s-5) pb-(--s-4)">
          {isGroupedImpact(impact) ? (
            impact.map((group) => (
              <section className="flex flex-col gap-(--s-2)" key={group.title}>
                <Overline as="h3">{group.title}</Overline>
                <ImpactList rows={group.rows} />
                {group.note ? (
                  <p className="m-0 text-badge font-normal leading-(--t-body-lh) text-[color:var(--muted)]">
                    {group.note}
                  </p>
                ) : null}
              </section>
            ))
          ) : (
            <ImpactList rows={impact} />
          )}

          {consequence ? (
            /* Amber ground, hairline border on all four sides, no edge stripe: the tone says
               "weigh this", and the border stays the same rule the impact list uses. */
            <p
              className="m-0 rounded-(--r-card) border border-[var(--line)] bg-[var(--warning-wash)] p-(--s-3) text-badge font-normal leading-(--t-body-lh) text-[color:var(--warning-body)]"
              data-slot="confirm-flow-consequence"
            >
              {consequence}
            </p>
          ) : null}

          {reasonConfig ? (
            <div className="flex flex-col gap-(--s-2)">
              <Label className="text-[length:var(--t-body)] leading-(--t-body-lh) font-medium tracking-(--t-body-tr) text-[color:var(--ink)]" htmlFor={reasonId}>
                {reasonConfig.label}
                {!reasonRequired ? (
                  <span className="font-normal text-[color:var(--faint)]"> (optional)</span>
                ) : null}
              </Label>
              <p className="text-badge font-normal leading-(--t-body-lh) text-[color:var(--muted)]" id={reasonHintId}>
                {reasonConfig.hint}
              </p>
              <Textarea
                aria-describedby={reasonHintId}
                aria-invalid={reasonRequired && !reasonValue.trim()}
                disabled={isPending || Boolean(result?.ok)}
                id={reasonId}
                onChange={(event) => onReasonChange(event.currentTarget.value)}
                required={reasonRequired}
                value={reasonValue}
              />
            </div>
          ) : null}

          {typeToConfirm ? (
            <div className="flex flex-col gap-(--s-2)">
              <Label className="text-[length:var(--t-body)] leading-(--t-body-lh) font-medium tracking-(--t-body-tr) text-[color:var(--ink)]" htmlFor={typedId}>
                {typeToConfirm.label}
              </Label>
              <p className="text-badge font-normal leading-(--t-body-lh) text-[color:var(--muted)]" id={typedHintId}>
                {typeToConfirm.hint}
              </p>
              <Input
                aria-describedby={typedHintId}
                aria-invalid={!typedMatches}
                autoComplete="off"
                disabled={isPending || Boolean(result?.ok)}
                id={typedId}
                onChange={(event) => onTypedChange(event.currentTarget.value)}
                value={typedValue}
              />
            </div>
          ) : null}

          {expiry ? (
            <div className="flex flex-col gap-(--s-2)">
              <Label className="text-[length:var(--t-body)] leading-(--t-body-lh) font-medium tracking-(--t-body-tr) text-[color:var(--ink)]" htmlFor={expiryId}>
                {expiry.label}
              </Label>
              <Input
                disabled={isPending || Boolean(result?.ok)}
                id={expiryId}
                onChange={(event) =>
                  expiry.onChange(event.currentTarget.value || null)
                }
                type="date"
                value={expiry.value ?? ""}
              />
            </div>
          ) : null}

          {result?.ok ? (
            <LoggedReceipt
              actionKey={result.receipt.actionKey}
              auditId={result.receipt.auditId}
            />
          ) : null}

          {result && !result.ok ? (
            <div
              aria-live="assertive"
              className="flex items-start gap-(--s-2) rounded-(--r-card) bg-[var(--critical-wash)] p-(--s-3) text-badge font-normal leading-(--t-body-lh) text-[color:var(--critical)]"
              role="alert"
            >
              <CircleX aria-hidden className="mt-(--s-1) size-(--s-4) shrink-0" />
              <p>
                {result.message}{" "}
                {result.partial
                  ? "Some steps completed before it stopped. The record shows what ran."
                  : "Nothing changed."}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-end gap-(--s-2) border-t border-[var(--line)] px-(--s-5) py-(--s-3)">
        {closeControl}
        {!result?.ok ? (
          <LoggedButton
            actionKey={action}
            aria-busy={isPending}
            disabled={isPending || !canConfirm}
            type="submit"
            variant={destructive ? "danger" : "primary"}
          >
            {isPending ? pendingLabel(confirmLabel) : confirmLabel}
          </LoggedButton>
        ) : null}
      </div>
    </form>
  )
}

export function ConfirmFlow(props: ConfirmFlowProps) {
  const scopeKey = `${props.action}:${props.open ? "open" : "closed"}`

  return <ConfirmFlowInstance key={scopeKey} {...props} />
}

function ConfirmFlowInstance({
  open,
  onOpenChange,
  action,
  title,
  impact,
  reason,
  consequence,
  typeToConfirm,
  expiry,
  confirmLabel,
  destructive = false,
  onConfirm,
}: ConfirmFlowProps) {
  const [reasonValue, setReasonValue] = useState("")
  const [typedValue, setTypedValue] = useState("")
  const [result, setResult] = useState<Result | null>(null)
  const [isPending, startTransition] = useTransition()
  const baseId = useId()
  const titleId = `${baseId}-title`
  const descriptionId = `${baseId}-description`
  const reasonRequired = AUDIT_ACTIONS[action].reasonRequired

  if (
    process.env.NODE_ENV === "development" &&
    reason &&
    reason.required !== reasonRequired
  ) {
    throw new Error(
      `ConfirmFlow reason requirement does not match the audit registry for ${action}`
    )
  }

  function requestOpenChange(nextOpen: boolean) {
    if (isPending) return

    onOpenChange(nextOpen)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const normalizedReason = reasonValue.trim()
    if (reasonRequired && !normalizedReason) return
    if (typeToConfirm && typedValue.trim() !== typeToConfirm.word) return

    startTransition(async () => {
      try {
        const nextResult = await onConfirm({
          ...(reason || reasonRequired
            ? { reason: normalizedReason || undefined }
            : {}),
          ...(expiry ? { expiry: expiry.value } : {}),
        })
        setResult(nextResult)
      } catch {
        setResult({
          ok: false,
          message: "We could not complete this action.",
        })
      }
    })
  }

  const closeButton = (
    <Button
      disabled={isPending}
      onClick={() => requestOpenChange(false)}
      type="button"
      variant="outline"
    >
      {result?.ok ? "Done" : "Cancel"}
    </Button>
  )

  const bodyProps = {
    action,
    title,
    impact,
    reason,
    consequence,
    typeToConfirm,
    typedValue,
    onTypedChange: setTypedValue,
    expiry,
    confirmLabel,
    destructive,
    isPending,
    result,
    reasonValue,
    onReasonChange: setReasonValue,
    onSubmit: submit,
    titleId,
    descriptionId,
  }

  if (destructive) {
    return (
      <AlertDialog open={open} onOpenChange={requestOpenChange}>
        <AlertDialogContent
          className="flex max-h-[calc(100dvh-var(--s-8))] w-[calc(100%-var(--s-8))] max-w-[calc(var(--drawer-w)+var(--s-10))] flex-col gap-0 overflow-hidden rounded-(--r-panel) border border-[var(--line)] bg-[var(--raised)] p-0 shadow-(--shadow-modal) duration-(--modal-open-dur) ease-(--modal-ease) motion-reduce:animate-none motion-reduce:transition-none"
        >
          <AlertDialogHeader className="sr-only">
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>
              Review exactly what will change before you confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FlowBody
            {...bodyProps}
            closeControl={
              <AlertDialogCancel disabled={isPending} variant="outline">
                {result?.ok ? "Done" : "Cancel"}
              </AlertDialogCancel>
            }
          />
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  return (
    <Sheet open={open} onOpenChange={requestOpenChange}>
      <SheetContent
        className="w-full max-w-(--drawer-w) gap-0 border-[var(--line)] bg-[var(--raised)] p-0 shadow-(--shadow-drawer) transition-[transform,opacity] duration-(--duration-fast) ease-(--ease-out) motion-reduce:transition-none sm:max-w-(--drawer-w)"
        showCloseButton={!isPending}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            Review exactly what will change before you confirm.
          </SheetDescription>
        </SheetHeader>
        <FlowBody {...bodyProps} closeControl={closeButton} />
      </SheetContent>
    </Sheet>
  )
}
