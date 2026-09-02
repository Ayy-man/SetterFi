"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type FormSaveBarProps = {
  /** Nothing to save reads as a quiet bar with both controls disabled, never as a hidden one. */
  dirty: boolean;
  saving?: boolean;
  /**
   * Return `false`, or a promise that resolves `false` or rejects, and the bar shakes: the save
   * was refused and the reader is looking at the button they just pressed, not at the field that
   * is wrong. Return anything else and nothing happens.
   */
  onSave: () => void | boolean | Promise<unknown>;
  onDiscard?: () => void;
  saveLabel?: string;
  discardLabel?: string;
  /** Audit microcopy, e.g. AUDIT_ACTIONS[...].microcopy. Shown next to the controls. */
  logged?: string;
  /** Anything else the bar should say: a validation summary, a last-saved time. */
  children?: ReactNode;
  className?: string;
};

/** Kept in step with `--shake-dur` in `tokens.css`; the class is cleared once the shake is over. */
const SHAKE_MS = 400;

/**
 * The sticky save bar for a settings section. It stays at the bottom of the section card so the
 * reader never scrolls a long form to find out whether their edit took.
 */
export function FormSaveBar({
  children,
  className,
  discardLabel = "Discard",
  dirty,
  logged,
  onDiscard,
  onSave,
  saveLabel = "Save changes",
  saving = false,
}: FormSaveBarProps) {
  // Two refused saves in a row have to replay the shake, and re-adding a class that is already
  // there restarts nothing. The fix is React's version of the remove-reflow-re-add: drop the class,
  // let a frame paint without it, then put it back. Remounting the bar with a `key` would also
  // work and is shorter, but it would tear down the button the reader just pressed and drop their
  // focus to the document -- on the exact interaction where they most need to stay where they are.
  const [shaking, setShaking] = useState(false);
  const alive = useRef(true);
  const frame = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const refuse = useCallback(() => {
    if (!alive.current) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (timer.current) clearTimeout(timer.current);
    setShaking(false);
    frame.current = requestAnimationFrame(() => {
      if (!alive.current) return;
      setShaking(true);
      timer.current = setTimeout(() => {
        if (alive.current) setShaking(false);
      }, SHAKE_MS);
    });
  }, []);

  const handleSave = useCallback(() => {
    let result: void | boolean | Promise<unknown>;
    try {
      result = onSave();
    } catch {
      refuse();
      return;
    }
    if (result === false) {
      refuse();
      return;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).then(
        (settled) => {
          if (settled === false) refuse();
        },
        () => refuse(),
      );
    }
  }, [onSave, refuse]);

  return (
    <div
      className={cn(
        // Pinned to the bottom of the settings card it belongs to, so it is that card's own
        // material: on --raised it was a lighter stripe inside a --card section, reading as a
        // separate floating thing when it is part of the form above it. The top rule is the
        // separation; the bar is not over your work, it is the bottom of it.
        "sticky bottom-0 z-[var(--z-sticky)] flex flex-wrap items-center justify-between gap-[var(--s-3)] border-t border-[var(--line)] bg-[var(--card)] px-[var(--s-4)] py-[var(--s-3)]",
        // The shake is a rejection, so it is short and it decays -- a long wobble reads as the
        // interface being unwell rather than the input being wrong.
        shaking &&
          "[animation:kit-shake_var(--shake-dur)_var(--ease-out)_both] motion-reduce:animate-none",
        className,
      )}
      data-dirty={dirty ? "" : undefined}
      data-refused={shaking ? "" : undefined}
      data-slot="form-save-bar"
    >
      <div className="flex min-w-0 flex-col gap-[var(--s-1)] text-[length:var(--t-body)] text-[var(--muted)]">
        {children}
        {logged ? (
          <span className="text-[length:var(--t-badge)] text-[var(--faint)]" data-slot="form-save-bar-logged">
            {logged}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-[var(--s-2)]">
        {onDiscard ? (
          <Button
            disabled={!dirty || saving}
            onClick={onDiscard}
            size="sm"
            type="button"
            variant="outline"
          >
            {discardLabel}
          </Button>
        ) : null}
        <Button disabled={!dirty || saving} onClick={handleSave} type="button">
          {saving ? "Saving…" : saveLabel}
        </Button>
      </div>
    </div>
  );
}
