import Link from "next/link";
import type { ReactNode } from "react";

import { CoachScale } from "@/components/coach-scale";
import { StatusDot, kitButtonClass } from "@/components/kit/atomics";
import type { Tone } from "@/components/kit/atomics";
import { cn } from "@/lib/utils";

/**
 * The chrome the five setup screens share, drawn from the `Onboarding*.body.html` artboards.
 *
 * It is the top strip and nothing else: the mark, the position readout, and the way out. The
 * artboards draw the same bar on all five steps with one dot filled, so the position lives here
 * rather than being retyped five times, and a step can only say which of the five it is -- it
 * cannot tick a step it has no evidence for, because there is nothing to tick. The old
 * `SetupSteps` strip stays where it is for the pre-rehaul path; this is a position readout for a
 * linear five-screen wizard, which is a different claim from that strip's four proved steps.
 *
 * Server-renderable on purpose. Three of the five steps are client components because they own a
 * form; the chrome around them does not have to be.
 */

export const ONBOARDING_STEP_COUNT = 5;

const H1_CLASS =
  "m-0 text-[46px] leading-[1.05] font-semibold tracking-[-0.025em] text-[color:var(--ink)]";

const MONO_META_CLASS =
  "font-[family-name:var(--font-mono)] text-[13px] leading-[1.4] text-[color:var(--muted)] "
  + "[font-variant-numeric:tabular-nums_lining-nums]";

/** The 48px field face every setup input and read-back wears. */
export const ONBOARDING_FIELD_CLASS =
  "h-[48px] w-full min-w-0 rounded-[10px] border border-[var(--line-input)] bg-[var(--well)] "
  + "px-[14px] text-[16px] leading-[1.4] text-[color:var(--ink)] "
  + "placeholder:text-[color:var(--muted)]";

/** The same face for a value the coach cannot type into. */
export const ONBOARDING_READBACK_CLASS =
  `flex items-center gap-[10px] ${ONBOARDING_FIELD_CLASS}`;

export const ONBOARDING_LABEL_CLASS =
  "mb-[6px] block text-[13px] leading-[1.4] font-medium text-[color:var(--muted)]";

export const ONBOARDING_SENTENCE_CLASS =
  "m-0 max-w-[58ch] text-[16px] leading-[1.5] text-[color:var(--muted)]";

export const ONBOARDING_MONO_CLASS =
  "font-[family-name:var(--font-mono)] [font-variant-numeric:tabular-nums_lining-nums]";

export type OnboardingStatusItem = {
  tone: Tone;
  label: string;
};

/** One label per field, so every control on these screens is named by something visible. */
export function OnboardingField({
  children,
  id,
  label,
}: {
  children: ReactNode;
  id: string;
  label: string;
}) {
  return (
    <div className="min-w-0">
      <label className={ONBOARDING_LABEL_CLASS} htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

/** A stated value in the field's face, for the rows the coach does not fill in. */
export function OnboardingReadback({
  absent,
  children,
  className,
  mono,
}: {
  /** Renders muted, and marks the row so a test can tell a stated absence from a value. */
  absent?: boolean;
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <p
      className={cn(
        "m-0",
        ONBOARDING_READBACK_CLASS,
        mono ? ONBOARDING_MONO_CLASS : null,
        absent ? "text-[color:var(--muted)]" : null,
        className,
      )}
      data-absent={absent ? "true" : undefined}
    >
      {children}
    </p>
  );
}

/**
 * The footer bar every step ends on: one sentence, then the step's controls.
 *
 * One sentence is the ceiling, and the primary in `actions` is the step's single fill. Everything
 * that used to be a paragraph of help under a heading belongs to the context eye instead.
 */
export function OnboardingFooter({
  actions,
  sentence,
}: {
  actions: ReactNode;
  sentence: string;
}) {
  return (
    <div
      className="flex flex-col items-start gap-[16px] rounded-[17px] border border-[var(--line)] bg-[var(--pane)] px-[20px] py-[16px] @min-[720px]:flex-row @min-[720px]:items-center"
      data-slot="onboarding-footer"
    >
      <p className={ONBOARDING_SENTENCE_CLASS}>{sentence}</p>
      <div className="flex shrink-0 flex-wrap items-center gap-[12px] @min-[720px]:ml-auto">
        {actions}
      </div>
    </div>
  );
}

export function OnboardingShell({
  children,
  status,
  step,
  title,
  width = 1200,
}: {
  children: ReactNode;
  /** The dot-and-word row under the title. Real state only; never a step's position restated. */
  status?: readonly OnboardingStatusItem[];
  /** Which of the five screens this is, 1-indexed. */
  step: number;
  title: string;
  /** The artboard's own measure for this step. */
  width?: number;
}) {
  const dots = Array.from({ length: ONBOARDING_STEP_COUNT }, (_, index) => index + 1);

  return (
    <CoachScale
      as="main"
      className="min-h-svh bg-[var(--canvas)] pb-[56px] text-[color:var(--body)]"
      style={{ backgroundImage: "var(--pane-bloom)" }}
    >
      <div className="flex h-[76px] items-center gap-[16px] border-b border-[var(--line)] bg-[var(--pane)] px-[var(--s-4)] sm:px-[40px]">
        <OnboardingMark />

        <div className="mx-auto flex items-center gap-[14px]">
          <span aria-hidden="true" className="flex gap-[7px]">
            {dots.map((dot) => (
              <span
                className={cn(
                  "size-[9px] rounded-full",
                  dot === step ? "bg-[var(--ink)]" : "bg-[var(--line-input)]",
                )}
                key={dot}
              />
            ))}
          </span>
          <span className={MONO_META_CLASS}>{`Step ${step} of ${ONBOARDING_STEP_COUNT}`}</span>
        </div>

        <Link
          className={kitButtonClass({
            className: "h-[44px] px-[18px] text-[15px] no-underline",
            variant: "secondary",
          })}
          href="/onboarding"
        >
          Save and exit
        </Link>
      </div>

      <div
        className="@container relative mx-auto flex w-full flex-col gap-[24px] px-[var(--s-4)] pt-[34px] sm:px-[40px]"
        style={{ maxWidth: `${width}px` }}
      >
        <header className="flex flex-col gap-[12px]">
          <h1 className={H1_CLASS}>{title}</h1>
          {status && status.length > 0 ? (
            <p className="m-0 flex flex-wrap items-center gap-x-[22px] gap-y-[6px] text-[15px] leading-[1.4] text-[color:var(--body)]">
              {status.map((item) => (
                <span className="inline-flex items-center gap-[8px]" key={item.label}>
                  <StatusDot size={6} tone={item.tone} />
                  {item.label}
                </span>
              ))}
            </p>
          ) : null}
        </header>

        {children}
      </div>
    </CoachScale>
  );
}

/** The mark, drawn the same way the pre-rehaul setup stage draws it. */
function OnboardingMark() {
  return (
    <p className="m-0 flex shrink-0 items-center gap-[var(--s-3)]">
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
      <span className="text-[20px] font-[600] tracking-[-0.014em] text-[color:var(--ink)]">
        SetterFi
      </span>
    </p>
  );
}
