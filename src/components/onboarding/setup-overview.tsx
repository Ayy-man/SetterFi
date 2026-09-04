import Link from "next/link";
import type { ReactNode } from "react";

import { TONE_LINE, TONE_MARK, TONE_TEXT, TONE_WASH } from "@/components/kit/atomics";
import { CoachScale } from "@/components/coach-scale";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { OnboardingMark, STEP_PRIMARY_CLASS } from "@/components/onboarding/step-shell";
import {
  ONBOARDING_STEP_COUNT,
  resumeStep,
  setupHeadline,
  stepsDone,
  type OnboardingStepRow,
} from "@/components/onboarding/setup-status";

/**
 * The setup root, drawn from `OnboardingOverview.dc.html`.
 *
 * The N26 vertical status list the Mobbin research settled on: one panel, six rungs, a state on
 * each, and one button at the foot that resumes wherever the coach actually is. The audit called
 * the shipped root the best composed coach screen in the product and named three defects on it.
 * All three are structural rather than cosmetic, and all three are fixed here by the same move.
 *
 * **The counter and the rows are one array.** `stepsDone(steps)` counts the rows this component
 * maps, so "2 of 6 done" cannot drift from what a reader can see, and the headline above counts
 * the same array again rather than reading a second source. That is defect 1, the three-way
 * disagreement, closed by construction rather than by a corrected constant.
 *
 * **Later steps carry a plain ring with no numeral.** The shipped rail drew ticks for steps 1, 5
 * and 7 and circled numbers for 2, 3, 4 and 6, so a reader saw "2, 3, 4, 6" and concluded a step
 * was missing. There are no numerals now, which removes the sequence a reader can find a hole in.
 *
 * **Nothing on the page is drenched.** Defect 3 was the accent spent on a panel of prose while the
 * real action sat beneath it in grey. The explanation is the eye's, and the accent is spent once,
 * on the button that resumes.
 */

export type SetupOverviewProps = {
  steps: readonly OnboardingStepRow[];
};

/** The sentences this screen used to print as panels of prose, handed to the eye instead. */
export const SETUP_OVERVIEW_EYE_COPY =
  "Setup has six steps and you can leave and come back at any point, because every answer is "
  + "saved as you go. A step marked done has saved evidence behind it, never a guess from where "
  + "you are in the list, so a step you finished out of order still shows as done. Texting is the "
  + "one step no one here can move: the phone carriers vet every business that wants to send "
  + "texts in the US, that review runs about three weeks, and nobody is given a finish date, which "
  + "is why this page counts real days and never shows a percentage. Instagram and Messenger are "
  + "unaffected by it, so the rest of your setup keeps working while it waits. Nothing you connect "
  + "starts answering your leads until you press the button on the last step.";

export function SetupOverview({ steps }: SetupOverviewProps) {
  const done = stepsDone(steps);
  const resume = resumeStep(steps);

  return (
    <CoachScale
      as="main"
      className="min-h-svh bg-[var(--canvas)] text-[color:var(--body)]"
      style={{ backgroundImage: "var(--pane-bloom)" }}
    >
      <div className="flex h-[64px] items-center gap-[16px] border-b border-[var(--line)] bg-[var(--pane)] px-[var(--s-4)] sm:h-[76px] sm:gap-[32px] sm:px-[40px]">
        <OnboardingMark />
        <span className="mx-auto hidden text-[20px] font-[500] tracking-[-0.015em] text-[color:var(--ink)] sm:block">
          Setup
        </span>
        <span className="ml-auto flex items-center sm:ml-0">
          <ContextEye copy={SETUP_OVERVIEW_EYE_COPY} screen="onboarding-overview" />
        </span>
      </div>

      <div className="mx-auto w-full max-w-[1280px] px-[var(--s-4)] pt-[24px] pb-[56px] sm:px-[40px] sm:pt-[36px] sm:pb-[96px]">
        <header className="mb-[24px] sm:mb-[32px]">
          <h1 className="m-0 mb-[12px] text-[34px] leading-[1.05] font-[600] tracking-[-0.026em] text-[color:var(--ink)] sm:text-[46px]">
            Set up your agent
          </h1>
          <p className="m-0 max-w-[76ch] text-[16px] leading-[1.5] text-[color:var(--body)] sm:text-[17px]">
            {`${setupHeadline(steps)}. The rest is with us and the carriers.`}
          </p>
        </header>

        <div className="grid grid-cols-1 items-start gap-[20px] lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:gap-[24px]">
          <section
            aria-labelledby="onboarding-setup-heading"
            className="flex flex-col overflow-hidden rounded-[24px_24px_17px_17px] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] shadow-[var(--shadow-card)]"
          >
            <div className="flex min-h-[78px] flex-col justify-center border-b border-[var(--line)] px-[16px] py-[19px] sm:px-[20px]">
              <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
                Six steps, in order
              </span>
              <h2
                className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
                id="onboarding-setup-heading"
              >
                {`${done} of ${ONBOARDING_STEP_COUNT} done`}
              </h2>
            </div>

            <ol className="m-0 flex list-none flex-col p-0">
              {steps.map((step, index) => (
                <StepRung key={step.key} last={index === steps.length - 1} step={step} />
              ))}
            </ol>

            {/*
              The board's foot: one sentence about coming back, and the page's only filled button.
              It names the step it resumes to, so the reader knows where it goes before pressing it.
              With every step proved there is nothing to resume, and the row says so rather than
              offering a button whose only outcome is landing back on a finished screen.
            */}
            <div className="flex flex-col gap-[16px] border-t border-[var(--line)] bg-[var(--well)] px-[16px] py-[20px] sm:flex-row sm:items-center sm:justify-between sm:px-[20px]">
              <p className="m-0 max-w-[44ch] text-[16px] leading-[1.55] text-[color:var(--muted)]">
                You can leave and come back. Every answer is saved as you go.
              </p>
              {resume ? (
                <Link className={STEP_PRIMARY_CLASS} href={resume.href}>
                  {`Continue with ${resume.title.toLowerCase()}`}
                </Link>
              ) : (
                <p className="m-0 text-[16px] leading-[1.55] font-[500] text-[color:var(--ink)]">
                  Nothing here is left to finish.
                </p>
              )}
            </div>
          </section>

          <div className="flex flex-col gap-[20px]">
            <HandledPanel />
            <AskPanel />
          </div>
        </div>
      </div>
    </CoachScale>
  );
}

/**
 * One rung: the node, the connector, the name, one sentence, and the state.
 *
 * The connector is drawn by the rung rather than by the list, which is the fix coach Home made for
 * the same defect: a single line running to a fixed offset from the bottom of the last row breaks
 * the moment a row's height changes with its content.
 */
function StepRung({ last, step }: { last: boolean; step: OnboardingStepRow }) {
  return (
    <li
      className="flex flex-wrap items-start gap-x-[14px] gap-y-[12px] px-[16px] py-[20px] sm:flex-nowrap sm:gap-x-[20px] sm:px-[20px]"
      data-slot="onboarding-step-rung"
      data-state={step.state}
      style={last ? undefined : { borderBottom: "1px solid var(--line-soft)" }}
    >
      <span className="flex w-[44px] flex-none flex-col items-center self-stretch">
        <StepNode state={step.state} />
        {last ? null : (
          <span
            aria-hidden="true"
            className="mt-[8px] -mb-[28px] w-[2px] flex-grow bg-[var(--line)]"
          />
        )}
      </span>

      <span className="flex min-w-0 flex-grow basis-[200px] flex-col pt-[8px]">
        <h3 className="m-0 text-[18px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)] sm:text-[20px]">
          {step.title}
        </h3>
        <p className="m-0 mt-[6px] max-w-[56ch] text-[16px] leading-[1.55] text-[color:var(--muted)]">
          {step.sentence}
        </p>
      </span>

      {/*
        One pill, one place in the DOM. It wraps to its own line at 390px and sits at the end of
        the row from `sm` up, which is the board's two layouts without a second copy of the words:
        two copies would read the state twice to a screen reader and would be the same fact said
        twice on one row, which is the rule the audit found broken across this flow.
      */}
      {step.pill ? (
        <span className="w-full pl-[58px] sm:w-auto sm:flex-none sm:pt-[12px] sm:pl-0">
          <StatePill label={step.pill.label} tone={step.pill.tone} />
        </span>
      ) : null}
    </li>
  );
}

/**
 * The node beside a rung: a check when done, filled when current, a plain ring otherwise.
 *
 * No numerals, which is Note 5's ruling and the fix for the audit's "2, 3, 4, 6". The waiting arm
 * takes the current node's shape in the waiting tone, because a step with work genuinely under way
 * is not an empty ring.
 */
function StepNode({ state }: { state: OnboardingStepRow["state"] }) {
  if (state === "done") {
    return (
      <span
        className="grid size-[44px] flex-none place-items-center rounded-full border"
        style={{
          background: TONE_WASH.good,
          borderColor: TONE_LINE.good,
          color: TONE_TEXT.good,
        }}
      >
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
          <path d="m5 13 4 4L19 7" />
        </svg>
      </span>
    );
  }

  if (state === "current" || state === "waiting") {
    const tone = state === "current" ? "accent" : "waiting";
    return (
      <span
        className="grid size-[44px] flex-none place-items-center rounded-full border"
        style={{ background: TONE_WASH[tone], borderColor: TONE_LINE[tone] }}
      >
        <span
          aria-hidden="true"
          className="size-[16px] rounded-full"
          style={{ background: TONE_MARK[tone] }}
        />
      </span>
    );
  }

  return (
    <span className="size-[44px] flex-none rounded-full border border-[var(--line)] bg-[var(--well)]" />
  );
}

/** The vocabulary's 32px state pill: a dot, then the word. Never pressable. */
function StatePill({ label, tone }: { label: string; tone: keyof typeof TONE_WASH }) {
  return (
    <span
      className="inline-flex h-[32px] items-center gap-[8px] rounded-full border px-[12px] text-[15px] leading-none font-[500] whitespace-nowrap"
      style={{ background: TONE_WASH[tone], borderColor: TONE_LINE[tone], color: TONE_TEXT[tone] }}
    >
      <span
        aria-hidden="true"
        className="size-[8px] flex-none rounded-full"
        style={{ background: TONE_MARK[tone] }}
      />
      {label}
    </span>
  );
}

/**
 * The right column's first panel: what the product does without being asked.
 *
 * Every line is something the product actually does, and none of them is a performance promise.
 * The board's version said an answer arrives "within a minute, day and night"; nothing in the
 * product measures reply latency, so the claim here is that an answer comes rather than how fast.
 */
const HANDLED_FOR_YOU = [
  "Your agent answers your leads day and night, without you watching for them.",
  "Anyone who asks to stop hearing from you is opted out for you.",
  "Leads who qualify reach you by email and text the moment they do.",
  "Nothing you connect starts answering until you press go live.",
] as const;

function HandledPanel() {
  return (
    <section
      aria-labelledby="onboarding-handled-heading"
      className="flex flex-col overflow-hidden rounded-[24px_24px_17px_17px] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] shadow-[var(--shadow-card)]"
    >
      <div className="flex min-h-[78px] flex-col justify-center border-b border-[var(--line)] px-[16px] py-[19px] sm:px-[20px]">
        <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
          Nothing for you to do
        </span>
        <h2
          className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
          id="onboarding-handled-heading"
        >
          We handle these for you
        </h2>
      </div>
      <ul className="m-0 flex list-none flex-col px-[16px] py-[4px] pb-[14px] sm:px-[20px]">
        {HANDLED_FOR_YOU.map((line, index) => (
          <li
            className="flex gap-[14px] py-[18px]"
            key={line}
            style={
              index === HANDLED_FOR_YOU.length - 1
                ? undefined
                : { borderBottom: "1px solid var(--line-soft)" }
            }
          >
            <span className="flex-none pt-[2px]" style={{ color: TONE_TEXT.good }}>
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
                <path d="m5 13 4 4L19 7" />
              </svg>
            </span>
            <p className="m-0 text-[16px] leading-[1.55] text-[color:var(--body)]">{line}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The right column's second panel: the way to a person.
 *
 * It states the hours rather than a response time, because the product records no response time
 * and a number nobody measures is a promise nobody can keep.
 */
function AskPanel() {
  return (
    <PlainPanel
      eyebrow="Not answered here"
      headingId="onboarding-ask-heading"
      name="Ask a person"
    >
      <p className="m-0 max-w-[34ch] text-[16px] leading-[1.5] text-[color:var(--muted)]">
        Message us from the bubble in the corner of your console. Someone answers on weekdays
        between 9 and 6 Eastern.
      </p>
    </PlainPanel>
  );
}

function PlainPanel({
  children,
  eyebrow,
  headingId,
  name,
}: {
  children: ReactNode;
  eyebrow: string;
  headingId: string;
  name: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col overflow-hidden rounded-[24px_24px_17px_17px] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] shadow-[var(--shadow-card)]"
    >
      <div className="flex min-h-[78px] flex-col justify-center border-b border-[var(--line)] px-[16px] py-[19px] sm:px-[20px]">
        <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
          {eyebrow}
        </span>
        <h2
          className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
          id={headingId}
        >
          {name}
        </h2>
      </div>
      <div className="px-[16px] pt-[18px] pb-[20px] sm:px-[20px]">{children}</div>
    </section>
  );
}
