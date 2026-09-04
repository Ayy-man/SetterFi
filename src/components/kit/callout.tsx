import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A callout is a solid, bordered card that says one thing about a state -- a channel is live, a
 * registration is still with the carrier, a payout failed.
 *
 * Two rules are baked into the shape rather than left to the caller:
 *
 *  1. **No coloured edge.** No left stripe, no tinted rail, no border-side accent of any kind.
 *     The border is the same hairline on all four sides in every tone; the tone is carried by a
 *     single small dot before the title. The client rejected edge bars by name, and a component
 *     that can be told to grow one is a component that eventually does.
 *  2. **Day counts only.** The right-hand slot takes `day`, a whole number, and prints "day 11".
 *     There is no prop for a percentage and no prop for a predicted finish date, because A2P
 *     registration genuinely takes two to three weeks per coach and neither of those numbers can
 *     be honestly produced. A caller who wants to claim progress has to change this file.
 */

export type CalloutTone = "good" | "warning" | "critical";

export type CalloutProps = {
  /** Carried by the dot alone. `warning` is the provisioning tone: waiting, not broken. */
  tone: CalloutTone;
  title: string;
  /** One muted sentence. Say what is true and what, if anything, the reader does about it. */
  body: ReactNode;
  /**
   * Whole days elapsed, rendered as "day 11" in the right-hand mono slot. Days only: no
   * percentage, no predicted date. Omit it when nothing is being waited on.
   */
  day?: number;
  className?: string;
};

/** The dot is the only place tone reaches. Never the border, never the background. */
const DOT_TONE_CLASSES = {
  good: "bg-[var(--good)]",
  warning: "bg-[var(--warning)]",
  critical: "bg-[var(--critical)]",
} as const satisfies Record<CalloutTone, string>;

export function Callout({ body, className, day, title, tone }: CalloutProps): ReactElement {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-start gap-[var(--s-3)] rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] p-[var(--d-card-p)]",
        className,
      )}
      data-slot="callout"
      data-tone={tone}
    >
      <div className="min-w-0 flex-1">
        <p
          className="m-0 flex items-center gap-[var(--s-2)] text-[12.5px] leading-[1.3] font-semibold text-[var(--ink)]"
          data-slot="callout-title"
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-[var(--s-2)] shrink-0 rounded-[var(--r-full)]",
              DOT_TONE_CLASSES[tone],
            )}
            data-slot="callout-dot"
          />
          <span className="min-w-0">{title}</span>
        </p>
        <p className="t-muted m-0 mt-[var(--s-1)] max-w-[var(--measure-prose)]">{body}</p>
      </div>
      {day === undefined ? null : (
        <span
          className="t-mono-meta shrink-0 self-start tabular-nums"
          data-slot="callout-day"
        >
          day {day}
        </span>
      )}
    </div>
  );
}
