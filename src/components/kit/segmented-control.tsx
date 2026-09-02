"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type Segment = {
  key: string;
  label: string;
  /** Rendered faint in mono after the label. Decorative: the label alone is the accessible name. */
  count?: number;
  /** Drawn before the label. Decorative: the label alone is the accessible name. */
  icon?: ReactNode;
};

export type SegmentedControlProps = {
  segments: readonly Segment[];
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel?: string;
  className?: string;
  /**
   * `coach` is the portal density: 16px labels on a 44px target, which is the floor `coach.css`
   * puts under every other control a coach touches. The console keeps its own compact row.
   */
  scale?: "console" | "coach";
};

/**
 * A bordered segmented control: one hairline box, hairline dividers between the segments, and the
 * active segment carrying a quiet fill at weight 500. There is deliberately no accent rule and no
 * coloured edge stripe on it: the fill and the weight are the whole signal, because a coloured
 * left-edge accent is the pattern the client rejected outright.
 *
 * It is the saved-view switch on a list toolbar ("All · Mine · Needs attention"), which is a
 * different question from the filters: the segment picks the saved set of rows, the chips below
 * narrow whatever set the segment chose.
 */
export function SegmentedControl({
  ariaLabel = "Views",
  className,
  onValueChange,
  scale = "console",
  segments,
  value,
}: SegmentedControlProps) {
  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "inline-flex min-w-0 max-w-full items-stretch overflow-x-auto rounded-[var(--r-input)] [border-width:calc(var(--s-1)/4)] border-[var(--line)] bg-[var(--card)]",
        className,
      )}
      data-slot="segmented-control"
      role="group"
    >
      {segments.map((segment, index) => {
        const active = segment.key === value;
        return (
          <button
            aria-label={segment.label}
            aria-pressed={active}
            className={cn(
              "relative inline-flex shrink-0 items-center gap-[calc(var(--s-1)+var(--s-1)/2)] whitespace-nowrap bg-transparent px-[calc(var(--s-2)+var(--s-1)/2)] [font-size:var(--t-body)] [line-height:var(--t-body-lh)] [color:var(--muted)] transition-colors duration-[var(--duration-quick)] ease-[var(--ease-out)] first:rounded-l-[calc(var(--r-input)-var(--s-1)/4)] last:rounded-r-[calc(var(--r-input)-var(--s-1)/4)] hover:[color:var(--ink)] motion-reduce:transition-none",
              scale === "coach"
                ? "h-[44px] px-[var(--s-4)] [font-size:16px]"
                : "h-[calc(var(--s-8)-var(--s-1)/2)]",
              // The hairline divider between segments, never on the outer edges.
              index > 0 && "[border-left-width:calc(var(--s-1)/4)] border-[var(--line)]",
              active
                ? "bg-[var(--quiet)] [font-weight:500] [color:var(--ink)]"
                : "[font-weight:var(--t-body-w)]",
            )}
            data-active={active ? "" : undefined}
            data-segment={segment.key}
            key={segment.key}
            onClick={() => onValueChange(segment.key)}
            type="button"
          >
            {segment.icon ? (
              <span aria-hidden="true" className="inline-flex shrink-0 items-center">
                {segment.icon}
              </span>
            ) : null}
            <span>{segment.label}</span>
            {segment.count !== undefined ? (
              <span
                aria-hidden="true"
                className="[font-family:var(--font-mono)] [font-size:var(--t-mono-crumb)] [font-weight:var(--t-mono-crumb-w)] [line-height:var(--t-mono-crumb-lh)] [color:var(--faint)] tabular-nums"
                data-slot="segmented-control-count"
              >
                {segment.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
