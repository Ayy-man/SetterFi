"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell, type Crumb } from "@/components/kit/app-shell";
import { Skeleton } from "@/components/kit/skeleton";
import { BREAK } from "@/components/kit/templates/rhythm";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";
import {
  isWorkspaceNavItemActive,
  workspaceNavItemsWithChildren,
  workspaceNavigationFor,
  type WorkspaceRole,
} from "@/lib/workspace-navigation";
import { cn } from "@/lib/utils";

/**
 * The route-transition skeletons.
 *
 * Every page under `(workspace)` mounts its own <AppShell>, so a route change unmounts the shell
 * with the page and the reader watched the sidebar, the topbar and the breadcrumb blink out before
 * the next page's payload landed. A `loading.tsx` is the only markup on screen during that gap, so
 * these skeletons render the shell themselves: same sidebar, same topbar, same active item, and a
 * body shaped like the page that is arriving.
 *
 * Nothing here fades in. `kit-content-reveal` starts at opacity 0 and a 2px blur, so a skeleton
 * wearing it is invisible for the first frames -- exactly the blank the skeleton exists to remove.
 * The reveal belongs on the other side of the swap: the arriving content plays it once as it
 * replaces these bones (DataTable already does, see `data-table.tsx`). The only motion the
 * skeleton itself carries is the kit Skeleton's single shimmer sweep, which `motion-reduce` drops.
 */

/** Height of one field/control row, so a skeleton control lines up with the real one. */
const CONTROL_H = "h-[var(--s-8)]";

type SkeletonRootProps = {
  label: string;
  slot: string;
  children: ReactNode;
  className?: string;
};

/**
 * One announcement per page, not one per bone: the root carries `role="status"` and `aria-busy`,
 * and everything inside it is `aria-hidden` so a screen reader hears "Loading …" once.
 */
function SkeletonRoot({ children, className, label, slot }: SkeletonRootProps) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        "lg:h-[calc(100svh-var(--topbar-h,3.5rem)-var(--s-6)*2)]",
        className,
      )}
      data-layout="fixed"
      data-slot={slot}
      role="status"
    >
      {children}
    </div>
  );
}

/** Title + description + action cluster, at the height of the real page header. */
function HeaderBones({ actions = true }: { actions?: boolean }) {
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-start justify-between gap-[var(--s-6)] max-sm:flex-col"
      data-slot="page-skeleton-header"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[var(--s-2)]">
        <Skeleton aria-hidden className="h-[var(--s-6)] w-[min(18rem,60%)]" />
        <Skeleton aria-hidden className="h-[var(--s-4)] w-[min(32rem,85%)]" />
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-[var(--s-2)]">
          <Skeleton aria-hidden className={cn(CONTROL_H, "w-[6rem]")} />
          <Skeleton aria-hidden className={cn(CONTROL_H, "w-[7rem]")} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The stat strip: one bordered strip divided by hairlines, at the real tile's 20/16 padding.
 *
 * These bones used to be four separately bordered cards in a gapped grid, which is not what
 * StatStrip has drawn for some time -- so the skeleton promised four boxes and the payload
 * delivered one strip, and every route change flickered between two different shapes. A skeleton
 * whose proportions are its own is worse than no skeleton: it moves the furniture twice.
 */
function StatStripBones({ tiles }: { tiles: number }) {
  return (
    <div
      aria-hidden
      className="grid grid-cols-1 overflow-hidden rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] lg:auto-cols-fr lg:grid-flow-col"
      data-slot="page-skeleton-stats"
      data-tile-count={tiles}
    >
      {Array.from({ length: tiles }, (_, index) => (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-[var(--s-2)] px-[var(--s-5)] py-[var(--s-4)]",
            "border-t border-[var(--line)] first:border-t-0",
            "lg:border-t-0 lg:border-l lg:first:border-l-0",
          )}
          key={`tile-${index}`}
        >
          {/* Label, figure, note: 32px of padding around them is the ~95px a real tile stands at. */}
          <Skeleton aria-hidden className="h-[var(--s-3)] w-1/2" />
          <Skeleton aria-hidden className="h-[var(--s-6)] w-2/3" />
          <Skeleton aria-hidden className="h-[var(--s-3)] w-2/5" />
        </div>
      ))}
    </div>
  );
}

/**
 * The table card: toolbar row, header row, then rows.
 *
 * The heights are `--d-th` and `--d-row`, which are what DataTable actually renders. They used to
 * both be `--row-h`, the density-toggle contract, so every bone stood 4px taller than the row that
 * replaced it and eight rows of table shifted 32px on arrival.
 */
function TableBones({ columns, rows }: { columns: number; rows: number }) {
  return (
    <div
      aria-hidden
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)]"
      data-column-count={columns}
      data-row-count={rows}
      data-slot="page-skeleton-table"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-[var(--s-2)] border-b border-[var(--line)] px-[var(--cell-x)] py-[var(--s-2)]">
        <Skeleton aria-hidden className={cn(CONTROL_H, "w-[15rem] max-w-[45%]")} />
        <Skeleton aria-hidden className={cn(CONTROL_H, "w-[6rem]")} />
        <Skeleton aria-hidden className={cn(CONTROL_H, "w-[6rem]")} />
        <Skeleton aria-hidden className={cn(CONTROL_H, "ml-auto w-[5.5rem]")} />
        <Skeleton aria-hidden className={cn(CONTROL_H, "w-[5.5rem]")} />
      </div>
      <div
        className="grid h-[var(--d-th)] shrink-0 items-center gap-[var(--s-3)] border-b border-[var(--line)] bg-[var(--quiet)] px-[var(--cell-x)]"
        style={{ gridTemplateColumns: `2fr repeat(${Math.max(1, columns - 1)}, 1fr)` }}
      >
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton aria-hidden className="h-[var(--s-3)] w-1/2" key={`head-${index}`} />
        ))}
      </div>
      {/* The body rows take `--line-soft` and the header band above keeps `--line`, which is the
          weight `DataTable` draws and the artboards draw. A skeleton whose rows are heavier than
          the table it stands in for makes the table look like it settled when the data arrives. */}
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          className="grid h-[var(--d-row)] shrink-0 items-center gap-[var(--s-3)] border-b border-[var(--line-soft)] px-[var(--cell-x)] last:border-b-0"
          key={`row-${rowIndex}`}
          style={{ gridTemplateColumns: `2fr repeat(${Math.max(1, columns - 1)}, 1fr)` }}
        >
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              aria-hidden
              className={cn(
                "h-[var(--s-3)]",
                columnIndex === 0 ? "w-3/4" : columnIndex % 2 === 0 ? "w-1/2" : "w-3/5",
              )}
              key={`cell-${rowIndex}-${columnIndex}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function CardBones({ className, lines = 3 }: { className?: string; lines?: number }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex min-w-0 flex-col gap-[var(--s-3)] rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] p-[var(--s-5)]",
        className,
      )}
    >
      <Skeleton aria-hidden className="h-[var(--s-5)] w-2/5" />
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          aria-hidden
          className={cn("h-[var(--s-3)]", index === lines - 1 ? "w-3/5" : "w-full")}
          key={`line-${index}`}
        />
      ))}
    </div>
  );
}

export type ListPageSkeletonProps = {
  /** Rows to draw. Eight fills a 900px viewport at compact density without overflowing it. */
  rows?: number;
  columns?: number;
  /** Stat tiles above the table; 0 for a list page that carries none. */
  stats?: number;
  label?: string;
  className?: string;
};

/** Header, stat strip, toolbar, and rows at the table's own row height. */
export function ListPageSkeleton({
  className,
  columns = 5,
  label = "Loading page",
  rows = 8,
  stats = 4,
}: ListPageSkeletonProps) {
  return (
    <SkeletonRoot className={className} label={label} slot="list-page-skeleton">
      <HeaderBones />
      {stats > 0 ? (
        <div className={BREAK.head}>
          <StatStripBones tiles={stats} />
        </div>
      ) : null}
      {/* Same rule as ListPage: with a strip the table takes the section break, without one it
          opens at the head break. A skeleton that spaces itself evenly re-flattens the page it is
          standing in for. */}
      <div className={cn("flex min-h-0 flex-col", stats > 0 ? BREAK.section : BREAK.head)}>
        <TableBones columns={columns} rows={rows} />
      </div>
    </SkeletonRoot>
  );
}

export type DetailPageSkeletonProps = {
  tabs?: number;
  label?: string;
  className?: string;
};

/** Header, a tab strip, then the two-column body a detail tab opens with. */
export function DetailPageSkeleton({
  className,
  label = "Loading record",
  tabs = 3,
}: DetailPageSkeletonProps) {
  return (
    <SkeletonRoot className={className} label={label} slot="detail-page-skeleton">
      <HeaderBones />
      <div
        aria-hidden
        className={cn(
          "flex shrink-0 items-center gap-[var(--s-5)] border-b border-[var(--line)] pb-[var(--s-2)]",
          BREAK.bareControl,
        )}
        data-slot="page-skeleton-tabs"
        data-tab-count={tabs}
      >
        {Array.from({ length: tabs }, (_, index) => (
          <Skeleton aria-hidden className="h-[var(--s-4)] w-[5.5rem]" key={`tab-${index}`} />
        ))}
      </div>
      <div
        aria-hidden
        className={cn(
          "grid min-h-0 min-w-0 flex-1 gap-[var(--s-4)] lg:grid-cols-[2fr_1fr]",
          BREAK.control,
        )}
        data-slot="page-skeleton-detail-body"
      >
        <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
          <CardBones lines={4} />
          <CardBones lines={3} />
        </div>
        <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
          <CardBones lines={3} />
          <CardBones lines={2} />
        </div>
      </div>
    </SkeletonRoot>
  );
}

export type SettingsPageSkeletonProps = {
  /** Rail entries. Six is the median across the admin settings surfaces. */
  railItems?: number;
  sections?: number;
  label?: string;
  className?: string;
};

/** The settings shape: a text rail on the left, section cards on the right. */
export function SettingsPageSkeleton({
  className,
  label = "Loading settings",
  railItems = 6,
  sections = 2,
}: SettingsPageSkeletonProps) {
  return (
    <SkeletonRoot className={className} label={label} slot="settings-page-skeleton">
      <HeaderBones actions={false} />
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--s-6)] lg:flex-row",
          BREAK.head,
        )}
      >
        <aside
          aria-hidden
          className="flex shrink-0 flex-col gap-[var(--s-2)] lg:w-[calc(var(--sidebar-w)*0.8)]"
          data-rail-count={railItems}
          data-slot="page-skeleton-rail"
        >
          {Array.from({ length: railItems }, (_, index) => (
            <Skeleton
              aria-hidden
              className={cn(CONTROL_H, index % 2 === 0 ? "w-4/5" : "w-3/5")}
              key={`rail-${index}`}
            />
          ))}
        </aside>
        <div
          aria-hidden
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--d-section-gap)]"
        >
          {Array.from({ length: sections }, (_, index) => (
            <CardBones key={`section-${index}`} lines={4} />
          ))}
        </div>
      </div>
    </SkeletonRoot>
  );
}

export type OverviewSkeletonProps = {
  label?: string;
  className?: string;
};

/** Four tiles, a queue list, and a chart panel beside it. */
export function OverviewSkeleton({ className, label = "Loading overview" }: OverviewSkeletonProps) {
  return (
    <SkeletonRoot className={cn("lg:h-auto", className)} label={label} slot="overview-skeleton">
      <HeaderBones />
      <div className={BREAK.head}>
        <StatStripBones tiles={4} />
      </div>
      <div
        aria-hidden
        className={cn("grid min-w-0 gap-[var(--s-4)] lg:grid-cols-2", BREAK.section)}
        data-slot="page-skeleton-overview-body"
      >
        <div className="flex min-w-0 flex-col gap-[var(--s-3)]" data-slot="page-skeleton-queue">
          <Skeleton aria-hidden className="h-[var(--s-5)] w-2/5" />
          {Array.from({ length: 3 }, (_, index) => (
            <div
              className="flex items-center gap-[var(--s-4)] rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] px-[var(--s-4)] py-[var(--s-4)]"
              key={`queue-${index}`}
            >
              <Skeleton aria-hidden className="size-[var(--s-8)] shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-[var(--s-2)]">
                <Skeleton aria-hidden className="h-[var(--s-3)] w-3/5" />
                <Skeleton aria-hidden className="h-[var(--s-3)] w-2/5" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-[var(--s-3)]" data-slot="page-skeleton-chart">
          <Skeleton aria-hidden className="h-[var(--s-5)] w-2/5" />
          <div className="flex min-h-[16rem] flex-1 items-end gap-[var(--s-6)] rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] p-[var(--s-5)]">
            <Skeleton aria-hidden className="h-[45%] w-[5.5rem]" />
            <Skeleton aria-hidden className="h-[70%] w-[5.5rem]" />
          </div>
        </div>
      </div>
    </SkeletonRoot>
  );
}

/**
 * The shell around a loading skeleton.
 *
 * `activePath` comes from `usePathname()` because the router commits the destination URL before it
 * renders this fallback, so the sidebar highlights the item being opened rather than the one being
 * left. The breadcrumb is read from the same nav the shell builds, which keeps the trail correct
 * without asking each `loading.tsx` to restate it.
 */
export function PageSkeletonShell({
  children,
  role = "admin",
}: {
  children: ReactNode;
  role?: WorkspaceRole;
}) {
  const pathname = usePathname() ?? "";
  const { platformRole } = useWorkspaceEnv();

  return (
    <AppShell
      activePath={pathname}
      crumbs={loadingCrumbs(role, pathname, platformRole)}
      role={role}
    >
      {children}
    </AppShell>
  );
}

/**
 * Group label plus item label, the same two-level trail the pages hand the shell. An exact href
 * match wins over a prefix match so `/admin/brain/testing` reads as Evals rather than The Brain.
 */
export function loadingCrumbs(
  role: WorkspaceRole,
  pathname: string,
  platformRole?: Parameters<typeof workspaceNavigationFor>[2],
): readonly Crumb[] {
  const groups = workspaceNavigationFor(role, undefined, platformRole);

  for (const match of ["exact", "prefix"] as const) {
    for (const group of groups) {
      for (const item of workspaceNavItemsWithChildren(group.items)) {
        const hit =
          match === "exact"
            ? [item.href, ...(item.matchPaths ?? [])].includes(pathname)
            : isWorkspaceNavItemActive(item, pathname);
        if (!hit) continue;
        return group.label ? [{ label: group.label }, { label: item.label }] : [{ label: item.label }];
      }
    }
  }

  return [{ label: "Loading" }];
}

/** The four `loading.tsx` entry points. Each admin route re-exports the one its shape matches. */
export function ListPageLoading() {
  return (
    <PageSkeletonShell>
      <ListPageSkeleton />
    </PageSkeletonShell>
  );
}

export function DetailPageLoading() {
  return (
    <PageSkeletonShell>
      <DetailPageSkeleton />
    </PageSkeletonShell>
  );
}

export function SettingsPageLoading() {
  return (
    <PageSkeletonShell>
      <SettingsPageSkeleton />
    </PageSkeletonShell>
  );
}

export function OverviewLoading() {
  return (
    <PageSkeletonShell>
      <OverviewSkeleton />
    </PageSkeletonShell>
  );
}
