"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { ProvenanceChip, type ProvenanceKind } from "@/components/kit/provenance-chip";

export type Crumb = {
  label: string;
  href?: string;
};

export type PageHeaderProps = {
  title: string;
  /**
   * Required. One muted sentence saying what the page is for, under the title. Every page head in
   * the product carries one, because a title alone leaves the reader to infer the page's job from its
   * table, and five different pages inferred five different jobs.
   */
  description: string;
  crumbs: readonly Crumb[];
  /**
   * Right-aligned. **At most one filled (primary) control**, and it must be last; everything else
   * is outline or ghost. PageHeader enforces this by inspecting what actually renders, so a filled
   * button smuggled in through a wrapper component still trips it.
   */
  actions?: ReactNode;
  /**
   * The seeded-data chip above the title.
   *
   * This slot used to be a `provenance` string -- `"demo" | "test" | "real"` -- rendered as a
   * faint badge-sized sentence *under* the description. Two things were wrong with it and only
   * one was placement. It was last in the reading order, so a reader met the disclosure after the
   * numbers it was about; and `"real"` printed "Real data" on a page whose rows are real, which is
   * a label nobody needs and which turned the absence of a disclosure into a positive claim the
   * page could get wrong. The console artboards draw one thing here: a mono chip above the `<h1>`
   * when the rows are seeded, and nothing at all when they are not.
   *
   * Whole-page claim only. A page whose rows are a mix of real and seeded must label the seeded
   * rows in the row and say so in a sentence -- see `ProvenanceChip`'s own note on why a chip over
   * a mixed table misleads in the other direction.
   */
  provenanceKind?: ProvenanceKind;
};

const RENDERED_ACTION_SELECTOR = [
  "a[href]",
  "button",
  'input[type="button"]',
  'input[type="submit"]',
  '[role="button"]',
].join(",");

const ACTION_ATTRIBUTE_FILTER = [
  "class",
  "data-variant",
  "href",
  "role",
  "type",
];

function isPrimaryAction(action: Element) {
  const variant = action.getAttribute("data-variant");
  return (
    variant === "primary" ||
    variant === "default" ||
    action.classList.contains("bg-primary")
  );
}

function validateRenderedActions(container: HTMLElement) {
  const elements = Array.from(container.querySelectorAll(RENDERED_ACTION_SELECTOR));
  const primaryIndexes = elements.flatMap((action, index) =>
    isPrimaryAction(action) ? [index] : [],
  );

  if (primaryIndexes.length > 1) {
    throw new Error("PageHeader accepts at most one primary action.");
  }

  if (primaryIndexes.length === 1 && primaryIndexes[0] !== elements.length - 1) {
    throw new Error("The primary PageHeader action must be last.");
  }
}

/**
 * The soft version of the rule above, for the templates that take a `primaryAction` prop plus a
 * free `actions` slot. It counts what actually rendered into the action row and warns once in
 * development when more than one control reads as filled.
 *
 * What it cannot police: a page that puts a filled button somewhere else entirely, inside the
 * stat strip, in a section heading, in the table toolbar. The "one fill per page" rule is a
 * convention the page author keeps; this only watches the header row.
 */
export function useSingleFilledActionWarning(
  ref: RefObject<HTMLElement | null>,
  componentName: string,
  deps: readonly unknown[],
) {
  useLayoutEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    const container = ref.current;
    if (!container) return;

    const filled = Array.from(
      container.querySelectorAll(RENDERED_ACTION_SELECTOR),
    ).filter(isPrimaryAction);

    if (filled.length > 1) {
      console.warn(
        `${componentName}: ${filled.length} filled actions in the header row. Exactly one control on a page may be filled. Pass it as \`primaryAction\` and keep everything in \`actions\` outline or ghost.`,
      );
    }
    // The action row is a free slot: the caller's own render is the only signal we get.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * The break under the head is 20px, the same one the page templates use, and it is deliberately
 * smaller than the 32px a `PageSection` takes above its heading. The head is already the largest
 * thing on the page and needs no extra room to be seen; the section headings under it are what
 * have to break the rhythm, and they cannot if the head has spent the biggest gap on itself.
 */
export function PageHeader({
  title,
  description,
  crumbs,
  actions,
  provenanceKind,
}: PageHeaderProps) {
  const rootRef = useRef<HTMLElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [actionValidationError, setActionValidationError] = useState<Error | null>(
    null,
  );

  if (actionValidationError) throw actionValidationError;

  useLayoutEffect(() => {
    const actionsContainer = actionsRef.current;
    if (!actionsContainer) return;

    validateRenderedActions(actionsContainer);

    const observer = new MutationObserver(() => {
      try {
        validateRenderedActions(actionsContainer);
      } catch (error) {
        setActionValidationError(
          error instanceof Error
            ? error
            : new Error("PageHeader action validation failed."),
        );
      }
    });

    observer.observe(actionsContainer, {
      attributes: true,
      attributeFilter: ACTION_ATTRIBUTE_FILTER,
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, [actions]);

  useLayoutEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    const shellRoot = rootRef.current?.closest("[data-shell-root]");
    if (shellRoot && shellRoot.querySelectorAll("[data-page-header]").length > 1) {
      throw new Error("Render exactly one PageHeader inside each AppShell.");
    }
  }, []);

  return (
    <header
      ref={rootRef}
      data-crumb-count={crumbs.length}
      data-page-header=""
      className="mb-[var(--s-5)] flex items-start justify-between gap-[var(--s-6)] max-sm:flex-col"
    >
      <div className="flex min-w-0 flex-col gap-[var(--s-1)]">
        {provenanceKind ? (
          <div className="mb-[var(--s-1)]">
            <ProvenanceChip kind={provenanceKind} />
          </div>
        ) : null}
        <h1 className="t-page-title m-0" data-slot="page-header-title">
          {title}
        </h1>
        <p
          className="m-0 max-w-[var(--measure-prose)] text-[length:var(--t-body)] leading-[var(--t-body-lh)] font-[var(--t-body-w)] tracking-[var(--t-body-tr)] text-[color:var(--muted)]"
          data-slot="page-header-description"
        >
          {description}
        </p>
      </div>
      {actions ? (
        <div
          ref={actionsRef}
          data-slot="page-header-actions"
          className="flex shrink-0 items-center gap-[var(--s-2)] max-sm:w-full max-sm:flex-wrap"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
