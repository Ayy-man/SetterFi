"use client";

import { useId } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";

import type { Tone } from "@/components/kit/atomics/tone";
import { indicatorTransition } from "@/components/kit/motion";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type ViewDef = {
  key: string;
  label: string;
  count?: number;
  /**
   * Lifts one view out of the neutral set. The coach inbox spends it on "Waiting on you", which is
   * the amber pill `Inbox.dc.html` draws and the only view on that bar that means work.
   */
  tone?: Tone;
};

export type ViewSwitchProps = {
  views: readonly ViewDef[];
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel?: string;
};

export function ViewSwitch({
  views,
  value,
  onValueChange,
  ariaLabel = "Views",
}: ViewSwitchProps) {
  // One id per instance: two switches on the same page must not share an indicator, or the rule
  // flies across the screen between them when either one changes.
  const groupId = useId();
  const reduced = useReducedMotion();

  return (
    <LayoutGroup id={groupId}>
      <ToggleGroup
        aria-label={ariaLabel}
        className="max-w-full gap-[calc(var(--s-1)/2)] overflow-x-auto rounded-none [border-bottom-width:calc(var(--s-1)/4)] border-[var(--line)]"
        multiple={false}
        value={value ? [value] : []}
        onValueChange={(next) => {
          const selected = next.at(-1);
          if (selected) {
            onValueChange(selected);
          }
        }}
      >
        {views.map((view) => {
          const active = view.key === value;
          return (
            <ToggleGroupItem
              key={view.key}
              aria-label={view.label}
              // The pressed underline is no longer a border on the item: one shared rule travels
              // between items instead, so switching views reads as the same rule moving rather
              // than one line blinking out and another blinking in.
              className="relative mb-[calc(var(--s-1)/-4)] h-[calc(var(--s-8)+var(--s-1))] min-w-0 shrink-0 gap-[calc(var(--s-1)+var(--s-1)/2)] rounded-none border-0 bg-transparent px-[calc(var(--s-2)+var(--s-1)/2)] [font-size:var(--t-body)] font-medium [line-height:var(--t-body-lh)] [letter-spacing:var(--t-body-tr)] [color:var(--muted)] shadow-none transition-colors duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:transition-none hover:bg-transparent hover:[color:var(--ink)] focus-visible:rounded-[var(--r-control)] aria-pressed:bg-transparent aria-pressed:[color:var(--ink)]"
              value={view.key}
            >
              <span className="relative z-10">{view.label}</span>
              {view.count !== undefined ? (
                <span
                  aria-hidden="true"
                  className="tabular relative z-10 rounded-[var(--r-full)] bg-[var(--quiet)] px-[calc(var(--s-1)+var(--s-1)/2)] py-[calc(var(--s-1)/4)] [font-size:calc((var(--t-over)+var(--t-badge))/2)] [font-weight:var(--t-badge-w)] [line-height:var(--t-badge-lh)] [letter-spacing:var(--t-badge-tr)] [color:var(--faint)] transition-colors duration-[var(--duration-quick)] motion-reduce:transition-none group-aria-pressed/toggle:bg-[var(--line)] group-aria-pressed/toggle:[color:var(--ink)]"
                >
                  {view.count}
                </span>
              ) : null}
              {active ? (
                <motion.span
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-[calc(var(--s-1)/2)] bg-[var(--ink)]"
                  layoutId="view-switch-rule"
                  transition={indicatorTransition(reduced)}
                />
              ) : null}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </LayoutGroup>
  );
}
