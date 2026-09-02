"use client"

import { Check, ChevronDown, ChevronUp } from "@/components/kit/icons";

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"

import { cn } from "@/lib/utils"

export type SelectOption<Value extends string = string> = {
  value: Value
  label: string
  disabled?: boolean
}

export type SelectProps<Value extends string = string> = {
  options: readonly SelectOption<Value>[]
  value?: Value | null
  defaultValue?: Value | null
  onValueChange?: (value: Value) => void
  name?: string
  label: string
  srOnly?: boolean
  placeholder?: string
  disabled?: boolean
  required?: boolean
  id?: string
  className?: string
}

const selectTriggerClassName =
  "flex min-h-9 w-full items-center justify-between gap-2 rounded-[var(--r-control)] border border-[var(--line)] bg-[var(--card)] px-2.5 py-2 text-left text-xs text-[var(--ink)] outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-popup-open:border-[var(--focus-ring)] focus-visible:border-[var(--focus-ring)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"

const selectLabelClassName =
  "text-over text-[var(--muted)]"

export const selectPopupClassName =
  "z-50 max-h-72 min-w-[var(--anchor-width)] overflow-y-auto overscroll-contain rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] p-1 text-[var(--ink)] shadow-[var(--shadow-raised)] outline-none duration-[var(--duration-quick)] ease-[var(--ease-out)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[var(--dropdown-pre-scale)] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[var(--dropdown-closing-scale)] motion-reduce:animate-none motion-reduce:transition-none"

export const selectItemClassName =
  "relative flex w-full cursor-default items-center gap-2 rounded-[var(--r-control)] px-2.5 py-1.5 text-xs leading-5 outline-none select-none data-highlighted:bg-[color-mix(in_oklch,var(--card),var(--muted)_12%)] data-disabled:pointer-events-none data-disabled:opacity-50"

export const selectItemTextClassName = "min-w-0 flex-1 truncate text-left whitespace-nowrap"

export const selectItemIndicatorClassName =
  "order-last shrink-0 text-[var(--focus-ring)]"

function OptionsSelect<Value extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  label,
  srOnly = false,
  placeholder,
  disabled,
  required,
  id,
  className,
}: SelectProps<Value>) {
  const generatedId = React.useId()
  const rootId = id ?? `sf-select-${generatedId}`
  const labelId = `${rootId}-label`
  const [triggerElement, setTriggerElement] = React.useState<HTMLElement | null>(null)
  // Base UI's FloatingPortal treats an explicit null container as "wait for a container" and
  // never mounts the popup, so fall back to undefined (document.body) outside the agent shell.
  const portalContainer = React.useMemo(
    () => triggerElement?.closest<HTMLElement>(".agent-shell") ?? undefined,
    [triggerElement]
  )

  return (
    <SelectPrimitive.Root
      id={rootId}
      items={options as readonly { value: string; label: string }[]}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => onValueChange?.((next ?? "") as Value)}
      name={name}
      disabled={disabled}
      required={required}
    >
      <div data-slot="select-field" className={cn("grid gap-1.5", className)}>
        <SelectPrimitive.Label
          data-slot="select-label"
          render={<span />}
          className={srOnly ? "sr-only" : selectLabelClassName}
        >
          {label}
        </SelectPrimitive.Label>
        <SelectPrimitive.Trigger
          data-slot="select-trigger"
          ref={setTriggerElement}
          aria-labelledby={labelId}
          className={selectTriggerClassName}
        >
          <SelectPrimitive.Value
            data-slot="select-value"
            className="min-w-0 flex-1 truncate text-left"
            placeholder={placeholder}
          />
          <SelectPrimitive.Icon
            data-slot="select-icon"
            className="shrink-0 text-[var(--muted)]"
          >
            <ChevronDown className="size-3.5" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
      </div>
      <SelectPrimitive.Portal container={portalContainer}>
        <SelectPrimitive.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50">
          <SelectPrimitive.Popup data-slot="select-popup" className={selectPopupClassName}>
            <SelectPrimitive.List data-slot="select-list">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  data-slot="select-item"
                  className={selectItemClassName}
                >
                  <SelectPrimitive.ItemText
                    data-slot="select-item-text"
                    className={selectItemTextClassName}
                  >
                    {option.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator
                    data-slot="select-item-indicator"
                    className={selectItemIndicatorClassName}
                  >
                    <Check className="size-3.5" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/**
 * The label to draw on the trigger for a given selected value, or `undefined` for "nothing here
 * resolves that".
 */
type SelectLabelLookup = (value: unknown) => React.ReactNode | undefined

/**
 * The labels of the `<SelectItem>`s a composed `<Select>` was given, keyed by their value.
 *
 * Null only outside a `<Select>`, which is the one case where this file has nothing to resolve
 * against and `SelectValue` leaves Base UI to its own behaviour.
 */
const SelectLabelsContext = React.createContext<SelectLabelLookup | null>(null)

/** Values Base UI compares by identity and this file can key a plain map on. */
function labelKey(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : null
}

/**
 * Every `<SelectItem>` in a subtree, as value to label.
 *
 * It walks the JSX rather than the DOM on purpose: the popup is portalled and mounts only once it
 * has been opened, so anything reading rendered items would have nothing to resolve against on
 * first paint -- which is exactly when the trigger has to say who is selected. Elements are
 * matched on `SelectItem` by identity, so an item wrapped in a fragment, a `.map()`, or a
 * conditional is found and something merely shaped like one is not.
 *
 * The label is kept as the ReactNode the caller wrote instead of being flattened to text, so an
 * item drawn with an icon beside its name reaches the trigger as it was authored.
 */
function collectItemLabels(
  node: React.ReactNode,
  into: Map<string, React.ReactNode> = new Map()
): Map<string, React.ReactNode> {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return
    const props = child.props as { value?: unknown; children?: React.ReactNode }
    if (child.type === SelectItem) {
      const key = labelKey(props.value)
      // An item with no label of its own is left unregistered rather than registered as blank:
      // resolving to nothing and resolving to an empty string are different states on screen.
      if (key !== null && props.children != null) into.set(key, props.children)
      return
    }
    collectItemLabels(props.children, into)
  })
  return into
}

/**
 * The composed API -- `<Select>` around a trigger, a value and hand-written items.
 *
 * **This is where the raw-id defect lived.** Base UI resolves the trigger's text from the `items`
 * prop on the root, not from the `<Select.Item>`s in the tree, and with no `items` its
 * `resolveSelectedLabel` falls through to `String(value)`. So six call sites bound to an id or an
 * enum key printed that key at a reader: a success owner's UUID in the client drawer, a
 * billable-event UUID under "Which booked call" to a coach, `provider_asserted`, `tenant_specific`,
 * `one_time`.
 *
 * The items are derived from the children the caller already wrote, so no call site has to
 * remember to pass them and the seventh cannot reintroduce the defect by forgetting. An explicit
 * `items` prop still wins -- a caller who has the data already should not have it inferred.
 */
function ComposedSelect(
  props: SelectPrimitive.Root.Props<unknown, boolean | undefined> & { options?: never }
) {
  const { children, items, ...rest } = props
  const derived = React.useMemo(
    () => (items === undefined ? collectItemLabels(children) : null),
    [children, items]
  )
  const lookup = React.useMemo<SelectLabelLookup>(() => {
    return (value) => {
      const key = labelKey(value)
      if (key === null) return undefined
      if (derived) return derived.get(key)
      if (Array.isArray(items)) {
        return items.find((item) => labelKey((item as { value?: unknown }).value) === key)
          ?.label as React.ReactNode | undefined
      }
      if (items && typeof items === "object") {
        return (items as Record<string, React.ReactNode>)[key]
      }
      return undefined
    }
  }, [derived, items])

  const rootItems = React.useMemo(
    () => (derived ? Object.fromEntries(derived) : items),
    [derived, items]
  )

  return (
    <SelectLabelsContext.Provider value={lookup}>
      <SelectPrimitive.Root items={rootItems} {...rest}>
        {children}
      </SelectPrimitive.Root>
    </SelectLabelsContext.Provider>
  )
}

function Select<Value extends string>(
  props: SelectProps<Value>
): React.JSX.Element
function Select<Value, Multiple extends boolean | undefined = false>(
  props: SelectPrimitive.Root.Props<Value, Multiple> & { options?: never }
): React.JSX.Element
function Select(
  props:
    | SelectProps
    | (SelectPrimitive.Root.Props<unknown, boolean | undefined> & {
        options?: never
      })
) {
  if ("options" in props) {
    return <OptionsSelect {...(props as SelectProps)} />
  }

  return <ComposedSelect {...props} />
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  )
}

/**
 * What the trigger says is selected -- a label, or the placeholder, and never the stored value.
 *
 * Deriving the items on the root (see `ComposedSelect`) is most of the fix, but it leaves one way
 * back to the defect: a value with no matching item, which Base UI still renders as `String(value)`.
 * That is not a hypothetical -- it is a select whose options arrive after its value does, or a
 * stored id whose row has since gone. So the resolution happens here as well, and a value this
 * component cannot name falls back to the placeholder. A reader being asked to choose again is a
 * visible, fixable state; a UUID on screen is neither.
 *
 * A caller who passes their own `children` is formatting the value deliberately and is left alone.
 * Outside a `<Select>` there is nothing to resolve against, so Base UI keeps its own behaviour;
 * `select.test.ts` pins that no surface in the tree reaches the primitive directly, which is what
 * keeps that branch unreachable in this codebase.
 */
function SelectValue({
  className,
  children,
  placeholder,
  ...props
}: SelectPrimitive.Value.Props) {
  const lookup = React.useContext(SelectLabelsContext)

  if (children != null || lookup === null) {
    return (
      <SelectPrimitive.Value
        data-slot="select-value"
        className={cn("flex flex-1 text-left", className)}
        placeholder={placeholder}
        {...props}
      >
        {children}
      </SelectPrimitive.Value>
    )
  }

  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    >
      {(value: unknown) => resolveSelectedLabel(value, lookup, placeholder)}
    </SelectPrimitive.Value>
  )
}

function resolveSelectedLabel(
  value: unknown,
  lookup: SelectLabelLookup,
  placeholder: React.ReactNode
): React.ReactNode {
  if (Array.isArray(value)) {
    const labels = value.map(lookup).filter((label) => label != null)
    if (labels.length === 0) return placeholder ?? null
    return labels.map((label, index) => (
      <React.Fragment key={index}>
        {index > 0 ? ", " : null}
        {label}
      </React.Fragment>
    ))
  }
  // An empty string is "nothing chosen" at every call site in this tree -- several of them
  // normalise null to "" for a controlled input -- so it takes the placeholder rather than
  // rendering as a blank trigger.
  if (value == null || value === "") return placeholder ?? null
  return lookup(value) ?? placeholder ?? null
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDown className="pointer-events-none size-4 text-muted-foreground" />
        }
      />
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn("relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 data-open:duration-[var(--dropdown-open-dur)] data-closed:duration-[var(--dropdown-close-dur)] ease-[var(--ease-smooth-out)] data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[var(--dropdown-pre-scale)] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[var(--dropdown-closing-scale)]", className )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <Check className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronUp
      />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronDown
      />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
