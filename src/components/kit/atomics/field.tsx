"use client";

import type { InputHTMLAttributes, ReactNode } from "react";

import { useFieldControl } from "@/components/kit/field";
import { cn } from "@/lib/utils";

/**
 * The input shell.
 *
 * The artifact draws a focused input as an accent border plus a 3px teal tint ring, and that tint
 * is what makes a focused field read lit against the navy card. It is not, on its own, a legible
 * focus indicator: at `--accent-wash-strong` the ring is far under the 3:1 that WCAG 2.4.11 asks
 * of one. So both happen. The shell paints the artifact's tint on `:focus-within`, and the real
 * `<input>` inside keeps the product's global `:focus-visible` outline at `--focus-ring`, which is
 * `--accent-bright` at 0.6 and does the accessibility work. Removing the outline to "clean up" the
 * doubling would leave a keyboard user with a 14%-alpha wash as their only cue.
 */
export function FieldShell({
  children,
  className,
  invalid,
  ...rest
}: { children?: ReactNode; invalid?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex h-[34px] min-w-0 items-center gap-[9px] rounded-[9px] border bg-[var(--control-fill)] px-[11px] transition-[border-color,box-shadow] duration-[var(--duration-quick)] motion-reduce:transition-none",
        invalid
          ? "border-[var(--failure-line)] bg-[color-mix(in_oklab,var(--failure)_6%,transparent)]"
          : "border-[var(--line-input)]",
        "focus-within:border-[var(--accent-edge)] focus-within:[box-shadow:0_0_0_3px_var(--accent-wash-strong)]",
        className,
      )}
      data-invalid={invalid ? "true" : undefined}
      data-slot="field-shell"
      {...rest}
    >
      {children}
    </div>
  );
}

export type KitInputProps = {
  leading?: ReactNode;
  trailing?: ReactNode;
  invalid?: boolean;
  shellClassName?: string;
} & InputHTMLAttributes<HTMLInputElement>;

export function KitInput({
  className,
  invalid,
  leading,
  shellClassName,
  trailing,
  ...rest
}: KitInputProps) {
  /*
   * A `Field` in a server component cannot clone this element to stamp the id and aria wiring onto
   * it -- children that cross the RSC boundary are not recognisable as elements up there -- so it
   * publishes that wiring on a context instead and this reads it back down here. It returns
   * `undefined` in every other case (no field, or a field that already cloned), and anything the
   * caller passed explicitly wins, so this is inert unless the boundary case is actually in play.
   */
  const field = useFieldControl();

  return (
    <FieldShell className={shellClassName} invalid={invalid}>
      {leading ? (
        <span aria-hidden="true" className="inline-flex shrink-0 items-center text-[color:var(--glyph)]">
          {leading}
        </span>
      ) : null}
      <input
        aria-invalid={invalid || undefined}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-[13px] text-[color:var(--ink)] placeholder:text-[color:var(--faint)]",
          className,
        )}
        data-slot="kit-input"
        {...field}
        {...rest}
      />
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </FieldShell>
  );
}

/**
 * The caret a select and a combobox share. Two triangles rather than a chevron, which is how the
 * artifact distinguishes "pick one of a list" from "this row expands".
 */
export function SelectCaret({ tone = "var(--muted)" }: { tone?: string }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 flex-col gap-[2px]" data-slot="select-caret">
      <span
        style={{
          borderBottom: `4px solid ${tone}`,
          borderLeft: "3.5px solid transparent",
          borderRight: "3.5px solid transparent",
        }}
      />
      <span
        style={{
          borderLeft: "3.5px solid transparent",
          borderRight: "3.5px solid transparent",
          borderTop: `4px solid ${tone}`,
        }}
      />
    </span>
  );
}

/**
 * The select as the artifact draws it: the current value stated in the box, the caret at the end.
 * `needsValue` is the 3b "Needs a value" row -- clay border and clay placeholder text, because a
 * setting that blocks publish has to say so where it is, not only in a summary at the bottom of
 * the page.
 */
export function SelectShell({
  className,
  needsValue,
  value,
  width = 150,
  ...rest
}: {
  needsValue?: boolean;
  value: ReactNode;
  width?: number | string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "flex h-[33px] items-center justify-between gap-[var(--s-2)] rounded-[9px] border px-[11px] text-[13px] transition-[border-color] duration-[var(--duration-quick)] motion-reduce:transition-none",
        needsValue
          ? "border-[var(--failure-line)] bg-[color-mix(in_oklab,var(--failure)_6%,transparent)] text-[color:var(--failure-body)]"
          : "border-[var(--line-input)] bg-[var(--control-fill)] text-[color:var(--body)] hover:border-[var(--accent-edge)]",
        className,
      )}
      data-needs-value={needsValue ? "true" : undefined}
      data-slot="select-shell"
      style={{ width }}
      type="button"
      {...rest}
    >
      <span className="min-w-0 truncate">{value}</span>
      <SelectCaret tone={needsValue ? "var(--failure)" : "var(--muted)"} />
    </button>
  );
}

/**
 * The neutral chip: a tag the coach has entered, a filter that is not on. Truncates rather than
 * wraps, because a tag row that reflows on every keystroke is a moving target.
 */
export function Chip({
  children,
  className,
  onRemove,
  selected,
  ...rest
}: {
  children?: ReactNode;
  onRemove?: () => void;
  selected?: boolean;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[240px] items-center gap-[6px] rounded-[7px] border px-[9px] py-[4px] text-[12px]",
        selected
          ? "border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[color:var(--accent-text)]"
          : "border-[var(--line-input)] bg-[var(--control-fill)] text-[color:var(--body)]",
        className,
      )}
      data-selected={selected ? "true" : undefined}
      data-slot="chip"
      {...rest}
    >
      <span className="min-w-0 truncate">{children}</span>
      {onRemove ? (
        <button
          aria-label={`Remove ${typeof children === "string" ? children : "tag"}`}
          className="shrink-0 text-[color:var(--faint)] hover:text-[color:var(--ink)]"
          onClick={onRemove}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </span>
  );
}

/**
 * The toggle. Off is a well with a dim knob; on is the accent gradient. There is no third state:
 * a setting that is not the coach's to change is stated as a sentence, never as a disabled
 * toggle -- a disabled toggle reads as broken, a settled decision reads as decided.
 */
export function KitToggle({
  checked,
  className,
  label,
  onCheckedChange,
  ...rest
}: {
  checked: boolean;
  label: string;
  onCheckedChange?: (next: boolean) => void;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange">) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        "relative inline-flex h-[23px] w-[40px] shrink-0 items-center rounded-[var(--r-full)] border transition-colors duration-[var(--duration-quick)] motion-reduce:transition-none",
        checked
          ? "border-[var(--accent-line)] [background:var(--accent-fill)]"
          : "border-[var(--line-input)] bg-[var(--well)]",
        className,
      )}
      data-slot="kit-toggle"
      data-state={checked ? "on" : "off"}
      onClick={() => onCheckedChange?.(!checked)}
      role="switch"
      type="button"
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[2.5px] size-[17px] rounded-[var(--r-full)] transition-[left] duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)] motion-reduce:transition-none",
          checked ? "left-[20.5px] bg-[var(--on-accent)]" : "left-[2.5px] bg-[var(--glyph)]",
        )}
      />
    </button>
  );
}

/**
 * The slider's readout box: a mono figure in its own well beside the track. It is a separate
 * component because the value has to stay mono and tabular while the track resizes, and a caller
 * dropping a `<span>` there loses both.
 */
export function ValueReadout({
  children,
  className,
  width = 54,
}: {
  children?: ReactNode;
  className?: string;
  width?: number;
}) {
  return (
    <span
      className={cn(
        "mono inline-flex h-[33px] shrink-0 items-center justify-center rounded-[9px] border border-[var(--line-input)] bg-[var(--control-fill)] text-[13.5px] font-[500] tabular-nums text-[color:var(--ink)]",
        className,
      )}
      data-slot="value-readout"
      style={{ width }}
    >
      {children}
    </span>
  );
}
