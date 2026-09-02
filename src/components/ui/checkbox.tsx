"use client"

import { Check } from "@/components/kit/icons";

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"

import { cn } from "@/lib/utils"

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // The box fills first, then the mark draws itself into it -- two beats, not one snap.
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors duration-[var(--check-box)] ease-[var(--check-ease)] motion-reduce:transition-none outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary dark:data-checked:bg-primary",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        // The tick is stroked on, not faded in. Lucide's check path is a two-segment polyline
        // roughly 26 user units long, so dashing the stroke at that length and running the offset
        // to zero draws it left to right the way a hand would. `--kit-check-length` is set here
        // rather than baked into the keyframe so a different mark only has to restate its length.
        // The draw starts after the box has filled, hence the delay on --check-box.
        className="grid place-content-center text-current [&>svg]:size-3.5 [&>svg>path]:[stroke-dasharray:var(--kit-check-length)] [&>svg>path]:[animation:kit-check-draw_var(--check-draw)_var(--check-ease)_var(--check-box)_both] motion-reduce:[&>svg>path]:animate-none"
        style={{ "--kit-check-length": "26" } as React.CSSProperties}
      >
        <Check />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
