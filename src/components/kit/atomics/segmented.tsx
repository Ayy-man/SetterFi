"use client";

import type { ReactNode } from "react";

import { TONE_LINE, TONE_TEXT, TONE_WASH, type Tone } from "@/components/kit/atomics/tone";
import { cn } from "@/lib/utils";

export type SegmentOption = {
  key: string;
  label: ReactNode;
  /** Rendered after the label in the segment's own tone. "Needs attention 8" is one segment. */
  count?: ReactNode;
  /**
   * A tone lifts a single segment out of the neutral set: 1c's "Needs attention 8" carries the
   * amber wash even while unselected, because the count is the reason the tab exists.
   */
  tone?: Tone;
};

export type SegmentedProps = {
  options: readonly SegmentOption[];
  value: string;
  onValueChange: (next: string) => void;
  label: string;
  /** `mono` is the period switch (7D / 14D / 30D / 90D); `sans` is a view switch. */
  face?: "sans" | "mono";
  /** Segments share the width equally. The 3a agent-list filter does this in a 266px column. */
  fill?: boolean;
  /**
   * Which surface's density this control is rendering at, because the two are drawn differently
   * and the difference is not a preference.
   *
   * `console` is the eight admin artboards: a 12px pill in a 3px well, sized to sit beside a
   * 13.5px table. `coach` is `Main.dc.html:114-118`: 16px/500 labels in 44px pills, a 4px well
   * and 9px corners, because the coach surface's floor is 14px and its minimum target is 44px.
   * A shared atomic with one size cannot serve both, and the console's 12px is correct where it
   * is -- so the scale is a prop rather than a number somebody edits in place.
   */
  scale?: "console" | "coach";
  className?: string;
};

/**
 * The two densities, held as a table so the difference between them is readable in one place
 * rather than spread across five ternaries in the JSX.
 *
 * `label` carries the size, and it is the only thing `coach-shared-type-floor.test.ts` reads out
 * of this file: that guard asserts the coach arm is at or above 14px and the console arm below
 * it, so neither row can drift into the other without saying so.
 */
const SCALE = {
  console: {
    well: "gap-[2px] rounded-[9px] p-[3px]",
    segment: "rounded-[7px] px-[11px] py-[5px]",
    label: "text-[12px]",
    labelSans: "text-[12.5px]",
    count: "text-[11px]",
    resting: "",
    active: "font-[500]",
  },
  coach: {
    well: "gap-[4px] rounded-[12px] p-[4px]",
    segment: "h-[44px] rounded-[9px] px-[18px]",
    label: "text-[16px]",
    labelSans: "text-[16px]",
    count: "text-[14px]",
    resting: "font-[500]",
    active: "font-[600]",
  },
} as const;

/**
 * The segmented control as the artifact draws it: an outer well holding pills, the active pill a
 * plain white wash at 9%.
 *
 * This is a different object from `@/components/kit/segmented-control`, which draws one bordered
 * box with hairline dividers and belongs to the pre-redesign surfaces. Both exist on purpose and
 * neither should be edited into the other; this one is what the eight admin screens transcribe.
 *
 * The active segment is never the accent. A period switch is not the page's live action, and
 * spending the accent on it would use up the one fill a page gets on a thing nobody clicked.
 */
export function Segmented({
  className,
  face = "sans",
  fill,
  label,
  onValueChange,
  options,
  scale = "console",
  value,
}: SegmentedProps) {
  const density = SCALE[scale];
  return (
    <div
      aria-label={label}
      className={cn(
        "inline-flex max-w-full overflow-x-auto border border-[var(--line)] bg-[var(--control-fill)]",
        density.well,
        fill && "w-full",
        className,
      )}
      data-slot="segmented"
      role="group"
    >
      {options.map((option) => {
        const active = option.key === value;
        const tone = option.tone ?? "neutral";
        return (
          <button
            aria-pressed={active}
            className={cn(
              "inline-flex shrink-0 items-center justify-center gap-[6px] whitespace-nowrap transition-colors duration-[var(--duration-quick)] motion-reduce:transition-none",
              density.segment,
              fill && "flex-1",
              face === "mono"
                ? cn("mono font-[500] tabular-nums", density.label)
                : density.labelSans,
              active
                ? cn("bg-[var(--band)] text-[color:var(--ink)]", density.active)
                : cn("text-[color:var(--muted)] hover:text-[color:var(--ink)]", density.resting),
            )}
            data-active={active ? "true" : undefined}
            data-segment={option.key}
            data-slot="segmented-option"
            data-tone={tone}
            key={option.key}
            onClick={() => onValueChange(option.key)}
            style={
              tone === "neutral"
                ? undefined
                : {
                    background: TONE_WASH[tone],
                    border: `1px solid ${TONE_LINE[tone]}`,
                    color: TONE_TEXT[tone],
                  }
            }
            type="button"
          >
            <span>{option.label}</span>
            {option.count !== undefined ? (
              <span
                className={cn("mono font-[500] tabular-nums", density.count)}
                data-slot="segmented-count"
                style={{ color: tone === "neutral" ? "var(--faint)" : TONE_TEXT[tone] }}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export type UnderlineTab = { key: string; label: ReactNode };

/**
 * 3a's section tabs: an underline in `--accent-bright` under the active label, no pill and no
 * fill. A page that already has a Publish button cannot also spend a fill on its tab strip, and
 * the underline is what lets seven tabs sit in a row without becoming seven buttons.
 */
export function UnderlineTabs({
  className,
  label,
  onValueChange,
  tabs,
  value,
}: {
  className?: string;
  label: string;
  onValueChange: (next: string) => void;
  tabs: readonly UnderlineTab[];
  value: string;
}) {
  return (
    <div
      aria-label={label}
      className={cn(
        "flex gap-[20px] overflow-x-auto border-b border-[var(--line)]",
        className,
      )}
      data-slot="underline-tabs"
      role="tablist"
    >
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            aria-selected={active}
            className={cn(
              "shrink-0 pb-[11px] text-[13.5px] whitespace-nowrap transition-colors duration-[var(--duration-quick)] motion-reduce:transition-none",
              active
                ? "font-[600] text-[color:var(--ink)] [box-shadow:0_2px_0_var(--accent-bright)]"
                : "text-[color:var(--muted)] hover:text-[color:var(--body)]",
            )}
            data-active={active ? "true" : undefined}
            data-slot="underline-tab"
            data-tab={tab.key}
            key={tab.key}
            onClick={() => onValueChange(tab.key)}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
