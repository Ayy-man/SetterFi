import type { HTMLAttributes, ReactNode } from "react";

import {
  TONE_LINE,
  TONE_MARK,
  TONE_TEXT,
  TONE_WASH,
  toneGlow,
  type Tone,
} from "@/components/kit/atomics/tone";
import { cn } from "@/lib/utils";

export type StatusDotProps = {
  tone: Tone;
  /** 5px inside a pill, 6px beside bare text. Both are the artifact's own sizes. */
  size?: 5 | 6;
  /**
   * Off unless asked for. `TONE_GLOWS` says which tones are *allowed* a halo, not which ones take
   * one, so a dot only glows where a screen deliberately spends its one glow on it. See
   * `src/app/glow-budget.test.ts`, which pins the single spender.
   */
  glow?: boolean;
  className?: string;
};

/**
 * The dot alone. Always `aria-hidden`: the label beside it is the accessible name, because a
 * distinction is never carried by hue by itself.
 */
export function StatusDot({ className, glow, size = 5, tone }: StatusDotProps) {
  const halo = glow === true ? toneGlow(tone) : undefined;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0 rounded-[var(--r-full)]", className)}
      data-glow={halo ? "true" : undefined}
      data-slot="status-dot"
      data-tone={tone}
      style={{ background: TONE_MARK[tone], boxShadow: halo, height: size, width: size }}
    />
  );
}

export type StatusProps = {
  tone: Tone;
  /** The state in words. Never omit it: the dot is decoration, this is the status. */
  label: ReactNode;
  /**
   * `pill` is the tinted lozenge -- wash, hairline, dot, label -- and belongs in a card or a
   * cell that has room. `bare` is the dot plus coloured text with no chrome at all, and belongs in
   * a dense table where a column of lozenges would out-weigh the rows.
   *
   * One treatment per list. The artifact never mixes them in a single column, and a list that does
   * reads as two different kinds of status.
   */
  treatment?: "pill" | "bare";
  /** Trailing mono detail inside the same pill: "Open 2d", "retry 2 of 4". */
  detail?: ReactNode;
  glow?: boolean;
  dot?: boolean;
  className?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "color">;

/**
 * The two status treatments, which is the whole status vocabulary for the admin wave.
 *
 * There is deliberately no third. Every drawn screen uses one of these two, and the eight admin
 * lanes reusing them is the difference between a design system and eight
 * status pills that almost match.
 *
 * An absence is not a status. A cell with nothing to report renders an em-rule in `--faint`, not a
 * neutral pill saying "none" -- a pill for an absence is a state the reader has to weigh against
 * the real ones. Use `StatusAbsent` for that.
 */
export function Status({
  className,
  detail,
  dot = true,
  glow,
  label,
  style,
  tone,
  treatment = "pill",
  ...rest
}: StatusProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center whitespace-nowrap",
        treatment === "pill"
          ? "gap-[6px] rounded-[var(--r-full)] border py-[3px] pr-[9px] pl-[7px] text-[11.5px] leading-[1.35] font-[500]"
          : "gap-[7px] text-[12.5px] leading-[1.35] font-[400]",
        className,
      )}
      data-slot="status"
      data-tone={tone}
      data-treatment={treatment}
      style={{
        color: TONE_TEXT[tone],
        ...(treatment === "pill"
          ? { background: TONE_WASH[tone], borderColor: TONE_LINE[tone] }
          : null),
        ...style,
      }}
      {...rest}
    >
      {dot ? <StatusDot glow={glow} size={treatment === "pill" ? 5 : 6} tone={tone} /> : null}
      <span className="min-w-0 truncate" data-slot="status-label">
        {label}
      </span>
      {detail ? (
        <span
          className="mono shrink-0 text-[11px] tabular-nums opacity-80"
          data-slot="status-detail"
        >
          {detail}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The cell that has nothing to report. An em-rule in `--faint`, with a screen-reader word behind
 * it so the row still says something out loud.
 */
export function StatusAbsent({
  className,
  label = "Nothing to report",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center text-[11.5px] text-[color:var(--faint)]", className)}
      data-slot="status-absent"
    >
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
