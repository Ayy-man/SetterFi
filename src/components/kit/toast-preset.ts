import type { ToasterProps } from "sonner";

/**
 * No "use client" here on purpose: the workspace layout is a server component and spreads this
 * object into <Toaster>. A client module's exports reach a server component as client references,
 * not values, so the preset lives in a directive-free module and kit/toast.ts re-exports it.
 */
export const TOAST_DURATION_MS = 6_000;

/**
 * The kit's Toaster configuration, in the kit rather than inline in a layout, so every surface
 * that mounts a Toaster gets the same toast: the same corner, the same six seconds, the same
 * token-driven close.
 *
 * The motion is deliberately split. The rise and the stack are sonner's -- it owns the toast's
 * transform and drives it from JS, and a second transform here would break the stack and the
 * swipe. The cross-blur that softens the arrival is a global rule on `[data-sonner-toast]` in
 * `globals.css`, because `filter` is the one animatable property sonner leaves alone. What is
 * left for this object is the timing: the toast leaves on `--toast-close`, faster than it came.
 *
 * Spread it into a `<Toaster>`; anything passed after it still wins.
 */
export const TOASTER_PRESET = {
  className: "[--gap:var(--s-2)] !z-[var(--z-toast)]",
  duration: TOAST_DURATION_MS,
  mobileOffset: "var(--s-4)",
  offset: "var(--s-6)",
  position: "bottom-right",
  toastOptions: {
    classNames: {
      actionButton:
        "mt-[calc(var(--s-1)/2)] self-start border-0 bg-transparent p-0 text-[length:var(--t-badge)] font-[var(--t-row-w)] text-[var(--accent-text)]",
      content: "flex min-w-0 flex-1 flex-col gap-[calc(var(--s-1)/2)]",
      description:
        "text-[length:var(--t-badge)] font-[var(--t-body-w)] leading-[var(--t-body-lh)] text-[var(--muted)]",
      icon: "mt-[calc(var(--s-1)/4)] shrink-0 text-[var(--muted)]",
      title: "text-body font-[var(--t-row-w)] text-[var(--ink)]",
      toast:
        "flex items-start gap-[var(--s-3)] rounded-[var(--r-card)] bg-[var(--raised)] p-[var(--s-3)] text-body text-[var(--body)] shadow-[var(--shadow-toast)] !transition-[transform,opacity] !duration-[var(--toast-close)] !ease-[var(--toast-ease)] motion-reduce:!transition-none",
    },
    unstyled: true,
  },
} as const satisfies ToasterProps;
