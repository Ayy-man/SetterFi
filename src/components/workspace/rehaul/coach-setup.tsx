"use client";

/*
 * Setup, drawn from `design/coach/Setup.dc.html`.
 *
 * One surface replaces two: `/coach/get-started` (the six-step `GetStartedChecklist`) and
 * `/coach/integrations` (the 1936-line connections page). Both routes mount this, because
 * `src/lib/workspace-navigation.test.ts` pins that every destination demoted off the coach rail
 * stays reachable, and a route that stops rendering is a destination that stopped being reachable.
 *
 * What the audit sent away, per `docs/SIMPLIFICATION-SPEC.md` 2.5 and 2.6: reply windows,
 * connection history, last error, message templates, the four-up stat strip, the "what to try"
 * prose and every other diagnostic. Those are admin's. What is left is the two questions a coach
 * actually opens this page with -- how far along am I, and where can my leads reach me -- as four
 * receipt-backed steps and four channel rows.
 *
 * Three rules do most of the work here and each is enforced by the derivation rather than by
 * discipline at the callsite:
 *
 *   1. **Nothing reads done while provisioning.** A step is `done` only when it holds a receipt
 *      timestamp. `carrierReviewFrom` already refuses to call a filing approved on the strength of
 *      a `running` state, and a step with `ready` but no `evidenceAt` is a claim with no evidence.
 *   2. **The carrier counter is real days elapsed.** `elapsedWorkspaceDays` is the same function
 *      `DayCounter` computes from, so this pill and the counter on Home cannot drift by a day. It
 *      is never a percentage and never a predicted date: carriers publish no decision schedule, so
 *      "about 21" is `CARRIER_TYPICAL_DAYS`'s upper bound in words and not a promise.
 *   3. **A row that SetterFi broke offers no button.** The mobbin research's Customer.io and
 *      LangChain precedents both name the failure rather than flattening it into "disconnected",
 *      and a Reconnect button on a failure the coach cannot fix is an invitation to fail twice.
 */

import Link from "next/link";
import { useState, type ComponentType, type ReactNode } from "react";

import { Status } from "@/components/kit/atomics";
import { ConnectChannelButton } from "@/components/workspace/rehaul/connect-channel-button";
import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";
import {
  CalendarDays,
  ChatText,
  FacebookLogo,
  FileText,
  InstagramLogo,
  OctagonAlert,
  ShieldCheck,
  Smartphone,
  Sparkle,
  UserRound,
  type KitIconProps,
} from "@/components/kit/icons";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import {
  type MetaConnectChannel,
} from "@/components/workspace/live/coach-meta-connect";
import type { Tone } from "@/components/kit/atomics/tone";
import type { CarrierReview } from "@/lib/onboarding/carrier-review";
import { STEP_LABELS } from "@/components/onboarding/view-models";
import { CARRIER_TYPICAL_DAYS, type ProvisioningStep } from "@/lib/onboarding/contracts";
import { WORKSPACE_DISPLAY_TIMEZONE } from "@/lib/format/datetime";
import { displayTextOrNull } from "@/lib/format/display-name";
import type { ChannelConnectionState } from "@/lib/repositories/channel-connections";

/* --------------------------------------------------------------------------------------------
 * What the page is handed
 * ------------------------------------------------------------------------------------------ */

/**
 * A messaging channel's row as the server read it.
 *
 * `state: null` with `checked: true` is a channel with no connection row at all, which is a
 * different fact from a read that did not answer (`checked: false`) and both are different from
 * `disconnected`. Flattening the three is how a page ends up telling a coach to connect something
 * that is already connected, or that nothing is connected when the query timed out.
 */
export type CoachSetupChannelRead = {
  checked: boolean;
  state: ChannelConnectionState | null;
  /** The provider's own name for the account, before demo markers are stripped for display. */
  accountLabel: string | null;
  /** When this connection started answering. Only ever read from a receipt. */
  liveSince: string | null;
  /** When the row last changed, which is what dates an outage. */
  changedAt: string | null;
};

export type CoachSetupCalendarRead = {
  checked: boolean;
  connected: boolean;
  needsReconnect: boolean;
  name: string | null;
};

/** One row of the technical record. Every value is a field the record actually carries. */
export type CoachSetupRecordRow = { label: string; value: string };

/**
 * A provisioning step the runner stopped, by key and by when it stopped.
 *
 * `/coach/home` counts these and names the oldest one, so this page has to be able to name the
 * same rows. The key is the contract's own, not a label: the coach-facing name comes from
 * `STEP_LABELS`, which is the map Home reads, so the two surfaces cannot call one step two things.
 */
export type CoachSetupBlockedStep = { key: ProvisioningStep; stoppedAt: string | null };

export type CoachSetupRead = {
  carrier: CarrierReview;
  /** Every `provisioning_steps` row in `blocked`, oldest first, and whether the read answered. */
  blocked: { checked: boolean; steps: readonly CoachSetupBlockedStep[] };
  /** `provisioning_steps.business_profile`: its receipt, and whether the read answered. */
  business: { checked: boolean; completedAt: string | null };
  /** `provisioning_steps.test_pass`, the safe test SetterFi runs to a number it owns. */
  test: { checked: boolean; completedAt: string | null };
  /** `provisioning_steps.go_live`. */
  goLive: { checked: boolean; completedAt: string | null };
  instagram: CoachSetupChannelRead;
  messenger: CoachSetupChannelRead;
  sms: CoachSetupChannelRead;
  calendar: CoachSetupCalendarRead;
  /**
   * Whether a Meta sign-in can be started from this browser at all. `awaiting_meta` is SetterFi's
   * own review with Meta and is not the coach's to wait out, so those rows say so and press
   * nothing; `read_only` is an impersonated session, which may look but never start an OAuth.
   */
  metaConnect: "ready" | "awaiting_meta" | "read_only";
  record: { checked: boolean; rows: readonly CoachSetupRecordRow[] };
};

export type CoachSetupProps = {
  read: CoachSetupRead;
  /** Injected by tests so the day counter and the receipts cannot disagree about today. */
  now?: Date;
};

/* --------------------------------------------------------------------------------------------
 * Copy that left the page
 * ------------------------------------------------------------------------------------------ */

/**
 * The explanations this page used to print under its headings, handed to the eye.
 *
 * The old Connections page carried roughly 1,500 words of this in three places at once, and the
 * carrier reassurance was the single most load-bearing sentence in it: the most common support
 * contact during the A2P window is a coach who believes something has broken. It is one sentence
 * here rather than one per channel card, which is the "each fact once" rule doing its job.
 *
 * The support hours are deliberately not in this list. They are the "Ask a person" panel's whole
 * content, and saying them twice on one screen is exactly what this page was rebuilt to stop.
 */
export const COACH_SETUP_EYE_COPY = [
  "Carriers take about three weeks to approve a new business for texting.",
  "Nothing is broken while that runs and there is nothing for you to do.",
  "The day count is real days since we filed, never a prediction and never a percentage.",
  "Every step here has a receipt; the technical record holds the hashes, the carrier's own",
  "decision code and who filed it, for the day you need to prove when something happened.",
  "A channel that stopped answering because our connection broke is ours to fix, so it carries",
  "no button.",
].join(" ");

/* --------------------------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------------------------ */

/** "August 28". No year: every receipt on this page is inside the current setup. */
const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

/** "Tuesday". What dates an outage for a reader who does not think in calendar dates. */
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
  weekday: "long",
});

function dayLabel(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? DAY_FORMAT.format(new Date(parsed)) : null;
}

function weekdayLabel(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? WEEKDAY_FORMAT.format(new Date(parsed)) : null;
}

/* --------------------------------------------------------------------------------------------
 * The four steps
 * ------------------------------------------------------------------------------------------ */

/**
 * The four journey rows, plus one row per stopped step the four do not already stand for.
 *
 * A stopped step keyed `blocked:<provisioning key>` so the row can be told from the journey rows
 * in the DOM and so two stopped steps never collide on one React key.
 */
export type CoachSetupStepKey =
  | "business"
  | "carrier"
  | "test"
  | "live"
  | `blocked:${ProvisioningStep}`;

export type CoachSetupStepView = {
  key: CoachSetupStepKey;
  name: string;
  body: string;
  /** The receipt line under the body: a date when there is one, and words when there is not. */
  receipt: string;
  pill: { label: ReactNode; tone: Tone };
  /** True only where a receipt timestamp exists. Nothing reads done while provisioning. */
  done: boolean;
};

const STEP_ICON: Record<"business" | "carrier" | "test" | "live", ComponentType<KitIconProps>> = {
  business: UserRound,
  carrier: ShieldCheck,
  live: Sparkle,
  test: ChatText,
};

function stepIcon(key: CoachSetupStepKey): ComponentType<KitIconProps> {
  return key.startsWith("blocked:") ? OctagonAlert : STEP_ICON[key as "business"];
}

/**
 * The journey row each provisioning key already stands for.
 *
 * A stopped `business_profile` has to change the "Business details" row rather than add a second
 * row about the same subject, or the page would show one step twice under two names. Keys with no
 * entry here -- opt-in pages, the calendar, the offer -- have no row of their own on this page and
 * get one when they stop, which is what lets Setup name the step `/coach/home` names.
 */
const BLOCKED_ROW_OWNER: Partial<Record<ProvisioningStep, "business" | "carrier" | "test" | "live">> = {
  a2p_brand: "carrier",
  a2p_campaign: "carrier",
  business_profile: "business",
  go_live: "live",
  sms_live: "carrier",
  test_pass: "test",
};

/** What a stopped step says. No button anywhere: restarting one is not the coach's to press. */
function stoppedRow(base: { key: CoachSetupStepKey; name: string }, stoppedAt: string | null): CoachSetupStepView {
  const stopped = dayLabel(stoppedAt);
  return {
    body:
      "This step stopped before it finished. Starting it again is ours to do, not yours, and we "
      + "are on it.",
    done: false,
    key: base.key,
    name: base.name,
    pill: { label: "Blocked", tone: "warning" },
    receipt: stopped ? `Stopped ${stopped}` : "The day it stopped was not recorded.",
  };
}

/**
 * The carrier row, which is the one step whose state is a union rather than a timestamp.
 *
 * Six arms, because `CarrierReview` has six and each is a different sentence a coach can act on.
 * `unchecked` is deliberately not folded into `not-filed`: a read that did not run has established
 * nothing, and "we have not filed yet" on the strength of a failed query is the confident wrong
 * answer the honest-states rule exists to stop.
 */
function carrierStep(carrier: CarrierReview, now: Date | undefined): CoachSetupStepView {
  const base = {
    key: "carrier" as const,
    name: "Carrier review",
  };
  const typicalEnd = CARRIER_TYPICAL_DAYS[1];

  if (carrier.kind === "unchecked") {
    return {
      ...base,
      body: "We could not reach the carrier record just now, so this step is not reporting.",
      done: false,
      pill: { label: "Not checked", tone: "neutral" },
      receipt: "Nothing changed while we could not read it.",
    };
  }
  if (carrier.kind === "not-filed") {
    return {
      ...base,
      body: "We file your texting application with the carriers once your business details are in.",
      done: false,
      pill: { label: "Not filed", tone: "neutral" },
      receipt: "Comes after your business details.",
    };
  }
  if (carrier.kind === "live") {
    return {
      ...base,
      body: "The carriers approved your business for texting.",
      done: true,
      pill: { label: "Done", tone: "good" },
      receipt: "Approved. The decision is in the technical record below.",
    };
  }
  if (carrier.kind === "failed") {
    return {
      ...base,
      body: "The filing did not complete. We are refiling it; there is nothing for you to send.",
      done: false,
      pill: { label: "Being refiled", tone: "warning" },
      receipt: "SetterFi owns this one.",
    };
  }
  if (carrier.kind === "blocked") {
    return {
      ...base,
      body: "The carriers refused this filing. We will contact you about what they need.",
      done: false,
      pill: { label: "Refused", tone: "warning" },
      receipt: "The carrier's decision code is in the technical record below.",
    };
  }

  const day = carrier.submittedAt ? elapsedWorkspaceDays(carrier.submittedAt, now) : null;
  const sent = dayLabel(carrier.submittedAt);
  return {
    ...base,
    body:
      "Carrier review runs about three weeks and nobody is told a finish date. Nothing is broken "
      + "and there is nothing for you to do while it runs.",
    done: false,
    pill: day === null
      ? { label: "In review", tone: "waiting" }
      : {
        label: (
          <>
            Day <span className="mono">{day}</span> of about {typicalEnd}
          </>
        ),
        tone: "waiting",
      },
    receipt: sent
      ? `Sent ${sent}`
      : "The filing date was not recorded, so no day count is shown.",
  };
}

/**
 * The four steps, in the order the runner enforces.
 *
 * `test_pass` sits between the carrier and go-live rather than being folded into it, because the
 * runner already gates `go_live` on it: a journey that jumped from the carrier straight to live
 * was hiding a gate the coach still had to clear.
 */
export function coachSetupSteps(read: CoachSetupRead, now?: Date): readonly CoachSetupStepView[] {
  const businessFiled = dayLabel(read.business.completedAt);
  const testPassed = dayLabel(read.test.completedAt);
  const liveSince = dayLabel(read.goLive.completedAt);

  const business: CoachSetupStepView = businessFiled
    ? {
      body: "Your name, address and website went to the carriers with your texting application.",
      done: true,
      key: "business",
      name: "Business details",
      pill: { label: "Done", tone: "good" },
      receipt: `Filed ${businessFiled}`,
    }
    : read.business.checked
      ? {
        body: "Your name, address and website go to the carriers with your texting application.",
        done: false,
        key: "business",
        name: "Business details",
        pill: { label: "Not filed yet", tone: "neutral" },
        receipt: "We collect these with you before anything is filed.",
      }
      : {
        body: "We could not read your business details just now, so this step is not reporting.",
        done: false,
        key: "business",
        name: "Business details",
        pill: { label: "Not checked", tone: "neutral" },
        receipt: "Nothing changed while we could not read it.",
      };

  const test: CoachSetupStepView = testPassed
    ? {
      body: "We sent one message to a number we own and it arrived, so texting works.",
      done: true,
      key: "test",
      name: "Safe test",
      pill: { label: "Done", tone: "good" },
      receipt: `Passed ${testPassed}`,
    }
    : {
      body:
        "We send one message to a number we own the day the carriers finish, to prove texting "
        + "works before a lead ever sees it.",
      done: false,
      key: "test",
      name: "Safe test",
      pill: { label: "Comes later", tone: "neutral" },
      receipt: read.test.checked
        ? "Runs after the carrier review."
        : "We could not read this step just now.",
    };

  const live: CoachSetupStepView = liveSince
    ? {
      body: "Your agent is answering and booking calls.",
      done: true,
      key: "live",
      name: "Go live",
      pill: { label: "Live", tone: "good" },
      receipt: `Live since ${liveSince}`,
    }
    : {
      body: "Your agent turns on once your calendar is connected and the safe test has passed.",
      done: false,
      key: "live",
      name: "Go live",
      pill: { label: "Comes last", tone: "neutral" },
      receipt: !read.calendar.checked
        ? "We could not read your calendar just now."
        : read.calendar.connected
          ? "Waiting on the safe test"
          : "Waiting on your calendar",
    };

  const journey = [business, carrierStep(read.carrier, now), test, live];
  const stopped = read.blocked.steps;

  /*
   * A stopped step either replaces the row that already stands for it or becomes a row of its own.
   * Both arms name it from `STEP_LABELS` when it is a row of its own, which is the map
   * `/coach/home` names the blocked step from, so the page a coach is sent to shows the step they
   * were sent to look at.
   */
  const rows = journey.map((row) => {
    const hit = stopped.find((candidate) => BLOCKED_ROW_OWNER[candidate.key] === row.key);
    return hit ? stoppedRow(row, hit.stoppedAt) : row;
  });
  const ownRows = stopped
    .filter((candidate) => !BLOCKED_ROW_OWNER[candidate.key])
    .map((candidate) =>
      stoppedRow({ key: `blocked:${candidate.key}`, name: STEP_LABELS[candidate.key] }, candidate.stoppedAt)
    );

  return [...rows, ...ownRows];
}

/**
 * The coach-facing names of the stopped steps, in the order they stopped.
 *
 * Read by the status sentence so the header can name what Home names. A step folded into a journey
 * row keeps that row's name -- "Business details", not "Business profile" -- because that is the
 * name the row under the sentence carries, and a sentence that points at a row nobody can find is
 * the defect this whole change is about.
 */
export function coachSetupBlockedNames(read: CoachSetupRead): readonly string[] {
  const JOURNEY_NAMES = {
    business: "Business details",
    carrier: "Carrier review",
    live: "Go live",
    test: "Safe test",
  } as const;
  const names: string[] = [];
  for (const step of read.blocked.steps) {
    const owner = BLOCKED_ROW_OWNER[step.key];
    const name = owner ? JOURNEY_NAMES[owner] : STEP_LABELS[step.key];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/* --------------------------------------------------------------------------------------------
 * The four channels
 * ------------------------------------------------------------------------------------------ */

export type CoachSetupChannelKey = "instagram" | "messenger" | "sms" | "calendar";

export type CoachSetupChannelAction =
  | { kind: "meta"; label: "Connect" | "Reconnect"; channel: MetaConnectChannel; name: string }
  | { kind: "link"; label: string; href: string };

export type CoachSetupChannelView = {
  key: CoachSetupChannelKey;
  name: string;
  sentence: string;
  pill: { label: string; tone: Tone };
  action: CoachSetupChannelAction | null;
};

const CHANNEL_ICON: Record<CoachSetupChannelKey, ComponentType<KitIconProps>> = {
  calendar: CalendarDays,
  instagram: InstagramLogo,
  messenger: FacebookLogo,
  sms: Smartphone,
};

/** The states SetterFi owns. None of them is the coach's to press, so none of them gets a button. */
const OUTAGE_STATES: readonly ChannelConnectionState[] = [
  "error",
  "flagged",
  "restricted",
  "blocked_permanent",
];

/**
 * One Meta channel's row.
 *
 * The three sentences the brief names are all here and each belongs to exactly one state.
 * `expired` is the coach's: a token that ran out is fixed by signing in again, which is a thing
 * they can do in thirty seconds. Everything in `OUTAGE_STATES` is ours, and it says so and offers
 * nothing to press. A connected row names the account and stops, because there is nothing on a
 * working connection worth a coach's attention.
 */
function metaChannelRow(
  key: "instagram" | "messenger",
  name: string,
  read: CoachSetupChannelRead,
  metaConnect: CoachSetupRead["metaConnect"],
): CoachSetupChannelView {
  const account = displayTextOrNull(read.accountLabel);
  const connectAction = (label: "Connect" | "Reconnect"): CoachSetupChannelAction | null =>
    metaConnect === "ready" ? { channel: key, kind: "meta", label, name } : null;

  if (!read.checked) {
    return {
      action: null,
      key,
      name,
      pill: { label: "Not checked", tone: "neutral" },
      sentence: "We could not check this connection just now. Nothing has changed.",
    };
  }

  if (read.state === "live") {
    const since = dayLabel(read.liveSince);
    return {
      action: null,
      key,
      name,
      pill: { label: "Connected", tone: "good" },
      sentence: account
        ? since
          ? `Answering messages for ${account} since ${since}.`
          : `Answering messages for ${account}.`
        : "Answering messages. The account name was not recorded.",
    };
  }

  if (read.state === "expired") {
    const action = connectAction("Reconnect");
    return {
      action,
      key,
      name,
      pill: { label: "Not answering", tone: "warning" },
      sentence: action
        ? "Its permission ran out, and reconnecting brings it back."
        : metaConnect === "read_only"
          ? "Its permission ran out. Reconnecting needs the coach's own sign-in, and this view is read only."
          : "Its permission ran out. Signing in again opens here once Meta approves our app, which is ours to chase.",
    };
  }

  if (read.state !== null && OUTAGE_STATES.includes(read.state)) {
    const day = weekdayLabel(read.changedAt);
    return {
      action: null,
      key,
      name,
      pill: { label: "Not answering", tone: "warning" },
      sentence: day
        ? `${name} stopped answering on ${day}. We’re fixing it.`
        : `${name} stopped answering. We’re fixing it.`,
    };
  }

  if (read.state === "connecting" || read.state === "pending_review" || read.state === "ready") {
    return {
      action: null,
      key,
      name,
      pill: { label: "Connecting", tone: "waiting" },
      sentence: "We are finishing this connection. There is nothing for you to do.",
    };
  }

  const action = connectAction("Connect");
  return {
    action,
    key,
    name,
    pill: { label: "Not connected", tone: "neutral" },
    sentence: action
      ? "Your agent answers here once you connect the account."
      : metaConnect === "read_only"
        ? "Connecting needs the coach's own sign-in, and this view is read only."
        : "Sign-in opens here once Meta approves our app, which is ours to chase.",
  };
}

/**
 * Texting, which is the one channel with no button in any state.
 *
 * A coach cannot make a carrier decide faster and there is nothing to press, so the row carries
 * its state and stops. It also does not repeat the day count: that fact belongs to the carrier
 * step above it and appears on this screen exactly once.
 */
function smsRow(read: CoachSetupChannelRead, carrier: CarrierReview): CoachSetupChannelView {
  const base = { action: null, key: "sms" as const, name: "Text messaging" };
  if (!read.checked) {
    return {
      ...base,
      pill: { label: "Not checked", tone: "neutral" },
      sentence: "We could not check this connection just now. Nothing has changed.",
    };
  }
  if (read.state === "live") {
    const number = displayTextOrNull(read.accountLabel);
    return {
      ...base,
      pill: { label: "Connected", tone: "good" },
      sentence: number
        ? `Your leads can text you at ${number}.`
        : "Your leads can text you. The number was not recorded.",
    };
  }
  if (read.state !== null && OUTAGE_STATES.includes(read.state)) {
    const day = weekdayLabel(read.changedAt);
    return {
      ...base,
      pill: { label: "Not answering", tone: "warning" },
      sentence: day
        ? `Text messaging stopped answering on ${day}. We’re fixing it.`
        : "Text messaging stopped answering. We’re fixing it.",
    };
  }
  return {
    ...base,
    pill: { label: "Not live yet", tone: "neutral" },
    sentence: carrier.kind === "blocked" || carrier.kind === "failed"
      ? "This turns on once the carrier filing is settled, which is ours to sort out."
      : "This turns on the day the carriers finish their review.",
  };
}

function calendarRow(read: CoachSetupCalendarRead): CoachSetupChannelView {
  const base = { key: "calendar" as const, name: "Your calendar" };
  if (!read.checked) {
    return {
      ...base,
      action: null,
      pill: { label: "Not checked", tone: "neutral" },
      sentence: "We could not check your calendar just now. Nothing has changed.",
    };
  }
  if (read.needsReconnect) {
    return {
      ...base,
      action: { href: "/onboarding/calendar", kind: "link", label: "Reconnect calendar" },
      pill: { label: "Not answering", tone: "warning" },
      sentence: "Its permission ran out, and reconnecting brings it back.",
    };
  }
  if (read.connected) {
    const name = displayTextOrNull(read.name);
    return {
      ...base,
      action: null,
      pill: { label: "Connected", tone: "good" },
      sentence: name
        ? `Booked calls go on ${name}.`
        : "Booked calls go on your calendar. Its name was not recorded.",
    };
  }
  return {
    ...base,
    action: { href: "/onboarding/calendar", kind: "link", label: "Connect calendar" },
    pill: { label: "Waiting on you", tone: "warning" },
    sentence: "Your agent needs somewhere to put the calls it books.",
  };
}

export function coachSetupChannels(read: CoachSetupRead): readonly CoachSetupChannelView[] {
  return [
    metaChannelRow("instagram", "Instagram", read.instagram, read.metaConnect),
    metaChannelRow("messenger", "Messenger", read.messenger, read.metaConnect),
    smsRow(read.sms, read.carrier),
    calendarRow(read.calendar),
  ];
}

/**
 * Which row spends the page's one accent fill.
 *
 * A first connection outranks a reconnection, which is what the artboard draws: the calendar has
 * never been connected and it is the gate on going live, while Instagram was working an hour ago
 * and its Reconnect is a thirty-second repair. Returning a key rather than a boolean per row is
 * what makes "exactly one" a property of the function instead of a thing every row has to agree
 * about.
 */
export function coachSetupAccentRow(
  rows: readonly CoachSetupChannelView[],
): CoachSetupChannelKey | null {
  const actionable = rows.filter((row) => row.action !== null);
  const firstConnect = actionable.find((row) => row.action?.label.startsWith("Connect"));
  return (firstConnect ?? actionable[0])?.key ?? null;
}

/**
 * How many of these are the coach's own to do, which is the only count the page states.
 *
 * Steps are excluded on purpose. Every step on this page is either finished, with SetterFi, or
 * with the carriers; the coach's own work always lands as a channel row with a button, so counting
 * both halves would count the calendar twice.
 */
export function coachSetupWaitingCount(rows: readonly CoachSetupChannelView[]): number {
  return rows.filter((row) => row.action !== null).length;
}

/* --------------------------------------------------------------------------------------------
 * Faces
 * ------------------------------------------------------------------------------------------ */

const PANEL_CLASS = [
  "flex min-w-0 flex-col overflow-hidden rounded-[24px_24px_17px_17px]",
  "border border-[var(--line)]",
  "bg-[linear-gradient(180deg,var(--card-top),var(--card))]",
  "shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_1px_2px_rgba(28,42,82,0.04),0_8px_20px_-14px_rgba(28,42,82,0.16)]",
].join(" ");

/*
 * 48px and 16px, which is the coach control scale in `design/coach/VOCABULARY.md` and not the
 * kit's. `kitButtonClass` tops out at 34px because the owner console's toolbar is 30 to 34px, and
 * `coach.css` can raise a mounted kit button to 44px but cannot make it the 48px the artboards
 * draw. The accent fill's shadow is imported rather than retyped so this file shares one string
 * with the kit's own primary variant.
 */
const BUTTON_BASE =
  "inline-flex h-[48px] shrink-0 items-center justify-center gap-[10px] whitespace-nowrap "
  + "rounded-[9px] border px-[22px] text-[16px] no-underline hover:no-underline";
const BUTTON_SECONDARY =
  `${BUTTON_BASE} border-[var(--line)] bg-[var(--control-fill)] font-medium text-[var(--body)] `
  + "hover:border-[var(--accent-edge)] hover:text-[var(--ink)]";
const BUTTON_ACCENT =
  `${BUTTON_BASE} border-[var(--accent-line)] px-[24px] font-semibold text-[var(--on-accent)] `
  + `[background:var(--accent-fill)] ${ACCENT_FILL_SHADOW_CLASS} hover:brightness-110`;

function Band({ eyebrow, name, titleId }: { eyebrow: string; name: string; titleId: string }) {
  return (
    <div className="flex min-h-[78px] items-start gap-3 border-b border-[var(--line)] px-5 py-[19px]">
      <div className="min-w-0">
        <p className="m-0 mb-1 text-[14px] leading-[1.4] text-[var(--muted)]">{eyebrow}</p>
        <h2
          className="m-0 text-[20px] leading-[1.25] font-medium tracking-[-0.015em] text-[var(--ink)]"
          id={titleId}
        >
          {name}
        </h2>
      </div>
    </div>
  );
}

/**
 * The round tile beside a step, and the square one beside a channel.
 *
 * `aria-hidden` on the glyph: the row already carries the step's name and its state in words, and
 * a tile that repeats either of them in a picture is the fourth time this screen would have said
 * the same thing.
 */
function RowTile({
  children,
  round,
  tone,
}: {
  children: ReactNode;
  round?: boolean;
  tone: "good" | "waiting" | "plain";
}) {
  const face = tone === "good"
    ? "border-[var(--good-line)] bg-[var(--good-wash)] text-[var(--good-text)]"
    : tone === "waiting"
      ? "border-[var(--waiting-line)] bg-[var(--waiting-wash)] text-[var(--waiting-text)]"
      : "border-[var(--line)] bg-[var(--well)] text-[var(--body)]";
  return (
    <span
      aria-hidden="true"
      className={`grid size-[44px] flex-none place-items-center border ${
        round ? "rounded-full" : "rounded-[10px]"
      } ${face}`}
    >
      {children}
    </span>
  );
}

const ROW_CLASS =
  "flex flex-wrap items-start gap-[18px] px-5 py-[22px] border-b border-[var(--line-soft)] last:border-b-0";
const STEP_ROW_CLASS =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 sm:gap-x-[18px] px-5 py-[22px] border-b border-[var(--line-soft)] last:border-b-0";
const ROW_NAME_CLASS =
  "m-0 text-[20px] leading-[1.25] font-medium tracking-[-0.015em] text-[var(--ink)]";
const ROW_BODY_CLASS =
  "m-0 mt-2 max-w-[var(--measure-sentence)] text-[16px] leading-[1.55] text-[var(--muted)]";
const ROW_RECEIPT_CLASS = "m-0 mt-2 text-[14px] leading-[1.55] text-[var(--muted)]";

/**
 * A step row: tile, name, state pill, then the two sentences.
 *
 * Grid rather than the flex `ROW_CLASS` the channel rows use, because at 390 the flex version put
 * the pill on a line of its own *under* the sentences, where it read as orphaned from the step it
 * describes. The grid keeps the pill on the name's line at every width -- right-aligned in its own
 * column -- and lets the sentences take the width the pill vacates on the row below, which is the
 * only thing that changes below `sm`. At `sm` and up the sentences stay inside the name's column,
 * so the 1440 rendering is byte-for-byte what it was.
 */
function StepRow({ step }: { step: CoachSetupStepView }) {
  const Icon = stepIcon(step.key);
  return (
    <li className={`${STEP_ROW_CLASS} list-none`} data-slot="coach-setup-step" data-step={step.key}>
      <div className="col-start-1 row-start-1 row-span-2">
        <RowTile
          round
          tone={step.done
            ? "good"
            : step.pill.tone === "waiting" || step.pill.tone === "warning"
              ? "waiting"
              : "plain"}
        >
          <Icon size={20} strokeWidth={1.75} />
        </RowTile>
      </div>
      <h3 className={`${ROW_NAME_CLASS} col-start-2 row-start-1 min-w-0`}>{step.name}</h3>
      <div className="col-start-3 row-start-1 justify-self-end pt-[6px]">
        <Status label={step.pill.label} tone={step.pill.tone} />
      </div>
      <div className="col-start-2 col-span-2 row-start-2 min-w-0 sm:col-span-1">
        <p className={ROW_BODY_CLASS}>{step.body}</p>
        <p className={ROW_RECEIPT_CLASS}>{step.receipt}</p>
      </div>
    </li>
  );
}

function ChannelRow({ accent, row }: { accent: boolean; row: CoachSetupChannelView }) {
  const Icon = CHANNEL_ICON[row.key];
  return (
    <li className={`${ROW_CLASS} list-none`} data-channel={row.key} data-slot="coach-setup-channel">
      <RowTile tone="plain">
        <Icon size={20} strokeWidth={1.75} />
      </RowTile>
      <div className="min-w-0 flex-1 basis-[min(100%,24ch)]">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className={ROW_NAME_CLASS}>{row.name}</h3>
          <Status label={row.pill.label} tone={row.pill.tone} />
        </div>
        <p className={ROW_BODY_CLASS}>{row.sentence}</p>
      </div>
      {row.action ? (
        <div className="flex-none">
          {row.action.kind === "link" ? (
            <Link className={accent ? BUTTON_ACCENT : BUTTON_SECONDARY} href={row.action.href}>
              {row.action.label}
            </Link>
          ) : (
            <ConnectChannelButton
              channels={[row.action.channel]}
              className={accent ? BUTTON_ACCENT : BUTTON_SECONDARY}
            >
              {`${row.action.label} ${row.action.name}`}
            </ConnectChannelButton>
          )}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The technical record, closed.
 *
 * A native `<details>` rather than a kit disclosure, so it opens with no JavaScript and so the
 * summary inherits the 44px target `coach.css` puts on every `summary` under this shell. The rows
 * are the hashes, the carrier's decision code and who filed: evidence for a reviewer, which
 * `docs/SIMPLIFICATION-SPEC.md` 2.5 demotes off the face and does not delete.
 */
function TechnicalRecord({ record }: { record: CoachSetupRead["record"] }) {
  if (!record.checked) {
    return (
      <p className="m-0 px-5 pb-5 text-[16px] leading-[1.55] text-[var(--muted)]">
        We could not read the filing record just now.
      </p>
    );
  }
  if (record.rows.length === 0) {
    return (
      <p className="m-0 px-5 pb-5 text-[16px] leading-[1.55] text-[var(--muted)]">
        No filing record has been stored yet.
      </p>
    );
  }
  return (
    <div className="px-5 pb-5">
      <details
        className="rounded-[11px] border border-[var(--line)] bg-[var(--well)]"
        data-slot="coach-setup-record"
      >
        <summary className="flex min-h-[56px] cursor-pointer list-none items-center gap-3 px-[18px] text-[16px] font-medium text-[var(--body)]">
          <FileText aria-hidden className="text-[var(--faint)]" size={20} strokeWidth={1.75} />
          Show the technical record
        </summary>
        <dl className="m-0 grid gap-x-5 gap-y-2 border-t border-[var(--line)] px-[18px] py-4 text-[14px] leading-[1.55] sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)]">
          {record.rows.map((entry) => (
            <div className="contents" key={entry.label}>
              <dt className="text-[var(--muted)]">{entry.label}</dt>
              <dd className="m-0 min-w-0 break-words text-[var(--ink)]">{entry.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * The page
 * ------------------------------------------------------------------------------------------ */

/** "A", "A and B", "A, B and C". */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The status sentence under the title, which names what stopped, counts what waits, and says who
 * has the rest.
 *
 * The stopped clause comes first and by name because `/coach/home` prints the same step's name on
 * its own setup rung and links here. Until 2026-09-04 this sentence read "Nothing is waiting on
 * you" while Home said a step was blocked and offered "Fix this step", so a coach arrived at a
 * page that showed neither the step nor the trouble. The clause never says the stopped step is
 * waiting on the coach: `provisioningStepDescriptor` refuses to offer a retry on any step in
 * `blocked`, whoever owns it, so there is nothing for them to press and saying otherwise would be
 * the same lie in the other direction.
 *
 * The count that follows is still only what a coach can act on, which on this page is a channel
 * row carrying a button.
 */
function statusSentence(
  waiting: number,
  everythingUnchecked: boolean,
  blockedNames: readonly string[],
): string {
  if (everythingUnchecked) {
    return "We could not read your setup just now. Nothing has changed while we could not read it.";
  }
  const rest = waiting === 0
    ? blockedNames.length > 0
      ? "Nothing else is waiting on you."
      : "Nothing is waiting on you. Everything here is with us or the carriers."
    : waiting === 1
      ? "One thing is waiting on you. Everything else is with us or the carriers."
      : `${waiting} things are waiting on you. Everything else is with us or the carriers.`;
  if (blockedNames.length === 0) return rest;
  const stopped = `${nameList(blockedNames)} stopped, and ${
    blockedNames.length === 1 ? "it is" : "they are"
  } ours to fix, not yours.`;
  return `${stopped} ${rest}`;
}

export function CoachSetup({ now, read }: CoachSetupProps) {

  const steps = coachSetupSteps(read, now);
  const channels = coachSetupChannels(read);
  const accentKey = coachSetupAccentRow(channels);
  const waiting = coachSetupWaitingCount(channels);
  const blockedNames = coachSetupBlockedNames(read);
  const everythingUnchecked = !read.business.checked
    && !read.test.checked
    && read.carrier.kind === "unchecked"
    && !read.instagram.checked
    && !read.messenger.checked
    && !read.sms.checked
    && !read.calendar.checked;


  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end gap-6">
        <div className="min-w-0">
          <h1 className="m-0 text-[46px] leading-[1.05] font-semibold tracking-[-0.026em] text-[var(--ink)]">
            Your setup
          </h1>
          <p className="m-0 mt-3 max-w-[var(--measure-wide)] text-[17px] leading-[1.5] text-[var(--body)]">
            {statusSentence(waiting, everythingUnchecked, blockedNames)}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <ContextEye
            copy={COACH_SETUP_EYE_COPY}
            placement="header"
            scale="coach"
            screen="coach-setup"
          />
        </div>
      </div>

      <div className="grid items-stretch gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section
          aria-labelledby="coach-setup-steps-heading"
          className={`${PANEL_CLASS} flex-grow`}
          data-slot="coach-setup-steps"
        >
          <Band
            eyebrow="Each step here carries a receipt"
            name="How far along you are"
            titleId="coach-setup-steps-heading"
          />
          <ul className="m-0 flex list-none flex-col p-0">
            {steps.map((step) => (
              <StepRow key={step.key} step={step} />
            ))}
          </ul>
          <div className="mt-auto pt-5">
            <TechnicalRecord record={read.record} />
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-5">
          <section
            aria-labelledby="coach-setup-channels-heading"
            className={`${PANEL_CLASS} flex-grow`}
            data-slot="coach-setup-channels"
          >
            <Band
              eyebrow="Where your leads reach you"
              name="Your channels"
              titleId="coach-setup-channels-heading"
            />
            <ul className="m-0 flex list-none flex-col p-0">
              {channels.map((row) => (
                <ChannelRow accent={row.key === accentKey} key={row.key} row={row} />
              ))}
            </ul>
          </section>

          <section
            aria-labelledby="coach-setup-support-heading"
            className={PANEL_CLASS}
            data-slot="coach-setup-support"
          >
            <Band
              eyebrow="Not answered here"
              name="Ask a person"
              titleId="coach-setup-support-heading"
            />
            <p className="m-0 max-w-[var(--measure-deck)] px-5 pt-[18px] pb-5 text-[16px] leading-[1.5] text-[var(--muted)]">
              Message us from the bubble in the corner. Someone answers on weekdays between 9 and 6
              Eastern.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
