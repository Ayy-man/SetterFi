import type { ReactNode } from "react";

import { BREAK } from "@/components/kit/templates/rhythm";
import { cn } from "@/lib/utils";

export type PageSectionProps = {
  /** The section's subject, in 14/600. One noun phrase, not a sentence. */
  title: string;
  /** One muted sentence, where the title alone does not say what the section is for. */
  description?: string;
  /**
   * Right-aligned on the heading row: an export, a link out, a scope switch for this section only.
   * Outline or ghost, always -- the page's one filled control belongs in the page head.
   */
  actions?: ReactNode;
  /**
   * `2` by default. Pass `3` for a section nested inside another one, so the document outline stays
   * honest; the type does not change with the level, because the break above the heading is what
   * carries the level, not its size.
   */
  headingLevel?: 2 | 3;
  /** Set it when something needs to point at this heading -- an `aria-labelledby`, a deep link. */
  id?: string;
  children: ReactNode;
  className?: string;
};

/**
 * A section heading that breaks the page's rhythm instead of sitting in it.
 *
 * Long pages -- help, the offer editor, integrations, support -- stacked their sections at the same
 * gap they used between everything else, with a bare `<h2 class="text-section">` inside each one.
 * A heading spaced identically to the paragraph above it is not a heading, it is a bold line, and
 * a reader scrolling such a page cannot see where one subject ends and the next begins.
 *
 * The whole announcement is proportion. 32px above the heading, the largest break a page contains,
 * and then 12px from the heading to its own content: the section is pushed away from what precedes
 * it and pulled tight around what belongs to it, so the eye reads the grouping before it reads a
 * word. No rule, no tint, and specifically no coloured edge bar -- an accent stripe would be doing
 * the spacing's job badly and is against the house rules besides. `first:mt-0` keeps the top
 * section from double-spacing under a page head that already set its own break.
 */
export function PageSection({
  actions,
  children,
  className,
  description,
  headingLevel = 2,
  id,
  title,
}: PageSectionProps) {
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <section
      className={cn("flex min-w-0 flex-col", BREAK.section, "first:mt-0", className)}
      data-slot="page-section"
    >
      <div
        className="flex min-w-0 items-start justify-between gap-[var(--s-4)] max-sm:flex-col"
        data-slot="page-section-heading"
      >
        <div className="flex min-w-0 flex-col gap-[var(--s-1)]">
          <Heading className="t-section-title m-0" id={id}>
            {title}
          </Heading>
          {description ? (
            <p
              className="m-0 max-w-[var(--measure-prose)] text-[length:var(--t-body)] leading-[var(--t-body-lh)] text-[color:var(--muted)]"
              data-slot="page-section-description"
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div
            className="flex shrink-0 items-center gap-[var(--s-2)]"
            data-slot="page-section-actions"
          >
            {actions}
          </div>
        ) : null}
      </div>
      <div className="mt-[var(--s-3)] min-w-0" data-slot="page-section-body">
        {children}
      </div>
    </section>
  );
}
