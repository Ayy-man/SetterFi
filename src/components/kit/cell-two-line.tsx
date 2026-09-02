import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The two-line table cell the drawn Inbox puts in every column that carries more than one fact:
 * a 14px/600 primary line in `--ink`, and under it the
 * one line of context that would otherwise need its own column.
 *
 * The primary line is the same size and weight as `GridTableIdentity`'s name and the one
 * `identityColumn` renders, and that is the point: the three of them are the same role -- the
 * thing the row is about -- and they shipped at 12.5px/400, 13.5px/500 and 13px/500, so two
 * lists side by side disagreed about how loud a row's own name is. 6b draws it at ~14px/600.
 *
 * It exists as a component because the drawing spends this shape four times on one screen -- name
 * over channel, headline over detail, client over surface -- and every hand-rolled copy of it so
 * far has got one of the three nested `min-width: 0` boxes wrong, which is what lets a long client
 * name push the wait column off the table. It also fixes the one rule that is easy to lose: the
 * subline is a *fact*, so when there is none the cell either says what is missing in words
 * (`absentSubline`) or drops the second line entirely. It never prints a dash, because a dash in
 * the subline position reads as "no data" and "not applicable" and "we didn't look" all at once.
 *
 * Two-line cells need the row to be allowed to grow: mark the column `meta.multiline` so the
 * `DataTable` drops its single-line clamp on that cell.
 */
export type CellTwoLineProps = {
  /** The line the reader scans: a name, a headline, an event. */
  primary: ReactNode;
  /** The line under it: the channel, the rule that matched, the detail. */
  subline?: ReactNode;
  /**
   * Which face the subline wears.
   *
   * `mono` (the default) is the Mono Licence Rule's own list -- timestamps, handles, masked
   * numbers, counts, machine events. `prose` is 11px sans in `--faint`, the same treatment
   * `GridTableIdentity` gives its subline, and it is what a sentence gets: the support queue's
   * subject line is a person's words, and setting a sentence in 10.5px mono made a table of
   * requests read as a log of events.
   */
  sublineKind?: "mono" | "prose";
  /**
   * What to say when there is no subline: "no origin recorded", "wait not recorded". Omit both
   * and the cell is a single line, which is the right answer when the second fact is not merely
   * missing but does not apply.
   */
  absentSubline?: string;
  /** The identity glyph: a `Monogram`, an `IconTile`, an avatar. Never carries meaning alone. */
  leading?: ReactNode;
  className?: string;
};

export function CellTwoLine({
  absentSubline,
  className,
  leading,
  primary,
  subline,
  sublineKind = "mono",
}: CellTwoLineProps) {
  const sublineClass =
    sublineKind === "prose"
      ? "truncate text-[11px] leading-[1.35] text-[color:var(--faint)]"
      : "truncate font-mono text-[10.5px] leading-[1.3] text-[color:var(--faint)]";
  return (
    <span
      className={cn("flex min-w-0 items-center gap-[var(--s-2)]", className)}
      data-slot="cell-two-line"
    >
      {leading}
      <span className="flex min-w-0 flex-col gap-[1px]">
        <span
          className="truncate text-[14px] leading-[1.3] font-[600] text-[color:var(--ink)]"
          data-slot="cell-two-line-primary"
        >
          {primary}
        </span>
        {subline !== undefined && subline !== null && subline !== "" ? (
          <span className={sublineClass} data-slot="cell-two-line-subline">
            {subline}
          </span>
        ) : absentSubline ? (
          // Not italic, for the two reasons `absentValue` stopped being italic. Italic reads as
          // emphasis, so a column where half the rows have no subline becomes a table shouting
          // about the rows where nothing happened; and an italic's overhang is clipped by
          // `truncate`, which is how "no channel saved" lost the tail of its last letter.
          <span
            className={sublineClass}
            data-absent=""
            data-slot="cell-two-line-subline"
          >
            {absentSubline}
          </span>
        ) : null}
      </span>
    </span>
  );
}
