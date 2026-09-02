import { TONE_MARK, TONE_TEXT, type Tone } from "@/components/kit/atomics/tone";
import { workspaceCountFormat } from "@/lib/format/datetime";
import { cn } from "@/lib/utils";

/**
 * The band that opens a group of rows: a tiny caps mono label and its count on the left, and on
 * the right, in the same mono at `--muted`, one line saying what the group *means*.
 *
 * The annotation is the part that earns the band. `.planning/design/screens-r4/5a.html` never
 * writes a bare label: "SYSTEM PROBLEMS 3" carries "need a fix, not a reply", and "LEAD HANDOFFS 4"
 * carries "claiming pauses the agent on the thread". A label plus a count only restates what the
 * reader can already see by looking down the rows; the annotation tells them what the grouping
 * commits to, which is the only reason to draw a rule across the table at all.
 *
 * Keep it a standing property of the group -- what these rows are, what acting on one does, what
 * the boundary is drawn against. Never a status, never anything that changes when a row changes:
 * it renders once per band and does not update per row.
 */
export type TableGroupHeaderProps = {
  label: string;
  count: number;
  /** The right-aligned sentence. Omit only when the label genuinely says everything. */
  annotation?: string;
  /**
   * A dot before the label, saying what kind of band this is: clay on money that is owed, amber on
   * a step someone has to move. Every band draws one; omitting the tone draws it in `--glyph`,
   * which asserts nothing. It is flat -- the product spends its one glow elsewhere (`TONE_GLOWS`).
   */
  tone?: Tone;
  /**
   * Runs a hairline from the count out to the table's right edge, stopping short of the
   * annotation when there is one.
   *
   * It is the 6b treatment's band and nothing else's. A quiet list has no fill behind its bands
   * and no card edge either, so without the rule the label floats in the middle of the canvas
   * with nothing saying how far the group reaches; 6a does not need it because its band is a
   * filled row inside the card and the fill already draws the full width.
   */
  rule?: boolean;
  className?: string;
};

export function TableGroupHeader({
  annotation,
  className,
  count,
  label,
  rule,
  tone,
}: TableGroupHeaderProps) {
  return (
    <span
      className={cn("flex min-w-0 items-center gap-[var(--s-2)]", className)}
      data-slot="table-group-header"
      data-tone={tone}
    >
      {/* Every band carries a dot, the 6a drawing included: a band that draws one and a band that
          draws none read as two different kinds of object, and the reader has to work out which.
          A band with nothing to assert draws it in --glyph, so the mark stays a rhythm rather than
          becoming a status. */}
      <span
        aria-hidden
        className="size-[6px] shrink-0 rounded-[var(--r-full)]"
        data-slot="table-group-dot"
        style={{ background: TONE_MARK[tone ?? "neutral"] }}
      />
      {/* The overline recipe, not a small bold sans line: 9.5px mono at 0.09em is the role
          `docs/DESIGN.md` defines for a label of this kind, and the band was the one place in the
          kit still hand-rolling it at 11px semibold. The label takes the tone's own text colour
          so the band states its kind in the words as well as in the dot -- a 6px dot alone is a
          lot of meaning to hang on one mark. An untoned band stays --muted, because a band that
          asserts nothing should not be reading as a colour. */}
      <span
        className="mono min-w-0 truncate text-[9.5px] leading-[1.2] font-[500] tracking-[0.09em] uppercase"
        data-slot="table-group-label"
        style={{ color: tone && tone !== "neutral" ? TONE_TEXT[tone] : "var(--muted)" }}
      >
        {label}
      </span>
      <span
        className="shrink-0 font-mono text-[length:var(--t-mono-crumb)] leading-[var(--t-mono-crumb-lh)] tabular-nums text-[var(--faint)]"
        data-slot="data-table-group-count"
      >
        {workspaceCountFormat.format(count)}
      </span>
      {rule ? (
        <span
          aria-hidden
          className="h-px min-w-[var(--s-4)] flex-1 bg-[var(--line)]"
          data-slot="table-group-rule"
        />
      ) : null}
      {annotation ? (
        <span
          className={cn(
            "min-w-0 truncate pl-[var(--s-4)] font-mono text-[11.5px] leading-[1.3] text-[color:var(--muted)] normal-case",
            rule ? "shrink" : "ml-auto",
          )}
          data-slot="table-group-annotation"
        >
          {annotation}
        </span>
      ) : null}
    </span>
  );
}
