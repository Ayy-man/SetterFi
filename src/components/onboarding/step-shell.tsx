import Link from "next/link";
import type { ReactNode } from "react";

import { CoachScale } from "@/components/coach-scale";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEP_KEYS,
  ONBOARDING_STEP_HREFS,
  type OnboardingStepKey,
} from "@/components/onboarding/setup-status";

/**
 * The chrome the six setup screens share, drawn from `OnboardingStep.dc.html` and
 * `OnboardingStepMobile.dc.html`.
 *
 * It replaces `onboarding-shell.tsx`, whose 76px header packed a mark, a five dot rail, a mono
 * "Step 2 of 5" and a "Save and exit" button into one non-wrapping flex row. That row is the cause
 * the visual audit measured for defect 9: every sub-route reported `scrollWidth` 416 against a
 * `clientWidth` of 390, so the page slid 26px sideways under a coach's thumb. The board's answer
 * is not a narrower header, it is a different anatomy: the header carries the mark and the eye
 * only, the position moves into the page as words under a hairline rail, and the way out becomes a
 * plain link beside the one button.
 *
 * **The step title is the h1, and there is no header band above it.** Note 5 ruled that a step's
 * form panel carries no band because the title already names it, which is also what stops the
 * screen saying the same thing twice within 200px.
 *
 * **One filled button, and one plain way out.** `Continue` is the page's only accent fill; the
 * way out is an inline link at a 44px hit box. At 390px the pair becomes a sticky full-width
 * footer, and it is the same DOM node moved by CSS rather than a second copy, so the accent-fill
 * count is one at every width.
 *
 * The way out says what it does. It lands on the Setup list and saves nothing, so the default
 * label is "Back to your setup" on every step: a step already done (Google connected, the offer
 * read back) has nothing to save, and a label that said "Save" on it was a claim about work that
 * did not exist. The one step whose form can hold unsaved edits passes `exitLabel` to say so.
 *
 * Server-renderable, and directive-free, so the three steps that own a form can import the
 * constants below without dragging a client boundary across the pages that do not.
 */

/** The 48px field face every setup input and stated value wears. `OnboardingStep.dc.html:70`. */
export const STEP_FIELD_CLASS =
  "h-[48px] w-full min-w-0 rounded-[9px] border border-[var(--line-input)] bg-[var(--well)] "
  + "px-[16px] text-[16px] leading-[1.5] text-[color:var(--ink)] "
  + "placeholder:text-[color:var(--muted)]";

/** The same face carrying a value the coach cannot type into. */
export const STEP_READBACK_CLASS =
  "m-0 flex min-h-[48px] w-full min-w-0 items-center gap-[10px] rounded-[9px] "
  + "border border-[var(--line-input)] bg-[var(--well)] px-[16px] py-[10px] text-[16px] "
  + "leading-[1.5] text-[color:var(--ink)]";

/** Label above the field, 16px muted. The board sets these at body size, not at small. */
export const STEP_LABEL_CLASS = "mb-[6px] block text-[16px] leading-[1.4] text-[color:var(--muted)]";

export const STEP_MONO_CLASS =
  "font-[family-name:var(--font-mono)] [font-variant-numeric:tabular-nums_lining-nums]";

/** The panel face, from the vocabulary's panel snippet. A step panel has no header band. */
export const STEP_PANEL_CLASS =
  "flex flex-col overflow-hidden rounded-[24px_24px_17px_17px] border border-[var(--line)] "
  + "bg-[linear-gradient(180deg,var(--card-top),var(--card))] shadow-[var(--shadow-card)]";

/** The one filled button on a step, at the vocabulary's primary size. */
export const STEP_PRIMARY_CLASS =
  "inline-flex h-[48px] w-full items-center justify-center gap-[10px] rounded-[9px] "
  + "border border-[var(--accent-line)] bg-[image:var(--accent-fill)] px-[24px] text-[16px] "
  + "font-[600] whitespace-nowrap text-[color:var(--on-accent)] shadow-[var(--primary-shadow)] "
  + "no-underline disabled:opacity-60 sm:w-auto";

/** The secondary face, for a step's own in-panel action. Never the page's forward action. */
export const STEP_SECONDARY_CLASS =
  "inline-flex h-[48px] items-center justify-center gap-[10px] rounded-[9px] border "
  + "border-[var(--line)] bg-[var(--control-fill)] px-[22px] text-[16px] font-[500] "
  + "text-[color:var(--body)] no-underline disabled:opacity-60";

/** The plain link face, with the vocabulary's 44px hit box around a 16px word. */
export const STEP_LINK_CLASS =
  "-my-[10px] inline-flex min-h-[44px] items-center px-[2px] text-[16px] "
  + "text-[color:var(--accent-text)] hover:underline";

const RAIL_SEGMENT_FILL: Record<"done" | "current" | "later", string> = {
  current: "var(--accent)",
  done: "var(--good)",
  later: "var(--line)",
};

/**
 * The rail collapsed to a line.
 *
 * Six segments, no numerals, no targets. The shipped rail drew ticks for some steps and circled
 * numbers for others, so a reader saw "2, 3, 4, 6" and concluded a step was missing. A hairline
 * carries the same position with nothing to misread, and because it is `aria-hidden` the position
 * is stated once, in the words beneath it, rather than twice.
 */
function StepRail({ step }: { step: number }) {
  return (
    <div aria-hidden="true" className="flex w-full gap-[6px]">
      {ONBOARDING_STEP_KEYS.map((key, index) => {
        const position = index + 1;
        const state = position < step ? "done" : position === step ? "current" : "later";
        return (
          <span
            className="h-[6px] flex-1 rounded-full"
            key={key}
            style={{ background: RAIL_SEGMENT_FILL[state] }}
          />
        );
      })}
    </div>
  );
}

export type OnboardingStepShellProps = {
  children: ReactNode;
  /** The sentences this screen no longer prints under its heading. */
  eyeCopy: string;
  /** Stable eye id, so hiding one step's eye leaves the others alone. */
  eyeScreen: string;
  /** One sentence under the h1. The board's lead; never two. */
  lead: string;
  /** The step this screen is, by key, which fixes both its number and its title. */
  stepKey: OnboardingStepKey;
  /**
   * The page's forward action. A node rather than an href, because three of the six steps submit
   * a form and three navigate, and both belong in the same sticky footer at 390px.
   */
  primary: ReactNode;
  /** The board's measure for this step. */
  width?: number;
  /** Overrides the step title as the h1, for a step whose board words differ from its rung. */
  title?: string;
  /**
   * The way out's label. Defaults to "Back to your setup". A step with unsaved edits passes a
   * label that says the edits will be left behind; nothing else should override it.
   */
  exitLabel?: string;
};

export const STEP_EXIT_HREF = "/coach/get-started";
export const STEP_EXIT_LABEL = "Back to your setup";

export function OnboardingStepShell({
  children,
  exitLabel = STEP_EXIT_LABEL,
  eyeCopy,
  eyeScreen,
  lead,
  primary,
  stepKey,
  title,
  width = 720,
}: OnboardingStepShellProps) {
  const step = ONBOARDING_STEP_KEYS.indexOf(stepKey) + 1;

  return (
    <CoachScale
        as="main"
        className="flex min-h-svh flex-col bg-[var(--canvas)] text-[color:var(--body)]"
        style={{ backgroundImage: "var(--pane-bloom)" }}
      >
        <OnboardingTopBar eye={<ContextEye copy={eyeCopy} screen={eyeScreen} />} />

        <div
          className="mx-auto flex w-full flex-grow flex-col px-[var(--s-4)] pt-[24px] sm:px-[40px] sm:pt-[36px]"
          style={{ maxWidth: `${width}px` }}
        >
          <StepRail step={step} />

          <header className="mt-[20px] mb-[24px] flex flex-col sm:mt-[24px] sm:mb-[32px]">
            <p className="m-0 mb-[8px] text-[16px] leading-[1.5] text-[color:var(--muted)]">
              {`Step ${step} of ${ONBOARDING_STEP_COUNT}`}
            </p>
            <h1 className="m-0 mb-[12px] text-[34px] leading-[1.05] font-[600] tracking-[-0.026em] text-[color:var(--ink)] sm:text-[46px]">
              {title ?? STEP_H1[stepKey]}
            </h1>
            <p className="m-0 max-w-[var(--measure-wide)] text-[16px] leading-[1.5] text-[color:var(--body)] sm:text-[17px]">
              {lead}
            </p>
          </header>

          {children}

          {/*
            One footer, two shapes. At 390px it is the board's sticky bar: full-bleed by a negative
            margin that exactly cancels the container's own padding, so it can never widen the page.
            From `sm` up it is the board's inline row, the button auto width with the plain link
            beside it. `flex-col-reverse` puts the link above the button on the phone, which is the
            order the mobile board draws.
          */}
          <div
            className="sticky bottom-0 z-20 -mx-[var(--s-4)] mt-auto flex flex-col-reverse items-stretch gap-[12px] border-t border-[var(--line)] bg-[var(--pane)] px-[var(--s-4)] pt-[12px] pb-[16px] sm:static sm:mx-0 sm:mt-[32px] sm:mb-[40px] sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-[24px] sm:gap-y-[16px] sm:border-0 sm:bg-transparent sm:px-0 sm:pt-0"
            data-slot="onboarding-step-footer"
          >
            {primary}
            <Link
              className={`${STEP_LINK_CLASS} justify-center sm:justify-start`}
              data-slot="onboarding-step-exit"
              href={STEP_EXIT_HREF}
            >
              {exitLabel}
            </Link>
          </div>
        </div>
    </CoachScale>
  );
}

/**
 * The h1 for each step.
 *
 * Deliberately not `ONBOARDING_STEP_TITLES`. The rung on the overview names the step in a list
 * ("Business profile"); the step's own h1 is the board's sentence for the page a coach is standing
 * on ("Your business profile"). One is a label in a column of six, the other is the title of a
 * screen, and collapsing them would make one of the two read wrong.
 */
const STEP_H1: Record<OnboardingStepKey, string> = {
  business_profile: "Your business profile",
  connect: "Where your leads reach you",
  texting: "Can your business send texts",
  calendar: "Where your calls should land",
  offer: "Your offer",
  go_live: "Turn your agent on",
};

/**
 * The top bar: the mark, the word for where you are, and the eye.
 *
 * The board also draws a bell and an account chip here. Neither is drawn: onboarding runs before
 * there is a workspace, the notifications surface it would open lives behind the console shell,
 * and an account chip that opens nothing is a control that lies. The eye is the one thing in the
 * board's trailing group that has somewhere to go on this route, and it is in the header rather
 * than floating because `context-eye.tsx` records the floating corner as the placement with the
 * known collision defect.
 */
function OnboardingTopBar({ eye }: { eye: ReactNode }) {
  return (
    <div className="flex h-[64px] flex-none items-center gap-[16px] border-b border-[var(--line)] bg-[var(--pane)] px-[var(--s-4)] sm:h-[76px] sm:gap-[32px] sm:px-[40px]">
      <OnboardingMark />
      <span className="mx-auto hidden text-[20px] font-[500] tracking-[-0.015em] text-[color:var(--ink)] sm:block">
        Setup
      </span>
      <span className="ml-auto flex items-center sm:ml-0">{eye}</span>
    </div>
  );
}

/** The mark, drawn the way every artboard draws it: one glyph, one word, one colour. */
export function OnboardingMark() {
  return (
    <p className="m-0 flex shrink-0 items-center gap-[10px] sm:gap-[12px]">
      <span className="grid size-[36px] place-items-center rounded-[10px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[color:var(--accent-text)] sm:size-[38px]">
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
      <span className="text-[18px] font-[600] tracking-[-0.014em] text-[color:var(--ink)] sm:text-[20px]">
        SetterFi
      </span>
    </p>
  );
}

/** One label per field, so every control on these screens is named by something visible. */
export function StepField({
  children,
  error,
  id,
  label,
}: {
  children: ReactNode;
  /** The sentence under the control when it stopped a save; the control is red while it stands. */
  error?: string | null;
  id: string;
  label: string;
}) {
  return (
    <div className="min-w-0" data-invalid={error ? "true" : undefined} data-slot="onboarding-field">
      <label className={STEP_LABEL_CLASS} htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="m-0 mt-[6px] text-[14px] leading-[1.4] font-medium text-[color:var(--failure-text)]" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A stated value in the field's face, for the rows a coach does not fill in. */
export function StepReadback({
  absent,
  children,
  mono,
}: {
  /** Renders muted, and marks the row so a test can tell a stated absence from a value. */
  absent?: boolean;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <p
      className={[
        STEP_READBACK_CLASS,
        mono ? STEP_MONO_CLASS : "",
        absent ? "text-[color:var(--muted)]" : "",
      ].filter(Boolean).join(" ")}
      data-absent={absent ? "true" : undefined}
    >
      {children}
    </p>
  );
}

/** The href of the step after this one, for a screen whose forward action is a link. */
export function nextStepHref(stepKey: OnboardingStepKey): string {
  const index = ONBOARDING_STEP_KEYS.indexOf(stepKey);
  const next = ONBOARDING_STEP_KEYS[index + 1];
  return next ? ONBOARDING_STEP_HREFS[next] : "/coach/home";
}
