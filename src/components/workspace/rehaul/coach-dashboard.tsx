"use client";

import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import Link from "next/link";
import { useSyncExternalStore } from "react";

import { DayCounter, elapsedWorkspaceDays } from "@/components/kit/day-counter";
import { Pill, StatusDot } from "@/components/workspace/rehaul/_primitives";
import { CoachHomeBubbles } from "@/components/workspace/rehaul/coach-home-figures";
import { CoachHomeKeywords } from "@/components/workspace/rehaul/coach-home-keywords";
import { CoachHomeMonths } from "@/components/workspace/rehaul/coach-home-months";
import { CoachHomeRange } from "@/components/workspace/rehaul/coach-home-range";
import { DeckPanel } from "@/components/kit/deck-panel";
import {
  clearDemoSetupOverride,
  readDemoSetupOverride,
  startDemoSetupOverride,
} from "@/lib/demo-setup-override";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";
import { workspaceCountFormat } from "@/lib/format/datetime";
import { STEP_LABELS } from "@/components/onboarding/view-models";
import { CARRIER_TYPICAL_DAYS, type ProvisioningStep } from "@/lib/onboarding/contracts";
import type {
  CoachLeadComposition,
  CoachMeasurement,
  CoachMeasurementWindow,
} from "@/lib/repositories/analytics";
import type { CoachChannelStatus } from "@/components/workspace/live/coach-channel-status";
import { PROVENANCE_COPY } from "@/components/workspace/live/coach-page-head";
import type { MessagingChannel } from "@/lib/integrations/types";

/**
 * Every explainer sentence the live coach dashboard printed under a heading, moved off the page.
 *
 * These are `coach-measurement.tsx`'s own `DECK_COPY` sentences and the carrier reassurance from
 * `CoachCarrierNotice`, copied verbatim rather than imported because neither is exported and that
 * file is not ours to edit. If a sentence there changes, it changes here.
 */
const EYE_COPY = [
  "Leads: everyone your agent reached in the window you picked.",
  "Booked: leads who took a slot on your calendar.",
  "Time to book: the average from a lead's first message to a call on the calendar.",
  "The keyword table counts opt-ins per conversation and qualified and booked per contact, so a lead who returns through a second keyword is counted on both rows.",
  "Percent view uses each keyword's share of all keyword opt-ins; qualified and booked use that keyword's opt-ins.",
  "Carriers take about three weeks to approve a new business for texting. Nothing is broken and there is nothing for you to do.",
].join(" ");

const COACH_CHANNEL_NAMES: Readonly<Record<MessagingChannel, string>> = {
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "Text messaging",
  webchat: "Web chat",
  whatsapp: "WhatsApp",
};

export type CoachDashboardProps = {
  attention: {
    threadsNeedingHuman: number;
    leadsToCallBack: number;
    blockedSetupSteps: number;
    /*
     * The oldest blocked step's own key, so the rail's blocked rung can name the step instead of
     * counting the blocked ones a second time under a header that already counted them. The page
     * has read it beside the count since this surface shipped; only the type was missing.
     */
    blockedStepKey?: ProvisioningStep | null;
    openConversations?: number;
  };
  billingPeriod?: { periodStart: string; periodEnd: string } | null | "unavailable";
  channelStatus?: CoachChannelStatus | null;
  composition: CoachLeadComposition;
  customFrom?: string | null;
  customTo?: string | null;
  greeting?: string | null;
  measurement: CoachMeasurement;
  window: CoachMeasurementWindow;
  /** Injected by tests so the day counter and the elapsed reading cannot disagree. */
  now?: Date;
};

/* --------------------------------------------------------------------------------------------
 * The setup rail's own faces
 * ------------------------------------------------------------------------------------------ */

/**
 * The rail's card face, spelled here rather than taken from `DeckPanel`.
 *
 * A rung's band carries a state pill and a labelled action, and `DeckPanel`'s band offers a 44px
 * square link and nothing else. The six bubbles below use the component; the rail keeps the same
 * face by class so the two shapes are visibly one family without the rail pretending to be a card
 * it is not shaped like.
 */
const PANEL_CLASS = [
  "flex min-w-0 flex-col overflow-hidden rounded-[24px_24px_17px_17px]",
  "border border-[var(--line)]",
  "bg-[linear-gradient(180deg,var(--card-top),var(--card))]",
  "shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_1px_2px_rgba(28,42,82,0.04),0_8px_20px_-14px_rgba(28,42,82,0.16)]",
].join(" ");

/**
 * The band, in two arrangements, with nothing drawn twice.
 *
 * The desk arrangement is one line: the eyebrow and the name stacked at the left, then the state,
 * then at most one action, both pushed to the right. A phone gives the panel about 300px of inner
 * width, and that one line put a 20px name, a state pill and a filled button into it: the pill
 * landed on top of "Instagram and Messenger", the name broke over three lines around it, and the
 * button truncated to "Instagram and". Three readings competing for one line is not a narrow
 * version of that band, it is an unreadable one.
 *
 * So under `sm` the band is a two column grid and the pieces take their own rows: the eyebrow with
 * the state pill at its right, the name across the full width under it, and the action across the
 * full width under that. Each child is placed explicitly rather than by source order, because the
 * eyebrow and the name have to be one stacked block at the desk and two separate cells on the
 * phone. `contents` is what lets a single wrapper be both: it dissolves into the grid below `sm`,
 * where the placement classes apply, and becomes an ordinary block at `sm`, where they are inert
 * because there is no grid to place into.
 *
 * `status` and `action` are separate props rather than one `children` for the same reason. A
 * fragment can only be positioned as a unit, and the phone needs the pill on the eyebrow's line
 * and the button two rows below it. The alternative was rendering each twice under `sm:hidden` and
 * `hidden sm:flex`, which puts the same sentence in the document twice and makes every test that
 * asks for a state by its text ambiguous.
 */
function Band({
  action,
  eyebrow,
  name,
  status,
  titleId,
}: {
  action?: React.ReactNode;
  eyebrow: string;
  name: string;
  status?: React.ReactNode;
  titleId?: string;
}) {
  return (
    <div className="grid min-h-[78px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 border-b border-[var(--line)] px-5 py-[19px] sm:flex sm:gap-3">
      <div className="contents sm:block sm:min-w-0">
        <div className="col-start-1 row-start-1 text-[14px] text-[var(--muted)]">{eyebrow}</div>
        <h2
          className="col-span-2 col-start-1 row-start-2 m-0 text-[20px] font-medium tracking-[-0.015em]"
          id={titleId}
        >
          {name}
        </h2>
      </div>
      {status ? (
        <div className="col-start-2 row-start-1 flex-none justify-self-end sm:ml-auto">
          {status}
        </div>
      ) : null}
      {action ? (
        <div className="col-span-2 col-start-1 row-start-3 flex-none sm:col-auto sm:row-auto">
          {action}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * Status line
 * ------------------------------------------------------------------------------------------ */

function nameList(names: readonly string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The one status sentence under the greeting.
 *
 * `Main.dc.html:111` draws prose, not a row of dotted chips: "Your agent is live on Instagram and
 * Messenger. Text messages are on day 14 of about 21." The chips were three coloured statements
 * competing with the 46px greeting above them, and two of the three were only ever one clause
 * long.
 *
 * Every clause is a read. The live half is drawn only from connection rows that say `live`, so a
 * coach mid-onboarding is never told their agent is answering. The texting half is a day count and
 * never a percentage or a predicted date, because A2P vetting is a wait on a third party who
 * publishes no schedule, and it is said only while the wait is running: a registration that is
 * finished puts its channel in the live list, where it is already named.
 */
function StatusLine({
  blockedSetupSteps,
  now,
  status,
}: {
  blockedSetupSteps: number;
  now?: Date;
  status: CoachChannelStatus | null | undefined;
}) {
  if (!status) return null;
  const liveNames = status.liveChannels.map((channel) => COACH_CHANNEL_NAMES[channel]);
  const carrier = status.carrier;
  const carrierDay = carrier.kind === "in-review" && carrier.submittedAt
    ? elapsedWorkspaceDays(carrier.submittedAt, now)
    : null;

  const clauses: string[] = [];
  if (liveNames.length > 0) clauses.push(`Your agent is live on ${nameList(liveNames)}.`);
  if (carrier.kind === "in-review") {
    clauses.push(
      carrierDay === null
        ? "Text messages are still with the carrier."
        // The typical range is a pair, `[14, 21]`, and the artboard prints its upper bound: the
        // carriers publish no schedule, so the sentence gives the outer edge of what we have seen
        // rather than a midpoint that would read as a prediction.
        : `Text messages are on day ${carrierDay} of about ${
          CARRIER_TYPICAL_DAYS[CARRIER_TYPICAL_DAYS.length - 1]
        }.`,
    );
  }
  if (blockedSetupSteps > 0) {
    clauses.push(
      `${workspaceCountFormat.format(blockedSetupSteps)} ${
        blockedSetupSteps === 1 ? "step is" : "steps are"
      } waiting on you.`,
    );
  }
  if (clauses.length === 0) return null;

  return (
    <p
      className="m-0 mt-3 max-w-[var(--measure-wide)] text-[17px] leading-[1.5] text-[color:var(--body)]"
      data-slot="home-status"
    >
      {clauses.join(" ")}
    </p>
  );
}

/* --------------------------------------------------------------------------------------------
 * First run
 * ------------------------------------------------------------------------------------------ */

/**
 * Setup is unfinished when the connection read succeeded and found nothing live.
 *
 * `channelsChecked` is the load-bearing half. A failed connection read is not the same claim as
 * "no channel is live", and greeting a working coach with a setup checklist because a query timed
 * out is exactly the fake state this surface is not allowed to invent. A missing status is
 * likewise not evidence of anything, so it renders the figures.
 */
function setupIncomplete(status: CoachChannelStatus | null | undefined) {
  return Boolean(status && status.channelsChecked && status.liveChannels.length === 0);
}

/**
 * The rung face, per state. Amber is the only pending colour and green is only ever a state the
 * server confirmed, so the mark reads the same as the pill beside it rather than inventing a
 * fourth vocabulary of its own.
 */
const RUNG_FACE: Record<"good" | "amber" | "wait" | "grey", string> = {
  amber: "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[var(--warning-text)]",
  good: "border-[var(--good-line)] bg-[var(--good-wash)] text-[var(--good-text)]",
  grey: "border-[var(--line)] bg-[var(--well)] text-[var(--muted)]",
  wait: "border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[var(--accent-text)]",
};

/**
 * The two action faces the rail spends, declared once.
 *
 * They were four inline class strings, two of them identical, which is how the rail ended up
 * offering "See setup" twice against two different destinations without anybody noticing the pair
 * was a pair. One face per weight, named, makes a second copy of an action visible in the diff.
 */
const RUNG_ACTION_PRIMARY = [
  // Full width and at least 48px tall on a phone, where it is its own row and the only thing on
  // it, and back to a 44px chip beside the state at the desk. A minimum rather than a fixed
  // height, because "Connect Instagram and Messenger" is two lines at 300px and a fixed 48px box
  // held them with no room to breathe.
  "inline-flex min-h-12 w-full items-center justify-center py-2.5 text-center",
  "sm:h-11 sm:min-h-0 sm:w-auto sm:justify-start sm:py-0 sm:text-left",
  "rounded-xl border border-transparent",
  "[background:var(--accent-fill)] px-5 text-[16px] font-medium text-[var(--on-accent)]",
  "no-underline hover:no-underline",
].join(" ");

const RUNG_ACTION_SECONDARY = [
  // Full width and at least 48px tall on a phone, where it is its own row and the only thing on
  // it, and back to a 44px chip beside the state at the desk. A minimum rather than a fixed
  // height, because "Connect Instagram and Messenger" is two lines at 300px and a fixed 48px box
  // held them with no room to breathe.
  "inline-flex min-h-12 w-full items-center justify-center py-2.5 text-center",
  "sm:h-11 sm:min-h-0 sm:w-auto sm:justify-start sm:py-0 sm:text-left",
  "rounded-xl border border-[var(--line-input)]",
  "bg-[var(--card)] px-5 text-[16px] font-medium text-[var(--ink)]",
  "no-underline hover:no-underline",
].join(" ");

/** A 24px stroke glyph, the artboard's own paths. Decorative: the row beside it carries the word. */
function StepGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="24"
    >
      {children}
    </svg>
  );
}

/**
 * One rung, and the only anatomy a rung has.
 *
 * A spine node, then a panel whose header band carries the eyebrow, the row's name, the row's
 * state and at most one action at the band's right. `docs/REDESIGN-CANVAS.md` makes that band the
 * panel's only control, so no rung draws a footer action bar: the rail used to give three of its
 * rows one and the fourth none, which read as four different components stacked in one column.
 * A rung with nothing to do simply carries no action and keeps the same 78px band.
 *
 * `body` is the canvas's optional footer widget, and it is the one thing a rung may add: a reading
 * too wide for the band. Only the carrier row has one.
 *
 * The connector is drawn by the rung rather than by the list. A single absolutely positioned line
 * behind the whole list has to guess where the last node sits, and it guessed wrong the moment a
 * row grew a footer, which is what left the spine hanging past the bottom icon. Each rung owns the
 * segment between its own node and the next one, so the spine cannot outlast the rows again.
 */
function StepRow({
  action,
  body,
  eyebrow,
  icon,
  last,
  name,
  status,
  tone,
}: {
  action?: React.ReactNode;
  body?: React.ReactNode;
  eyebrow: string;
  icon: React.ReactNode;
  last: boolean;
  name: string;
  status: React.ReactNode;
  tone: "good" | "amber" | "wait" | "grey";
}) {
  return (
    /*
     * The node is 44px on a phone and 64px at the desk. A 64px column plus its 20px gap took 84px
     * of a 358px card, which is most of the room the name needed, and the node is a decoration:
     * it repeats the eyebrow the band already prints in words. It is still a real target's worth
     * of space at 44px, and the spine and the gap move with it so the rail stays one column.
     */
    <li className="relative flex list-none items-start gap-3 sm:gap-5">
      {last ? null : (
        <span
          aria-hidden="true"
          className="absolute top-11 -bottom-4 left-[21px] w-0.5 bg-[var(--line)] sm:top-16 sm:left-[31px]"
          data-slot="rung-spine"
        />
      )}
      <span
        aria-hidden="true"
        className={`relative z-[1] mt-0 flex size-11 flex-[0_0_44px] items-center justify-center rounded-2xl border sm:size-16 sm:flex-[0_0_64px] ${RUNG_FACE[tone]}`}
        data-slot="rung-node"
      >
        {icon}
      </span>
      <div className={`${PANEL_CLASS} flex-1`}>
        <Band action={action} eyebrow={eyebrow} name={name} status={status} />
        {body ? <div className="px-5 py-[18px]">{body}</div> : null}
      </div>
    </li>
  );
}

/** One row of the rail: what it is called, what state it is in, and whether that state is done. */
type Rung = {
  action?: React.ReactNode;
  body?: React.ReactNode;
  /** Counted by the numerator. A rung with no state to be done in is not a rung. */
  done: boolean;
  eyebrow: string;
  icon: React.ReactNode;
  key: string;
  name: string;
  status: React.ReactNode;
  tone: "good" | "amber" | "wait" | "grey";
};

/**
 * The setup journey, built only from state this page already reads.
 *
 * The artboard draws five steps with a state on each. This page loads two of them, the channel
 * connections and the A2P registration, plus the blocked-step read; the per-step states for the
 * calendar, the offer and the safe test live behind the Get started page's own reads, and adding a
 * query here is the one thing this screen may not do.
 *
 * So the rail is exactly the rows whose state was read, and the counter denominates over that same
 * array rather than over a number derived beside it. Four cards over "0 of 3 done" was an honest
 * number that read as a bug, and it was honest only by accident: the count and the rows were two
 * expressions of the same idea maintained by hand. `rungs.length` cannot disagree with what
 * `rungs.map` drew.
 *
 * "The rest of your setup" names no state, so it is not a rung and is not drawn as one. It leaves
 * the list entirely and becomes the line under it, which is what it always was: a link to the page
 * that holds the three steps this one cannot see.
 *
 * Nothing is numbered. The rail's length changes with the blocked read, so "Step 2" would mean a
 * different row on two accounts, and two of the four rows were never steps in a sequence anyway.
 */
function FirstRun({
  blockedSetupSteps,
  blockedStepKey,
  now,
  status,
}: {
  blockedSetupSteps: number;
  blockedStepKey?: ProvisioningStep | null;
  now?: Date;
  status: CoachChannelStatus;
}) {
  const carrier = status.carrier;
  const carrierDay = carrier.kind === "in-review" && carrier.submittedAt
    ? elapsedWorkspaceDays(carrier.submittedAt, now)
    : null;
  const channelsLive = status.liveChannels.length > 0;

  const rungs: Rung[] = [
    {
      action: channelsLive ? undefined : (
        <Link className={RUNG_ACTION_PRIMARY} href="/coach/integrations">
          Connect Instagram and Messenger
        </Link>
      ),
      done: channelsLive,
      eyebrow: "Your channels",
      icon: (
        <StepGlyph>
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.5-4.1A8.4 8.4 0 0 1 3.6 12a8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 9 7.9Z" />
        </StepGlyph>
      ),
      key: "channels",
      name: "Instagram and Messenger",
      /*
       * `FirstRun` renders on "the read succeeded and nothing is live", which covers `ready`,
       * `pending_review` and `error` as well as no row at all. "Not connected" would claim one of
       * those; "not live yet" is exactly what the read established and nothing more.
       */
      status: channelsLive
        ? (
          <Pill className="text-[14px]" tone="good">
            <StatusDot tone="good" />
            Live
          </Pill>
        )
        : <Pill className="text-[14px]" tone="neutral">Not live yet</Pill>,
      tone: channelsLive ? "good" : "grey",
    },
    {
      /*
       * The one footer widget on the rail. The pill says which day the wait is on; the counter
       * says the same day against the range it is measured in and the date it started, which is
       * the fact the band cannot hold and the reason the widget survives the anatomy pass. The
       * reassurance that used to trail it lives in the eye with the rest of the prose.
       */
      body: carrier.kind === "in-review" && carrier.submittedAt
        ? <DayCounter now={now} since={carrier.submittedAt} typicalDays={CARRIER_TYPICAL_DAYS} />
        : undefined,
      done: carrier.kind === "live",
      eyebrow: "With the carrier",
      icon: (
        <StepGlyph>
          <rect height="19" rx="3" width="12" x="6" y="2.5" />
          <path d="M11 18.5h2" />
        </StepGlyph>
      ),
      key: "carrier",
      name: "Texting registration",
      status: carrier.kind === "in-review"
        ? (
          <Pill className="text-[14px]" tone="amber">
            <StatusDot tone="amber" />
            {carrierDay === null ? "In review" : `Day ${carrierDay}`}
          </Pill>
        )
        : carrier.kind === "live"
        ? (
          <Pill className="text-[14px]" tone="good">
            <StatusDot tone="good" />
            Registered
          </Pill>
        )
        : <Pill className="text-[14px]" tone="neutral">Not filed</Pill>,
      tone: carrier.kind === "in-review" ? "amber" : carrier.kind === "live" ? "good" : "grey",
    },
    /*
     * The blocked rung names the step rather than counting the blocked ones.
     *
     * The status line above already prints that count, and printing it again eleven hundred pixels
     * lower said one fact twice and added nothing. `provisioning_steps.step_key` for the oldest
     * blocked row is read by the page beside the count, and `STEP_LABELS` is the coach-facing name
     * of that key, so the row can say which step it is: the header says how many are waiting, the
     * row says which one to open first, and neither repeats the other.
     *
     * `blocked_reason` stays unrendered, for the reason the page's own read states: it is
     * operator-authored free text with no contract about audience.
     */
    ...(blockedSetupSteps > 0
      ? [{
        action: (
          <Link className={RUNG_ACTION_SECONDARY} href="/coach/get-started">
            Fix this step
          </Link>
        ),
        done: false,
        eyebrow: "On your setup page",
        icon: (
          <StepGlyph>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5M12 16h.01" />
          </StepGlyph>
        ),
        key: "blocked",
        name: blockedStepKey ? STEP_LABELS[blockedStepKey] : "A step in your setup",
        status: <Pill className="text-[14px]" tone="amber">Blocked</Pill>,
        tone: "amber" as const,
      }]
      : []),
  ];

  const done = rungs.filter((rung) => rung.done).length;

  return (
    <>
      <div className="flex items-baseline gap-3">
        <h2
          className="m-0 text-[17px] font-semibold tracking-[-0.01em]"
          id="rehaul-setup-heading"
        >
          Your setup
        </h2>
        {/*
          The count is mono; the words are not. The 2026-09-04 audit's eighth defect on this screen
          was "0 of 3 done" set entirely in a monospace face, which `docs/SIMPLIFICATION-SPEC.md`
          reserves for figures. `design/coach/VOCABULARY.md` spells the fix out on this exact
          shape: the number sits in the glyph run and the sentence around it does not.
        */}
        <span className="ml-auto text-[14px] text-[var(--faint)]">
          <span className="font-mono">{workspaceCountFormat.format(done)}</span>{" "}
          of {workspaceCountFormat.format(rungs.length)} done
        </span>
      </div>
      <ol aria-labelledby="rehaul-setup-heading" className="m-0 flex list-none flex-col gap-4 p-0">
        {rungs.map((rung, index) => (
          <StepRow
            action={rung.action}
            body={rung.body}
            eyebrow={rung.eyebrow}
            icon={rung.icon}
            key={rung.key}
            last={index === rungs.length - 1}
            name={rung.name}
            status={rung.status}
            tone={rung.tone}
          />
        ))}
      </ol>
      {/*
        Not a rung, and drawn as one thing rather than as a card so a reader counting cards gets
        the denominator. It is indented to the rungs' left edge so it still reads as belonging to
        the rail, and it carries the one action the rail cannot: the page holding the three steps
        this one never read.
      */}
      <div className="flex flex-wrap items-center gap-4 pl-[84px]">
        <p className="m-0 max-w-[var(--measure-deck)] text-[14px] text-[var(--muted)]">
          Your calendar, your offer and the safe test are on your setup page.
        </p>
        <Link className={RUNG_ACTION_SECONDARY} href="/coach/get-started">
          See the rest of your setup
        </Link>
      </div>
    </>
  );
}

/* --------------------------------------------------------------------------------------------
 * The demo setup override
 * ------------------------------------------------------------------------------------------ */

/**
 * A status that presents the setup as finished, built from nothing.
 *
 * This is the whole of what the override "knows". It reads no row and it is handed to the same
 * `FirstRun` and `StatusLine` a real status goes to, so the two compositions cannot drift: there is
 * one setup rail, and the override changes what it is given rather than how it draws.
 *
 * The channel pair is the pair the coach-facing copy already names as one step, "Instagram and
 * Messenger", so the status line reads the sentence a finished connection would actually produce.
 */
const DEMO_COMPLETE_STATUS: CoachChannelStatus = {
  carrier: { kind: "live" },
  channelsChecked: true,
  liveChannels: ["instagram", "messenger"],
};

/**
 * The provenance sentence while the override is on.
 *
 * The page already prints one line saying these rows are seeded, and the rule is that a fact is
 * said once, so this replaces that line rather than sitting under it. It has to carry two claims:
 * the rows are demo rows, as before, and the setup above is being shown complete by a switch rather
 * than by anything the platform read. "Clears itself" rather than a wall-clock time because the
 * expiry is a browser clock and the display formatters are pinned to one timezone, so a printed
 * time would be wrong for anybody demoing outside it.
 */
const DEMO_OVERRIDE_PROVENANCE =
  "Demo data, excluded from real analytics. Setup is shown complete for this demo, and it clears itself within ten minutes.";

/**
 * The override, as one piece of state, held in a module store rather than in component state.
 *
 * `ContextEye` reaches for the same shape a few files over and for the same two reasons. The first
 * is that the server has no storage, so state seeded from it would hydrate one tree over another;
 * `useSyncExternalStore` renders the server snapshot on both passes and swaps to the real one after
 * hydration, with no cascading render and no effect that writes state on mount. The second is that
 * this is genuinely one value per browser, not one per mounted component.
 *
 * The timer is what makes "self expiring" true on a page nobody reloads. Without it a dashboard
 * left open would keep drawing a complete setup after the stamp died, because nothing would ask the
 * storage again. It fires once, at the expiry, and drops the value for every subscriber.
 *
 * The store empties itself when its last subscriber leaves, so a remount re-reads the stamp the
 * same way a fresh page load does, and one test's override cannot leak into the next.
 */
let overrideExpiresAt: number | null = null;
let overrideHydrated = false;
let overrideTimer: ReturnType<typeof setTimeout> | null = null;
const overrideListeners = new Set<() => void>();

function armOverrideExpiry() {
  if (overrideTimer !== null) {
    clearTimeout(overrideTimer);
    overrideTimer = null;
  }
  if (overrideExpiresAt === null) return;
  const remaining = overrideExpiresAt - Date.now();
  if (remaining <= 0) {
    overrideExpiresAt = null;
    return;
  }
  overrideTimer = setTimeout(() => {
    overrideTimer = null;
    setOverride(null);
  }, remaining);
}

function setOverride(next: number | null) {
  if (overrideExpiresAt === next) return;
  overrideExpiresAt = next;
  armOverrideExpiry();
  for (const listener of overrideListeners) listener();
}

function subscribeOverride(listener: () => void) {
  overrideListeners.add(listener);
  if (!overrideHydrated) {
    overrideHydrated = true;
    // The one read of the viewer's storage. It answers null for a missing, expired, corrupt or
    // over-long stamp, and for a browser that refuses storage at all.
    overrideExpiresAt = readDemoSetupOverride(Date.now())?.expiresAt ?? null;
    armOverrideExpiry();
  }
  return () => {
    overrideListeners.delete(listener);
    if (overrideListeners.size > 0) return;
    overrideHydrated = false;
    overrideExpiresAt = null;
    if (overrideTimer !== null) {
      clearTimeout(overrideTimer);
      overrideTimer = null;
    }
  };
}

function overrideSnapshot() {
  return overrideExpiresAt;
}

/** The server has no storage and therefore no override, on every render. */
function overrideServerSnapshot(): number | null {
  return null;
}

function useDemoSetupOverride(available: boolean) {
  const expiresAt = useSyncExternalStore(
    subscribeOverride,
    overrideSnapshot,
    overrideServerSnapshot,
  );

  return {
    active: available && expiresAt !== null,
    turnOff() {
      clearDemoSetupOverride();
      setOverride(null);
    },
    turnOn() {
      setOverride(startDemoSetupOverride(Date.now()).expiresAt);
    },
  };
}

/**
 * The control itself, which lives inside the context eye and nowhere else.
 *
 * The eye is where this console already puts things a reviewer opens on purpose, it is already
 * labelled "review only" in its own corner, and it is the one place on a coach screen that is not
 * a coach's own control. A button in the page header or the account sheet would read as a product
 * feature, and this is not one: it draws a state that no receipt supports, for ten minutes, on a
 * seeded tenant.
 *
 * One button, one state, so switching it off is the same click in the same place as switching it
 * on.
 */
function DemoSetupControl({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle(): void;
}) {
  return (
    <div>
      <p className="m-0 text-[oklch(0.85_0.01_262)]">
        {active
          ? "The setup steps above are being shown complete for this demo. Nothing was saved, nobody else sees it, and it clears itself within ten minutes."
          : "Show the setup steps as complete for ten minutes. This only changes what this browser draws. It writes nothing, and no other viewer of this account is affected."}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          className="inline-flex min-h-8 items-center rounded-lg bg-white/12 px-3 py-1.5 text-[14px] font-medium text-[oklch(0.97_0.004_262)] transition-colors duration-150 hover:bg-white/20 motion-reduce:transition-none"
          data-slot="demo-setup-override-toggle"
          onClick={onToggle}
          type="button"
        >
          {active ? "Show the real setup" : "Show setup as complete"}
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * The first run's right-hand column
 * ------------------------------------------------------------------------------------------ */

/**
 * What the first-run screen puts where the figures will be, per `HomeFirstRun.dc.html:...`.
 *
 * The previous build drew three figure cards here with a dash in each and a dashed rule under it,
 * which is the shape `docs/COACH-REDESIGN-PLAYBOOK.md` rule 1 exists to forbid: three empty charts
 * are a picture of nothing, drawn at the size of something. The artboard replaces all three with
 * one drenched panel that says what will appear and when, and one card offering the single thing a
 * coach with no leads can actually do.
 *
 * Neither panel reads a metric, deliberately. A first-run screen is the state where every figure
 * is absent by definition, so a figure here could only ever be a zero standing in for "not yet".
 *
 * The artboard's hero line reads "answers within a minute of a DM". That is a latency promise
 * nothing on this page has a receipt for, and `README.md`'s release boundary is explicit about
 * presenting a capability without one, so the sentence keeps the claim the setup rail above it
 * already makes from the connection rows and drops the number.
 */
function FirstRunHero() {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <DeckPanel
        dataSlot="home-first-run-hero"
        drench="live"
        eyebrow="Once you are live"
        headingId="home-first-run-hero-heading"
        hero
        name="Your leads"
      >
        <p className="max-w-[var(--measure-caption)] text-[20px] leading-[1.35] font-medium text-[color:var(--muted)]">
          Your first leads will appear here.
        </p>
        <p className="coach-panel__sentence">
          Your agent answers a DM the moment it arrives, asks your qualifying questions and books
          the good ones onto your calendar.
        </p>
        <p className="coach-panel__stat-note">
          Your numbers will show here once leads start arriving.
        </p>
      </DeckPanel>

      <DeckPanel
        action={{ href: "/coach/agent", label: "Open your agent" }}
        dataSlot="home-first-run-try"
        eyebrow="Before a lead does"
        headingId="home-first-run-try-heading"
        name="Try a conversation"
      >
        <p className="coach-panel__sentence">
          Message your agent the way a lead would. Test conversations never count as leads.
        </p>
      </DeckPanel>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * The screen
 * ------------------------------------------------------------------------------------------ */

export function CoachDashboard({
  attention,
  channelStatus,
  composition,
  customFrom,
  customTo,
  greeting,
  measurement,
  now,
  window,
}: CoachDashboardProps) {
  const firstRun = setupIncomplete(channelStatus);
  /*
   * The demo setup override, gated twice and presented once.
   *
   * Both gates are hard. `demoAccountSwitching` is `SETTERFI_DEMO_LOGINS`, resolved on the server
   * layout, and `account.isDemo` is `tenants.is_demo` for the signed-in tenant, read by that same
   * layout. `measurement.isDemo` is the third: it is the flag the provenance line under the
   * greeting already prints, so the control cannot appear on a page that is not already telling the
   * room these rows are seeded. Any one of the three being false or unknown removes the control,
   * which is the direction an unknown has to fail in.
   *
   * It is offered only on the first-run composition, because that is the only composition with a
   * setup rail to override. Elsewhere it would be a switch with nothing behind it.
   */
  const workspace = useWorkspaceEnv();
  const overrideAvailable = firstRun
    && Boolean(channelStatus)
    && workspace.demoAccountSwitching === true
    && workspace.account?.isDemo === true
    && measurement.isDemo === true;
  const demoOverride = useDemoSetupOverride(overrideAvailable);
  /*
   * One substitution, at the top, feeding every consumer. The status line, the rungs and the
   * counter all read these two values, so they cannot disagree about whether the setup is done: it
   * is not possible to override the cards and leave the header saying a step is waiting, because
   * the header is reading the same object.
   */
  const displayStatus = demoOverride.active ? DEMO_COMPLETE_STATUS : channelStatus;
  const displayBlockedSteps = demoOverride.active ? 0 : attention.blockedSetupSteps;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/*
        The head: the greeting, one status sentence, the provenance line, and the row of controls
        the artboard puts beside the title. It wraps on a narrow pane rather than squeezing,
        because the range control is six stops wide and a 46px title is not something to shrink.
      */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <h1 className="coach-page-title m-0">
            {greeting
              ? `${firstRun ? "Welcome" : "Welcome back"}, ${greeting}`
              : "Dashboard"}
          </h1>
          <StatusLine blockedSetupSteps={displayBlockedSteps} now={now} status={displayStatus} />
          {/*
            The provenance line, which is a hard rule rather than a decoration: demo and test rows
            are labelled on screen wherever they are shown. `measurement.isDemo` is the flag the
            repository already resolves, so nothing new is read to say it.
          */}
          <p
            className="m-0 mt-[10px] text-[14px] text-[var(--muted)]"
            data-provenance={
              demoOverride.active ? "demo-override" : measurement.isDemo ? "demo" : "real"
            }
          >
            {demoOverride.active
              ? DEMO_OVERRIDE_PROVENANCE
              : PROVENANCE_COPY[measurement.isDemo ? "demo" : "real"]}
          </p>
        </div>
        {/*
          The header's trailing control row. What sits in it changes with the run: a first-run
          screen has no window to pick, because it has no figures to pick one for.
        */}
        {/*
          On a phone the strip is the row: six word stops do not fit across 390, so the strip takes
          the full width and scrolls sideways inside it, which is what `HomeMobile.dc.html` draws.
          Sharing the line with the eye there clipped it mid-stop and made a scroller look like a
          truncation.
        */}
        <div className="flex w-full min-w-0 flex-wrap items-end gap-3 sm:w-auto sm:flex-nowrap">
          {firstRun ? null : (
            <CoachHomeRange customFrom={customFrom} customTo={customTo} window={window} />
          )}
          <ContextEye
            action={overrideAvailable
              ? (
                <DemoSetupControl
                  active={demoOverride.active}
                  onToggle={demoOverride.active ? demoOverride.turnOff : demoOverride.turnOn}
                />
              )
              : undefined}
            copy={EYE_COPY}
            placement="header"
            scale="coach"
            screen="coach-dashboard"
          />
        </div>
      </div>

      {firstRun && displayStatus ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            <FirstRun
              blockedSetupSteps={displayBlockedSteps}
              blockedStepKey={attention.blockedStepKey}
              now={now}
              status={displayStatus}
            />
          </div>
          <FirstRunHero />
        </div>
      ) : (
        <>
          <CoachHomeBubbles measurement={measurement} window={window} />
          <CoachHomeMonths composition={composition} />
          <CoachHomeKeywords
            customFrom={customFrom}
            customTo={customTo}
            keywords={measurement.keywords}
            window={window}
          />
        </>
      )}
    </div>
  );
}
