import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

/**
 * The cell that has nothing to report, in the round-5 treatment: muted plain text saying what did
 * not happen, and nothing else.
 *
 * It replaces `absentValue`'s italic in a dense multi-column table, and the reason is the table
 * rather than the idiom. Italic reads as emphasis; a Movement column where five of eight rows are
 * italic is a table shouting about the rows where nothing is happening. Round 5's note on the 6a
 * frame is exactly that: "empty cells go quiet instead of repeating italic filler". `absentValue`
 * stays correct where an absence is rare enough to be worth marking.
 *
 * What does not change is that the cell still says something. A dash is three claims at once --
 * not measured, not applicable, and none -- and the reader cannot tell which, so this refuses one
 * the same way `absentValue` does. Where the drawing does spend a bare dash, it buys it with a
 * footer sentence defining it, and `TableFooterNote` is where that sentence goes.
 */
export type CellQuietProps = {
  /** What did not happen: "nothing scheduled", "no provider receipt", "no origin recorded". */
  children: ReactNode;
  className?: string;
};

const FORBIDDEN = new Set(["—", "–", "-", "--", "n/a", "N/A", ""]);

export function CellQuiet({ children, className }: CellQuietProps) {
  if (typeof children === "string" && FORBIDDEN.has(children.trim())) {
    throw new Error(
      `A quiet cell must name what did not happen (e.g. "nothing scheduled"), not ${JSON.stringify(children)}.`,
    );
  }

  return (
    <span
      className={cn("truncate text-[color:var(--muted)]", className)}
      data-slot="cell-quiet"
    >
      {children}
    </span>
  );
}
