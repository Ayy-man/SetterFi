"use client";

import Link from "next/link";

import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ArrowLeft, Play } from "@/components/kit/icons";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { COACH_FOOTNOTE_CLASS, COACH_LEAD_CLASS, COACH_READING_CLASS } from "./coach-type";

/**
 * Tips and trainings, drawn from `design/coach/Tips.dc.html`.
 *
 * There is no repository behind `CoachTraining` and no API route that returns one, which is worth
 * stating in the file rather than leaving for the next reader to discover: `src/lib/repositories`
 * has no trainings store, nothing under `src/app/api` serves a catalogue, and the intake never
 * asked the client where the videos would live. So the surface ships with the real page head and
 * an honest absence, and the card shape lives behind the `trainings` prop, so the day the content
 * lands the work is passing an array rather than designing a page.
 *
 * What changed in this pass, against the drawing:
 *
 *   - **The featured card is gone.** The previous build led with a wide card carrying a drenched
 *     thumbnail block, from an earlier artboard. The current one draws six equal cards in two rows
 *     of three and nothing saturated at all, which is what a library of same-shaped things looks
 *     like; a hero among them was asserting an editorial ranking nobody has made.
 *   - **One action per card, in the body.** It was a 56px play tile beside the sentence, which
 *     reads as decoration until it is pressed. The artboard puts a named control there instead,
 *     and a named control is what a coach over 55 is looking for.
 *   - **The search box is gone.** Six cards is not a corpus, and the box only ever rendered when
 *     there were trainings to hide behind it.
 *   - **The empty state is a panel, not a dashed box.** The audit measured the old one at 13px in
 *     a 1440x900 viewport with 450px of grey under it. Absence at the scale of the page, per the
 *     canvas rule, is words in the slot the content would fill.
 */
export type CoachTraining = {
  id: string;
  /**
   * The category, sentence case. Never uppercase: it renders as the panel's eyebrow, at
   * `--coach-eyebrow`. Named by reference rather than as a pixel value, because this said "12px"
   * against a 14px token for a whole redesign pass -- see the same correction in `coach-billing.tsx`.
   */
  category: string;
  title: string;
  /** As authored -- "5:02", "8:14". Rides the header band in mono, hard right against the name. */
  duration: string;
  /** One sentence saying what the coach gets out of watching it. */
  sentence: string;
  /** Where the video plays. `null` while a listed training is not yet playable. */
  href: string | null;
};

export type CoachTipsProps = {
  /**
   * Defaults to empty, and empty is the state that ships today. A caller that has nothing to pass
   * gets the absence without opting into it, which is the right default for a surface whose
   * content does not exist yet: the failure mode to avoid is a page that looks populated because
   * somebody left placeholder rows in a default.
   */
  trainings?: readonly CoachTraining[];
};

/* The coach scale, restated locally the way `coach-billing.tsx` does it. */
const PANEL_SENTENCE_CLASS = `m-0 max-w-[var(--measure-deck)] text-[color:var(--muted)] ${COACH_READING_CLASS}`;
const DURATION_CLASS =
  "font-[family-name:var(--font-mono)] text-[17px] leading-[1.4] text-[color:var(--muted)] [font-variant-numeric:tabular-nums_lining-nums]";
/*
 * The page's one accent fill, and it goes to the first playable training rather than to a card
 * chosen for it. One filled control in view is the canvas rule; which card holds it is a
 * consequence of the order the catalogue arrives in, not an editorial claim about the video.
 */
const ACCENT_FILL_CLASS =
  "inline-flex h-[48px] items-center justify-center gap-[10px] rounded-[9px] border "
  + "border-[var(--accent-line)] [background:var(--accent-fill)] px-[24px] text-[16px] leading-none "
  + `font-semibold text-[color:var(--on-accent)] no-underline ${ACCENT_FILL_SHADOW_CLASS}`;
const WATCH_LINK_CLASS =
  "inline-flex min-h-[44px] items-center gap-[10px] px-[2px] text-[16px] leading-[1.4] font-medium "
  + "text-[color:var(--accent-text)] no-underline hover:underline";
/*
 * The absence line the canvas specifies: 20px/500 muted, capped short, and the card ends after it.
 *
 * The cap is `--measure-caption` rather than the 24ch literal it was written as, which widens it to
 * the token's 28ch. `measures.test.ts` refuses a hand-rolled `max-w-[Nch]` precisely so a role's
 * width is decided once rather than per file, and four extra characters on a one-line absence is
 * the cost of that. Same correction the Billing lane recorded against the same drawing.
 */
const ABSENCE_CLASS =
  "m-0 max-w-[var(--measure-caption)] text-[20px] leading-[1.35] font-medium text-[color:var(--muted)]";

/* The sentences this screen would otherwise print as help text, handed to the eye instead. */
const TIPS_EYE_COPY =
  "Short videos from your coaching team on getting more out of your agent. None of them runs "
  + "longer than nine minutes and none of them assumes you know what an API is. Nothing on this "
  + "page changes your agent, so it is safe to read at any point in setup. A training listed "
  + "without a Watch control has been announced but not published yet, which is why it says so "
  + "instead of showing a button that would go nowhere.";

/**
 * The page head, at the coach side's scale rather than the console's.
 *
 * Local rather than `PageHeader` for the reason `LeadsHead` documents: `PageHeader` sets its title
 * with `.t-page-title`, the console's 20px, and no prop moves it.
 */
function TipsHead() {
  return (
    <header className="flex min-w-0 flex-col gap-[var(--s-2)]" data-page-head="tips">
      {/*
        The way back. Tips is reached from the account menu and the support bubble, neither of
        which is a place on the page, so without this a coach who opens it has no route out except
        the browser. "Back to Home" rather than the artboard's "Back to overview": the shipped nav
        calls the destination Home, and a link should name it the way it names itself.
      */}
      <Link
        className="inline-flex min-h-[44px] items-center gap-[8px] px-[2px] text-[16px] leading-[1.4] font-medium text-[color:var(--accent-text)] no-underline hover:underline"
        data-slot="tips-back"
        href="/coach/home"
      >
        <ArrowLeft aria-hidden size={18} strokeWidth={1.75} />
        Back to Home
      </Link>
      <h1 className="coach-page-title m-0">Tips and trainings</h1>
      <p className={`m-0 max-w-[var(--measure-prose)] ${COACH_LEAD_CLASS}`}>
        Short videos from your coaching team on getting more out of your agent. None of them runs
        longer than nine minutes.
      </p>
    </header>
  );
}

/**
 * One card. The duration rides the header band, hard right against the name, which is where the
 * artboard puts it and which is also what makes a grid of these scannable: three cards in a row
 * show three lengths on one line rather than at three different heights, because the sentences
 * under them are not the same length.
 */
function TrainingCard({ training, filled }: { training: CoachTraining; filled: boolean }) {
  return (
    <DeckPanel
      eyebrow={training.category}
      headingId={`training-${training.id}`}
      meta={<span className={DURATION_CLASS}>{training.duration}</span>}
      name={training.title}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[16px]">
        <p className={PANEL_SENTENCE_CLASS}>{training.sentence}</p>
        <div className="mt-auto">
          {training.href ? (
            <Link
              className={filled ? ACCENT_FILL_CLASS : WATCH_LINK_CLASS}
              data-slot="training-watch"
              href={training.href}
            >
              <Play aria-hidden size={18} strokeWidth={1.75} />
              Watch now
            </Link>
          ) : (
            /*
              Listed but not yet playable. It says which of the two it is rather than showing a
              dead control, because "nothing happened when I pressed it" is the one outcome a coach
              cannot tell apart from a broken product.
            */
            <p className={`m-0 ${COACH_FOOTNOTE_CLASS}`}>This one is not published yet.</p>
          )}
        </div>
      </div>
    </DeckPanel>
  );
}

export function CoachTips({ trainings = [] }: CoachTipsProps) {
  const firstPlayable = trainings.find((training) => training.href)?.id ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-[24px]">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-[24px]">
        <TipsHead />
        <ContextEye copy={TIPS_EYE_COPY} placement="header" scale="coach" screen="coach-tips" />
      </div>

      {trainings.length > 0 ? (
        <div className="grid min-w-0 items-stretch gap-[20px] md:grid-cols-2 xl:grid-cols-3">
          {trainings.map((training) => (
            <TrainingCard
              filled={training.id === firstPlayable}
              key={training.id}
              training={training}
            />
          ))}
        </div>
      ) : (
        /*
          The honest absence, and the reason this page exists as a route at all: the surface is
          real, the catalogue is not. It says who owes the content and what happens when it
          arrives, rather than "no results", which would read as a search that failed.
        */
        <DeckPanel
          eyebrow="Published so far"
          headingId="coach-tips-empty"
          name="Trainings"
        >
          <p className={ABSENCE_CLASS}>No trainings have been published yet.</p>
          <p className={`m-0 mt-[12px] max-w-[var(--measure-prose)] ${COACH_FOOTNOTE_CLASS}`}>
            Your coaching team records these and adds one every few weeks. Nothing is missing from
            your account.
          </p>
        </DeckPanel>
      )}
    </div>
  );
}
