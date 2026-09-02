import type { ReactNode } from "react";

import { CoachScale } from "@/components/coach-scale";
import { Prose } from "@/components/kit/atomics";

/**
 * The stage the setup flow stands on, before there is a workspace to stand in.
 *
 * Onboarding lives outside the workspace shell, so it has to draw its own pane -- the rest of the
 * product gets `--pane-bloom` from the shell's content pane, which `docs/DESIGN.md` names as the
 * page's only light source, and a standalone route that skips it reads flat and visibly unlike
 * every surface a coach sees afterwards. On the first screen of the product that is the wrong
 * first impression to make.
 *
 * What it draws is the artboard's setup chrome: the mark and nothing else. There is deliberately
 * no nav on these screens -- no pill bar, no rail -- because none of those destinations exists for
 * this reader yet, and a bar of links to pages that will 404 or bounce them back here is worse
 * than no bar. `CoachScale` carries the 16px body and the 44px control floor; see that file for
 * why the coach language is loaned to a pre-workspace surface rather than retyped here.
 */
export function OnboardingStage({
  children,
  lead,
  steps,
  title,
  width = "wide",
}: {
  children: ReactNode;
  /** One sentence under the title. */
  lead?: ReactNode;
  /**
   * The four-step position strip, above the title. A `<SetupSteps>` and nothing else -- it is a
   * slot rather than a `current` prop because only the page knows which steps it can prove are
   * done, and the stage must not be able to tick one on its own.
   */
  steps?: ReactNode;
  title: string;
  /** `wide` is the three-across connect grid; `narrow` is a single form column. */
  width?: "narrow" | "wide";
}) {
  return (
    <CoachScale
      as="main"
      className="min-h-svh bg-[var(--canvas)] pb-[56px] text-[color:var(--body)]"
      style={{ backgroundImage: "var(--pane-bloom)" }}
    >
      <div className="flex h-[76px] items-center border-b border-[var(--line)] bg-[var(--pane)] px-[var(--s-4)] sm:px-[40px]">
        <OnboardingLockup />
      </div>

      <div
        className="@container mx-auto flex w-full flex-col gap-[var(--s-6)] px-[var(--s-4)] pt-[34px] sm:px-[40px]"
        style={{ maxWidth: width === "wide" ? "1280px" : "760px" }}
      >
        {steps}

        <header className="flex flex-col gap-[10px]">
          <h1 className="coach-page-title m-0">{title}</h1>
          {lead ? (
            <Prose className="text-[18px] leading-[1.5] text-[color:var(--muted)]" measure="wide">
              {lead}
            </Prose>
          ) : null}
        </header>
        {children}
      </div>
    </CoachScale>
  );
}

/**
 * The mark, identical to the one on the sign-in stage. Drawn rather than imported from
 * `auth-shell` because that module is a server-and-client boundary the auth pages own; this is one
 * `<svg>` and a word, and sharing it would couple the setup flow to the sign-in flow's exports for
 * no gain.
 */
function OnboardingLockup() {
  return (
    <p className="m-0 flex items-center gap-[var(--s-3)]">
      <span className="grid size-[38px] place-items-center rounded-[10px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[color:var(--accent-text)]">
        <svg
          aria-hidden="true"
          fill="none"
          height="20"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.75"
          viewBox="0 0 24 24"
          width="20"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      </span>
      {/*
        One word in one colour, which is how every artboard draws it. The two-tone version put a
        second accent on a screen that already spends one on the mark beside it and one on the
        submit, and the accent reads as emphasis only while it stays scarce -- a wordmark is not
        emphasis, it is the name of the place.
      */}
      <span className="text-[20px] font-[600] tracking-[-0.014em] text-[color:var(--ink)]">
        SetterFi
      </span>
    </p>
  );
}
