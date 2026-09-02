"use client";

import { ArrowLeft, ChevronRight, PanelRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { Composer } from "@/components/kit/composer";
import { CopyValue } from "@/components/kit/copy-value";
import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { DataState } from "@/components/kit/data-state";
import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import { ExportMenu, type ExportMenuProps } from "@/components/kit/export-menu";
import { FilterBar, type FacetGroup, type ViewDef } from "@/components/kit/filter-bar";
import { LoggedButton } from "@/components/kit/logged-button";
import { RecordSheet } from "@/components/kit/record-sheet";
import { Status } from "@/components/kit/atomics";
import { TONE_ROW_TINT, type Tone } from "@/components/kit/atomics/tone";
import { Transcript, type TranscriptMessage, type TranscriptStop } from "@/components/kit/transcript";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { AuditReceipt } from "@/lib/audit";
import { workspaceDateTimeFormat } from "@/lib/format/datetime";
import { useQueryState } from "@/lib/query-state";
import type { ConversationRead } from "@/lib/repositories/conversations";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";
import { CoachPageHead } from "./coach-page-head";
import { EscalationPanel, escalationClockLabel } from "./escalation-panel";
import { escalationQueue, handoffFor } from "./escalation-queue";
import {
  COACH_EYEBROW_CLASS,
  COACH_FOOTNOTE_CLASS,
  COACH_READING_CLASS,
  COACH_ROW_NAME_CLASS,
  COACH_SURFACE_TITLE_CLASS,
  LEAD_FACT_LABELS,
} from "./coach-type";
import { deriveConversationView, type ConversationView } from "./view-models";

type CoachConversationsProps = {
  initialConversations: ConversationRead[];
  filteredConversationIds?: readonly string[];
  fixtureMode?: boolean;
  enabled?: boolean;
  inboxVerbsEnabled?: boolean;
  impersonation?: { sessionId: string; tenantId: string } | null;
  /**
   * The objection narrowing this list, when the coach arrived on an `?objection=<id>` link from
   * the agent page. The filter itself is applied on the server; this is the label that lets the
   * scope line say which objection, rather than leaving a silently short list on screen.
   */
  activeObjection?: { id: string; label: string } | null;
  viewerId?: string | null;
  /**
   * The instant every wait on this page is measured against, resolved once on the server so the
   * server pass and the hydrated client agree on the numbers. Absent in fixtures and in tests that
   * do not care, and the queue then says its clock is unavailable rather than inventing one.
   */
  nowIso?: string | null;
};
type MutationResponse = { conversation: ConversationRead; audit: AuditReceipt | null };
type ComposerMode = "reply" | "internal_note";
type QuietHoursWarning = {
  body: string;
  scheduledAt: string;
  leadLocalTimes: readonly string[];
  allowedWindow: string;
};
type Appointment = NonNullable<ConversationRead["appointment"]>;
type BookingDraft = { appointmentId: string; reason: string; startLocal: string };
type LifecycleIntent = {
  action: "cancel" | "reschedule";
  appointment: Appointment;
  contactName: string;
  conversationId: string;
  reason: string;
  startAt: string | null;
  endAt: string | null;
};

const CRUMBS = [{ label: "Inbox" }, { label: "Conversations" }] as const;

/**
 * The words in the Inbox search box, and the sentence that keeps them honest.
 *
 * The artboard writes "Search a name or a message", which is the promise a coach reads it as, and
 * the filter delivers about three quarters of it: the haystack is the lead's name, the channel,
 * the status label and the *latest* message on the thread. The whole transcript is not searched,
 * because nothing loads it -- the list rows carry only their most recent message, and there is no
 * index over `messages` anywhere in `src` or `supabase` to query instead.
 *
 * So the placeholder is the artboard's and the scope note beside it says which message. The
 * alternative was to keep the old "Search conversations", which promises the transcript far more
 * strongly than the artboard's line does while delivering exactly the same thing. A coach who
 * types a phrase from three replies back and reads the empty result as proof the lead never said
 * it is the failure both of these exist to prevent, and only the note actually prevents it.
 */
const INBOX_SEARCH_PLACEHOLDER = "Search a name or a message";
const INBOX_SEARCH_SCOPE =
  "Search reads the lead's name, the channel, the thread's state and the most recent message on "
  + "it. Earlier messages are not loaded here, so a phrase from further back in a thread will not "
  + "match.";
const STATUS_TO_LIFECYCLE: Record<ConversationRead["status"], string> = {
  agent: "agent", needs_human: "needs-you", human: "human", nurture: "follow-up",
  closed: "closed", scope_blocked: "scope-blocked", opted_out: "opted-out",
};

function isConversationRead(value: unknown): value is ConversationRead {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ConversationRead>;
  return typeof row.id === "string" && typeof row.contactId === "string"
    && typeof row.contactName === "string" && typeof row.status === "string"
    && Array.isArray(row.messages);
}

function readMutationResponse(value: unknown): MutationResponse | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as { conversation?: unknown; audit?: unknown };
  if (!isConversationRead(payload.conversation)) return null;
  const audit = payload.audit && typeof payload.audit === "object"
    ? payload.audit as AuditReceipt : null;
  return { conversation: payload.conversation, audit };
}

function readQuietHoursWarning(value: unknown, body: string): QuietHoursWarning | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.code !== "HUMAN_REPLY_QUIET_HOURS_CONFIRMATION_REQUIRED" ||
    typeof payload.scheduledAt !== "string" ||
    !Number.isFinite(Date.parse(payload.scheduledAt)) ||
    typeof payload.allowedWindow !== "string" ||
    !Array.isArray(payload.leadLocalTimes) ||
    !payload.leadLocalTimes.every((entry) => typeof entry === "string")
  ) return null;
  return {
    body,
    scheduledAt: payload.scheduledAt,
    leadLocalTimes: payload.leadLocalTimes as string[],
    allowedWindow: payload.allowedWindow,
  };
}

function channelLabel(channel: ConversationRead["channel"]) {
  if (channel === "sms") return "Text messages (SMS)";
  if (channel === "messenger") return "Messenger";
  if (channel === "webchat") return "Web chat";
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

/** Where a reply actually lands. Only names the channel the row carries. */
function channelSendLabel(channel: ConversationRead["channel"]) {
  if (channel === "sms") return "Sends as you over text (SMS)";
  if (channel === "webchat") return "Sends as you in web chat";
  if (channel === "whatsapp") return "Sends as you on WhatsApp";
  if (channel === "messenger") return "Sends as you on Messenger";
  return "Sends as you on Instagram";
}

function localDateTimeParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  const [year, month, day, hour, minute] = values;
  if (
    month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) return null;
  return { year, month, day, hour, minute };
}

function partsInTimezone(instant: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(instant);
    const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    const result = {
      year: field("year"), month: field("month"), day: field("day"),
      hour: field("hour"), minute: field("minute"),
    };
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

/** Converts a wall-clock choice in the appointment's own IANA zone and refuses DST gaps. */
export function appointmentWallTimeToIso(value: string, timezone: string): string | null {
  const wanted = localDateTimeParts(value);
  if (!wanted) return null;
  const wallAsUtc = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
  let candidate = wallAsUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const observed = partsInTimezone(new Date(candidate), timezone);
    if (!observed) return null;
    const observedAsUtc = Date.UTC(
      observed.year, observed.month - 1, observed.day, observed.hour, observed.minute,
    );
    candidate += wallAsUtc - observedAsUtc;
  }
  const verified = partsInTimezone(new Date(candidate), timezone);
  if (!verified || Object.keys(wanted).some(
    (key) => wanted[key as keyof typeof wanted] !== verified[key as keyof typeof verified],
  )) return null;
  return new Date(candidate).toISOString();
}

function eligibleAppointment(value: Appointment | null): value is Appointment {
  return Boolean(
    value
    && (value.status === "scheduled" || value.status === "confirmed")
    && value.provider.trim()
    && value.externalId?.trim()
    && Number.isFinite(Date.parse(value.startAt))
    && Number.isFinite(Date.parse(value.endAt))
    && Date.parse(value.endAt) > Date.parse(value.startAt)
    && Number.isFinite(Date.parse(value.updatedAt)),
  );
}

function lifecycleReceipt(value: unknown, expectedAction: LifecycleIntent["action"]) {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const command = payload.command && typeof payload.command === "object"
    ? payload.command as Record<string, unknown> : null;
  const effect = payload.effect && typeof payload.effect === "object"
    ? payload.effect as Record<string, unknown> : null;
  const audit = payload.audit && typeof payload.audit === "object"
    ? payload.audit as Record<string, unknown> : null;
  if (
    command?.action !== expectedAction || command.state !== "confirmed"
    || effect?.status !== "confirmed" || effect.providerConfirmation !== "confirmed"
    || !Number.isSafeInteger(audit?.id) || Number(audit?.id) <= 0
  ) return null;
  return { auditId: Number(audit!.id) };
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return "?";
  return parts.map((part) => part.charAt(0).toLocaleUpperCase()).join("");
}

/**
 * Seven states onto the kit's seven tones, one claim each.
 *
 * The legacy `StateBadge` scale had five, so `needs_human`, `human` and `nurture` all resolved to
 * the same amber: the one state that means the agent stopped and a person is required looked
 * exactly like the two that need nothing. That is the failure this page can least afford, since a
 * coach opens it to find out whether anything went wrong.
 *
 * `needs_human` therefore takes `failure`, which nothing else on this page spends, and
 * `scope_blocked` takes `warning` because the clock is running on the coach without anything being
 * broken. `human` is `waiting` -- someone holds it and the clock is theirs. `nurture`, `closed` and
 * `opted_out` assert nothing and are carried by their labels.
 */
const STATUS_TONE: Record<ConversationRead["status"], Tone> = {
  agent: "good",
  needs_human: "failure",
  human: "waiting",
  nurture: "neutral",
  closed: "neutral",
  scope_blocked: "warning",
  opted_out: "neutral",
};

/** The two states that mean the agent stopped talking and is waiting on a person. */
function agentStopped(status: ConversationRead["status"]) {
  return status === "needs_human" || status === "scope_blocked";
}

/**
 * Why the agent stopped, in the words the handoff rules use. `handoffFor` reads
 * `convo_status_reason` and humanises an arm it has not been taught rather than dropping it, so a
 * reason the enum grows still reaches the row.
 */
function stopReason(conversation: ConversationView) {
  return handoffFor(conversation.statusReason)?.label ?? "No reason is recorded for this handoff";
}

function sentence(text: string) {
  const trimmed = text.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The stop callout `Inbox.dc.html` draws in the message flow, built from the same `handoffFor`
 * lookup the list row and the state accordion read -- the reason was always computed, it just had
 * nowhere to render at the point it explains. Null unless the agent has actually stopped: a thread
 * it is still working carries no stop to announce, and a thread it stopped on with no reason
 * column gets the callout with the handoff rules' own "no reason recorded" line rather than a
 * silent gap where the explanation should be.
 */
function transcriptStop(conversation: ConversationView): TranscriptStop | null {
  if (!agentStopped(conversation.status)) return null;
  const handoff = handoffFor(conversation.statusReason);
  // The handoff labels are written as fragments for a pill ("The lead asked for a person"), and
  // this is the one place they are read as prose next to a second sentence.
  return handoff
    ? { reason: sentence(handoff.label), behaviour: handoff.behaviour }
    : { reason: "No reason is recorded for this handoff." };
}

function latestBody(conversation: ConversationView) {
  return conversation.messages.at(-1)?.body ?? null;
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not recorded" : workspaceDateTimeFormat.format(date);
}

function isToday(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function outcomeMatches(conversation: ConversationView, filters: readonly string[]) {
  if (filters.length === 0) return true;
  const outcome = conversation.qualification.outcome;
  return filters.some((filter) => {
    if (filter === "qualified") return outcome === "BOOK";
    if (filter === "not-fit") return outcome === "HARD_DQ";
    return outcome === null || outcome === "SOFT_DQ";
  });
}

function outcomeLabel(outcome: string | null) {
  if (outcome === "BOOK") return "Qualified for a call";
  if (outcome === "HARD_DQ") return "Not a fit";
  if (outcome === "SOFT_DQ") return "Still deciding";
  return "Not captured";
}

function transcriptMessages(conversation: ConversationView): TranscriptMessage[] {
  return conversation.messages.map((message) => ({
    id: message.id,
    author: message.direction === "system" ? "system" : message.direction === "in" ? "lead"
      : message.author.startsWith("human:") ? "human" : "agent",
    authorName: message.direction === "in" ? conversation.contactName : undefined,
    body: message.body,
    at: displayTime(message.createdAt),
    delivery: message.direction === "out" ? message.delivered ? "delivered" : "sent" : undefined,
  }));
}

/**
 * One captured fact, stacked: the label above, the answer under it.
 *
 * Hand-rolled rather than taken from the `KeyValue` kit, and only because of the kit's own
 * `stacked` arm: it renders the label with `t-overline`, which is the 9.5px uppercase mono role
 * this surface is getting rid of. `KeyValue` is shared with the owner console, where that role is
 * correct and pinned, so the fix is for this pane to draw its own pair at the artboard's two sizes
 * rather than for the kit to grow a coach mode nobody else would use.
 */
function Pair({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0" data-slot="key-value">
      <dt className={PAIR_LABEL_CLASS}>{label}</dt>
      <dd className={`m-0 mt-[3px] min-w-0 [overflow-wrap:anywhere] ${PAIR_VALUE_CLASS}`}>{value}</dd>
    </div>
  );
}

/**
 * The four captured facts, in the artboard's stacked shape and now under the artboard's words.
 *
 * This comment used to say the rename was deferred: "Credit / Wants / Your agent decided" is
 * plainer and probably right, but coach Contacts said "Credit range" and "Funding goal" for the
 * same four values, and one pane renaming them alone is a vocabulary split rather than a
 * simplification. The condition it set was that the change had to land everywhere at once, and
 * this is that landing -- `LEAD_FACT_LABELS` in `coach-type.ts` is now the single source both
 * panes read, so the two cannot drift apart again without the shared constant moving first.
 *
 * "Your agent decided" rather than "Outcome" is the load-bearing one of the four. "Outcome" is a
 * column name and reads as something that happened to the lead; the artboard's phrasing names the
 * actor, which matters here because the value underneath is a judgement the agent made against
 * the coach's own qualification numbers and the coach is the only person who can overrule it.
 */
function CapturedFacts({ conversation }: { conversation: ConversationView }) {
  return (
    <dl className="grid min-w-0 gap-[18px]">
      <Pair label={LEAD_FACT_LABELS.credit} value={conversation.qualification.credit ?? "Not captured"} />
      <Pair label={LEAD_FACT_LABELS.goal} value={conversation.qualification.goal ?? "Not captured"} />
      <Pair label={LEAD_FACT_LABELS.timeline} value={conversation.qualification.timeline ?? "Not captured"} />
      <Pair label={LEAD_FACT_LABELS.outcome} value={outcomeLabel(conversation.qualification.outcome)} />
    </dl>
  );
}

function LeadDetails({ conversation }: { conversation: ConversationView }) {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-5)]">
      <CapturedFacts conversation={conversation} />
      <section className="border-t border-[var(--line)] pt-[var(--s-4)]">
        <h3 className={EYEBROW_CLASS}>Booking</h3>
        <p className={`mt-[var(--s-2)] ${COACH_READING_CLASS} text-[var(--body)]`}>
          {conversation.appointment
            ? `Appointment recorded for ${displayTime(conversation.appointment.startAt)}`
            : "No appointment is recorded for this conversation."}
        </p>
      </section>
      <section className="border-t border-[var(--line)] pt-[var(--s-4)]">
        <h3 className={EYEBROW_CLASS}>Conversation state</h3>
        <div className="mt-[var(--s-2)]">
          <Status label={conversation.statusLabel} tone={STATUS_TONE[conversation.status]} />
        </div>
        {conversation.statusReason ? <p className={`mt-[var(--s-2)] ${COACH_READING_CLASS} text-[var(--muted)]`}>{stopReason(conversation)}</p> : null}
      </section>
    </div>
  );
}

function technicalDetails(conversation: ConversationView) {
  return [
    { label: "Conversation ID", value: conversation.id },
    { label: "Contact ID", value: conversation.contactId },
    { label: "Lifecycle value", value: conversation.status },
    { label: "Last activity", value: conversation.lastActivityAt },
  ];
}

const ACC_ITEM = "border-0 border-b border-[var(--line)] last:border-b-0";
/*
 * The lead pane's disclosure rows. They are 16px sentence case now rather than the console's
 * `text-over` -- 11px sans 600, uppercase -- because this pane is read by the coach the whole
 * surface was widened for, and a row you have to lean in to read is not a row you open.
 *
 * There is deliberately no height here. `coach.css` puts a 44px floor under every
 * `[role="button"]` on `[data-shell-role="coach"]`, and an explicit height in this string would be
 * a second opinion about the same rule -- the kind that agrees today and drifts in six weeks.
 */
const ACC_TRIGGER =
  "items-center gap-[var(--s-2)] rounded-none border-0 py-[var(--s-3)] text-[16px] leading-[1.4] font-medium text-[color:var(--body)] hover:text-[color:var(--ink)] hover:no-underline focus-visible:rounded-[var(--r-control)]";
const ACC_HINT =
  "ml-auto shrink-0 text-[14px] leading-[1.4] font-normal tracking-normal normal-case text-[color:var(--faint)]";
const ACC_BODY = "flex flex-col gap-[var(--s-3)] pb-[calc(var(--s-3)+var(--s-1)/2)] pt-0";

/**
 * The block label on the coach surface, and it is an eyebrow rather than an overline.
 *
 * What this replaces was the 9.5px uppercase mono overline, copied here verbatim from
 * `coach-offer.tsx` on the argument that one label voice across the system is worth more than any
 * single screen's legibility. That argument held while the console and the coach portal were the
 * same product. They are not: the canvas in `docs/REDESIGN-CANVAS.md` splits them into two
 * densities on purpose, and 9.5px uppercase mono is the single worst legibility case in the
 * product for a reader over 55 -- which is exactly who round-1 demo feedback said was struggling.
 *
 * The size comes from `--coach-eyebrow` rather than from a literal, so this label and the deck
 * panel's eyebrow cannot end up at two different sizes while both claiming to be the eyebrow. The
 * atomic itself is untouched and still 9.5px where the console uses it, which is what
 * `src/app/overline-size.test.ts` pins; the change here is that this surface stops reaching for it.
 */
const EYEBROW_CLASS = COACH_EYEBROW_CLASS;

/**
 * Mono Licence: every timestamp, count and identifier on this page reads as an instrument.
 *
 * 14px rather than the console's 11.5px, which is the size the Inbox artboard sets its row clocks
 * at, and `--faint` rather than `--meta` for the same reason the artboard does it -- a clock beside
 * a 17px name has to recede without becoming unreadable, and at 14px `--meta` reads as a second
 * piece of content rather than as metadata.
 */
const MONO_META_CLASS = "mono text-[14px] leading-[1.3] text-[color:var(--faint)]";

/**
 * The list row, which is a row again rather than a card.
 *
 * The console's list was a column of `.surface-card` faces with a gap between them, and the open
 * one took the recipe's `data-open` rung. That is the right shape when a card grid is the page's
 * only species, and it is the wrong one inside a three-pane inbox: the artboard draws the list as
 * one continuous column divided by `--line-soft`, because a 380px pane full of floating cards
 * spends its width on gutters and its attention on edges rather than on names.
 *
 * The open row is `--accent-wash`, which is the artboard's own answer and the only fill this pane
 * spends. Hover is `--band`, a ground change rather than an outline, because there is no unlayered
 * card recipe here to fight with any more.
 */
const ROW_FACE_CLASS =
  "@container/row grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-x-[14px] border-b border-[var(--line-soft)] px-[22px] py-[20px] transition-[background-color] duration-[var(--duration-quick)] ease-[var(--ease-out)] hover:bg-[var(--band)] data-[current]:bg-[var(--accent-wash)] motion-reduce:transition-none";

/**
 * The stacked label/value pair the lead pane reads down.
 *
 * Both halves come from `coach-type.ts` rather than from literals: the label is the same 15px
 * muted caption a method note takes, and the value is the same 17px name a list row takes, so a
 * later change to either role reaches this pane instead of leaving it behind at last month's size.
 */
const PAIR_LABEL_CLASS = COACH_FOOTNOTE_CLASS;
const PAIR_VALUE_CLASS = COACH_ROW_NAME_CLASS;

/**
 * The status lozenge at coach size.
 *
 * `Status` hard-codes the console's 11.5px pill because that is the size the owner console's
 * tables need, and it takes a `className` for exactly this: the atomic keeps the tone contract --
 * which wash, which hairline, which text colour, and the `data-tone` the tests read -- and the
 * caller supplies the scale. Two sizes because the artboard draws two: 14px where the pill sits in
 * a list row beside a name, 15px where it is the answer to a question in the lead pane.
 */
const ROW_STATUS_PILL_CLASS = "gap-[7px] py-[4px] pr-[10px] pl-[9px] text-[14px]";
const STATUS_PILL_CLASS = "gap-[8px] py-[5px] pr-[12px] pl-[10px] text-[15px]";

/**
 * The bubbles and the transcript's own timestamps are rendered by the shared `Transcript` kit,
 * which the owner console also uses and which this pane therefore may not edit. A class cannot be
 * handed down through someone else's DOM, so the coach bubble is applied by descendant selector
 * on the slots that kit already emits -- `data-slot="message-text"` for the bubble, `data-side`
 * for which way it faces.
 *
 * What the artboard draws, and what these lines reproduce: 16px inside the bubble, 16/20 padding,
 * a 14px radius with the corner nearest the speaker pulled in to 5px, the lead in `--well` behind
 * `--line`, and everything the coach's side sent in `--accent-wash` behind `--accent-edge`. That
 * last pair is the one place this pane spends the accent on a ground, and it is spent on the
 * distinction the transcript exists to make: which of these did we say.
 */
const TRANSCRIPT_WELL_CLASS = [
  "[&_[data-slot=message-text]]:bg-[var(--well)]",
  "[&_[data-slot=message-text]]:border",
  "[&_[data-slot=message-text]]:border-[var(--line)]",
  "[&_[data-slot=message-text]]:rounded-[14px]",
  "[&_[data-slot=message-text]]:px-[20px]",
  "[&_[data-slot=message-text]]:py-[16px]",
  "[&_[data-slot=message-text]]:text-[16px]",
  "[&_[data-slot=message-text]]:leading-[1.55]",
  "[&_[data-side=left]_[data-slot=message-text]]:rounded-bl-[5px]",
  "[&_[data-side=right]_[data-slot=message-text]]:rounded-br-[5px]",
  "[&_[data-side=right]_[data-slot=message-text]]:bg-[var(--accent-wash)]",
  "[&_[data-side=right]_[data-slot=message-text]]:border-[var(--accent-edge)]",
  "[&_.msg__who]:text-[14px]",
  "[&_time]:font-[family-name:var(--font-mono)]",
  "[&_time]:text-[13px]",
  "[&_time]:tabular-nums",
].join(" ");

/**
 * Who holds the thread, as a dot plus a word. The dot never carries it alone, and the accent is
 * spent on the coach's own hold, per the Ownership Rule: accent is what the coach can act on.
 */
/**
 * The one control `SIMPLIFICATION-SPEC.md` §2.2 calls the most important thing a coach owns: the
 * agent, on or off, for this thread.
 *
 * `Inbox.dc.html` draws it as an accent-wash pill reading "Your agent is replying" with a 62x34
 * switch beside it, and until now the same decision was spelled two different ways in two places
 * -- "Take over to reply" inside the composer gate, "Hand back" in the header actions -- neither
 * of which reads as a state that can be flipped. It writes through the claim and release mutations
 * that already exist, so nothing new can be said or sent; what changes is that the thread's state
 * and its switch are the same object.
 *
 * On is the agent replying, which is `release`. Off is the coach holding it, which is `claim`. It
 * is a real `role="switch"` button rather than a styled div so a screen reader announces the state
 * and the space bar flips it, and it is disabled -- with the reason in its title -- while another
 * person holds the thread, in an impersonated read-only session, or with the verbs gate off.
 */
function AgentSwitch({
  busy,
  claim,
  disabled,
  heldByViewer,
  onToggle,
}: {
  busy: boolean;
  claim: { label: string; dot: string };
  disabled: boolean;
  heldByViewer: boolean;
  onToggle: (agentOn: boolean) => void;
}) {
  const agentOn = !heldByViewer;
  // Another person's takeover is neither of the coach's two states, so the switch reports rather
  // than offers: flipping it would claim a thread out from under whoever is typing in it.
  const heldByOther = !heldByViewer && claim.label === "Another person holds it";
  const blocked = disabled || heldByOther || busy;
  return (
    <button
      aria-label="Your agent replies to this lead"
      className={`flex h-[46px] shrink-0 items-center gap-[14px] rounded-[var(--r-full)] border py-[6px] pr-[8px] pl-[18px] text-[16px] leading-none font-medium disabled:cursor-not-allowed ${
        agentOn
          ? "border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[color:var(--ink)]"
          : "border-[var(--line)] bg-[var(--well)] text-[color:var(--body)]"
      }`}
      data-slot="agent-switch"
      disabled={blocked}
      onClick={() => onToggle(!agentOn)}
      role="switch"
      title={
        heldByOther
          ? "Another person has taken this thread over"
          : disabled
            ? "Taking a thread over is unavailable in this session"
            : undefined
      }
      type="button"
      aria-checked={agentOn}
    >
      <span className="truncate">{claim.label}</span>
      <span
        aria-hidden
        className={`relative block h-[34px] w-[62px] shrink-0 rounded-[var(--r-full)] border ${
          agentOn
            ? "border-[var(--accent-line)] bg-[var(--accent)]"
            : "border-[var(--line-strong)] bg-[var(--quiet)]"
        }`}
      >
        <span
          className={`absolute top-[3px] size-[26px] rounded-[var(--r-full)] ${
            agentOn ? "right-[3px] bg-[var(--on-accent)]" : "left-[3px] bg-[var(--muted)]"
          }`}
        />
      </span>
    </button>
  );
}

function claimReadout(conversation: ConversationView, heldByViewer: boolean) {
  if (heldByViewer) return { label: "You have this thread", dot: "bg-[var(--accent-text)]" };
  if (conversation.isHuman) return { label: "Another person holds it", dot: "bg-[var(--warning)]" };
  /*
   * "Your agent is replying" is the artboard's line for this state and it is kept because it
   * answers the question a coach opening a thread actually has, which is not who owns the row but
   * whether anybody is dealing with it. The two lines above stay possessive-free by contrast --
   * "another person" is genuinely somebody the coach may not know, and claiming it as theirs
   * would be wrong.
   *
   * The composer gate lower down still says "The agent is holding this thread", and that is not
   * the same sentence said twice: this one reports the state, and that one explains why the reply
   * box is closed. They are allowed to differ because they are answering different questions.
   */
  return { label: "Your agent is replying", dot: "bg-[var(--good)]" };
}

/**
 * How long this thread has been running, as whole days, or null when nothing can say.
 *
 * The artboard prints "Instagram \u00b7 first message 3 days ago" under the lead's name, and that
 * is a real elapsed count rather than a rounded impression -- it goes through
 * `elapsedWorkspaceDays`, the same reader the provisioning day counters use, so it counts civil
 * days in the workspace timezone and refuses a start time it cannot parse instead of guessing.
 *
 * The earliest message is found by scanning rather than by trusting position. The transcript is
 * ordered for reading, not for arithmetic, and a takeover or a system turn appended by `mutate`
 * lands at the end of the array with an older row still ahead of it; taking `messages[0]` would
 * have quietly measured from whatever happened to be first in the read.
 *
 * Null where the thread has no message at all, which is the ordinary state of a row the projection
 * has seen on a channel but never carried a body for. The header then shows the channel alone --
 * an age is not something to approximate from the row's last activity, because that is when the
 * thread was last touched and says nothing about when it began.
 */
function threadAgeDays(conversation: ConversationView) {
  let earliest: string | null = null;
  for (const message of conversation.messages) {
    if (earliest === null || message.createdAt < earliest) earliest = message.createdAt;
  }
  return earliest === null ? null : elapsedWorkspaceDays(earliest);
}

/** "first message today", "first message 1 day ago", "first message 3 days ago". */
function firstMessageLabel(days: number) {
  if (days === 0) return "first message today";
  return `first message ${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * The reply tab's words, which name the person the message is going to.
 *
 * Given name only, and no pronoun anywhere near it: the artboard writes "Book her a call" and
 * "Reply to Denise", and only the second of those is something this build can say truthfully.
 * Nothing on a contact record stores how a lead refers to themselves, so a pronoun here would be
 * a guess made from a name -- wrong often enough, and wrong in a way the lead would see.
 */
function replyTabLabel(contactName: string) {
  const given = contactName.trim().split(/\s+/u)[0] ?? "";
  return given ? `Reply to ${given}` : "Reply";
}

/** System turns are the only activity the row records, so the feed shows those and nothing more. */
function activityEvents(conversation: ConversationView) {
  return conversation.messages
    .filter((message) => message.direction === "system")
    .map((message) => ({ id: message.id, body: message.body, at: displayTime(message.createdAt) }))
    .reverse();
}

function LeadRail({
  bookingDraft,
  conversation,
  onBookingDraftChange,
  onReviewLifecycle,
  onOpenRecord,
  readOnly,
}: {
  bookingDraft: BookingDraft;
  conversation: ConversationView;
  onBookingDraftChange(next: BookingDraft): void;
  onReviewLifecycle(action: LifecycleIntent["action"]): void;
  onOpenRecord: () => void;
  readOnly: boolean;
}) {
  const events = activityEvents(conversation);

  return (
    <>
      {/* The pane names itself, which the console's version left to the `aria-label` alone. The
          artboard draws the heading because a coach who has scrolled a long transcript needs the
          right-hand column to say what it is without being read out to them. */}
      <h2 className="mb-[var(--s-4)] text-[18px] leading-[1.3] font-semibold text-[color:var(--ink)]">
        Lead details
      </h2>

      <div className="flex min-w-0 flex-wrap items-center gap-[var(--s-3)] border-b border-[var(--line)] pb-[var(--s-4)]">
        <span
          aria-hidden
          className="flex size-[44px] shrink-0 items-center justify-center rounded-[var(--r-full)] border border-[var(--line)] bg-[var(--card)] font-[family-name:var(--font-mono)] text-[15px] text-[var(--muted)]"
        >
          {initials(conversation.contactName)}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`truncate ${COACH_ROW_NAME_CLASS}`}>{conversation.contactName}</p>
          <p className={`${MONO_META_CLASS} mt-[calc(var(--s-1)/2)] truncate`}>
            {channelLabel(conversation.channel)}
          </p>
        </div>
        <Button className="basis-full justify-start px-0 text-[16px] text-[color:var(--accent-text)]" onClick={onOpenRecord} size="sm" type="button" variant="link">
          Open full record
        </Button>
      </div>

      {/*
        The four facts sit flat, which is what `Inbox.dc.html:240-263` draws: five label-over-value
        pairs down the rail at an 18px gap, with nothing to open.

        They were behind a disclosure that defaulted open, so nothing was actually hidden -- which
        is the argument for removing it rather than against. A disclosure that starts open is a
        control whose only reachable state is "shut", so the single thing it offers a coach is the
        ability to hide the four numbers the rail exists to show. On the surface built for the
        reader who told us the console had too much to press, a control that can only subtract is
        the wrong trade for the row of chrome it costs.

        The two below stay disclosures on purpose, and the line between them is whether the
        artboard has a row for the content. It draws no "conversation state" pair and no booking
        editor: one holds the recorded reason a conversation stopped, the other a reschedule form
        with a free-text reason and a datetime. Those are machinery and exceptions, genuinely worth
        folding away, and folding them is what leaves the four facts as the rail's flat content
        rather than as four more rows in a stack of six identical triggers.
      */}
      <CapturedFacts conversation={conversation} />

      <Accordion className="min-w-0">
        <AccordionItem className={ACC_ITEM} value="state">
          <AccordionTrigger className={ACC_TRIGGER}>
            Conversation state
            <span className={ACC_HINT}>{conversation.statusLabel}</span>
          </AccordionTrigger>
          <AccordionContent className={ACC_BODY}>
            <Status
              className={STATUS_PILL_CLASS}
              label={conversation.statusLabel}
              tone={STATUS_TONE[conversation.status]}
            />
            <p className={`m-0 ${COACH_READING_CLASS} text-[var(--muted)]`}>
              {conversation.statusReason ? stopReason(conversation) : "No reason is recorded for this state."}
            </p>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem className={ACC_ITEM} value="booking">
          <AccordionTrigger className={ACC_TRIGGER}>
            {/* "Call booked" rather than "Booking", and "Not yet" rather than "No slot held".
                The artboard's pair is what a coach is scanning this rail for -- has this lead got
                on my calendar -- where "Booking / No slot held" names the subsystem and leaves
                the reader to work out that the answer is no. */}
            Call booked
            <span className={ACC_HINT}>{conversation.appointment ? displayTime(conversation.appointment.startAt) : "Not yet"}</span>
          </AccordionTrigger>
          <AccordionContent className={ACC_BODY}>
            <p className={`m-0 ${COACH_READING_CLASS} text-[var(--body)]`}>
              {conversation.appointment
                ? `Appointment recorded for ${displayTime(conversation.appointment.startAt)}`
                : "No appointment is recorded for this conversation."}
            </p>
            {conversation.appointment && !eligibleAppointment(conversation.appointment) ? (
              <p className={`m-0 ${COACH_READING_CLASS} text-[var(--muted)]`}>
                This appointment cannot be changed because its provider or saved version is incomplete.
              </p>
            ) : null}
            {eligibleAppointment(conversation.appointment) && readOnly ? (
              <p className={`m-0 ${COACH_READING_CLASS} text-[var(--muted)]`}>
                Appointment changes are blocked in this read-only impersonated view.
              </p>
            ) : null}
            {eligibleAppointment(conversation.appointment) && !readOnly ? (
              <div className="flex min-w-0 flex-col gap-[var(--s-3)] border-t border-[var(--line)] pt-[var(--s-3)]">
                <div className="flex flex-col gap-[var(--s-2)]">
                  <Label htmlFor={`appointment-reason-${conversation.appointment.id}`}>Reason for the change</Label>
                  <Textarea
                    id={`appointment-reason-${conversation.appointment.id}`}
                    maxLength={500}
                    onChange={(event) => onBookingDraftChange({
                      ...bookingDraft,
                      appointmentId: conversation.appointment!.id,
                      reason: event.currentTarget.value,
                    })}
                    placeholder="What did the lead ask to change?"
                    value={bookingDraft.appointmentId === conversation.appointment.id ? bookingDraft.reason : ""}
                  />
                </div>
                <div className="flex flex-col gap-[var(--s-2)]">
                  <Label htmlFor={`appointment-start-${conversation.appointment.id}`}>
                    New start ({conversation.appointment.timezone})
                  </Label>
                  <Input
                    id={`appointment-start-${conversation.appointment.id}`}
                    onChange={(event) => onBookingDraftChange({
                      ...bookingDraft,
                      appointmentId: conversation.appointment!.id,
                      startLocal: event.currentTarget.value,
                    })}
                    type="datetime-local"
                    value={bookingDraft.appointmentId === conversation.appointment.id ? bookingDraft.startLocal : ""}
                  />
                </div>
                <div className="flex flex-wrap gap-[var(--s-2)]">
                  <Button
                    disabled={
                      bookingDraft.appointmentId !== conversation.appointment.id
                      || !bookingDraft.reason.trim() || !bookingDraft.startLocal
                    }
                    onClick={() => onReviewLifecycle("reschedule")}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Review reschedule
                  </Button>
                  <Button
                    disabled={
                      bookingDraft.appointmentId !== conversation.appointment.id
                      || !bookingDraft.reason.trim()
                    }
                    onClick={() => onReviewLifecycle("cancel")}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    Review cancellation
                  </Button>
                </div>
              </div>
            ) : null}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem className={ACC_ITEM} value="activity">
          <AccordionTrigger className={ACC_TRIGGER}>
            Activity
            <span className={ACC_HINT}>
              {events.length === 0 ? "No events" : `${events.length} ${events.length === 1 ? "event" : "events"}`}
            </span>
          </AccordionTrigger>
          <AccordionContent className={ACC_BODY}>
            {events.length === 0 ? (
              <p className={`m-0 ${COACH_READING_CLASS} text-[var(--muted)]`}>No system events are recorded on this thread.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-[var(--s-2)] p-0">
                {events.map((event) => (
                  <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-[var(--s-2)]" key={event.id}>
                    <span className={`min-w-0 ${COACH_READING_CLASS} text-[var(--body)]`}>{event.body}</span>
                    <time className={`${MONO_META_CLASS} shrink-0`}>{event.at}</time>
                  </li>
                ))}
              </ul>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem className={ACC_ITEM} value="technical">
          <AccordionTrigger className={ACC_TRIGGER}>Technical detail</AccordionTrigger>
          <AccordionContent className={ACC_BODY}>
            <dl className="surface-well m-0 flex min-w-0 flex-col gap-[var(--s-3)]">
              {technicalDetails(conversation).map((item) => (
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--s-2)]" key={item.label}>
                  <div className="min-w-0">
                    <dt className={EYEBROW_CLASS}>{item.label}</dt>
                    <dd className="mono m-0 mt-[3px] truncate text-[14px] leading-[1.3] text-[color:var(--body)]">{item.value}</dd>
                  </div>
                  <CopyValue label={item.label} value={item.value} />
                </div>
              ))}
            </dl>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}

/**
 * The empty tray, drawn rather than imported.
 *
 * Inline because it is one shape used once and an icon-set dependency for it would be larger than
 * the shape. `aria-hidden` because the heading beside it is already the accessible statement --
 * a decorative drawing that also announces itself would say the same thing twice.
 */
function EmptyTray() {
  return (
    <svg aria-hidden="true" height="150" viewBox="0 0 220 150" width="220">
      <g fill="none" stroke="var(--line)" strokeLinecap="round" strokeWidth="2">
        <line x1="26" x2="120" y1="34" y2="34" />
        <line x1="46" x2="100" y1="52" y2="52" />
        <line x1="160" x2="196" y1="52" y2="52" />
      </g>
      <g fill="none" stroke="var(--faint)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.25">
        <path d="M40 78h34l10 18h32l10-18h34" />
        <path d="M40 78 55 42h110l15 36v40a10 10 0 0 1-10 10H50a10 10 0 0 1-10-10z" />
      </g>
      <g fill="none" stroke="var(--accent-text)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.25">
        <path d="M96 62l10 10 20-22" />
      </g>
    </svg>
  );
}

/**
 * What the inbox looks like when there is genuinely nothing in the cohort to open.
 *
 * The artboard `InboxEmpty.dc.html` replaces the three panes with one calm centred statement, and
 * the reason is worth writing down: three empty panes tell a coach that something is broken, when
 * what actually happened is that their agent is doing its job. Two panes of "Choose a conversation"
 * beside a pane of "No matching conversations" is a rendering of nothing, not an answer.
 *
 * **This arm is only for an unfiltered cohort.** A search or a facet that matched nothing still
 * falls through to the list pane's own `DataState`, which says to clear the filters -- because
 * that is a different fact and it has a different remedy. Collapsing the two would tell a coach
 * who typed a misspelt name that their agent is handling everything.
 *
 * Every number here is a count the page already holds. The honest-states rule is why the sentence
 * branches at all rather than always naming a figure: a coach with no conversations at all must not
 * be told their agent is handling zero of them, which reads as a claim about the agent rather than
 * about the inbox.
 */
function InboxAtRest({
  agentHandling,
  onSeeAgentHandling,
  totalConversations,
  view,
}: {
  agentHandling: number;
  onSeeAgentHandling: (() => void) | null;
  totalConversations: number;
  view: string;
}) {
  const nothingAtAll = totalConversations === 0;
  const waitingCohort = view === "all" || view === "needs-you";
  const title = nothingAtAll
    ? "No conversations yet"
    : waitingCohort
      ? "Nothing needs you right now"
      : "Nothing is in this view";
  /*
   * `InboxEmpty.dc.html` sets the count in the sentence in mono at `--body` rather than letting it
   * run as plain text, and that is the one figure on an otherwise figureless screen: it is what
   * turns "your agent is handling things" from a reassurance into a claim a coach can check.
   */
  const body: ReactNode = nothingAtAll
    ? "When a lead messages you on a connected channel, the thread will appear here."
    : waitingCohort && agentHandling > 0
      ? (
        <>
          Your agent is handling{" "}
          <span className="mono text-[color:var(--body)]">{agentHandling}</span>{" "}
          {agentHandling === 1 ? "conversation" : "conversations"} on its own, and it will pull you
          in the moment one of them hits something only you can answer.
        </>
      )
      : waitingCohort
        ? "Nothing is waiting on you, and nothing is open with your agent either."
        : "No conversation matches this view at the moment.";

  return (
    <div
      className="grid min-h-0 flex-1 place-items-center overflow-y-auto bg-[radial-gradient(60%_55%_at_50%_8%,var(--accent-wash),transparent_66%)] p-[40px]"
      data-slot="inbox-at-rest"
    >
      {/*
        `InboxEmpty.dc.html` draws this column at 56ch, which is not one of the four measures the
        Line Length rule allows and `src/app/measures.test.ts` refuses. `--measure-tight` is the
        token that exists for exactly this -- centred empty-state copy, narrower than prose on
        purpose -- so the column takes it rather than adding a twelfth hand-rolled `ch` value.
      */}
      <div className="flex max-w-[var(--measure-tight)] flex-col items-center gap-[22px] text-center">
        <EmptyTray />
        {/*
          h2, not h1. `CoachPageHead` renders the page's h1 -- "Your inbox" -- and it sits outside
          the at-rest branch, so a quiet inbox mounted both and read as two top-level headings, the
          second one smaller than the first. The size is the artboard's 38px either way; only the
          level moves. This is the same defect `7c2844f2` fixed on the coach error page, which is
          worth saying because the error page's version was found by looking at the page and this
          one was not: a second h1 is invisible until something enumerates the outline.
        */}
        <h2 className="m-0 text-[38px] leading-[1.1] font-semibold tracking-[-0.024em] text-[color:var(--ink)]">
          {title}
        </h2>
        <p className="m-0 text-[18px] leading-[1.55] text-[color:var(--muted)]">{body}</p>
        {onSeeAgentHandling ? (
          /* 48px with a trailing chevron, which is what the artboard draws. It stays a button
             rather than becoming the artboard's anchor because it changes the view in place; a
             link would claim a destination this control does not have. */
          <button
            className="inline-flex h-[48px] items-center gap-[12px] rounded-[11px] border border-[var(--line)] bg-[var(--well)] px-[22px] text-[16px] leading-none font-medium text-[color:var(--body)] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]"
            onClick={onSeeAgentHandling}
            type="button"
          >
            See what the agent is handling
            <ChevronRight aria-hidden className="size-[18px] shrink-0" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function CoachConversations({
  initialConversations, filteredConversationIds, fixtureMode = false, enabled = true,
  inboxVerbsEnabled = false, impersonation = null, viewerId = null,
  activeObjection = null,
  nowIso = null,
}: CoachConversationsProps) {
  const queryState = useQueryState();
  const filterIdentity = queryState.searchParams.toString();
  const routedConversationId = queryState.get("conversationId") ?? "";
  const initialConversationId = initialConversations.some((row) => row.id === routedConversationId)
    ? routedConversationId
    : initialConversations[0]?.id ?? "";
  const [persisted, setPersisted] = useState(initialConversations);
  const [activeThread, setActiveThread] = useState(() => ({
    filterIdentity,
    id: initialConversationId,
  }));
  const [composerMode, setComposerMode] = useState<ComposerMode>("reply");
  const [detailOpen, setDetailOpen] = useState(Boolean(routedConversationId && initialConversationId));
  const [recordOpen, setRecordOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditReceipt | null>(null);
  const [quietHoursWarning, setQuietHoursWarning] = useState<QuietHoursWarning | null>(null);
  const [bookingDraft, setBookingDraft] = useState<BookingDraft>({
    appointmentId: "", reason: "", startLocal: "",
  });
  const [lifecycleIntent, setLifecycleIntent] = useState<LifecycleIntent | null>(null);

  const conversations = useMemo(() => persisted.map((row) => deriveConversationView(row)), [persisted]);
  const requestedView = queryState.get("view") ?? "all";
  const query = (queryState.get("q") ?? "").trim().toLocaleLowerCase();
  const channels = queryState.getAll("channel");
  const lifecycles = queryState.getAll("lifecycle");
  const outcomes = queryState.getAll("outcome");
  const locallyFiltered = conversations.filter((conversation) => {
    const matchesView = requestedView === "all"
      || (requestedView === "needs-you" && conversation.status === "needs_human")
      || (requestedView === "agent-handling" && conversation.status === "agent")
      || (requestedView === "booked-today" && Boolean(conversation.appointment && isToday(conversation.appointment.startAt)))
      || requestedView.startsWith("objection-");
    const haystack = `${conversation.contactName} ${channelLabel(conversation.channel)} ${conversation.statusLabel} ${latestBody(conversation) ?? ""}`.toLocaleLowerCase();
    return matchesView && (channels.length === 0 || channels.includes(conversation.channel))
      && (lifecycles.length === 0 || lifecycles.includes(STATUS_TO_LIFECYCLE[conversation.status]))
      && outcomeMatches(conversation, outcomes) && (!query || haystack.includes(query));
  });
  const serverFilteredIdSet = filteredConversationIds
    ? new Set(filteredConversationIds)
    : null;
  const inView = serverFilteredIdSet
    ? conversations.filter((conversation) => serverFilteredIdSet.has(conversation.id))
    : locallyFiltered;

  /*
   * The escalation queue (screen 1a) is this view rather than a second list of the same threads:
   * ranking lives where the rows are, and the panel above carries what a list cannot say. The queue
   * is derived from `persisted` rather than from `inView`, because the depth and the handoff counts
   * describe everything waiting on the coach, not whatever survived a channel facet.
   */
  const escalationView = requestedView === "needs-you";
  const queue = useMemo(() => escalationQueue(persisted, nowIso), [persisted, nowIso]);
  const escalationRank = useMemo(
    () => new Map(queue.rows.map((row, index) => [row.conversationId, index])),
    [queue],
  );
  const escalationRows = useMemo(
    () => new Map(queue.rows.map((row) => [row.conversationId, row])),
    [queue],
  );
  const visible = escalationView
    ? [...inView].sort((left, right) =>
        (escalationRank.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (escalationRank.get(right.id) ?? Number.MAX_SAFE_INTEGER))
    : inView;

  const readOnly = impersonation !== null;
  const firstVisibleId = visible[0]?.id ?? "";
  const selectedId = activeThread.filterIdentity === filterIdentity
    ? activeThread.id
    : firstVisibleId;
  const selected = visible.find((conversation) => conversation.id === selectedId) ?? visible[0] ?? null;
  // Held-by-a-human is not held-by-me: another coach's takeover must offer Take over, not Reply.
  const heldByViewer = selected !== null && selected.isHuman
    && (fixtureMode ? selected.takenOverBy === "fixture-coach"
      : viewerId !== null && selected.takenOverBy === viewerId);
  const claim = selected
    ? claimReadout(selected, heldByViewer)
    : { label: "", dot: "bg-[var(--good)]" };
  const threadAge = selected ? threadAgeDays(selected) : null;

  function reviewLifecycle(action: LifecycleIntent["action"]) {
    const appointment = selected?.appointment ?? null;
    if (readOnly || !selected || !eligibleAppointment(appointment)) {
      setFeedback("This appointment does not have a complete current provider record, so no change was requested.");
      return;
    }
    const reason = bookingDraft.appointmentId === appointment.id ? bookingDraft.reason.trim() : "";
    if (!reason) {
      setFeedback("Add a reason before reviewing this appointment change.");
      return;
    }
    let startAt: string | null = null;
    let endAt: string | null = null;
    if (action === "reschedule") {
      startAt = appointmentWallTimeToIso(bookingDraft.startLocal, appointment.timezone);
      const duration = Date.parse(appointment.endAt) - Date.parse(appointment.startAt);
      if (!startAt || !Number.isFinite(duration) || duration <= 0 || startAt === appointment.startAt) {
        setFeedback("Choose a valid new start in the appointment timezone before reviewing the reschedule.");
        return;
      }
      endAt = new Date(Date.parse(startAt) + duration).toISOString();
    }
    setFeedback(null);
    setLifecycleIntent({
      action,
      appointment: { ...appointment },
      contactName: selected.contactName,
      conversationId: selected.id,
      reason,
      startAt,
      endAt,
    });
  }

  async function confirmLifecycle(): Promise<Result> {
    const intent = lifecycleIntent;
    if (!intent || readOnly) return { ok: false, message: "This appointment change is no longer available." };
    const current = persisted.find((row) => row.id === intent.conversationId)?.appointment ?? null;
    if (
      !eligibleAppointment(current)
      || current.id !== intent.appointment.id
      || current.updatedAt !== intent.appointment.updatedAt
    ) {
      return { ok: false, message: "The appointment changed after this review opened. Reload it before trying again." };
    }
    const body = {
      action: intent.action,
      reason: intent.reason,
      expectedVersion: intent.appointment.updatedAt,
      idempotencyKey: [
        "coach-lifecycle", intent.appointment.id, intent.action,
        intent.appointment.updatedAt, intent.startAt ?? "current",
      ].join(":"),
      ...(intent.action === "reschedule"
        ? { startAt: intent.startAt, endAt: intent.endAt }
        : {}),
    };
    try {
      const response = await fetch(
        `/api/appointments/${encodeURIComponent(intent.appointment.id)}/lifecycle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload: unknown = await response.json();
      const receipt = lifecycleReceipt(payload, intent.action);
      if (response.status === 404) {
        // The lifecycle endpoint answers 404 with "Not found." when the verb is not released.
        // Echoing that reads as a lost appointment, so the off-state gets its own sentence.
        return {
          ok: false,
          message: "Appointment changes are not enabled in this environment. Nothing was sent to the calendar, and the lead was not messaged.",
        };
      }
      if (!response.ok || !receipt) {
        const message = payload && typeof payload === "object"
          && typeof (payload as Record<string, unknown>).error === "string"
          ? String((payload as Record<string, unknown>).error)
          : "The calendar did not confirm this appointment change.";
        return { ok: false, message };
      }

      const detailResponse = await fetch(
        `/api/conversations/${encodeURIComponent(intent.conversationId)}`,
        { cache: "no-store" },
      );
      const detailPayload: unknown = await detailResponse.json();
      const conversation = detailPayload && typeof detailPayload === "object"
        ? (detailPayload as { conversation?: unknown }).conversation
        : null;
      if (!detailResponse.ok || !isConversationRead(conversation)) {
        return {
          ok: false,
          message: "The calendar confirmed the change, but the updated appointment could not be read back.",
          partial: true,
        };
      }
      const savedAppointment = conversation.appointment;
      const readBackMatches = intent.action === "cancel"
        ? savedAppointment?.id !== intent.appointment.id
        : eligibleAppointment(savedAppointment)
          && savedAppointment.id === intent.appointment.id
          && savedAppointment.startAt === intent.startAt
          && savedAppointment.endAt === intent.endAt
          && savedAppointment.updatedAt !== intent.appointment.updatedAt;
      if (!readBackMatches) {
        return {
          ok: false,
          message: "The calendar confirmed the change, but the saved appointment still shows the prior version.",
          partial: true,
        };
      }
      setPersisted((rows) => rows.map((row) => row.id === conversation.id ? conversation : row));
      setBookingDraft({ appointmentId: "", reason: "", startLocal: "" });
      return {
        ok: true,
        receipt: {
          auditId: receipt.auditId,
          actionKey: intent.action === "cancel" ? "appointment.canceled" : "appointment.rescheduled",
        },
      };
    } catch {
      return { ok: false, message: "The appointment change could not be confirmed." };
    }
  }

  function acceptReadBack(original: ConversationRead, response: MutationResponse) {
    const view = deriveConversationView(original, { ok: true, conversation: response.conversation });
    if (view.readBackError) {
      setFeedback(view.readBackError);
      return;
    }
    setPersisted((current) => current.map((row) => row.id === original.id ? response.conversation : row));
    setAudit(response.audit);
  }

  async function mutate(
    kind: "claim" | "release" | "message",
    messageBody?: string,
    quietHoursOverride = false,
  ) {
    if (!selected || busy || readOnly) return;
    const original = persisted.find((row) => row.id === selected.id);
    if (!original) return;
    if (fixtureMode) {
      const now = new Date().toISOString();
      const next: ConversationRead = kind === "claim" ? {
        ...original, status: "human", takenOverBy: "fixture-coach",
        messages: [...original.messages, { id: `${original.id}-claim`, direction: "system", author: "system", body: "Automation paused, coach took over", createdAt: now, delivered: false }],
      } : kind === "release" ? {
        ...original, status: "agent", takenOverBy: null, disclosurePending: true,
        messages: [...original.messages, { id: `${original.id}-release`, direction: "system", author: "system", body: "Conversation handed back, agent resumed with context", createdAt: now, delivered: false }],
      } : {
        ...original,
        messages: [...original.messages, {
          id: `${original.id}-message-${Date.now()}`,
          direction: composerMode === "internal_note" ? "system" : "out",
          author: composerMode === "internal_note" ? "system" : "human:fixture-coach",
          body: composerMode === "internal_note" ? `Internal note: ${messageBody?.trim() ?? ""}` : messageBody?.trim() ?? "",
          createdAt: now, delivered: false,
        }],
      };
      setPersisted((current) => current.map((row) => row.id === original.id ? next : row));
      setFeedback("Demo-only change. No live tenant record was written.");
      setAudit(null);
      return;
    }

    setBusy(true);
    setFeedback(null);
    setAudit(null);
    try {
      const path = kind === "message" ? "messages" : kind;
      const body = kind === "claim"
        ? { expectedState: original.status, expectedHolderId: original.takenOverBy, confirmDisplace: false }
        : kind === "release" ? { expectedHolderId: original.takenOverBy }
          : {
              kind: composerMode,
              body: messageBody?.trim() ?? "",
              expectedState: "human",
              ...(composerMode === "reply" && quietHoursOverride ? { quietHoursOverride: true } : {}),
            };
      const response = await fetch(`/api/conversations/${encodeURIComponent(original.id)}/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const payload: unknown = await response.json();
      const quietHours = kind === "message" && composerMode === "reply"
        ? readQuietHoursWarning(payload, messageBody?.trim() ?? "")
        : null;
      if (response.status === 409 && quietHours) {
        setQuietHoursWarning(quietHours);
        return;
      }
      const readBack = readMutationResponse(payload);
      if (!response.ok || !readBack) {
        const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : "The saved state could not be read back. Nothing changed here; retry when ready.";
        setFeedback(deriveConversationView(original, { ok: false, error: message }).readBackError);
        throw new Error(message);
      }
      acceptReadBack(original, readBack);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message
        : "The request did not complete. Nothing changed here; retry when ready.";
      setFeedback((current) => current ?? deriveConversationView(original, { ok: false, error: message }).readBackError);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  /*
   * The three view names are the artboard's, not the console's, and the difference is the whole
   * point of the coach portal being a separate density. "All / Needs you / Agent handling" names
   * the cohorts from the system's side -- a filter over a status column. "Everything / Waiting on
   * you / Agent is handling" names them from the coach's side, as answers to the question the
   * coach actually arrives with, which is whether anything is theirs to do right now.
   *
   * The keys are untouched on purpose. They are in URLs a coach may have bookmarked and in the
   * query state the rail and the filter bar both read, so a rename that reached them would break
   * every saved link to buy nothing -- the label is the only part a reader ever sees.
   */
  /*
   * Three views, and "Waiting on you" is the first of them.
   *
   * `Inbox.dc.html` draws exactly three pills and comments the row "Three views, one search. That
   * is the whole filter bar." What left: "Booked today", which is a report rather than a queue and
   * has a home on Home, and one cohort per objection, which put an unbounded number of pills in a
   * row sized for three. The deep link they served survives -- `?objection=<id>` is applied on the
   * server by `listConversationSet`, not by a facet here, so the agent page's "what leads push back
   * on" rows still land on a filtered inbox; what they get instead of a pill is the scope line
   * below, which says which objection is filtering and offers the way out.
   *
   * Everything carries no count on purpose: it is the whole inbox, and a number beside it competes
   * with the one number on this bar that means work.
   */
  const needsYou = conversations.filter((row) => row.status === "needs_human").length;
  const views: ViewDef[] = [
    {
      key: "needs-you",
      label: "Waiting on you",
      count: needsYou,
      // Amber only while there is something to answer. A warning wash over a zero says the coach
      // is behind when they are not.
      tone: needsYou > 0 ? ("warning" as const) : undefined,
    },
    { key: "agent-handling", label: "Agent is handling", count: conversations.filter((row) => row.status === "agent").length },
    { key: "all", label: "Everything" },
  ];
  const activeViewKey = views.some((view) => view.key === requestedView) ? requestedView : "all";
  /*
   * No facets. The canvas draws one search box and nothing else, and every group that left was a
   * filter over a column the row already states: channel and lifecycle are both on the row's own
   * meta line, and outcome is in the lead rail beside the thread it belongs to. `FilterBar` renders
   * no Filters popover for an empty list, so the bar collapses to the views and the search.
   */
  const facets: FacetGroup[] = [];

  /*
   * The two facts the calm empty screen turns on.
   *
   * `filtersApplied` is deliberately about the search box and the facets and not about the view:
   * an empty "Needs you" with nothing typed is precisely the state the artboard draws as calm,
   * while an empty result under a typed query is a search that missed and keeps the list pane's
   * own "clear the filters" state. Collapsing the two would tell a coach who misspelt a name that
   * their agent is handling everything.
   */
  const filtersApplied = query.length > 0 || queryState.has("objection");
  const agentHandling = conversations.filter((row) => row.status === "agent").length;
  const atRest = visible.length === 0 && !filtersApplied;

  const exportRows = visible.map((row) => ({
    conversationId: row.id, contactId: row.contactId, lead: row.contactName,
    channel: channelLabel(row.channel), status: row.status, lastMessage: latestBody(row) ?? "",
    lastActivity: row.lastActivityAt, demoData: row.isDemo, testData: row.isTest,
  }));
  // The server route is exact for the base view with at most one channel. New views, lifecycle
  // facets, outcome facets, objection cohorts, and multi-channel queries export the complete
  // server-loaded cohort locally because the shared route cannot express those contracts.
  const canUseServerExport = requestedView === "all"
    && channels.length <= 1
    && lifecycles.length === 0
    && outcomes.length === 0
    && !queryState.has("objection");
  const serverExportProps: ExportMenuProps = {
    filename: "setterfi-conversations",
    mode: "server",
    query: {
      channel: channels[0] ?? "",
      columns: ["lead", "channel", "status", "lastMessage", "lastActivity", "demoData", "testData"],
      objection: "",
      outcome: "",
      order: "last_activity_desc",
      search: query,
      stage: "",
    },
    resource: "conversations",
  };
  const localExportProps: ExportMenuProps = {
    filename: "setterfi-conversations",
    mode: "local",
    rows: exportRows,
  };
  const exportMenuProps = canUseServerExport ? serverExportProps : localExportProps;
  const provenance = conversations.some((row) => row.isTest) ? "test" as const
    : conversations.some((row) => row.isDemo) ? "demo" as const : "real" as const;

  const headerActions = selected ? (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-[var(--s-2)]">
      <Button className="@5xl/inbox:hidden" onClick={() => setRecordOpen(true)} size="sm" type="button" variant="outline">
        <PanelRight aria-hidden className="size-[var(--s-4)]" />Details
      </Button>
    </div>
  ) : null;

  return (
    <AppShell
      activePath="/coach/conversations"
      crumbs={CRUMBS}
      nav={workspaceNavigationFor("coach")}
      navCounts={{ "/coach/conversations": needsYou }}
      role="coach"
    >
      {/*
        `Inbox.dc.html` draws no page header at all -- the filter row sits straight under the top
        bar. The head survives at coach scale because the provenance line does not become optional
        when a screen is drawn without one: a seeded demo tenant is labelled on every surface, and
        this is the surface where a coach reads what their agent said to a lead.
      */}
      {enabled ? (
        <CoachPageHead
          provenance={provenance}
          sub="Every thread your agent is running, and the ones it has handed to you."
          surface="inbox"
          title="Your inbox"
        />
      ) : null}
      {!enabled ? (
        <DataState body="This inbox is not active while conversations are disabled." kind="unavailable" title="Conversations are not enabled" />
      ) : (
        <>
          {impersonation ? (
            <div className={`surface-well mb-[var(--s-3)] ${COACH_READING_CLASS} text-[color:var(--body)]`} role="status">
              <strong className="font-medium text-[var(--ink)]">Read-only impersonated view.</strong>{" "}Conversation changes are unavailable in this session.
            </div>
          ) : null}
          {feedback ? <div className={`surface-well mb-[var(--s-3)] ${COACH_READING_CLASS} text-[color:var(--body)]`} role="status">{feedback}</div> : null}
          {audit ? <div aria-label={audit.ariaLabel} className={`mb-[var(--s-3)] ${COACH_READING_CLASS} font-medium text-[var(--good)]`} role="status">{audit.label}</div> : null}

          {/* The escalation queue's own header. It renders only in the view it describes, so the
              inbox does not carry a queue panel over a cohort the queue is not counting. */}
          {escalationView ? <EscalationPanel queue={queue} /> : null}

          {/* The shell measures itself, not the window: inside the three-pane app frame the
              viewport says nothing useful about how wide this workspace actually is, so every
              pane below switches on @container widths and the thread keeps its proportions. */}
          <div className="@container/inbox min-w-0">
          {/*
            The list column is `--sidebar-w * 1.7` rather than the `1.35` it inherited from the
            console. 1.35 is 324px, which held the console's 13px rows and does not hold these: at
            coach scale a row carries a 44px avatar, a 17px name and a 14px mono clock, and 324px
            left the name about 56px once everything else had taken its width. Widening the column
            and moving the clock to the meta line are the same fix approached from both ends -- the
            column now has room for a name at this size, and nothing on the name's line competes
            with it if the column is squeezed again.
          */}
          <section
            aria-label="Conversation workspace"
            /*
             * `--card`, not `--pane`. The shell paints `--pane` behind every page
             * (`app-shell.tsx:567`), so an inbox on `--pane` was the page's own ground with a
             * hairline drawn around it -- the three panes, the thread and the surface under them
             * were one flat tone, and only the border said a panel was there at all. The ramp
             * names four grounds in order (shell, content pane, card face, well sunk into it) and
             * this is a card face on the content pane, the same rung `StatStrip`, `PageSkeleton`
             * and every other panel already takes. It also puts the children back in their
             * documented relationship: the bubbles, the avatars and the agent toggle are all
             * `--well`, which is defined as the well sunk into a card, and until now there was no
             * card under them to sink into.
             */
            className="flex h-[calc(100svh-var(--topbar-h)-var(--s-12)*3)] min-h-[calc(var(--s-12)*8)] min-w-0 flex-col overflow-hidden rounded-[var(--r-panel)] border border-[var(--line)] bg-[var(--card)] shadow-[var(--shadow-card)]"
            data-detail-open={detailOpen || undefined}
            data-inbox-verbs-requested={inboxVerbsEnabled || undefined}
          >
            {/*
              The filter bar spans the frame, above all three panes, which is where
              `Inbox.dc.html` draws it: a `padding: 20px 40px` row closed by a hairline, with the
              380px list column beginning underneath it. It had been living inside the list
              column, which made the search box and the three views read as controls over that one
              pane rather than over the workspace, and squeezed a 16px search field, three view
              pills and their counts into 380px, where they wrapped.

              One copy, not two. While it sat in the column it had to be repeated in the calm
              empty branch, because the bar carries the only view switch below `@5xl` and an empty
              "Needs you" would otherwise have left a coach with no route back. Hoisting it above
              the branch makes that structural instead of duplicated: the switch is mounted in
              both states because it is no longer inside either.
            */}
            <div className="min-w-0 border-b border-[var(--line)] p-[var(--s-3)]">
              <FilterBar defaultViewKey="all" facets={facets} scale="coach" searchPlaceholder={INBOX_SEARCH_PLACEHOLDER} views={views} />
              {/* The scope sentence sits with the box it describes rather than in a tooltip:
                  the reader who needs it is the one whose search just returned nothing, and by
                  then a hover affordance is the last thing they will go looking for. */}
              <p className={`${COACH_FOOTNOTE_CLASS} text-[color:var(--faint)]`}>{INBOX_SEARCH_SCOPE}</p>
              {/*
                Why this list is narrowed, when it was narrowed by a link rather than by the
                search box. `?objection=<id>` is applied on the server, so without this line a
                coach arriving from the agent page's objection rows would read a filtered inbox
                as their whole inbox. The clear is a plain button rather than a facet chip
                because there is exactly one of these and no popover left to keep it in.
              */}
              {activeObjection ? (
                <p className={`flex flex-wrap items-center gap-[var(--s-2)] ${COACH_FOOTNOTE_CLASS}`} data-slot="inbox-objection-scope">
                  <span className="min-w-0">Showing only threads where a lead said &ldquo;{activeObjection.label}&rdquo;.</span>
                  <Button onClick={() => queryState.set("objection", null)} size="sm" type="button" variant="ghost">
                    Show everything
                  </Button>
                </p>
              ) : null}
              <div className="flex justify-end">
                <ExportMenu {...exportMenuProps} />
              </div>
            </div>
            <div
              className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden @3xl/inbox:grid-cols-[minmax(0,calc(var(--sidebar-w)+var(--s-10)))_minmax(0,1fr)] @5xl/inbox:grid-cols-[minmax(0,calc(var(--sidebar-w)*1.7))_minmax(0,1fr)_minmax(0,calc(var(--sidebar-w)*1.15))]"
            >
            {/*
              The views rail is gone. `Inbox.dc.html` draws three panes -- list, thread, lead -- and
              the fourth pane existed to hold six views and an unbounded objection group that the
              bar above could not fit. Three views fit the bar at every width, so the pane it
              needed is 260px of the workspace given back to the list and the thread.
            */}

            {/*
              Nothing to open, and nothing filtering it out: the three panes collapse into one
              calm statement, which is what `InboxEmpty.dc.html` draws.

              The views rail above is deliberately outside this branch and still mounted. An
              earlier pass replaced the whole workspace, which read well on a wide screen and left
              a coach with an empty "Needs you" no route back to any other view -- the rail was the
              route, and it had just been unmounted. The filter bar is no longer part of
              this question: it sits above both branches now, so the view switch a coach needs in
              order to leave an empty cohort is mounted whether or not there is a list under it.
            */}
            {atRest ? (
              <div className="col-span-full flex min-h-0 min-w-0 flex-col">
                <InboxAtRest
                  agentHandling={agentHandling}
                  onSeeAgentHandling={
                    agentHandling > 0 && requestedView !== "agent-handling"
                      ? () => queryState.set("view", "agent-handling")
                      : null
                  }
                  totalConversations={conversations.length}
                  view={activeViewKey}
                />
              </div>
            ) : (
            <>
            <section
              aria-label="Conversation list"
              /*
               * The two flanking panes are `--well`, the thread is the bare `--card` face. The
               * pane below already says it carries the artboard's light source, but a bloom at
               * `--accent-wash` over the same ground as everything beside it is not a depth cue --
               * all three panes were transparent, so the only thing separating a list from a
               * conversation from a lead record was a hairline. Sinking the flanks is the pairing
               * the ramp names: a well sunk into a card face, with the lit pane left on the face.
               */
              className={`${detailOpen ? "hidden @3xl/inbox:flex" : "flex"} min-h-0 min-w-0 flex-col border-[var(--line)] bg-[var(--well)] @3xl/inbox:border-r`}
            >
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" role="list">
                {visible.length ? visible.map((conversation) => {
                  const isCurrent = selected?.id === conversation.id;
                  /*
                   * The row that is wrong takes the tone's row tint, which is the system's own
                   * answer for exactly this and the only one available here: the page's glow is
                   * spent elsewhere and an edge stripe is banned outright.
                   *
                   * It is a single flat layer now rather than a tint over the card gradient,
                   * because the row is no longer a card: the list is one continuous column and the
                   * pane's own ground shows through everything the tint does not cover.
                   */
                  const stopped = agentStopped(conversation.status);
                  const tint = TONE_ROW_TINT[STATUS_TONE[conversation.status]];
                  return (
                    <div
                      className={ROW_FACE_CLASS}
                      data-current={isCurrent || undefined}
                      data-stopped={stopped || undefined}
                      data-unread={conversation.unread || undefined}
                      key={conversation.id}
                      role="listitem"
                      style={stopped
                        ? { backgroundImage: `linear-gradient(0deg, ${tint}, ${tint})` }
                        : undefined}
                    >
                      <button
                        aria-current={isCurrent ? "true" : undefined}
                        aria-label={`Open conversation with ${conversation.contactName}${conversation.unread ? ", unread" : ""}`}
                        className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-y-[var(--s-2)] text-left outline-none focus-visible:rounded-[var(--r-control)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                        onClick={() => {
                          setActiveThread({ filterIdentity, id: conversation.id });
                          setDetailOpen(true);
                        }} type="button"
                      >
                        <span className="flex min-w-0 items-center gap-[calc(var(--s-2)+var(--s-1)/2)]">
                          <span
                            aria-hidden
                            /* 44px, which is the artboard's own avatar and also the surface's
                               target floor -- the row's leading edge and the smallest thing a
                               coach is asked to hit are deliberately the same size. */
                            className="flex size-[44px] shrink-0 items-center justify-center rounded-[var(--r-full)] border border-[var(--line)] bg-[var(--card)] font-[family-name:var(--font-mono)] text-[15px] text-[var(--muted)]"
                          >
                            {initials(conversation.contactName)}
                          </span>
                          <span className="flex min-w-0 flex-1 items-center gap-[calc(var(--s-1)+var(--s-1)/2)]">
                            <span className={`truncate ${COACH_ROW_NAME_CLASS} ${conversation.unread ? "font-semibold" : ""}`}>
                              {conversation.contactName}
                            </span>
                            {/* Unread is a dot beside the name, so it never rests on weight alone. */}
                            <span
                              aria-hidden
                              className={`size-[8px] shrink-0 rounded-[var(--r-full)] bg-[var(--ink)] ${conversation.unread ? "" : "hidden"}`}
                            />
                          </span>
                        </span>
                        {/*
                          The last thing said, as plain text on the row's own ground. It used to
                          sit in a recessed `surface-well` frame, which made sense while the row
                          was a card and the well was the card's inner content; in a continuous
                          list a well per row draws a second column of boxes down the pane and
                          re-introduces exactly the edge noise the flat row removes.

                          A thread with no transcript prints its absence in the faint colour rather
                          than the body colour, because at body weight "No messages yet" is
                          indistinguishable from something the lead actually wrote -- and a coach
                          scanning this column reads every line here as a quote.
                        */}
                        <span
                          className={`block min-w-0 truncate ${COACH_FOOTNOTE_CLASS} ${
                            latestBody(conversation) === null
                              ? "text-[color:var(--faint)] italic"
                              : "text-[color:var(--body)]"
                          }`}
                        >
                          {latestBody(conversation) ?? "No messages yet"}
                        </span>
                        <span className="flex min-w-0 flex-wrap items-center gap-x-[var(--s-2)] gap-y-[var(--s-1)]">
                          {/* A pill, and still one treatment per list. The bare dot-plus-text was
                              right in a 13px column where a row of lozenges would have out-weighed
                              the sentence; at 15px in a 380px pane there is room for the lozenge,
                              and the artboard draws it because the state is the thing a coach
                              scans this column for. */}
                          <Status
                            className={ROW_STATUS_PILL_CLASS}
                            label={conversation.statusLabel}
                            tone={STATUS_TONE[conversation.status]}
                          />
                          <span className="min-w-0 truncate text-[14px] leading-[1.3] text-[color:var(--faint)]">
                            {channelLabel(conversation.channel)}
                          </span>
                          {/*
                            The clock sits here, on the meta line, rather than beside the name.

                            It used to share the name's line as a `shrink-0` sibling, which is a
                            layout that only works while the column is wide. At the four-pane
                            breakpoint the list is `--sidebar-w * 1.35`; after the padding, the
                            checkbox column, the 44px avatar and the gaps, the name line is 188px,
                            and a 14px mono "May 31, 8:00 PM" claims 126px of it before the name
                            gets a say -- so every lead rendered as "Jo...", "M...", "La...". A
                            name the coach cannot read is the one thing this column exists to show,
                            so the name now owns its line outright and the clock joins the other
                            metadata, where wrapping is already allowed and nothing is identity.

                            In the escalation view the clock is the wait rather than the timestamp,
                            because that is what the ordering means, and it is a span rather than a
                            `time` element -- a duration with an unknown case is not a datetime. It
                            carries no staleness cue of its own: `ESCALATION_CLOCK_BASIS`, rendered
                            once by the panel above, covers this clock and the ranking both.
                          */}
                          {escalationView ? (
                            <span className={MONO_META_CLASS}>
                              {escalationClockLabel(escalationRows.get(conversation.id)?.waitSeconds ?? null)}
                            </span>
                          ) : (
                            <time className={MONO_META_CLASS}>{displayTime(conversation.lastActivityAt)}</time>
                          )}
                        </span>
                        {/* Why the agent stopped, in the same words the handoff rules use, on every
                            view rather than only inside the escalation cohort -- a coach reading
                            All is the reader most likely not to know one is waiting. A thread whose
                            reason column is empty says so rather than borrowing one. */}
                        {stopped ? (
                          <span className={`line-clamp-2 min-w-0 ${COACH_FOOTNOTE_CLASS} text-[color:var(--body)]`}>
                            {stopReason(conversation)}
                          </span>
                        ) : null}
                      </button>
                    </div>
                  );
                }) : <DataState body="Clear the search or filters to bring conversations back into view." className="px-[var(--s-4)]" kind="empty" title="No matching conversations" />}
                {/*
                  The artboard's closing line, and it is a claim rather than decoration: it says
                  the coach has reached the bottom of the queue, so it may only appear where that
                  is true. Three conditions, all of them load-bearing.

                  It is scoped to the waiting-on-you cohort because that is the only view whose
                  bottom means anything -- "that is everything" under Everything would be a
                  statement about the page size, not about the coach's workload.

                  It requires an unfiltered view. Under a typed query or a channel facet the
                  bottom of the list is the bottom of the *match*, and telling a coach who
                  filtered to Instagram that nothing else is waiting hides the Messenger thread
                  that is.

                  And it requires the server not to have paged: `filteredConversationIds` narrows
                  the rows the client holds, so when the server has already decided the cohort
                  this list is a window onto it rather than the whole of it.
                */}
                {visible.length > 0 && activeViewKey === "needs-you" && !filtersApplied && !serverFilteredIdSet ? (
                  <p
                    className={`px-[22px] py-[20px] text-center ${COACH_READING_CLASS} text-[color:var(--muted)]`}
                    data-slot="inbox-list-end"
                  >
                    That is everything waiting on you.
                  </p>
                ) : null}
              </div>
            </section>

            {/* The thread pane carries one cool bloom off its top edge, which is the artboard's
                own light source and the same gradient the shell paints behind every page. It is
                decoration on a pane that is otherwise a wall of text, and it is the only thing on
                this screen that is not a fact. */}
            <section
              aria-label="Conversation detail"
              className={`${detailOpen ? "flex" : "hidden @3xl/inbox:flex"} min-h-0 min-w-0 flex-col bg-[radial-gradient(85%_50%_at_78%_-8%,var(--accent-wash),transparent_60%)]`}
            >
              {selected ? (
                <>
                  <header className="flex min-w-0 flex-wrap items-start gap-[var(--s-3)] border-b border-[var(--line)] px-[28px] py-[20px]">
                    <Button className="@3xl/inbox:hidden" onClick={() => setDetailOpen(false)} size="sm" type="button" variant="ghost"><ArrowLeft aria-hidden className="size-[var(--s-4)]" />Conversations</Button>
                    <span
                      aria-hidden
                      className="flex size-[44px] shrink-0 items-center justify-center rounded-[var(--r-full)] border border-[var(--line)] bg-[var(--quiet)] font-[family-name:var(--font-mono)] text-[15px] text-[var(--muted)]"
                    >
                      {initials(selected.contactName)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className={`truncate ${COACH_SURFACE_TITLE_CLASS}`}>{selected.contactName}</h2>
                      {/* The thread's facts read as one line under the name, which is how the
                          artboard draws them. They used to sit in a recessed `surface-well` bar,
                          and the reason for that was to keep them off a tinted band across the
                          pane -- still the rule, and still kept: a plain line spends no colour at
                          all, and the well was buying separation the name above already gives. */}
                      <div className="mt-[calc(var(--s-1)+var(--s-1)/2)] flex min-w-0 flex-wrap items-center gap-x-[var(--s-3)] gap-y-[var(--s-2)]">
                        {/* Channel and age read as one phrase, the way the artboard sets them,
                            because they answer the same question -- where this came from and how
                            long it has been going. They share a `span` so the separator cannot
                            end up stranded on its own line when the pane narrows, and the age
                            drops out entirely rather than degrading to a dangling middot when the
                            thread carries no message to measure from. */}
                        <span className={`min-w-0 truncate ${COACH_FOOTNOTE_CLASS}`}>
                          {channelLabel(selected.channel)}
                          {threadAge === null ? null : ` \u00b7 ${firstMessageLabel(threadAge)}`}
                        </span>
                        <Status
                          className={STATUS_PILL_CLASS}
                          label={selected.statusLabel}
                          tone={STATUS_TONE[selected.status]}
                        />
                      </div>
                    </div>
                    <AgentSwitch
                      busy={busy}
                      claim={claim}
                      disabled={readOnly || !inboxVerbsEnabled}
                      heldByViewer={heldByViewer}
                      onToggle={(next) => void mutate(next ? "release" : "claim").catch(() => undefined)}
                    />
                    {headerActions}
                  </header>
                  <div className={`min-h-0 min-w-0 flex-1 px-[28px] ${TRANSCRIPT_WELL_CLASS}`}><Transcript messages={transcriptMessages(selected)} stop={transcriptStop(selected)} variant="coach" /></div>
                  <div className="min-w-0 border-t border-[var(--line)] px-[28px] pt-[18px] pb-[22px]">
                    {readOnly ? (
                      <Composer disabled={{ reason: "Replies are blocked in a read-only impersonated view." }} onSend={async () => undefined} placeholder="Replies are blocked" sending={false} />
                    ) : heldByViewer ? (
                      <div className="min-w-0">
                        <Tabs className="mb-[var(--s-2)]" onValueChange={(value) => setComposerMode(value as ComposerMode)} value={composerMode}>
                          {/*
                            The tabs name the two destinations rather than the two formats, which
                            is the distinction a coach gets wrong under pressure. "Reply" and
                            "Internal note" are both things you type into a box; "Reply to Denise"
                            and "Note to yourself" are a message that leaves the building and one
                            that does not, and the second tab is the one where getting it wrong
                            sends a private remark to the lead.

                            The reply tab carries the lead's given name -- the first whitespace-
                            separated token of the name on the record -- because that is what the
                            artboard draws and because a name is what makes the destination
                            concrete. A single-token name degrades to itself, and an empty one
                            falls back to the untargeted word rather than rendering "Reply to ".
                          */}
                          <TabsList aria-label="Message type"><TabsTrigger value="reply">{replyTabLabel(selected.contactName)}</TabsTrigger><TabsTrigger value="internal_note">Note to yourself</TabsTrigger></TabsList>
                        </Tabs>
                        <Composer
                          hint={composerMode === "reply" ? channelSendLabel(selected.channel) : "Only your team sees this note. It is not sent to the lead."}
                          onSend={(body) => mutate("message", body)}
                          placeholder={composerMode === "reply" ? "Type your reply\u2026" : "Add a note only your team can see"}
                          sending={busy}
                        />
                      </div>
                    ) : (
                      <section
                        className="surface-well flex min-h-[calc(var(--s-12)*2)] min-w-0 flex-wrap items-center gap-[var(--s-4)]"
                        data-slot="composer-gate"
                        id="message-composer"
                        tabIndex={-1}
                      >
                        <div className="flex min-w-0 flex-1 flex-col gap-[calc(var(--s-1)/2)]">
                          <strong className={COACH_ROW_NAME_CLASS}>
                            {selected.isHuman ? "Another person has this thread" : "The agent is holding this thread"}
                          </strong>
                          <span className={`${COACH_READING_CLASS} text-[var(--muted)]`}>
                            Take over this conversation to reply as yourself. Taking over pauses the agent for {selected.contactName} only, and the thread shows you as the sender. Hand back any time.
                          </span>
                        </div>
                        <LoggedButton
                          actionKey="conversation.takeover.claimed"
                          disabled={busy}
                          onClick={() => void mutate("claim").catch(() => undefined)}
                          variant="primary"
                        >
                          Take over to reply
                        </LoggedButton>
                      </section>
                    )}
                  </div>
                </>
              ) : <DataState body="Select a conversation to review its transcript and captured lead details." className="m-[var(--s-6)]" kind="empty" title="Choose a conversation" />}
            </section>

            <aside
              aria-label="Lead details"
              className="hidden min-h-0 min-w-0 flex-col overflow-y-auto border-l border-[var(--line)] bg-[var(--well)] p-[24px] @5xl/inbox:flex"
            >
              {selected ? (
                <LeadRail
                  bookingDraft={bookingDraft}
                  conversation={selected}
                  onBookingDraftChange={setBookingDraft}
                  onOpenRecord={() => setRecordOpen(true)}
                  onReviewLifecycle={reviewLifecycle}
                  readOnly={readOnly}
                />
              ) : (
                <p className={`${COACH_READING_CLASS} text-[var(--muted)]`}>Choose a conversation to review captured details.</p>
              )}
            </aside>
            </>
            )}
            </div>
          </section>
          </div>

          <RecordSheet
            onOpenChange={setRecordOpen} open={recordOpen}
            sections={selected ? [{ title: "Captured details", body: <LeadDetails conversation={selected} /> }] : []}
            subtitle={selected ? channelLabel(selected.channel) : undefined}
            technical={selected ? technicalDetails(selected) : undefined}
            title={selected?.contactName ?? "Lead details"}
          />
          <AlertDialog
            open={quietHoursWarning !== null}
            onOpenChange={(open) => { if (!open && !busy) setQuietHoursWarning(null); }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Send outside this lead&apos;s messaging hours?</AlertDialogTitle>
                <AlertDialogDescription>
                  This lead&apos;s allowed window is {quietHoursWarning?.allowedWindow ?? "unavailable"}.
                  Their resolved local time {quietHoursWarning?.leadLocalTimes.length === 1 ? "is" : "could be"}{" "}
                  {quietHoursWarning?.leadLocalTimes.join("; ") ?? "unavailable"}. The routine next send time is{" "}
                  {quietHoursWarning ? displayTime(quietHoursWarning.scheduledAt) : "unavailable"}.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={() => {
                    if (!quietHoursWarning) return;
                    const reply = quietHoursWarning.body;
                    setQuietHoursWarning(null);
                    void mutate("message", reply, true).catch(() => undefined);
                  }}
                >
                  Send now anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <ConfirmFlow
            action={lifecycleIntent?.action === "cancel" ? "appointment.canceled" : "appointment.rescheduled"}
            confirmLabel={lifecycleIntent?.action === "cancel" ? "Cancel appointment" : "Reschedule appointment"}
            destructive={lifecycleIntent?.action === "cancel"}
            impact={lifecycleIntent ? [
              { label: "Lead", value: lifecycleIntent.contactName },
              { label: "Current time", value: displayTime(lifecycleIntent.appointment.startAt) },
              ...(lifecycleIntent.action === "reschedule" && lifecycleIntent.startAt
                ? [{ label: "New time", value: displayTime(lifecycleIntent.startAt) }]
                : []),
              { label: "Provider", value: lifecycleIntent.appointment.provider },
              { label: "Reason", value: lifecycleIntent.reason },
            ] : []}
            onConfirm={confirmLifecycle}
            onOpenChange={(open) => {
              if (!open) setLifecycleIntent(null);
            }}
            open={lifecycleIntent !== null}
            title={lifecycleIntent?.action === "cancel" ? "Cancel this appointment?" : "Reschedule this appointment?"}
          />
        </>
      )}
    </AppShell>
  );
}
