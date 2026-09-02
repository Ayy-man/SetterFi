import type { ReactNode } from "react";

import { MonoMeta, Overline } from "@/components/kit/atomics";
import { cn } from "@/lib/utils";

export type ReviewChecklistStep = {
  key: string;
  title: string;
  /** One sentence of what the step actually involves. No status, no promise about when. */
  body: string;
  /** Who does it. External parties read in the waiting tone; our own work reads neutral. */
  owner: { label: string; external?: boolean };
};

export type ReviewChecklistProps = {
  steps: readonly ReviewChecklistStep[];
  /** Accessible name for the list, e.g. "Meta app review steps". */
  label: string;
  className?: string;
};

/**
 * An ordered list of work that has to happen, where nothing measures whether it has.
 *
 * ## Why this is not `StepJourney`
 *
 * `StepJourney` is the right component for a tracked journey and its grammar is the reason: every
 * step carries `done | current | waiting | blocked`, `assertValidJourney` refuses a list without
 * exactly one current step, and it refuses a `done` step that has no provider receipt with a real
 * timestamp behind it. Those invariants are the honest-states rule made structural, and they are
 * worth keeping exactly as they are.
 *
 * They are also why it is the wrong component here. A journey with no storage behind it can still
 * satisfy every one of those invariants by having the states typed into the source, which is what
 * the Meta review list did: step one was `current` and five were `blocked` because somebody wrote
 * that down, not because anything was read. The component was then doing its job perfectly on
 * data that was an assertion, and a reader has no way to tell that apart from a tracked journey,
 * because it renders identically to one.
 *
 * So this component has **no state vocabulary at all**. The numeral carries order, the owner tag
 * carries who, and nothing carries progress, because nothing here measures progress. Adding a
 * `state` prop later would recreate the exact failure: the moment progress can be read from
 * storage, the list belongs on `StepJourney` and its receipt invariant, not on a widened version
 * of this.
 *
 * The steps are dividers on a shared ground rather than cards, per the no-nested-cards rule: this
 * always renders inside a record sheet that already has a face.
 */
export function ReviewChecklist({ className, label, steps }: ReviewChecklistProps) {
  return (
    <ol
      aria-label={label}
      className={cn("m-0 flex list-none flex-col p-0", className)}
      data-slot="review-checklist"
    >
      {steps.map((step, index) => (
        <li
          className="flex gap-[var(--s-3)] border-b border-[var(--line-soft)] py-[var(--s-2)] last:border-b-0"
          data-slot="review-checklist-step"
          key={step.key}
        >
          {/*
            * Outline only, in every position. The artifact fills the first circle to say "you are
            * here", and that is the one thing this list may not claim. An identical mark on all
            * six is the honest drawing of six steps nobody has reported progress against.
            */}
          <span
            aria-hidden="true"
            className="mono mt-[2px] grid size-[20px] shrink-0 place-items-center rounded-[var(--r-full)] border border-[var(--line-strong)] text-[10.5px] leading-none tabular-nums text-[color:var(--muted)]"
            data-slot="review-checklist-index"
          >
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] leading-[1.3] font-medium text-[color:var(--ink)]">
              {step.title}
            </span>
            <span className="mt-[2px] block max-w-[var(--measure-prose)] text-[11.5px] leading-[1.5] text-[color:var(--muted)]">
              {step.body}
            </span>
          </span>
          <Overline
            className={cn(
              "mt-[3px] shrink-0",
              step.owner.external && "text-[color:var(--waiting-text)]",
            )}
            data-slot="review-checklist-owner"
          >
            {step.owner.label}
          </Overline>
        </li>
      ))}
    </ol>
  );
}

/**
 * The line that says the list above is a description of work rather than a report on it.
 *
 * It is a component rather than a string so that every surface borrowing this list has to render
 * the same disclaimer with it, in the same place, instead of each one wording its own.
 */
export function ReviewChecklistUntracked({ children }: { children: ReactNode }) {
  return (
    <MonoMeta className="block max-w-[var(--measure-wide)]" data-slot="review-checklist-untracked">
      {children}
    </MonoMeta>
  );
}
