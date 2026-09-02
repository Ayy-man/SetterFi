import Link from "next/link";

import { cn } from "@/lib/utils";

type StateTone = "neutral" | "good" | "warning" | "critical" | "info";

export type ExceptionTileProps = {
  title: string;
  count: number;
  tone: StateTone;
  href: string;
  note?: string;
};

const COUNT_TONE: Record<StateTone, string> = {
  neutral: "text-[var(--faint)]",
  good: "text-[var(--good)]",
  warning: "text-[var(--warning)]",
  critical: "text-[var(--critical)]",
  info: "text-[var(--info)]",
};

/**
 * The queue tile sits at a third density, between the two things it shares a page with. On the
 * coach measurement page a stat tile stands near 95px because it is a figure to read, a table row
 * stands at 36px because it is one of two hundred to scan, and a "what needs you today" tile stands
 * near 60px because it is one of three things a person has to act on. At 12px of padding all round
 * it stood close enough to a table row that the queue read as a stray three-row table.
 *
 * The 4px between the two text rows is the rest of it: at gap 0 the title and its note ran together
 * as one wrapped sentence with a bold first line.
 */
export function ExceptionTile({ title, count, tone, href, note }: ExceptionTileProps) {
  const isEmpty = count === 0;
  const displayedTone: StateTone = isEmpty ? "neutral" : tone;

  return (
    <Link
      className={cn(
        "grid grid-cols-[auto_1fr] grid-rows-2 items-center gap-x-[var(--s-3)] gap-y-[var(--s-1)]",
        "rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] px-[var(--s-4)] py-[var(--s-3)]",
        "text-inherit no-underline hover:border-[var(--line-strong)] hover:bg-[var(--raised)] hover:no-underline",
      )}
      data-slot="exception-tile"
      data-tone={displayedTone}
      href={href}
    >
      <span
        className={cn(
          "t-title num row-span-2 min-w-[var(--s-8)]",
          COUNT_TONE[displayedTone],
        )}
        data-slot="exception-tile-count"
      >
        {count}
      </span>
      <span className="t-body font-medium text-[var(--ink)]" data-slot="exception-tile-title">
        {title}
      </span>
      <span
        className={cn(
          "t-faint",
          // `.t-faint` declares `color: var(--faint)` and unlayered CSS beats the utility layer, so
          // without the `!` a non-empty tile drew faint and the accent never appeared. Faint is the
          // right value for every other `.t-faint`, so this caller wins here rather than the recipe
          // changing for everyone. Deliberate override.
          !isEmpty && "text-[var(--accent-text)]!",
        )}
        data-slot="exception-tile-note"
      >
        {isEmpty ? "Nothing needs you" : (note ?? "Review")}
      </span>
    </Link>
  );
}
