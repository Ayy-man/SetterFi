"use client";

import type { ReactNode } from "react";

import { SidebarNav, type SidebarNavItem } from "@/components/kit/sidebar-nav";
import { BREAK } from "@/components/kit/templates/rhythm";
import { cn } from "@/lib/utils";

export type SettingsLayoutProps = {
  title: string;
  description?: string;
  breadcrumb?: ReactNode;
  items: readonly SidebarNavItem[];
  activePath?: string;
  children: ReactNode;
  className?: string;
};

/**
 * The settings shape: a text-only rail on the left, one sub-page on the right. Never one long
 * scroll of every setting the product has.
 *
 * The section cards stack at the page's full 32px section break rather than the 16px everything
 * used to sit at. Each card is its own subject with its own save bar, and at 16px two cards read as
 * one long form with a hairline through it; at 32px against 16px of card padding, the gap between
 * cards is visibly wider than the space inside one, which is what makes them read as separate.
 */
export function SettingsLayout({
  activePath,
  breadcrumb,
  children,
  className,
  description,
  items,
  title,
}: SettingsLayoutProps) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col lg:h-[calc(100svh-var(--topbar-h,3.5rem)-var(--s-6)*2)]",
        className,
      )}
      data-layout="fixed"
      data-slot="settings-layout"
    >
      {breadcrumb ? (
        <div className={BREAK.crumb} data-slot="settings-layout-breadcrumb">
          {breadcrumb}
        </div>
      ) : null}

      <header className="flex min-w-0 flex-col gap-[var(--s-1)]" data-slot="settings-layout-header">
        <h1 className="text-title m-0 text-[color:var(--ink)]">{title}</h1>
        {description ? (
          <p className="m-0 max-w-[var(--measure-prose)] text-[length:var(--t-body)] leading-[var(--t-body-lh)] text-[color:var(--muted)]">
            {description}
          </p>
        ) : null}
      </header>

      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--s-6)] lg:flex-row",
          BREAK.head,
        )}
      >
        <aside className="shrink-0 lg:w-[calc(var(--sidebar-w)*0.8)]" data-slot="settings-layout-nav">
          <SidebarNav activePath={activePath} items={items} />
        </aside>
        <div
          className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--d-section-gap)] overflow-y-auto"
          data-slot="settings-layout-content"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export type SettingsSectionProps = {
  title: string;
  description?: string;
  children: ReactNode;
  /** A FormSaveBar, pinned to the bottom of the card. */
  footer?: ReactNode;
  /** Right-aligned controls on the heading row: an export, a link out. Never the save action. */
  actions?: ReactNode;
  className?: string;
};

/** One card per settings section: heading, fields, and its own save bar. */
export function SettingsSection({
  actions,
  children,
  className,
  description,
  footer,
  title,
}: SettingsSectionProps) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)]",
        className,
      )}
      data-slot="settings-section"
    >
      <div className="flex min-w-0 flex-col gap-[var(--s-4)] p-[var(--s-5)]">
        <div className="flex min-w-0 items-start justify-between gap-[var(--s-4)] max-sm:flex-col">
          <div className="flex min-w-0 flex-col gap-[var(--s-1)]">
            <h2 className="m-0 text-[length:var(--t-section)] leading-[var(--t-section-lh)] font-[var(--t-section-w)] tracking-[var(--t-section-tr)] text-[color:var(--ink)]">
              {title}
            </h2>
            {description ? (
              <p className="m-0 max-w-[var(--measure-prose)] text-[length:var(--t-body)] text-[color:var(--muted)]">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div
              className="flex shrink-0 items-center gap-[var(--s-2)]"
              data-slot="settings-section-actions"
            >
              {actions}
            </div>
          ) : null}
        </div>
        {children}
      </div>
      {footer}
    </section>
  );
}
