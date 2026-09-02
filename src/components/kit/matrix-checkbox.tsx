"use client";

import { Lock } from "@/components/kit/icons";

import { useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export type MatrixCheckboxProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The destination or capability this column is: "Bell", "Email", "Slack". */
  columnLabel: string;
  /** The record this row is: the rule name, the client name. */
  rowLabel: string;
  /**
   * Repeat the column name beside the box. Off in a table, where the column header already says
   * it and repeating it prints the same word once per row; on in a list with no header row.
   */
  showColumnLabel?: boolean;
  /** The value is fixed by policy. Renders a lock, not just a dimmed box. */
  locked?: boolean;
  /** What the lock means, e.g. "Required notice". Shown to screen readers, and as a tooltip. */
  lockedReason?: string;
  disabled?: boolean;
  /** Rendered beside the box while a write is in flight. */
  busy?: boolean;
  className?: string;
};

/**
 * One cell of a checkbox matrix.
 *
 * The accessible name is always the full "column for row" phrase, built from a hidden span, so a
 * screen reader hears "Email for Appointment booked" while the screen shows a bare box under a
 * column header. Printing that phrase -- or even the column word -- next to all 96 boxes is the
 * densest redundancy in the product.
 *
 * A locked cell gets a lock glyph. Disabled styling alone renders a locked-on box and a
 * disabled-off box almost identically, which is the one distinction the reader actually needs.
 */
export function MatrixCheckbox({
  busy = false,
  checked,
  className,
  columnLabel,
  disabled = false,
  locked = false,
  lockedReason,
  onCheckedChange,
  rowLabel,
  showColumnLabel = false,
}: MatrixCheckboxProps) {
  const id = useId();
  const nameId = `${id}-name`;

  return (
    <label
      className={cn(
        "inline-flex min-h-[var(--s-8)] w-fit cursor-pointer items-center gap-[var(--s-2)] rounded-[var(--r-control)] px-[var(--s-2)] text-[length:var(--t-body)] font-medium text-[var(--body)] hover:bg-[var(--row-hover)] has-[:disabled]:cursor-not-allowed",
        className,
      )}
      data-slot="matrix-checkbox"
      htmlFor={id}
      onClick={(event) => event.stopPropagation()}
    >
      <Checkbox
        aria-labelledby={nameId}
        checked={checked}
        className="shrink-0"
        disabled={locked || disabled}
        id={id}
        onCheckedChange={(nextChecked) => onCheckedChange(Boolean(nextChecked))}
      />
      {showColumnLabel ? <span>{columnLabel}</span> : null}
      <span className="sr-only" id={nameId}>{`${columnLabel} for ${rowLabel}`}</span>
      {locked ? (
        <span
          className="inline-flex items-center text-[var(--muted)]"
          data-slot="matrix-checkbox-lock"
          title={lockedReason}
        >
          <Lock aria-hidden className="size-[var(--s-3)]" />
          <span className="sr-only">{lockedReason ? `Locked: ${lockedReason}` : "Locked"}</span>
        </span>
      ) : null}
      {busy ? <span className="text-[var(--muted)]">Saving</span> : null}
    </label>
  );
}
