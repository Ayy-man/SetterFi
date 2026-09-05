/*
 * Setup: one list of what stands between a coach and a live agent, drawn from one read.
 *
 * The 2026-09-04 screenshots showed the same coach three lists about the same afternoon: Home's
 * three-row rail said a step was blocked and offered to fix it, this page said nothing was waiting,
 * and `/onboarding` said five steps were still theirs. Each read something true. Together they
 * were a contradiction a coach cannot resolve, and `docs/plans/2026-09-04-coach-setup-and-thread-
 * design.md` records the four rules that replace them:
 *
 *   1. One list. `coachSetupRows` is the only derivation, `loadCoachSetup` the only read. Home
 *      draws the rows compact through `CoachSetupRows`; this page draws them in full.
 *   2. Every row has an owner. A row that is the coach's carries at most one button. A row that is
 *      SetterFi's or the carriers' carries a date, a day count or a sentence, and nothing to press.
 *   3. One row is open: the first that is the coach's to do. It carries its explanation and its
 *      button; every other row is a line. The page spends its one accent fill on that button.
 *   4. The wait is a timeline: filed on a date, in review on day N of about 21, the safe test, live.
 *
 * `coachSetupSteps` and `coachSetupChannels` survive from the first build as the per-fact
 * derivations the rows are assembled from, because their arms (nothing reads done while the
 * carriers decide, a row SetterFi broke offers no button, the outage names the day) are each a
 * ruling with a test behind it.
 */

import Link from "next/link";
import { type ComponentType, type ReactNode } from "react";

import { Status } from "@/components/kit/atomics";
import { ConnectChannelButton } from "@/components/workspace/rehaul/connect-channel-button";
import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";
import {
  CalendarDays,
  ChatText,
  Check,
  CreditCard,
  FileText,
  OctagonAlert,
  ShieldCheck,
  Smartphone,
  Sparkle,
  UserRound,
  type KitIconProps,
} from "@/components/kit/icons";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import type { MetaConnectChannel } from "@/components/workspace/live/coach-meta-connect";
import type { Tone } from "@/components/kit/atomics/tone";
import type { CarrierReview } from "@/lib/onboarding/carrier-review";
import { STEP_LABELS } from "@/components/onboarding/view-models";
import { CARRIER_TYPICAL_DAYS, type ProvisioningStep } from "@/lib/onboarding/contracts";
import { WORKSPACE_DISPLAY_TIMEZONE } from "@/lib/format/datetime";
import { displayTextOrNull } from "@/lib/format/display-name";
import type { ChannelConnectionState } from "@/lib/repositories/channel-connections";

/* --------------------------------------------------------------------------------------------
 * The read
 * ------------------------------------------------------------------------------------------ */

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

export type CoachSetupRecordRow = { label: string; value: string };

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
  /**
   * The published offer row, which is the same read the offer step makes. Published, not saved: a
   * draft is words the agent has never said to a lead, and the row says so rather than ticking.
   */
  offer: { checked: boolean; published: boolean };
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

/**
 * What the eye says. The support hours are deliberately not in this list: they are the "Ask a
 * person" panel's whole content, and saying them twice on one screen is what this page was rebuilt
 * to stop.
 */
export const COACH_SETUP_EYE_COPY = [
  "Every row here is either yours or ours, and only yours carry a button.",
  "Carriers take about three weeks to approve a new business for texting; nothing is broken while",
  "that runs and the day count is real days since we filed, never a prediction and never a",
  "percentage.",
  "A step that stopped is ours to restart, so it carries no button either.",
  "The technical record holds the hashes, the carrier's own decision code and who filed it, for",
  "the day you need to prove when something happened.",
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

/** "A", "A and B", "A, B and C". */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A row name mid-sentence: "your calendar", but "Instagram and Messenger" keeps its capitals. */
function mention(name: string): string {
  return /^[A-Z][a-z]+ and /.test(name) || /^(Instagram|Messenger|WhatsApp)/.test(name)
    ? name
    : name.charAt(0).toLowerCase() + name.slice(1);
}

const COUNT_WORDS = ["Nothing", "One thing", "Two things", "Three things", "Four things", "Five things"];

/* --------------------------------------------------------------------------------------------
 * The receipt-backed steps
 * ------------------------------------------------------------------------------------------ */

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

/**
 * The journey row each provisioning key already stands for.
 *
 * A stopped `business_profile` has to change the "Business details" row rather than add a second
 * row about the same subject, or the page would show one step twice under two names. Keys with no
 * entry here get a row of their own when they stop, which is what lets this page name the step
 * `/coach/home` used to name.
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
    pill: { label: "Stopped", tone: "warning" },
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
  const base = { key: "carrier" as const, name: "Carrier review" };
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
      receipt: "Approved. The decision is in the technical record.",
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
      receipt: "The carrier's decision code is in the technical record.",
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
 * The four receipt-backed steps, in the order the runner enforces, with a stopped step either
 * changing the row that stands for it or adding a row of its own.
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
        body:
          "Your name, address and website. The carriers need them before we can file your "
          + "texting application, and it takes about five minutes.",
        done: false,
        key: "business",
        name: "Business details",
        pill: { label: "Yours to do", tone: "warning" },
        receipt: "About five minutes.",
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
        ? "After the carriers finish."
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
      body: "Your agent turns on when you press go live, once everything above is done.",
      done: false,
      key: "live",
      name: "Go live",
      pill: { label: "Comes last", tone: "neutral" },
      receipt: "After the safe test.",
    };

  const journey = [business, carrierStep(read.carrier, now), test, live];
  const stopped = read.blocked.steps;

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

/** The coach-facing names of the stopped steps, in the order they stopped. */
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
 * The channels
 * ------------------------------------------------------------------------------------------ */

export type CoachSetupChannelKey = "instagram" | "messenger" | "sms" | "calendar";

export type CoachSetupChannelAction =
  | { kind: "link"; href: string; label: string }
  | { kind: "meta"; channel: MetaConnectChannel; label: "Connect" | "Reconnect"; name: string };

export type CoachSetupChannelView = {
  key: CoachSetupChannelKey;
  name: string;
  sentence: string;
  pill: { label: string; tone: Tone };
  action: CoachSetupChannelAction | null;
};

/** The states that are SetterFi's connection failing, as opposed to the coach's permission. */
const OUTAGE_STATES: readonly ChannelConnectionState[] = ["error", "flagged", "restricted", "blocked_permanent"];

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
          : "Its permission ran out. Signing in again opens here once Facebook approves our app, which is ours to chase.",
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
        : "Sign-in opens here once Facebook approves our app, which is ours to chase.",
  };
}

/**
 * Texting, which is the one channel with no button in any state.
 *
 * A coach cannot make a carrier decide faster and there is nothing to press, so the row carries
 * its state and stops. It does not repeat the day count: that fact belongs to the carrier step and
 * appears on this screen exactly once.
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
      action: { href: "/onboarding/calendar", kind: "link", label: "Reconnect your calendar" },
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
    action: { href: "/onboarding/calendar", kind: "link", label: "Connect your calendar" },
    pill: { label: "Yours to do", tone: "warning" },
    sentence: "Your agent needs somewhere to put the calls it books. Google and Outlook both work.",
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

/* --------------------------------------------------------------------------------------------
 * The rows
 * ------------------------------------------------------------------------------------------ */

/** Who moves a row. Only `you` may carry a button. */
export type CoachSetupOwner = "you" | "us" | "carriers";

export type CoachSetupRowKey =
  | "business"
  | "channels"
  | "calendar"
  | "offer"
  | "carrier"
  | "test"
  | "live"
  | `blocked:${ProvisioningStep}`;

export type CoachSetupRowAction =
  | { kind: "link"; href: string; label: string }
  | { kind: "meta"; channels: readonly MetaConnectChannel[]; label: string };

/** One line inside a row: the channels row lists Instagram and Messenger this way. */
export type CoachSetupFact = { name: string; sentence: string; pill: { label: string; tone: Tone } };

export type CoachSetupRow = {
  key: CoachSetupRowKey;
  name: string;
  owner: CoachSetupOwner;
  /** True only on a receipt. Nothing reads done while provisioning. */
  done: boolean;
  pill: { label: ReactNode; tone: Tone };
  /** The explanation, drawn while the row is open or current. One idea, two sentences at most. */
  body: string;
  /** The receipt or timing line, drawn on every row that has one. */
  receipt: string | null;
  /** Only on a row the coach owns. A done row may still carry a repair. */
  action: CoachSetupRowAction | null;
  facts: readonly CoachSetupFact[];
  icon: ComponentType<KitIconProps>;
};

const ROW_ICON: Record<Exclude<CoachSetupRowKey, `blocked:${ProvisioningStep}`>, ComponentType<KitIconProps>> = {
  business: UserRound,
  calendar: CalendarDays,
  carrier: ShieldCheck,
  channels: Smartphone,
  live: Sparkle,
  offer: CreditCard,
  test: ChatText,
};

function fromStep(step: CoachSetupStepView, owner: CoachSetupOwner, icon: ComponentType<KitIconProps>): CoachSetupRow {
  return {
    action: null,
    body: step.body,
    done: step.done,
    facts: [],
    icon,
    key: step.key,
    name: step.name,
    owner: step.pill.label === "Stopped" ? "us" : owner,
    pill: step.pill,
    receipt: step.receipt,
  };
}

function channelsRow(read: CoachSetupRead, channels: readonly CoachSetupChannelView[]): CoachSetupRow {
  const instagram = channels.find((row) => row.key === "instagram")!;
  const messenger = channels.find((row) => row.key === "messenger")!;
  const pair = [instagram, messenger];
  const facts: CoachSetupFact[] = pair.map((row) => ({ name: row.name, pill: row.pill, sentence: row.sentence }));
  const live = pair.filter((row) => row.pill.label === "Connected");
  const connect = pair.filter((row) => row.action?.kind === "meta" && row.action.label === "Connect");
  const reconnect = pair.filter((row) => row.action?.kind === "meta" && row.action.label === "Reconnect");
  const outage = pair.some((row) => row.pill.label === "Not answering" && row.action === null);
  const unchecked = pair.every((row) => row.pill.label === "Not checked");
  const done = live.length > 0;

  const action: CoachSetupRowAction | null = connect.length > 0
    ? {
      channels: connect.map((row) => row.key as MetaConnectChannel),
      kind: "meta",
      label: `Connect ${nameList(connect.map((row) => row.name))}`,
    }
    : reconnect.length > 0
      ? {
        channels: reconnect.map((row) => row.key as MetaConnectChannel),
        kind: "meta",
        label: `Reconnect ${nameList(reconnect.map((row) => row.name))}`,
      }
      : null;

  const pill: CoachSetupRow["pill"] = unchecked
    ? { label: "Not checked", tone: "neutral" }
    : done
      ? reconnect.length > 0 || outage
        ? { label: "Partly answering", tone: "warning" }
        : { label: "Connected", tone: "good" }
      : action
        ? { label: "Yours to do", tone: "warning" }
        : outage
          ? { label: "Not answering", tone: "warning" }
          : read.metaConnect === "awaiting_meta"
            ? { label: "Not ready yet", tone: "neutral" }
            : pair.some((row) => row.pill.label === "Connecting")
              ? { label: "Connecting", tone: "waiting" }
              : { label: "Not connected", tone: "neutral" };

  const body = unchecked
    ? "We could not check these connections just now. Nothing has changed."
    : action?.label.startsWith("Connect")
      ? "Your agent answers Instagram and Messenger messages the moment they arrive. Connecting "
        + "opens Facebook in a new window and takes about a minute."
      : action
        ? "A permission ran out, and reconnecting brings it back in about a minute."
        : read.metaConnect === "awaiting_meta" && !done
          ? "Sign-in opens here once Facebook approves our app, which is ours to chase. There is "
            + "nothing for you to do yet."
          : read.metaConnect === "read_only" && !done
            ? "Connecting needs the coach's own sign-in, and this view is read only."
            : done
              ? "Your agent answers messages here."
              : "We are finishing this connection. There is nothing for you to do.";

  const since = live
    .map((row) => (row.key === "instagram" ? read.instagram : read.messenger).liveSince)
    .map(dayLabel)
    .filter((label): label is string => label !== null);

  return {
    action,
    body,
    done,
    facts,
    icon: ROW_ICON.channels,
    key: "channels",
    name: "Instagram and Messenger",
    owner: "you",
    pill,
    receipt: since.length > 0
      ? `Answering since ${since[0]}`
      : action?.label.startsWith("Connect")
        ? "About a minute."
        : null,
  };
}

function calendarSetupRow(channel: CoachSetupChannelView): CoachSetupRow {
  const done = channel.pill.label === "Connected";
  return {
    action: channel.action?.kind === "link" ? channel.action : null,
    body: channel.sentence,
    done,
    facts: [],
    icon: ROW_ICON.calendar,
    key: "calendar",
    name: "Your calendar",
    owner: "you",
    pill: channel.pill,
    receipt: channel.action ? "About a minute." : null,
  };
}

function offerRow(read: CoachSetupRead): CoachSetupRow {
  const base = { facts: [], icon: ROW_ICON.offer, key: "offer" as const, name: "Your offer", owner: "you" as const };
  if (!read.offer.checked) {
    return {
      ...base,
      action: null,
      body: "We could not read your offer just now, so this step is not reporting.",
      done: false,
      pill: { label: "Not checked", tone: "neutral" },
      receipt: "Nothing changed while we could not read it.",
    };
  }
  if (read.offer.published) {
    return {
      ...base,
      action: null,
      body: "Your agent knows what you sell, who it is for and what it costs.",
      done: true,
      pill: { label: "Done", tone: "good" },
      receipt: "Change it any time from Your agent.",
    };
  }
  return {
    ...base,
    action: { href: "/onboarding/offer", kind: "link", label: "Tell us about your offer" },
    body:
      "What you sell, who it is for and what it costs. Your agent uses this to answer questions "
      + "and to decide who to book.",
    done: false,
    pill: { label: "Yours to do", tone: "warning" },
    receipt: "About ten minutes.",
  };
}

/**
 * The whole setup as one list, in journey order.
 *
 * The coach's four rows come first, then the carriers' wait, the safe test and the final press.
 * Go live is the coach's, and it carries its button only once every row above it is done: a
 * button that would be refused at the route is the completion theatre the honest-states rule
 * forbids, so until then the row says what it is waiting on.
 */
export function coachSetupRows(read: CoachSetupRead, now?: Date): readonly CoachSetupRow[] {
  const steps = coachSetupSteps(read, now);
  const channels = coachSetupChannels(read);
  const step = (key: CoachSetupStepKey) => steps.find((row) => row.key === key)!;

  const business = fromStep(step("business"), "you", ROW_ICON.business);
  if (!business.done && business.owner === "you" && read.business.checked) {
    business.action = { href: "/onboarding/business-profile", kind: "link", label: "Add your business details" };
  }
  const pair = channelsRow(read, channels);
  const calendar = calendarSetupRow(channels.find((row) => row.key === "calendar")!);
  const offer = offerRow(read);
  const carrier = fromStep(step("carrier"), "carriers", ROW_ICON.carrier);
  const sms = channels.find((row) => row.key === "sms")!;
  if (carrier.done && sms.pill.label === "Connected") carrier.receipt = sms.sentence;
  const test = fromStep(step("test"), "us", ROW_ICON.test);
  const live = fromStep(step("live"), "you", ROW_ICON.live);

  const ready = [business, pair, calendar, offer, carrier, test].every((row) => row.done);
  if (!live.done && live.owner === "you") {
    if (ready) {
      live.action = { href: "/onboarding/go-live", kind: "link", label: "Go live" };
      live.pill = { label: "Ready when you are", tone: "good" };
      live.body = "Everything above is done. Pressing go live turns your agent on for real leads.";
      live.receipt = null;
    } else {
      const waitingOn = [business, pair, calendar, offer].filter((row) => !row.done).map((row) => row.name);
      live.receipt = waitingOn.length > 0
        ? `After ${waitingOn.map(mention).join(", ")}, and then the safe test.`
        : carrier.done
          ? test.done
            ? live.receipt
            : "After the safe test."
          : "After the carriers finish and the safe test passes.";
    }
  }

  const own = steps
    .filter((row) => row.key.startsWith("blocked:"))
    .map((row) => fromStep(row, "us", OctagonAlert));

  return [business, pair, calendar, offer, carrier, ...own, test, live];
}

/** The rows that are the coach's to move: owned by them and carrying something to press. */
export function coachSetupYours(rows: readonly CoachSetupRow[]): readonly CoachSetupRow[] {
  return rows.filter((row) => row.owner === "you" && row.action !== null);
}

/**
 * The one open row: the first the coach can move that is not done. A repair on a finished row
 * is offered inline and never opens, because the thing to do next is always the first gap.
 */
export function coachSetupOpenRow(rows: readonly CoachSetupRow[]): CoachSetupRowKey | null {
  return rows.find((row) => row.owner === "you" && row.action !== null && !row.done)?.key
    ?? coachSetupYours(rows)[0]?.key
    ?? null;
}

/**
 * Where setup resumes: the open row's own screen.
 *
 * The setup root sends a returning coach here rather than to the list, so coming back after
 * "Back to your setup" or a fresh sign-in lands on the first thing still theirs to do and never on
 * step one again. The channels row's button opens the Meta sheet rather than a page, so its
 * resume is the connect step, which draws the same two channels. Null when nothing is theirs,
 * and the caller falls back to the list, which is the honest place to stand when there is
 * nothing to press.
 */
export function coachSetupResumeHref(rows: readonly CoachSetupRow[]): string | null {
  const key = coachSetupOpenRow(rows);
  const row = key === null ? null : rows.find((candidate) => candidate.key === key) ?? null;
  if (!row?.action) return null;
  return row.action.kind === "link" ? row.action.href : "/onboarding/connect";
}

/**
 * The status sentence, which both surfaces print from the same rows.
 *
 * Three clauses at most: how much is the coach's, in words; where the carriers are; and what
 * stopped, by name and with whose it is. It never counts a stopped step as the coach's, because
 * nothing on a stopped row can be pressed.
 */
export function coachSetupSentence(
  rows: readonly CoachSetupRow[],
  read: CoachSetupRead,
  now?: Date,
): string {
  const everythingUnchecked = !read.business.checked
    && !read.test.checked
    && read.carrier.kind === "unchecked"
    && !read.instagram.checked
    && !read.messenger.checked
    && !read.sms.checked
    && !read.calendar.checked;
  if (everythingUnchecked) {
    return "We could not read your setup just now. Nothing has changed while we could not read it.";
  }

  const yours = coachSetupYours(rows).length;
  const stopped = coachSetupBlockedNames(read);
  const clauses: string[] = [];

  if (yours === 0) {
    clauses.push(stopped.length > 0 ? "Nothing else is waiting on you." : "Nothing is waiting on you.");
  } else {
    clauses.push(`${COUNT_WORDS[yours] ?? `${yours} things`} ${yours === 1 ? "is" : "are"} yours to do.`);
  }

  const carrier = read.carrier;
  if (carrier.kind === "in-review") {
    const day = carrier.submittedAt ? elapsedWorkspaceDays(carrier.submittedAt, now) : null;
    clauses.push(
      day === null
        ? "Text messages are still with the carriers."
        : `Text messages are on day ${day} of about ${CARRIER_TYPICAL_DAYS[1]}.`,
    );
  } else if (carrier.kind === "blocked" || carrier.kind === "failed") {
    clauses.push("The carrier filing is ours to sort out.");
  }

  if (stopped.length > 0) {
    clauses.unshift(
      `${nameList(stopped)} stopped, and ${stopped.length === 1 ? "it is" : "they are"} ours to fix, not yours.`,
    );
  } else if (yours === 0 && clauses.length === 1) {
    clauses.push("Everything here is with us or the carriers.");
  }

  return clauses.join(" ");
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
 * draw. The accent fill's shadow is imported so this file shares one string with the kit's own
 * primary variant.
 */
const BUTTON_BASE =
  "inline-flex min-h-[48px] shrink-0 items-center justify-center gap-[10px] text-center "
  + "rounded-[9px] border px-[22px] py-[10px] text-[16px] no-underline hover:no-underline";
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
 * The mark beside a row: a tick on a done row, the row's glyph otherwise, on a face that says
 * which of the three states it is in. `aria-hidden`: the row carries its name and its state in
 * words, and a picture that repeats either would be the same fact said twice.
 */
function RowMark({ row, open }: { row: CoachSetupRow; open: boolean }) {
  const Icon = row.icon;
  const face = row.done
    ? "border-[var(--good-line)] bg-[var(--good-wash)] text-[var(--good-text)]"
    : open
      ? "border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] text-[var(--accent-text)]"
      : row.pill.tone === "warning" && row.owner !== "you"
        ? "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[var(--warning-text)]"
        : row.pill.tone === "waiting"
          ? "border-[var(--waiting-line)] bg-[var(--waiting-wash)] text-[var(--waiting-text)]"
          : "border-[var(--line)] bg-[var(--well)] text-[var(--muted)]";
  return (
    <span
      aria-hidden="true"
      className={`relative z-[1] grid size-[44px] flex-none place-items-center rounded-full border ${face}`}
      data-slot="coach-setup-mark"
    >
      {row.done ? <Check size={22} strokeWidth={2.25} /> : <Icon size={20} strokeWidth={1.75} />}
    </span>
  );
}

function RowAction({ action, accent }: { action: CoachSetupRowAction; accent: boolean }) {
  const className = `${accent ? BUTTON_ACCENT : BUTTON_SECONDARY} w-full sm:w-auto`;
  if (action.kind === "link") {
    return (
      <Link className={className} href={action.href}>
        {action.label}
      </Link>
    );
  }
  return (
    <ConnectChannelButton channels={action.channels} className={className}>
      {action.label}
    </ConnectChannelButton>
  );
}

const ROW_NAME_CLASS =
  "m-0 text-[20px] leading-[1.25] font-medium tracking-[-0.015em] text-[var(--ink)]";
const ROW_BODY_CLASS =
  "m-0 mt-[10px] max-w-[var(--measure-sentence)] text-[16px] leading-[1.55] text-[var(--body)]";
const ROW_RECEIPT_CLASS = "m-0 mt-[6px] text-[14px] leading-[1.55] text-[var(--muted)]";

/**
 * One row: the mark, the name with its state on the same line at every width, and under the name
 * whatever the row's state earns. A closed row is the name, the state and its receipt. The open
 * row adds its explanation, its facts and its one button. A row on the timeline draws a spine to
 * the next, which is what makes the wait read as a sequence rather than a list of pills.
 */
function SetupRow({
  compact,
  last,
  open,
  row,
  timeline,
}: {
  compact: boolean;
  last: boolean;
  open: boolean;
  row: CoachSetupRow;
  timeline: boolean;
}) {
  const current = timeline && !row.done && row.pill.tone === "waiting";
  const showBody = open || (current && !compact) || (row.owner === "us" && row.pill.label === "Stopped");
  const showFacts = row.facts.length > 0 && (open || row.done) && !compact;
  // A finished row may still carry a repair; an unfinished closed row carries nothing, or the page
  // would offer two things to press for one gap.
  const repair = row.action && !open && row.done ? row.action : null;
  return (
    <li
      className={[
        "relative grid grid-cols-[auto_minmax(0,1fr)] gap-x-[16px] px-5 sm:gap-x-[18px]",
        compact ? "py-[16px]" : "py-[20px]",
        timeline ? "" : "border-b border-[var(--line-soft)] last:border-b-0",
        open ? "bg-[var(--accent-wash)]" : "",
      ].join(" ")}
      data-done={row.done ? "true" : "false"}
      data-open={open ? "true" : undefined}
      data-owner={row.owner}
      data-row={row.key}
      data-slot="coach-setup-row"
    >
      {timeline && !last ? (
        <span
          aria-hidden="true"
          className="absolute top-[64px] bottom-[-4px] left-[41px] w-[2px] bg-[var(--line)]"
          data-slot="coach-setup-spine"
        />
      ) : null}
      <div className="row-span-2">
        <RowMark open={open} row={row} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-[8px]">
        <h3 className={`${ROW_NAME_CLASS} min-w-0`}>{row.name}</h3>
        <Status className="text-[14px]" label={row.pill.label} tone={row.pill.tone} />
      </div>
      <div className="col-start-2 min-w-0">
        {showBody ? <p className={ROW_BODY_CLASS}>{row.body}</p> : null}
        {row.receipt && (showBody || !compact || row.done) ? (
          <p className={ROW_RECEIPT_CLASS}>{row.receipt}</p>
        ) : null}
        {showFacts ? (
          <ul className="m-0 mt-[12px] flex list-none flex-col gap-[8px] p-0" data-slot="coach-setup-facts">
            {row.facts.map((fact) => (
              <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[15px] leading-[1.5]" key={fact.name}>
                <span className="font-medium text-[var(--ink)]">{fact.name}</span>
                <span className="text-[var(--muted)]">{fact.sentence}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {open && row.action ? (
          <div className="mt-[16px]">
            <RowAction accent action={row.action} />
          </div>
        ) : repair ? (
          <div className="mt-[12px]">
            <RowAction accent={false} action={repair} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

export type CoachSetupRowsProps = {
  rows: readonly CoachSetupRow[];
  /** Home's rendering: closed rows are one line and the timeline carries no explanation. */
  compact?: boolean;
  headingId: string;
};

/**
 * The list, in two bands inside one panel: the coach's four rows, then the timeline that ends in
 * go live. Both bands read the same array, so a row cannot appear in one and be counted in the
 * other.
 */
export function CoachSetupRows({ compact = false, headingId, rows }: CoachSetupRowsProps) {
  const openKey = coachSetupOpenRow(rows);
  const yours = rows.filter((row) => ["business", "channels", "calendar", "offer"].includes(row.key));
  const timeline = rows.filter((row) => !yours.includes(row));
  const yoursDone = yours.filter((row) => row.done).length;

  return (
    <div className={PANEL_CLASS} data-slot="coach-setup-list">
      <div className="flex min-h-[64px] items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-[16px]">
        <h2
          className="m-0 text-[20px] leading-[1.25] font-medium tracking-[-0.015em] text-[var(--ink)]"
          id={headingId}
        >
          Yours to do
        </h2>
        <span className="text-[14px] text-[var(--muted)]" data-slot="coach-setup-count">
          <span className="mono">{yoursDone}</span> of <span className="mono">{yours.length}</span> done
        </span>
      </div>
      <ol aria-labelledby={headingId} className="m-0 flex list-none flex-col p-0">
        {yours.map((row, index) => (
          <SetupRow
            compact={compact}
            key={row.key}
            last={index === yours.length - 1}
            open={row.key === openKey}
            row={row}
            timeline={false}
          />
        ))}
      </ol>
      <div className="flex min-h-[64px] items-center border-y border-[var(--line)] bg-[var(--well)] px-5 py-[16px]">
        <h2 className="m-0 text-[20px] leading-[1.25] font-medium tracking-[-0.015em] text-[var(--ink)]" id={`${headingId}-then`}>
          Then, with us and the carriers
        </h2>
      </div>
      <ol aria-labelledby={`${headingId}-then`} className="m-0 flex list-none flex-col p-0 pb-[6px]">
        {timeline.map((row, index) => (
          <SetupRow
            compact={compact}
            key={row.key}
            last={index === timeline.length - 1}
            open={row.key === openKey}
            row={row}
            timeline
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * The technical record, closed.
 *
 * A native `<details>` rather than a kit disclosure, so it opens with no JavaScript and so the
 * summary inherits the 44px target `coach.css` puts on every `summary` under this shell.
 */
function TechnicalRecord({ record }: { record: CoachSetupRead["record"] }) {
  if (!record.checked) {
    return (
      <p className="m-0 px-5 py-5 text-[16px] leading-[1.55] text-[var(--muted)]">
        We could not read the filing record just now.
      </p>
    );
  }
  if (record.rows.length === 0) {
    return (
      <p className="m-0 px-5 py-5 text-[16px] leading-[1.55] text-[var(--muted)]">
        No filing record has been stored yet.
      </p>
    );
  }
  return (
    <div className="px-5 py-5">
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

export function CoachSetup({ now, read }: CoachSetupProps) {
  const rows = coachSetupRows(read, now);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end gap-6">
        <div className="min-w-0">
          <h1 className="m-0 text-[46px] leading-[1.05] font-semibold tracking-[-0.026em] text-[var(--ink)]">
            Getting you live
          </h1>
          <p
            className="m-0 mt-3 max-w-[var(--measure-wide)] text-[17px] leading-[1.5] text-[var(--body)]"
            data-slot="coach-setup-sentence"
          >
            {coachSetupSentence(rows, read, now)}
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

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
        <section aria-labelledby="coach-setup-heading" data-slot="coach-setup-steps">
          <CoachSetupRows headingId="coach-setup-heading" rows={rows} />
        </section>

        <div className="flex min-w-0 flex-col gap-5">
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

          <section
            aria-labelledby="coach-setup-record-heading"
            className={PANEL_CLASS}
            data-slot="coach-setup-evidence"
          >
            <Band
              eyebrow="For the day you need to prove it"
              name="The record"
              titleId="coach-setup-record-heading"
            />
            <TechnicalRecord record={read.record} />
          </section>
        </div>
      </div>
    </div>
  );
}
