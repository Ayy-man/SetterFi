import { Check } from "@/components/kit/icons";


import { DayCounter } from "@/components/kit/day-counter"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { workspaceDateFormat } from "@/lib/format/datetime"

export type DataStateAction = {
  label: string
  onClick?: () => void
  href?: string
}

export type JourneyStep = {
  key: string
  title: string
  owner: "you" | "setterfi" | "carrier" | "meta"
  state: "done" | "current" | "waiting" | "blocked"
  body: string
  receipt?: { label: string; at: string }
  action?: DataStateAction
  wait?: { since: string; typicalDays: [number, number] }
}

export type StepJourneyProps = {
  steps: readonly JourneyStep[]
  className?: string
}

type ReceiptBackedStep = JourneyStep & {
  state: "done"
  receipt: NonNullable<JourneyStep["receipt"]>
}

type ValidJourneyStep = ReceiptBackedStep | (JourneyStep & {
  state: Exclude<JourneyStep["state"], "done">
})

const OWNER_LABELS: Record<JourneyStep["owner"], string> = {
  carrier: "the carrier",
  meta: "Meta",
  setterfi: "SetterFi",
  you: "you",
}

function assertValidJourney(
  steps: readonly JourneyStep[],
): asserts steps is readonly ValidJourneyStep[] {
  const currentCount = steps.filter((step) => step.state === "current").length

  if (currentCount !== 1) {
    throw new TypeError("StepJourney requires exactly one current step")
  }

  const unprovenDoneStep = steps.find((step) => {
    if (step.state !== "done") {
      return false
    }

    const label = step.receipt?.label.trim()
    const receiptTimestamp = step.receipt ? new Date(step.receipt.at).getTime() : Number.NaN

    return !label || Number.isNaN(receiptTimestamp)
  })
  if (unprovenDoneStep) {
    throw new TypeError("A done journey step requires a valid provider receipt")
  }
}

function receiptTime(value: string) {
  return workspaceDateFormat.format(new Date(value))
}

/**
 * Which step, if any, gets the page's one accent fill.
 *
 * The Ownership Rule in docs/DESIGN.md says the accent marks what the coach set or can act on, and
 * neutral marks what SetterFi and the providers run. Current-ness is a position in a timeline, not
 * ownership, and on the A2P journey the two come apart: the carrier holds the current step for two
 * to three weeks while "Confirm consent page" -- the one control the coach can press -- sits
 * further down. Keying the fill to `state === "current"` filled the carrier's step, left the
 * coach's own action as an outline, and spent the page's fill on the only thing nobody can click.
 *
 * So the fill follows actionability. A step qualifies when the coach owns it, it is not already
 * done, and its action has somewhere to go -- a disabled action is a name for what is coming, not
 * a thing to press. The first qualifying step wins and the rest stay outlined, which is the One
 * Fill Rule: a journey with three things the coach could eventually do still lights exactly one,
 * the next one. A journey where the coach can do nothing right now lights nothing, which is the
 * correct resting state rather than an unfinished one.
 *
 * "Try again" is deliberately excluded. A retry is a recovery path, not the forward one, and
 * filling it would make a failed step the brightest thing on the page.
 */
function primaryActionKey(steps: readonly JourneyStep[]): string | null {
  const actionable = steps.find(
    (step) =>
      step.state !== "done" &&
      step.owner === "you" &&
      step.action !== undefined &&
      step.action.label !== "Try again" &&
      (step.action.href !== undefined || step.action.onClick !== undefined),
  )
  return actionable?.key ?? null
}

function JourneyAction({ action, primary }: { action: DataStateAction; primary: boolean }) {
  const variant = primary ? "default" : "outline"

  if (action.href) {
    return (
      <Button
        nativeButton={false}
        render={<a href={action.href} onClick={action.onClick} />}
        size="sm"
        variant={variant}
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
      variant={variant}
    >
      {action.label}
    </Button>
  )
}

function stepBadge(step: JourneyStep, previousTitle: string | null) {
  // Honest states: the badge names who is holding the step, never a bare "Current".
  if (step.state === "blocked") {
    /*
     * Blocked is a lifecycle state, so it takes the neutral lifecycle badge alongside the critical
     * dot on the marker, which is what the visual contract asks for. It used to name only what the
     * step is waiting behind, and the first blocked step in a journey has nothing in front of it,
     * so that step drew the dot and no badge at all: a red mark on the marker with nothing saying
     * what it meant. The word is the state; the previous step's title stays as the reason.
     */
    return {
      label: previousTitle
        ? `Blocked, after ${previousTitle.charAt(0).toLowerCase()}${previousTitle.slice(1)}`
        : "Blocked",
      tone: "neutral" as const,
      pulse: false,
    }
  }
  if (step.owner === "you") return { label: "Ready for you", tone: "neutral" as const, pulse: false }
  return {
    label: `Waiting on ${OWNER_LABELS[step.owner]}`,
    tone: "warning" as const,
    pulse: step.state === "current" || step.state === "waiting",
  }
}

function StepBadge({ step, previousTitle }: { step: JourneyStep; previousTitle: string | null }) {
  const badge = stepBadge(step, previousTitle)
  if (!badge) return null

  return (
    <span
      className="state-badge state-badge--lifecycle inline-flex min-h-[var(--s-6)] items-center gap-[var(--s-2)] rounded-[var(--r-input)] px-[var(--s-2)] text-body font-medium text-[var(--body)]"
      data-kind="lifecycle"
      data-slot="state-badge"
      data-tone={badge.tone}
    >
      <span
        aria-hidden="true"
        className={cn(
          "state-badge__indicator size-[var(--distance-small)] shrink-0 rounded-[var(--r-full)]",
          badge.tone === "warning" ? "bg-[var(--warning)]" : "bg-[var(--neutral)]",
          badge.pulse && "motion-safe:animate-pulse",
        )}
      />
      <span className="state-badge__label">{badge.label}</span>
    </span>
  )
}

export function StepJourney({ steps, className }: StepJourneyProps) {
  assertValidJourney(steps)
  const filledKey = primaryActionKey(steps)

  return (
    <ol aria-label="Setup journey" className={cn("journey flex flex-col", className)}>
      {steps.map((step, index) => {
        // Only the step being worked gets the larger title and the indent. Everything ahead of it
        // stays quiet, so the eye lands on the one thing that is actually happening.
        const emphasised = step.state === "current"
        const previousTitle = index > 0 ? steps[index - 1].title : null
        const formattedReceiptTime = step.state === "done" ? receiptTime(step.receipt.at) : null

        return (
          <li
            aria-current={step.state === "current" ? "step" : undefined}
            className="step relative grid grid-cols-[var(--s-6)_minmax(0,1fr)] gap-x-[var(--s-4)] pb-[var(--s-6)] last:pb-0"
            data-state={step.state}
            key={step.key}
          >
            <div aria-hidden="true" className="flex flex-col items-center">
              <span
                className={cn(
                  "step__dot relative z-10 grid size-[var(--s-6)] shrink-0 place-items-center rounded-[var(--r-full)] border bg-[var(--card)] text-badge tabular-nums",
                  step.state === "done"
                    ? "border-[var(--ink)] bg-[var(--ink)] text-[var(--canvas)]"
                    : step.state === "blocked"
                      ? "border-[var(--line-strong)] text-[var(--faint)]"
                      : "border-2 border-[var(--ink)] text-[var(--ink)]",
                )}
              >
                {step.state === "done" ? <Check className="size-[var(--s-3)]" /> : index + 1}
                {step.state === "blocked" ? (
                  <span className="absolute right-0 top-0 size-[var(--distance-small)] rounded-[var(--r-full)] bg-[var(--critical)] ring-2 ring-[var(--card)]" />
                ) : null}
              </span>
              {index < steps.length - 1 ? (
                <span className="grow border-l border-[var(--line)]" />
              ) : null}
            </div>

            <div
              className={cn(
                "step__body flex min-w-0 flex-col gap-[var(--distance-small)] pt-[var(--s-1)]",
                emphasised && "gap-[var(--s-2)] pl-[var(--s-2)] pt-0",
              )}
            >
              <h3
                className={cn(
                  // Explicit length/colour forms: a bare `text-section` next to `text-[var(--ink)]`
                  // reads as two font-size utilities to the class merger, and the size is dropped.
                  "step__title flex flex-wrap items-center gap-[var(--s-2)]",
                  emphasised
                    ? "text-[length:var(--t-section)] font-[var(--t-section-w)] leading-[var(--t-section-lh)] text-[color:var(--ink)]"
                    : "text-[length:var(--t-row)] font-[var(--t-row-w)] leading-[var(--t-row-lh)]",
                  emphasised
                    ? null
                    : step.state === "done"
                      ? "text-[color:var(--body)]"
                      : "text-[color:var(--muted)]",
                )}
              >
                {step.title}
                {step.state !== "done" ? <StepBadge previousTitle={previousTitle} step={step} /> : null}
              </h3>

              {step.state === "done" ? (
                /*
                 * `text-faint` was never a registered utility, so it emitted no CSS and the
                 * receipt line inherited 16px body type where the receipt role is the 12px badge.
                 * The colour utility beside it always worked, which is why it read as styled.
                 */
                <p className="step__receipt text-badge font-normal text-[var(--faint)]">
                  {step.receipt.label}
                  {formattedReceiptTime ? `, ${formattedReceiptTime}` : null}
                </p>
              ) : (
                <>
                  <p
                    className={cn(
                      "step__text max-w-[var(--measure-prose)] text-body",
                      emphasised ? "text-[var(--muted)]" : "text-[var(--faint)]",
                    )}
                  >
                    {step.body}
                  </p>
                  <p className="step__owner text-body text-[var(--muted)]">
                    Owner: {OWNER_LABELS[step.owner]}
                  </p>

                  {step.wait ? (
                    <DayCounter since={step.wait.since} typicalDays={step.wait.typicalDays} />
                  ) : null}

                  <div className="flex flex-wrap items-center gap-[var(--s-3)] pt-[var(--s-1)]">
                    {step.owner === "you" && step.action ? (
                      step.state === "current" || step.action.href || step.action.onClick ? (
                        <JourneyAction
                          action={step.action}
                          primary={step.key === filledKey}
                        />
                      ) : (
                        // Sequenced, not greyed-out primary: the action stays visible and named so
                        // the coach knows what is coming, with the step that unblocks it spelled out.
                        <span className="inline-flex items-center gap-[var(--s-2)]">
                          <Button
                            aria-disabled="true"
                            disabled
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            {step.action.label}
                          </Button>
                          {index > 0 ? (
                            <span className="step__next-note text-badge font-normal text-[var(--faint)]">
                              after step {index}
                            </span>
                          ) : null}
                        </span>
                      )
                    ) : null}
                    {step.owner !== "you" ? (
                      // `step__nothing` is a hook, not a style: every other line in this row has a
                      // `step__*` class that a caller can reach from outside, and this one did not,
                      // so `COACH_JOURNEY_SCALE` could lift the whole journey into the coach's
                      // sizes except this sentence, which stayed at the console's 13px on a surface
                      // whose floor is 16px. Naming it changes nothing here.
                      <span className="step__nothing text-body font-medium text-[var(--muted)]">
                        Nothing for you to do
                      </span>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
