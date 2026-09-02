import type { ReactNode } from "react";

import { IconTile } from "@/components/kit/atomics/icon-tile";
import { StatusDot } from "@/components/kit/atomics/status";
import { TONE_LINE, TONE_ROW_TINT, TONE_TEXT, type Tone } from "@/components/kit/atomics/tone";
import { cn } from "@/lib/utils";

export type QueueItemProps = {
  title: ReactNode;
  /** Who and what: "Reid Funding Group · Closer agent · 38 leads waiting". */
  context: ReactNode;
  /**
   * The clock, in mono: "41m over", "4h 10m", "2d". Never a percentage and never a predicted
   * date -- a queue that guesses when something will clear is making a promise nobody can keep.
   */
  clock?: ReactNode;
  tone?: Tone;
  /** Row actions, rendered only on the item that is actually actionable. */
  actions?: ReactNode;
  /**
   * A cleared item stays in the list for the rest of the session, struck through and dimmed, so
   * the reader can see what they just did rather than watching rows vanish under the cursor.
   */
  cleared?: boolean;
  className?: string;
};

/**
 * One row of the attention queue (2a).
 *
 * The leading mark is an icon tile holding a status dot rather than an icon, because in a triage
 * list the only thing the leading mark has to say is how bad it is. It is the same tile the rest
 * of the system uses, so the queue lines up with the KPI strip above it.
 */
export function QueueItem({
  actions,
  className,
  cleared,
  clock,
  context,
  title,
  tone = "neutral",
}: QueueItemProps) {
  return (
    <div
      className={cn(
        "@container flex gap-[12px] border-b border-[var(--line-soft)] px-[14px] py-[12px] last:border-b-0",
        cleared && "opacity-55",
        className,
      )}
      data-cleared={cleared ? "true" : undefined}
      data-slot="queue-item"
      data-tone={tone}
      style={{ background: cleared ? undefined : TONE_ROW_TINT[tone] }}
    >
      <IconTile className="mt-[2px]" size="xs" tone={tone}>
        <StatusDot size={6} tone={tone} />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="mb-[4px] flex flex-wrap items-baseline gap-x-[var(--s-2)] gap-y-[2px]">
          <span
            className={cn(
              "min-w-0 text-[13.5px] leading-[1.3] font-[600] text-[color:var(--ink)]",
              cleared && "line-through decoration-[var(--faint)]",
            )}
            data-slot="queue-item-title"
          >
            {title}
          </span>
          {clock !== undefined ? (
            <span
              className="mono ml-auto shrink-0 text-[11.5px] font-[500] tabular-nums"
              data-slot="queue-item-clock"
              style={{ color: tone === "neutral" ? "var(--muted)" : TONE_TEXT[tone] }}
            >
              {clock}
            </span>
          ) : null}
        </div>
        <div className="text-[12px] leading-[1.45] text-[color:var(--muted)]" data-slot="queue-item-context">
          {context}
        </div>
        {actions ? (
          <div className="mt-[var(--s-2)] flex flex-wrap gap-[7px]" data-slot="queue-item-actions">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export type NoteStripProps = {
  /** The sentence. Rich text is fine: 3a bolds "The Brain v18" inside it. */
  children: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  /** A single trailing link. One, never a row of buttons: this is a note, not a toolbar. */
  action?: ReactNode;
  className?: string;
};

/**
 * The inline note: 3a's "9 of 14 settings come from The Brain v18."
 *
 * It is a wash and a hairline with no shadow at all, which is what keeps it below the cards it
 * sits above. A note that took a card's elevation would read as the most important thing on the
 * page, and this one exists to explain the page rather than to be it.
 */
export function NoteStrip({ action, children, className, icon, tone = "accent" }: NoteStripProps) {
  return (
    <div
      className={cn(
        "@container flex flex-col gap-[var(--s-2)] rounded-[11px] border px-[15px] py-[11px]",
        "@min-[420px]:flex-row @min-[420px]:items-center @min-[420px]:gap-[12px]",
        className,
      )}
      data-slot="note-strip"
      data-tone={tone}
      style={{
        background: `color-mix(in oklab, ${TONE_TEXT[tone]} 6%, transparent)`,
        borderColor: TONE_LINE[tone],
      }}
    >
      {icon ? (
        <IconTile size="xs" tone={tone}>
          {icon}
        </IconTile>
      ) : null}
      <p className="m-0 min-w-0 text-[12.5px] leading-[1.5] text-[color:var(--body)] text-pretty">
        {children}
      </p>
      {action ? <div className="shrink-0 @min-[420px]:ml-auto">{action}</div> : null}
    </div>
  );
}
