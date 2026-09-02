"use client";

import { useRef, type ReactNode } from "react";

import { useSingleFilledActionWarning } from "@/components/kit/page-header";
import {
  PrimaryActionButton,
  type PrimaryAction,
} from "@/components/kit/primary-action";
import {
  assertOneProvenanceClaim,
  ProvenanceChip,
  type ProvenanceKind,
} from "@/components/kit/provenance-chip";
import { BREAK } from "@/components/kit/templates/rhythm";
import { cn } from "@/lib/utils";

export type ListPageProps = {
  title: string;
  /**
   * Required. One muted sentence under the title saying what this list is for. It is not optional
   * on purpose: a bare title plus a table makes the reader work out the page's job from its
   * columns, and every admin page now answers that question in words first.
   */
  description: string;
  /** Breadcrumb slot. The shell renders the real trail; pass a node only when a page needs its own. */
  breadcrumb?: ReactNode;
  /**
   * Page actions, right-aligned, and every one of them outline or ghost. **At most one filled
   * control per page**, and it belongs in `primaryAction`, not here.
   */
  actions?: ReactNode;
  /** The single filled control on the page, rendered last in the action row. */
  primaryAction?: PrimaryAction;
  /** A StatStrip, capped at four tiles. Only where a number changes a decision. */
  stats?: ReactNode;
  /**
   * The scope switch, above the table's own toolbar: my clients vs all, this month vs last. It
   * sits outside the toolbar because it changes what the rows are, not how they are filtered.
   */
  scope?: ReactNode;
  /**
   * A standing rule about what this page's actions do, under the description.
   *
   * Distinct from `description`, which says what the list is, and from `provenance`, which says
   * the rows are not real. This is the sentence that keeps an action honest -- "approving writes
   * an offset event, history is never edited" -- and it is true whatever the rows say.
   */
  note?: string;
  /** One line under the title when the rows are not production data. */
  provenance?: string;
  /**
   * The seeded-data chip above the title, on the console.
   *
   * Distinct from `provenance`, which is a free sentence under the description, and it supersedes
   * it: a page that passes this should not also pass a sentence saying the rows are seeded, or the
   * same fact is stated twice in one header. All thirteen owner-console artboards put the
   * disclosure first, above the `<h1>`, because a reader who meets it under the description has
   * already read the numbers. Coach pages state it in words instead and leave this unset.
   */
  provenanceKind?: ProvenanceKind;
  /** The table. It fills the rest of the viewport and scrolls inside itself. */
  children: ReactNode;
  className?: string;
};

/**
 * The list shape: breadcrumb, title row, optional stat strip, then a table that owns the rest of
 * the viewport. The page itself never scrolls, so the toolbar and the header stay put while the
 * rows move under them.
 *
 * The head is fixed: mono breadcrumb, 20/600 title, one muted sentence of description, then
 * right-aligned actions of which at most one may be filled. In development the action row warns
 * when it can see two fills; it cannot see a fill you put anywhere else on the page, so that half
 * of the rule stays yours to keep.
 *
 * **The page's texture follows what it carries.** A list page with a stat strip is two sections --
 * a summary block and a table -- so the strip sits close under the head and a full 32px break
 * separates it from the rows, and the reader sees a tall block over tight rows. A list page with
 * no strip is one section, so the table starts 20px under the head and the reader is in the rows
 * immediately. The Overview and the client book stop looking like the same page.
 */
export function ListPage({
  actions,
  breadcrumb,
  children,
  className,
  description,
  note,
  primaryAction,
  provenance,
  provenanceKind,
  scope,
  stats,
  title,
}: ListPageProps) {
  assertOneProvenanceClaim("ListPage", provenance, provenanceKind);

  const actionsRef = useRef<HTMLDivElement>(null);
  useSingleFilledActionWarning(actionsRef, "ListPage", [actions, primaryAction]);

  // The break under the strip is the biggest one on the page, because the strip and the table are
  // two different kinds of thing. With no strip there is no second section, so the table simply
  // opens under the head.
  const afterHead = stats ? BREAK.section : BREAK.head;

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col lg:h-[calc(100svh-var(--topbar-h,3.5rem)-var(--s-6)*2)]",
        className,
      )}
      data-layout="fixed"
      data-slot="list-page"
    >
      {breadcrumb ? (
        <div className={cn("t-mono-crumb min-w-0", BREAK.crumb)} data-slot="list-page-breadcrumb">
          {breadcrumb}
        </div>
      ) : null}

      {/*
        `items-end`, so the action row sits on the description's baseline rather than level with
        the provenance chip: `AdminClients.dc.html:227` draws the head as
        `align-items: flex-end`, and so does every other console artboard with a head
        (`AdminRevenue`, `AdminAffiliates`, `AdminAudit`, `AdminAgents`, all at :227). With
        `items-start` the scope switch rode roughly 40px above where it is drawn, on nine screens.

        The stacked case keeps `items-start`: once the header is a column, the cross axis is
        horizontal, and `items-end` would right-align the title against the left-aligned rows
        under it.
      */}
      <header
        className="flex items-end justify-between gap-[var(--s-6)] max-sm:flex-col max-sm:items-start"
        data-slot="list-page-header"
      >
        <div className="flex min-w-0 flex-col gap-[var(--s-1)]">
          {provenanceKind ? (
            <div className="mb-[var(--s-1)]">
              <ProvenanceChip kind={provenanceKind} />
            </div>
          ) : null}
          <h1 className="t-page-title m-0" data-slot="list-page-title">
            {title}
          </h1>
          {/*
            The purpose line, at the artboard's two values and neither of them a token.

            **14px.** `AdminClients.dc.html:231` draws this line at 14px over a body of 13.5px --
            a half-step above body, which is a role and not a rounding. It is written as a literal
            because no token holds that role: `--t-row` is 14px, but it is the *row* role at weight
            500, and binding to it because the number matches is the value-versus-role mistake this
            codebase refuses by name. The token this wants is a `--t-page-lede` declared shared and
            restated in `console.css`; that is outstanding work, deferred since 2026-09-01 for
            contention on `console.css` rather than rejected. A literal is safe here in a way it
            would not be
            in a shared atomic: every one of `ListPage`'s seventeen mounts is console.

            **`--measure-wide` (72ch)**, not `--measure-prose` (68ch), and not the 76ch drawn:
            `docs/DESIGN.md:350` caps prose at 65-75ch, a band `measures.test.ts` holds for every
            surface. A drawing landing 1ch outside the rule is inside the drawing's own tolerance,
            so the token keeps its value and this line takes the widest legal role. Nobody should
            re-derive the remaining 4ch as a defect.

            One trap, if you come here to check the sizes: `tokens.css` alone does not tell you
            what this renders at. `console.css` restates the scale under `[data-shell-role="admin"]`
            -- `--t-page-title` 20px -> 30px, `--t-body` 13px -> 13.5px -- so the effective value is
            never the one in the root palette. Same shape as the coach scale and the drench blocks.
          */}
          <p
            className="m-0 max-w-[var(--measure-wide)] text-[14px] leading-[var(--t-body-lh)] text-[color:var(--muted)]"
            data-slot="list-page-description"
          >
            {description}
          </p>
          {note ? (
            <p
              className="m-0 max-w-[var(--measure-wide)] text-[length:var(--t-badge)] text-[color:var(--muted)]"
              data-slot="list-page-note"
            >
              {note}
            </p>
          ) : null}
          {provenance ? (
            <p
              className="m-0 max-w-[var(--measure-wide)] text-[length:var(--t-badge)] text-[color:var(--faint)]"
              data-slot="list-page-provenance"
            >
              {provenance}
            </p>
          ) : null}
        </div>
        {actions || primaryAction ? (
          <div
            className="flex shrink-0 items-center gap-[var(--s-2)] max-sm:w-full max-sm:flex-wrap"
            data-slot="list-page-actions"
            ref={actionsRef}
          >
            {actions}
            {primaryAction ? <PrimaryActionButton action={primaryAction} /> : null}
          </div>
        ) : null}
      </header>

      {stats ? (
        <div className={BREAK.head} data-slot="list-page-stats">
          {stats}
        </div>
      ) : null}

      {scope ? (
        <div
          className={cn("flex min-w-0 flex-wrap items-center gap-[var(--s-2)]", afterHead)}
          data-slot="list-page-scope"
        >
          {scope}
        </div>
      ) : null}

      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          scope ? BREAK.control : afterHead,
        )}
        data-slot="list-page-body"
      >
        {children}
      </div>
    </div>
  );
}
