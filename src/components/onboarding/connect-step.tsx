import Link from "next/link";
import type { ReactNode } from "react";

import { TONE_LINE, TONE_MARK, TONE_TEXT, TONE_WASH, type Tone } from "@/components/kit/atomics";
import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import {
  OnboardingStepShell,
  STEP_PANEL_CLASS,
  STEP_PRIMARY_CLASS,
  STEP_SECONDARY_CLASS,
  nextStepHref,
} from "@/components/onboarding/step-shell";
import type { ConnectCard } from "@/components/onboarding/connect-view-models";
import { ConnectChannelButton } from "@/components/workspace/rehaul/connect-channel-button";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";

/*
 * Step 2 of 6, drawn from `OnboardingConnect.dc.html`.
 *
 * The three channel cards are `connectCards(...)` unchanged, so the honest-state rules and the
 * destinations are the ones that module already holds and tests. What the board changes is the
 * shape: three cards across became four rows down, which is what stops the header row and a
 * three-across grid fighting for 390px, and each row now carries a state, one sentence and at most
 * one control instead of a card full of key-value furniture.
 *
 * **The three channel states get distinct treatments.** Connected states a fact and carries no
 * button, because there is nothing to press on a channel that is already answering. A channel that
 * needs the coach carries exactly one secondary button. A channel that is with the carriers, or
 * that SetterFi is fixing, carries no button at all and says why, which is Note 5's ruling: an
 * outage we own says "We're fixing it" and offers nothing, because it is not the coach's to fix.
 *
 * The audit's defect 12 was six accent-looking labels in one view over zero measured accent fills,
 * so the primary path was unmarked in both directions. Here the row buttons are all secondary and
 * the page's single fill is Continue, which is the only forward action on the screen.
 */

export type ConnectStepProps = {
  cards: readonly ConnectCard[];
  /** Whether the calendar step has a stored connection. `null` when that read did not run. */
  calendarReady: boolean | null;
};

export function connectStepEyeCopy(cards: readonly ConnectCard[]) {
  return [
    "These are the four places your agent reaches your leads and puts their calls.",
    ...cards.map((card) => `${card.name}: ${card.body} ${card.note}`),
    "Your calendar is what gives the agent somewhere to book into; without it a qualified lead"
    + " reaches you but cannot pick a time.",
  ].join(" ");
}

type ChannelRow = {
  key: string;
  name: string;
  icon: ReactNode;
  sentence: string;
  pill: { label: string; tone: Tone } | null;
  action: { href: string; label: string; channel?: "instagram" | "messenger" } | null;
};

export function ConnectStep({ calendarReady, cards }: ConnectStepProps) {
  const rows: ChannelRow[] = cards.map((card) => ({
    action: card.action,
    icon: CHANNEL_ICON[card.key],
    key: card.key,
    name: card.name,
    pill: card.key === "sms" ? carrierPill(card) : card.status,
    sentence: card.note,
  }));

  rows.push(calendarRow(calendarReady));

  return (
    <OnboardingStepShell
      eyeCopy={connectStepEyeCopy(cards)}
      eyeScreen="onboarding-connect"
      lead="Connect the accounts your leads already message you on. The rest is running or with the carriers."
      primary={
        <Link className={STEP_PRIMARY_CLASS} href={nextStepHref("connect")}>
          Continue to texting
        </Link>
      }
      stepKey="connect"
      width={860}
    >
      <section aria-labelledby="onboarding-connect-heading" className={STEP_PANEL_CLASS}>
        <div className="flex min-h-[78px] flex-col justify-center border-b border-[var(--line)] px-[16px] py-[19px] sm:px-[20px]">
          <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
            Four places
          </span>
          <h2
            className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
            id="onboarding-connect-heading"
          >
            Your channels
          </h2>
        </div>

        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((row, index) => (
            <li
              className="flex flex-col gap-[14px] px-[16px] py-[22px] sm:flex-row sm:items-start sm:gap-[18px] sm:px-[20px]"
              data-slot="onboarding-channel-row"
              key={row.key}
              style={
                index === rows.length - 1
                  ? undefined
                  : { borderBottom: "1px solid var(--line-soft)" }
              }
            >
              <span className="grid size-[44px] flex-none place-items-center rounded-[10px] border border-[var(--line)] bg-[var(--well)] text-[color:var(--body)]">
                {row.icon}
              </span>

              <div className="flex min-w-0 flex-grow flex-col">
                <div className="flex flex-wrap items-center gap-[12px]">
                  <h3 className="m-0 text-[18px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)] sm:text-[20px]">
                    {row.name}
                  </h3>
                  {row.pill ? <StatePill label={row.pill.label} tone={row.pill.tone} /> : null}
                </div>
                <p className="m-0 mt-[8px] max-w-[var(--measure-sentence)] text-[16px] leading-[1.55] text-[color:var(--muted)]">
                  {row.sentence}
                </p>
              </div>

              {row.action?.channel ? (
                <ConnectChannelButton
                  channels={[row.action.channel]}
                  className={`${STEP_SECONDARY_CLASS} w-full sm:w-auto sm:flex-none`}
                >
                  {row.action.label}
                </ConnectChannelButton>
              ) : row.action ? (
                <Link
                  className={`${STEP_SECONDARY_CLASS} w-full sm:w-auto sm:flex-none`}
                  href={row.action.href}
                >
                  {row.action.label}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </OnboardingStepShell>
  );
}

/**
 * The texting row's pill, which is the one place on this screen a clock belongs.
 *
 * It counts real elapsed days off the filing date through `elapsedWorkspaceDays`, which is the
 * same function the overview rail and coach Home count with, and it never draws a percentage or a
 * predicted date. Not filed yet and there is no clock to show, so the pill states that instead of
 * printing a day zero that implies a review is under way.
 */
function carrierPill(card: ConnectCard): { label: string; tone: Tone } | null {
  const since = card.wait?.since ?? null;
  if (!since) return card.status;
  const day = elapsedWorkspaceDays(since);
  return {
    label: day === null
      ? "With the carriers"
      : `Day ${day} of about ${CARRIER_TYPICAL_DAYS[1]}`,
    tone: "waiting",
  };
}

/**
 * The calendar row.
 *
 * It is on this screen because the board draws it here: a coach reads "where my leads reach me"
 * as including where their calls land, and splitting the two put the one connection they still owe
 * on a screen they had no reason to open. The step itself still exists, and this row is the way in
 * to it rather than a second editor for the same connection.
 */
function calendarRow(ready: boolean | null): ChannelRow {
  if (ready === null) {
    return {
      action: null,
      icon: CHANNEL_ICON.calendar,
      key: "calendar",
      name: "Your calendar",
      pill: { label: "We could not check this", tone: "neutral" },
      sentence: "Your calendar connection could not be read just now, so this row cannot say where it stands.",
    };
  }
  if (ready) {
    return {
      action: null,
      icon: CHANNEL_ICON.calendar,
      key: "calendar",
      name: "Your calendar",
      pill: { label: "Connected", tone: "good" },
      sentence: "Your agent can see when you are free and put the calls it books somewhere.",
    };
  }
  return {
    action: { href: "/onboarding/calendar", label: "Connect calendar" },
    icon: CHANNEL_ICON.calendar,
    key: "calendar",
    name: "Your calendar",
    pill: { label: "Waiting on you", tone: "warning" },
    sentence: "Your agent needs somewhere to put the calls it books.",
  };
}

/** The vocabulary's 32px state pill: a dot, then the word. Never pressable. */
function StatePill({ label, tone }: { label: string; tone: Tone }) {
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

function Glyph({ children }: { children: ReactNode }) {
  return (
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
      {children}
    </svg>
  );
}

const CHANNEL_ICON: Record<string, ReactNode> = {
  calendar: (
    <Glyph>
      <rect height="16" rx="3" width="18" x="3" y="5" />
      <path d="M3 10h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </Glyph>
  ),
  instagram: (
    <Glyph>
      <rect height="18" rx="5" width="18" x="3" y="3" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.3" cy="6.7" r="1" />
    </Glyph>
  ),
  messenger: (
    <Glyph>
      <path d="M21 11.5c0 4.7-4 8.5-9 8.5a10 10 0 0 1-2.9-.4L4 21l1.4-3.5A8.2 8.2 0 0 1 3 11.5C3 6.8 7 3 12 3s9 3.8 9 8.5z" />
      <path d="m7.6 14 3.3-3.5 2 2 3.5-3.3-3.3 3.5-2-2z" />
    </Glyph>
  ),
  sms: (
    <Glyph>
      <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
    </Glyph>
  ),
};
