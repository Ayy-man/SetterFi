import { cn } from "@/lib/utils";

/**
 * What sits under a table: the range, the ordering, and one sentence saying what that ordering
 * does and does not mean.
 *
 * It sits on one line: the range left, the note right in mono, the way the 6a drawing draws it.
 *
 * The drawn Inbox writes it as "Showing 1-7 of 7 items, longest wait first" followed by "nothing
 * here stores a reply promise, so the order is how long each has waited and nothing else". The
 * second half is the point. A reader who sees rows sorted by wait will assume the top row is the
 * most urgent one; the sentence is where the surface says whether it has any basis for that claim.
 * So `ordering` names the sort and `note` says what the sort is blind to.
 *
 * `note` is a standing property of the whole list, printed once and never per row. It is not a
 * place for a status, a count, or anything that changes as the reader filters.
 */
export type TableFooterNoteProps = {
  /** "Showing 1-50 of 202 events". Rendered tabular so paging does not shuffle the digits. */
  range: string;
  /** The sort, in the reader's words: "newest first", "longest wait first". */
  ordering?: string;
  /** The sentence: what the ordering, or the page, cannot tell them. */
  note?: string;
  className?: string;
};

export function TableFooterNote({ className, note, ordering, range }: TableFooterNoteProps) {
  return (
    // One row, not two: the 6a drawing puts the range at the left edge of the table and the note
    // right-aligned against its other edge, so the footer reads as the table's last rule rather
    // than as a paragraph that grew under it. `flex-wrap` is what makes that safe -- on a narrow
    // frame the note drops to its own line instead of squeezing the range.
    <span
      className={cn(
        "flex min-w-0 grow flex-wrap items-baseline justify-between gap-x-[var(--s-4)] gap-y-[2px]",
        className,
      )}
      data-slot="table-footer-note"
    >
      <span className="tabular-nums" data-slot="table-footer-range">
        {range}
        {ordering ? (
          <span data-slot="table-footer-ordering">{` · ${ordering}`}</span>
        ) : null}
      </span>
      {note ? (
        <span
          className="min-w-0 font-mono text-[length:var(--t-mono-crumb)] leading-[var(--t-mono-crumb-lh)] text-[var(--faint)]"
          data-slot="data-table-footer-note"
        >
          {note}
        </span>
      ) : null}
    </span>
  );
}
