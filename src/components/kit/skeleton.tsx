import type { CSSProperties, ComponentProps } from "react"

import { Skeleton as BaseSkeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type SkeletonProps = ComponentProps<typeof BaseSkeleton>

const boneClassName = cn(
  "relative min-h-[var(--s-3)] w-full animate-none overflow-hidden border-0 bg-[var(--quiet)]",
  "before:pointer-events-none before:absolute before:inset-0 before:content-['']",
  "before:bg-[linear-gradient(to_right,transparent,var(--line-strong),transparent)] before:opacity-50",
  "before:[transform:translateX(-100%)]",
  // One slow sweep. The previous 250ms shimmer stacked with a 250ms pulse strobed at 4Hz.
  "before:[animation:skeleton-shimmer_1.6s_var(--ease-out)_infinite]",
  "motion-reduce:before:hidden motion-reduce:before:animate-none"
)

function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <BaseSkeleton
      aria-label={props["aria-hidden"] ? undefined : (props["aria-label"] ?? "Loading content")}
      role={props["aria-hidden"] ? undefined : (props.role ?? "status")}
      className={cn(boneClassName, "rounded-[var(--r-control)]", className)}
      {...props}
    />
  )
}

function SkeletonRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-label={props["aria-label"] ?? "Loading row"}
      role={props.role ?? "status"}
      className={cn(
        // The approved row: a 28px identity track, three text tracks, and an 80px action track.
        // The 24px and 56px this used to draw were narrower than the row that arrives, so the
        // identity column and the action cell both jumped sideways at the swap, which is the
        // opposite of what a skeleton is for. Both are token expressions, not literals.
        "grid h-[var(--row-h)]",
        "grid-cols-[calc(var(--s-6)+var(--s-1))_2fr_1fr_1fr_calc(var(--s-12)+var(--s-8))]",
        "items-center gap-[var(--s-3)] border-b border-[var(--line)] px-[var(--cell-x)]",
        className
      )}
      {...props}
    >
      {/* 22px of avatar inside the 28px track, so the round bone sits off both hairlines. */}
      <Skeleton
        aria-hidden
        className="size-[calc(var(--s-6)-var(--s-1)/2)] justify-self-center rounded-[var(--r-full)]"
      />
      <Skeleton aria-hidden className="w-3/4" />
      <Skeleton aria-hidden className="w-3/5" />
      <Skeleton aria-hidden className="w-1/2" />
      <Skeleton
        aria-hidden
        className="h-[var(--s-5)] w-full justify-self-end rounded-[var(--r-input)]"
      />
    </div>
  )
}

function SkeletonCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-label={props["aria-label"] ?? "Loading card"}
      role={props.role ?? "status"}
      className={cn(
        "space-y-[var(--s-4)] rounded-[var(--r-card)] border border-[var(--line)]",
        "bg-[var(--card)] p-[var(--s-4)] shadow-[var(--shadow-card)]",
        className
      )}
      {...props}
    >
      <div aria-hidden className="flex items-center gap-[var(--s-3)]">
        <Skeleton aria-hidden className="size-[var(--s-8)] shrink-0 rounded-[var(--r-full)]" />
        <div className="flex-1 space-y-[var(--s-2)]">
          <Skeleton aria-hidden className="w-2/5" />
          <Skeleton aria-hidden className="w-3/5" />
        </div>
      </div>
      <div aria-hidden className="space-y-[var(--s-2)]">
        <Skeleton aria-hidden />
        <Skeleton aria-hidden className="w-4/5" />
      </div>
    </div>
  )
}

type SkeletonTableProps = ComponentProps<"div"> & {
  rows?: number
  cols?: number
}

function safeCount(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(value)))
}

function SkeletonTable({ rows, cols, className, ...props }: SkeletonTableProps) {
  const rowCount = safeCount(rows, 5, 20)
  const columnCount = safeCount(cols, 4, 12)
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
  }

  return (
    <div
      aria-label={props["aria-label"] ?? "Loading table"}
      role={props.role ?? "status"}
      className={cn(
        "overflow-hidden rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)]",
        className
      )}
      {...props}
    >
      <div
        aria-hidden
        className="grid h-[var(--row-h)] items-center gap-[var(--s-3)] border-b border-[var(--line)] bg-[var(--quiet)] px-[var(--cell-x)]"
        style={gridStyle}
      >
        {Array.from({ length: columnCount }, (_, columnIndex) => (
          <Skeleton aria-hidden className="w-1/2" key={`heading-${columnIndex}`} />
        ))}
      </div>
      {Array.from({ length: rowCount }, (_, rowIndex) => (
        <div
          aria-hidden
          className="grid h-[var(--row-h)] items-center gap-[var(--s-3)] border-b border-[var(--line)] px-[var(--cell-x)] last:border-b-0"
          key={`row-${rowIndex}`}
          style={gridStyle}
        >
          {Array.from({ length: columnCount }, (_, columnIndex) => (
            <Skeleton
              aria-hidden
              className={columnIndex === 0 ? "w-3/4" : columnIndex % 2 === 0 ? "w-1/2" : "w-3/5"}
              key={`cell-${rowIndex}-${columnIndex}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export default Skeleton
export { Skeleton, SkeletonCard, SkeletonRow, SkeletonTable }
export type { SkeletonProps, SkeletonTableProps }
