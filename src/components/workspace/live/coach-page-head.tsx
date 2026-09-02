import type { ReactNode } from "react";

import { Prose } from "@/components/kit/atomics";
import { COACH_LEAD_CLASS } from "./coach-type";

/**
 * What the rows on a coach page are, said once under the title.
 *
 * The same three sentences `PageHeader` prints for a provenance, kept verbatim so a seeded demo
 * tenant is labelled here exactly as it is on every other screen. The hard rule is that test and
 * demo data are labelled on-screen, and it does not become optional because the head is drawn at
 * coach size.
 */
export const PROVENANCE_COPY: Record<CoachProvenance, string> = {
  demo: "Demo data, excluded from real analytics",
  real: "Real data",
  test: "Test data, excluded from real analytics",
  /*
   * The arm for a read that did not answer, and it says that rather than guessing.
   *
   * Every other surface derives its provenance from a read whose failure has already thrown by the
   * time the head renders. Coach setup does not: its provenance is its own small query, so "we
   * could not read this" is a state that reaches the screen. Printing "Real data" there would be
   * an invented affirmative on no evidence -- the same thing the grounding rule stops the agent
   * doing with a price -- and printing nothing is the bug this arm exists to close, because an
   * unlabelled page is indistinguishable from a page whose rows are known to be real.
   */
  unknown: "We could not confirm whether this workspace holds real or demo records",
};

export type CoachProvenance = "demo" | "real" | "test" | "unknown";

export type CoachPageHeadProps = {
  /**
   * The one action the canvas draws beside a coach title, and never more than one. Home, Leads
   * and Billing draw none; `/coach/agent` draws "Try a conversation". Anything that is a filter,
   * an export or a view switch belongs on the row below the head, not in it.
   */
  action?: ReactNode;
  /** Omitted where the surface has no provenance to state, which is no coach page today. */
  provenance?: CoachProvenance;
  /** The canvas's own sentence under the title. One sentence, no second paragraph. */
  sub: string;
  title: string;
  /** Stamped as `data-page-head` so a test can name the head it is reading. */
  surface: string;
};

/**
 * The coach page head, at the coach side's scale rather than the console's.
 *
 * This is a local head instead of `PageHeader` for one reason: `PageHeader` sets its title with
 * `.t-page-title`, which is the console's 20px, and there is no prop that moves it. The canvas
 * draws every coach page at `--coach-page-title` -- 46px, weight 500, tracking -0.026em -- and
 * that size is not decoration. It is the first thing a reader over 55 sees and the reason coach
 * Home stopped reading as a spreadsheet, so a coach screen that keeps the console's title is not
 * ported however faithful the rest of it is.
 *
 * What `PageHeader` also carried and is deliberately not reproduced: the crumb list, which no
 * coach artboard draws at all, and the multi-sentence description, which the canvas replaces with
 * one line. `PageHeader`'s one-filled-action rule survives as the single `action` slot.
 */
export function CoachPageHead({
  action,
  provenance,
  sub,
  surface,
  title,
}: CoachPageHeadProps) {
  return (
    <header
      className="flex min-w-0 flex-wrap items-end justify-between gap-[var(--s-5)]"
      data-page-head={surface}
    >
      <div className="flex min-w-0 flex-col gap-[var(--s-2)]">
        <h1 className="coach-page-title m-0">{title}</h1>
        <Prose className={`m-0 ${COACH_LEAD_CLASS}`}>{sub}</Prose>
        {/*
          16px `--muted`, which is the treatment the ruling that kept this a sentence was made on.

          The canvas draws a bordered mono chip here (`Main.dc.html:99`), and the ruling is that the
          sentence wins: on a surface built for readers over 55 a 13px uppercase lozenge is the
          wrong form for the product's most safety-relevant label, and `coach-support.tsx:35`
          records the same rule in the same words. But the sentence was rendering at 15px in
          `--faint`, the quietest pairing on the page -- so the argument for keeping it ("we say it
          in words, legibly") was being made about a line that was neither of those. Whichever form
          wins, this is the line that tells a coach the numbers above it are not their business's,
          and it cannot be the faintest thing on the screen while being the reason we refused the
          chip.
        */}
        {provenance ? (
          <p
            className="m-0 text-[length:var(--coach-body)] leading-[1.45] text-[color:var(--muted)]"
            data-provenance={provenance}
          >
            {PROVENANCE_COPY[provenance]}
          </p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
    </header>
  );
}
