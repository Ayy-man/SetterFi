"use client"

import type { ComponentProps } from "react"

import {
  Tooltip as BaseTooltip,
  TooltipContent as BaseTooltipContent,
  TooltipProvider as BaseTooltipProvider,
  TooltipTrigger as BaseTooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const TOOLTIP_INTENT_DELAY_MS = 400

function TooltipProvider({
  delay = TOOLTIP_INTENT_DELAY_MS,
  ...props
}: ComponentProps<typeof BaseTooltipProvider>) {
  return <BaseTooltipProvider delay={delay} {...props} />
}

function Tooltip(props: ComponentProps<typeof BaseTooltip>) {
  return (
    <TooltipProvider>
      <BaseTooltip {...props} />
    </TooltipProvider>
  )
}

function TooltipTrigger(props: ComponentProps<typeof BaseTooltipTrigger>) {
  return <BaseTooltipTrigger {...props} />
}

function TooltipContent({
  className,
  ...props
}: ComponentProps<typeof BaseTooltipContent>) {
  return (
    <BaseTooltipContent
      className={cn(
        "z-[var(--z-popover)] origin-(--transform-origin) rounded-[var(--r-input)]",
        "bg-[var(--ink)] px-[var(--s-2)] py-[var(--s-1)] text-badge text-[var(--canvas)]",
        "shadow-[var(--shadow-raised)] opacity-0 scale-[var(--tt-scale)]",
        "data-[state=delayed-open]:animate-none! data-open:animate-none! data-closed:animate-none!",
        "transition-[opacity,transform] [transition-duration:var(--tt-out-dur)] [transition-timing-function:var(--tt-out-ease)]",
        "data-open:opacity-100 data-open:scale-100 data-open:[transition-duration:var(--tt-in-dur)] data-open:[transition-timing-function:var(--tt-in-ease)]",
        "data-closed:opacity-0 data-closed:scale-[var(--tt-scale)]",
        "motion-reduce:transform-none motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
