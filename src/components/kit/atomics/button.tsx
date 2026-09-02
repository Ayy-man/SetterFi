"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { kitButtonClass } from "@/components/kit/atomics/button-class";

export type { KitButtonSize, KitButtonVariant } from "@/components/kit/atomics/button-class";
export { kitButtonClass } from "@/components/kit/atomics/button-class";
import type { KitButtonSize, KitButtonVariant } from "@/components/kit/atomics/button-class";

export type KitButtonProps = {
  variant?: KitButtonVariant;
  size?: KitButtonSize;
  /** A glyph before the label. Decorative: the label is the accessible name. */
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * The button set. Press feedback is the one motion the whole product shares, and it collapses
 * under `prefers-reduced-motion` like everything else.
 */
export function KitButton({
  children,
  className,
  leading,
  size = "md",
  trailing,
  type = "button",
  variant = "secondary",
  ...rest
}: KitButtonProps) {
  return (
    <button
      className={kitButtonClass({ className, size, variant })}
      data-size={size}
      data-slot="kit-button"
      data-variant={variant}
      type={type}
      {...rest}
    >
      {leading ? (
        <span aria-hidden="true" className="inline-flex shrink-0 items-center">
          {leading}
        </span>
      ) : null}
      {children}
      {trailing ? (
        <span aria-hidden="true" className="inline-flex shrink-0 items-center">
          {trailing}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The dashed add affordance: a tag input's "add", a slot grid's empty cell. Deliberately not a
 * `KitButton` variant -- it is shaped like the thing it would create, not like a control.
 */
export function AddChipButton({
  children = "add",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex items-center rounded-[7px] border border-dashed border-[var(--accent-edge)] bg-[var(--accent-wash)] px-[9px] py-[4px] text-[12px] text-[color:var(--accent-text)] transition-colors duration-[var(--duration-quick)] hover:bg-[var(--accent-wash-strong)] motion-reduce:transition-none",
        className,
      )}
      data-slot="add-chip-button"
      type="button"
      {...rest}
    >
      {children}
    </button>
  );
}
