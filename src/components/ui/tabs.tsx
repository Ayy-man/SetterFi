"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * The moving indicator: one element that travels to the active tab rather than a per-tab
 * underline that cross-fades. Base UI publishes the active tab's box as CSS variables
 * (`--active-tab-left`, `--active-tab-width`, and the vertical pair), so the travel is a plain
 * transition on `translate` and `width` -- no measuring in an effect, no layout thrash, and the
 * indicator is already in the right place on first paint because Base UI ships a prehydration
 * script that writes those variables before React runs.
 *
 * Two looks off one element: the `default` list gets a filled pill behind the tab, the `line`
 * list gets a rule under it. It renders nothing until Base UI knows which tab is active
 * (`renderBeforeHydration` is deliberately off), so nothing slides in from the left on load.
 */
function TabsIndicator({ className, ...props }: TabsPrimitive.Indicator.Props) {
  return (
    <TabsPrimitive.Indicator
      data-slot="tabs-indicator"
      className={cn(
        "absolute z-0 transition-[translate,width,height] duration-[var(--tabs-dur)] ease-[var(--ease-smooth-out)] motion-reduce:transition-none",
        // Horizontal: travel along x, take the active tab's width.
        "group-data-horizontal/tabs:top-0 group-data-horizontal/tabs:left-0 group-data-horizontal/tabs:h-full group-data-horizontal/tabs:w-[var(--active-tab-width)] group-data-horizontal/tabs:translate-x-[var(--active-tab-left)]",
        // Vertical: travel along y, take the active tab's height.
        "group-data-vertical/tabs:top-0 group-data-vertical/tabs:left-0 group-data-vertical/tabs:h-[var(--active-tab-height)] group-data-vertical/tabs:w-full group-data-vertical/tabs:translate-y-[var(--active-tab-top)]",
        // The pill, for the default list.
        "group-data-[variant=default]/tabs-list:rounded-md group-data-[variant=default]/tabs-list:bg-background group-data-[variant=default]/tabs-list:shadow-sm dark:group-data-[variant=default]/tabs-list:bg-input/30",
        // The rule, for the line list. Sits on the list's bottom edge, not the tab's.
        "group-data-[variant=line]/tabs-list:bg-foreground group-data-horizontal/tabs:group-data-[variant=line]/tabs-list:top-auto group-data-horizontal/tabs:group-data-[variant=line]/tabs-list:bottom-[-5px] group-data-horizontal/tabs:group-data-[variant=line]/tabs-list:h-0.5 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:left-auto group-data-vertical/tabs:group-data-[variant=line]/tabs-list:-right-1 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:w-0.5",
        className
      )}
      {...props}
    />
  )
}

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), "relative", className)}
      {...props}
    >
      <TabsIndicator />
      {children}
    </TabsPrimitive.List>
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        // `z-10` puts the label above the travelling indicator; the background and the underline
        // that used to live on the trigger have moved onto that indicator, so a tab now only
        // carries its own text colour. Only the colour transitions -- the geometry belongs to
        // the indicator, and a trigger animating its own width fights it.
        "relative z-10 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:transition-none group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "data-active:text-foreground dark:data-active:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, TabsIndicator, tabsListVariants }
