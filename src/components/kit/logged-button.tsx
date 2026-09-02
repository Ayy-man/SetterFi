"use client"

import { Check, ShieldCheck } from "@/components/kit/icons";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react"

import { Button } from "@/components/ui/button"
import {
  AUDIT_ACTIONS,
  type AuditActionKey,
} from "@/lib/audit/actions"
import { cn } from "@/lib/utils"

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost"

export type LoggedButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "variant" | "onClick"
> & {
  actionKey: AuditActionKey
  children: ReactNode
  variant?: ButtonVariant
  /**
   * Return a promise and the button reports on it: it goes busy while the action is in flight and
   * marks itself done when it resolves. Return nothing and the button behaves exactly as before.
   */
  onClick?: () => void | Promise<unknown>
  /** Classes for the button + caption wrapper, e.g. `items-end` in a right-aligned action row. */
  wrapperClassName?: string
  /**
   * Draws the button at the coach surface's control size instead of the console's.
   *
   * Opt-in, and it has to be: this component renders on both sides of the product. The console's
   * own control height is a different scale on purpose -- 30-34px for a team who are in it all day
   * with a mouse -- and four of the twelve call sites are admin surfaces, so a default that moved
   * everything would resize the console to fix a coach page.
   *
   * **What went wrong without it.** `Button` sets no height at all, so on a coach surface it fell
   * to `coach.css`'s 44px target floor -- the floor being a minimum that nothing had raised, not a
   * size anybody chose. `Billing.dc.html` draws 48px eight times and it is the only control height
   * on that screen, and `COACH_ACTION_CLASS` in `coach-billing.tsx` is already `h-[48px]`. So the
   * drawing and the page's own dominant control agreed on 48 and the odd one out was the button
   * that had never specified a height, which put two control heights two rows apart.
   *
   * **Why there are two values and not one.** The artboard draws two recipes at that one height,
   * four times each, and the split is not decorative. `"coach"` is the ordinary page action --
   * `padding: 0 24px`, `font-size: 16px` at `Billing.dc.html:119`, `:120` and `:182` ("Change your
   * plan", "Update your card", "This looks wrong") -- and it is the same recipe
   * `COACH_ACTION_CLASS` already spells out for the non-logged controls beside it, so a logged
   * button in an action row now lines up with its neighbours instead of being 4px wider inside.
   * `"coach-verb"` is the attendance answer pair at `:160-161` and `:170-171`, `padding: 0 28px`
   * at `font-size: 17px`: a two-button question the coach answers about one appointment, drawn
   * heavier than the page's other actions because it is the one thing on that row asking for a
   * reply. Flattening both to one recipe would be tidying the drawing rather than following it.
   *
   * Both clear the 44px floor, so nothing about the pressable target changes.
   */
  scale?: "coach" | "coach-verb"
}

/** The coach control recipes. See `scale` above for why each number is the number it is. */
const COACH_SCALE_CLASS = {
  coach: "h-[48px] rounded-[9px] px-[24px] text-[16px] leading-none",
  "coach-verb": "h-[48px] rounded-[9px] px-[28px] text-[17px] leading-none",
} as const satisfies Record<NonNullable<LoggedButtonProps["scale"]>, string>

const variants = {
  primary: "default",
  secondary: "secondary",
  danger: "destructive",
  ghost: "ghost",
} as const satisfies Record<
  ButtonVariant,
  NonNullable<ComponentProps<typeof Button>["variant"]>
>

/** How long the check stays up before the label comes back. */
const DONE_HOLD_MS = 1_400

/**
 * A button plus its audit caption. The caption sits under the button, never inside it: shipped
 * inside the label it read as part of the action ("Publish to all agents PUBLISH LOGGED"), which
 * is both a worse button name for a screen reader and a shout on the product's most privileged
 * control. The button says what it does; the line under it says what gets recorded.
 *
 * When the handler is async, the button also answers. A privileged action is exactly where a
 * reader needs to know the thing actually happened, and a toast that appears in the corner is a
 * long way from the control they just pressed. So the label steps aside and a check draws itself
 * in its place -- but only once the promise has resolved, never on the click. A check that
 * appears on press is a lie about work that has not been done yet.
 *
 * The label stays in the DOM at zero opacity while the check is up, so the button keeps its width
 * and nothing in the action row shifts.
 */
export function LoggedButton({
  actionKey,
  children,
  className,
  disabled,
  onClick,
  scale,
  wrapperClassName,
  variant = "secondary",
  ...props
}: LoggedButtonProps) {
  const accountability = AUDIT_ACTIONS[actionKey]
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const handleClick = useCallback(() => {
    const result = onClick?.()
    // A synchronous handler gets no reporting: there is nothing to wait for, and flashing a check
    // for work that was already done by the time the click returned is just decoration.
    if (!result || typeof (result as PromiseLike<unknown>).then !== "function") return

    setPhase("busy")
    void Promise.resolve(result)
      .then(() => {
        if (!alive.current) return
        setPhase("done")
        timer.current = setTimeout(() => {
          if (alive.current) setPhase("idle")
        }, DONE_HOLD_MS)
      })
      .catch(() => {
        // The failure is the caller's to report -- a toast, an inline error. All this button owes
        // is to stop claiming to be busy.
        if (alive.current) setPhase("idle")
      })
  }, [onClick])

  const done = phase === "done"

  return (
    <span
      className={cn("inline-flex min-w-0 flex-col items-start gap-(--s-1)", wrapperClassName)}
      data-slot="logged-button"
    >
      <Button
        className={cn("relative", scale && COACH_SCALE_CLASS[scale], className)}
        data-phase={phase}
        disabled={disabled || phase === "busy"}
        onClick={handleClick}
        variant={variants[variant]}
        {...props}
      >
        <span
          className={cn(
            "inline-flex items-center gap-1.5 transition-[opacity,filter] duration-[var(--duration-quick)] ease-[var(--ease-in-out)] motion-reduce:transition-none",
            done && "opacity-0 blur-[var(--blur-small)]",
          )}
        >
          {children}
        </span>
        {done ? (
          <span
            className="absolute inset-0 grid place-content-center"
            data-slot="logged-button-done"
          >
            <Check
              aria-hidden
              className="[&>path]:[stroke-dasharray:var(--kit-check-length)] [&>path]:[animation:kit-check-draw_var(--check-draw)_var(--check-ease)_both] motion-reduce:[&>path]:animate-none"
              style={{ "--kit-check-length": "26" } as CSSProperties}
            />
            <span className="sr-only">Done</span>
          </span>
        ) : null}
      </Button>
      <span
        aria-label={accountability.ariaLabel}
        className="text-over inline-flex items-center gap-(--s-1) [color:var(--muted)]"
        data-slot="logged-button-caption"
      >
        <ShieldCheck aria-hidden className="size-(--s-3)" />
        {accountability.microcopy}
      </span>
    </span>
  )
}
