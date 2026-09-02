"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";

import { indicatorTransition } from "@/components/kit/motion";
import { cn } from "@/lib/utils";

export type SidebarNavItem = {
  href: string;
  title: string;
  /** Reserved for a later custom-icon pass. Nothing renders today: the labels do the work. */
  icon?: never;
};

export type SidebarNavProps = {
  items: readonly SidebarNavItem[];
  /** Overrides the active route. Useful in tests and in nested layouts. */
  activePath?: string;
  ariaLabel?: string;
  className?: string;
};

/**
 * The settings rail. Text only, one item per sub-page, so a long form never becomes one long
 * scroll the reader has to hunt through.
 */
export function SidebarNav({
  activePath,
  ariaLabel = "Settings sections",
  className,
  items,
}: SidebarNavProps) {
  const pathname = usePathname();
  const current = activePath ?? pathname ?? "";
  const groupId = useId();
  const reduced = useReducedMotion();

  return (
    <LayoutGroup id={groupId}>
      <nav
        aria-label={ariaLabel}
        className={cn(
          "relative flex gap-[var(--s-1)] overflow-x-auto lg:flex-col lg:overflow-visible",
          className,
        )}
        data-slot="sidebar-nav"
      >
        {items.map((item) => {
          const active = current === item.href;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              // The active wash is a separate element that glides between items rather than a
              // background that repaints. Hover stays instant: a pointer hint should land the
              // moment the pointer does, and only the committed selection is worth animating.
              className={cn(
                "relative flex min-h-[var(--row-h-compact)] items-center rounded-[var(--r-control)] px-[var(--s-3)] text-[length:var(--t-nav)] whitespace-nowrap text-[var(--body)] transition-colors duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:transition-none hover:bg-[var(--quiet)]",
                active && "font-medium text-[var(--ink)] hover:bg-transparent",
              )}
              href={item.href}
              key={item.href}
            >
              {active ? (
                <motion.span
                  aria-hidden
                  className="absolute inset-0 -z-10 rounded-[var(--r-control)] bg-[var(--quiet)]"
                  layoutId="settings-rail-active"
                  transition={indicatorTransition(reduced)}
                />
              ) : null}
              {item.title}
            </Link>
          );
        })}
      </nav>
    </LayoutGroup>
  );
}
