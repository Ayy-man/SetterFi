"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { TITLE_PANEL_TITLE_CLASS } from "@/components/kit/deck-panel";
import { handoffFor } from "@/components/workspace/live/escalation-queue";
import { deriveConversationView } from "@/components/workspace/live/view-models";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";
import type { AuditReceipt } from "@/lib/audit";
import { WORKSPACE_DISPLAY_TIMEZONE, workspaceDateTimeFormat } from "@/lib/format/datetime";
import { displayText, displayTextOrNull } from "@/lib/format/display-name";
import type {
  ConversationMessageRead,
  ConversationRead,
} from "@/lib/repositories/conversations";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";
import { StatusDot } from "./_primitives";
import { ContextEye } from "./context-eye";

/**
 * The coach Inbox as `design/coach/Inbox.dc.html` draws it.
 *
 * Three panes flush to one top line under a single bar that carries three views, one search box
 * and one channel filter. The list finds the thread, the transcript is the thread and its audit
 * trail, and the rail is the facts the agent captured with nothing pressable in it. The seven
 * named views, the objection cohorts, the bulk select and every diagnostic chip the 2026-09-04
 * visual audit listed are gone rather than restyled.
 *
 * Two things the audit measured are structural rather than cosmetic and are fixed here as
 * structure. The agent toggle used to be a 46px slab painted ink on ink, unreadable at 1:1
 * contrast, and it is now a 52px labelled switch whose word changes with its state. The phone
 * used to paint all three panes on top of each other; the panes stack now, the list hands over to
 * the thread on selection with a back control, and the rail becomes a sheet.
 */

/* The sentences this screen does not print, handed to the eye instead. */
const COACH_INBOX_EYE_COPY =
  "Every thread your agent is running, and the ones it has handed to you. Needs you is the "
  + "threads the agent has stopped on or a person already holds, Agent handling is the ones it is "
  + "still running, and Everything is both plus the closed and opted-out threads. Search reads the "
  + "lead's name, the channel and the most recent message on the thread; earlier messages are not "
  + "loaded here, so a phrase from further back will not match. Turning your agent off pauses it "
  + "for this lead only and writes a line into the thread naming you. Turn it back on any time.";

export type CoachInboxView = "needs-you" | "agent-handling" | "everything";

export type CoachInboxProps = {
  /** The tenant's conversation set, read once on the server. */
  initialConversations: ConversationRead[];
  /**
   * The ids surviving the active view, resolved on the server from the repository's own
   * `conversationViewStatuses` so the view boundary and the status enum cannot drift apart.
   * Absent, every row shows.
   */
  viewIds?: readonly string[];
  view?: CoachInboxView;
  /** The two lane sizes, counted on the server off the whole set. Null when it did not count. */
  viewCounts?: { needsYou: number; agentHandling: number } | null;
  enabled?: boolean;
  fixtureMode?: boolean;
  impersonation?: { sessionId: string; tenantId: string } | null;
  viewerId?: string | null;
  /** The instant every wait is measured against, resolved on the server so both passes agree. */
  nowIso?: string | null;
};

type MutationResponse = { conversation: ConversationRead; audit: AuditReceipt | null };

const CRUMBS = [{ label: "Inbox" }, { label: "Conversations" }] as const;

/** The channel as a coach says it. Never a vendor code, and never a two-letter tag. */
const CHANNEL_LABELS: Record<ConversationRead["channel"], string> = {
  sms: "Text message",
  instagram: "Instagram",
  messenger: "Messenger",
  whatsapp: "WhatsApp",
  webchat: "Web chat",
};

const CHANNEL_ORDER: readonly ConversationRead["channel"][] = [
  "instagram",
  "messenger",
  "whatsapp",
  "sms",
  "webchat",
];

type StateWord = { label: string; tone: "good" | "amber" | "grey" };

/**
 * The word a row's state pill carries outside the Needs you view. Amber is spent only on the
 * states that are the coach's to act on, so a full inbox never reads as a backlog it is not.
 */
const STATE_WORDS: Record<ConversationRead["status"], StateWord> = {
  agent: { label: "Agent handling", tone: "good" },
  needs_human: { label: "Needs you", tone: "amber" },
  human: { label: "A person has it", tone: "amber" },
  nurture: { label: "Following up", tone: "grey" },
  closed: { label: "Closed", tone: "grey" },
  scope_blocked: { label: "Held for you", tone: "amber" },
  opted_out: { label: "Opted out", tone: "grey" },
};

const PILL_TONE: Record<StateWord["tone"], string> = {
  amber: "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[color:var(--warning-text)]",
  good: "border-[var(--good-line)] bg-[var(--good-wash)] text-[color:var(--good-text)]",
  grey: "border-[var(--line)] bg-[var(--control-fill)] text-[color:var(--muted)]",
};

const PILL_CLASS =
  "inline-flex h-[32px] shrink-0 items-center gap-[8px] rounded-full border px-[12px] text-[15px] "
  + "font-medium whitespace-nowrap";

/*
 * Control shapes carry no colour, and that omission is the fix for a defect rather than a tidy-up.
 *
 * The old constant carried `bg-[var(--card)] text-[color:var(--ink)]` and the agent toggle's
 * callsite appended `bg-[var(--ink)] text-[color:var(--card)]`. Two arbitrary utilities of one CSS
 * property in a single class list do not resolve in the order they are written: Tailwind emits
 * each candidate once in its own sort order and the cascade picks whichever it emitted later. It
 * picked ink for both halves, so the most important control on the coach side rendered at 1:1
 * contrast and read as a black slab. A base with no colour plus one named variant per pair closes
 * the class of bug rather than the instance, and `coach-inbox-toggle.test.tsx` pins it.
 */
const BUTTON_SHAPE_CLASS =
  "inline-flex h-[48px] min-w-0 shrink-0 items-center justify-center gap-[10px] rounded-[9px] "
  + "border px-[22px] text-[16px] disabled:cursor-not-allowed disabled:opacity-55";

/** The quiet button: the control fill on the hairline. */
const BUTTON_QUIET_CLASS =
  `${BUTTON_SHAPE_CLASS} border-[var(--line)] bg-[var(--control-fill)] font-medium `
  + "text-[color:var(--body)]";

/** Send, which is the screen's one accent fill. */
const BUTTON_ACCENT_CLASS =
  `${BUTTON_SHAPE_CLASS} border-[var(--accent-line)] bg-[image:var(--accent-fill)] px-[24px] `
  + "font-semibold text-[color:var(--on-accent)] shadow-[var(--primary-shadow)]";

const ICON_BUTTON_CLASS =
  "grid size-[44px] shrink-0 place-items-center rounded-[10px] border border-[var(--line)] "
  + "bg-[var(--control-fill)] text-[color:var(--body)]";

const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

const MONTH_DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

/** The calendar day an instant falls on in the reporting zone, as a sortable key. */
const DAY_KEY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

function initials(name: string) {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "??";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return `${first}${last}`.toLocaleUpperCase() || "??";
}

function firstName(name: string) {
  return name.trim().split(/\s+/u).filter(Boolean)[0] ?? name.trim();
}

/** "4:12 pm". Lowercase, because the artboards write the meridiem as a word and not a shout. */
function clockLabel(at: number) {
  return TIME_FORMAT.format(new Date(at)).replace(/\s?(AM|PM)/u, (match) => match.toLowerCase());
}

function daysBetween(then: number, now: number) {
  const thenKey = DAY_KEY_FORMAT.format(new Date(then));
  const nowKey = DAY_KEY_FORMAT.format(new Date(now));
  const difference = Date.parse(`${nowKey}T00:00:00Z`) - Date.parse(`${thenKey}T00:00:00Z`);
  return Number.isFinite(difference) ? Math.round(difference / 86_400_000) : 0;
}

/**
 * The stamp under a bubble: "today 11:48 am", "Monday 4:12 pm", "Aug 17 4:12 pm". Null whenever
 * the clock is unavailable, so an unreadable instant is left out rather than printed as an epoch.
 */
function messageStamp(iso: string, nowIso: string | null) {
  const then = Date.parse(iso);
  const now = nowIso ? Date.parse(nowIso) : Number.NaN;
  if (!Number.isFinite(then)) return null;
  if (!Number.isFinite(now)) return clockLabel(then);

  const days = daysBetween(then, now);
  const day = days <= 0
    ? "today"
    : days === 1
      ? "yesterday"
      : days < 7
        ? WEEKDAY_FORMAT.format(new Date(then))
        : MONTH_DAY_FORMAT.format(new Date(then));
  return `${day} ${clockLabel(then)}`;
}

/**
 * How long a thread has been sitting, in words rather than in a mono abbreviation. Null when the
 * clock is unavailable: no "0m" ever stands in for an age nothing measured.
 */
function ageLabel(iso: string, nowIso: string | null) {
  const then = Date.parse(iso);
  const now = nowIso ? Date.parse(nowIso) : Number.NaN;
  if (!Number.isFinite(then) || !Number.isFinite(now) || now < then) return null;
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Takes the messages alone so it reads a repository row and a `ConversationView` alike. */
function latestBody(conversation: { messages: readonly ConversationMessageRead[] }) {
  return conversation.messages.at(-1)?.body ?? null;
}

function threadStartAt(conversation: ConversationRead) {
  return conversation.messages[0]?.createdAt ?? conversation.lastActivityAt;
}

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
    ? payload.audit as AuditReceipt
    : null;
  return { conversation: payload.conversation, audit };
}

/** A thread is the viewer's only while they are the recorded holder. Another coach's is not. */
function heldByViewerOf(
  conversation: ConversationRead | null,
  viewerId: string | null,
  fixtureMode: boolean,
) {
  if (!conversation || conversation.status !== "human" || conversation.takenOverBy === null) {
    return false;
  }
  return fixtureMode
    ? conversation.takenOverBy === "fixture-coach"
    : viewerId !== null && conversation.takenOverBy === viewerId;
}

/**
 * The six facts the rail states, in the artboard's order, each with the honest absence in place of
 * the value. A blank row and an unasked question look identical on screen and only one of them is
 * true, so nothing here is ever left empty.
 *
 * "Questions answered" counts the four qualification fields this read carries. The agent's own
 * question set is longer and its size is not on `ConversationRead`, so the denominator names what
 * was actually counted rather than borrowing a number from somewhere else.
 */
function leadFacts(conversation: ConversationRead) {
  const captured = [
    conversation.qualification.credit,
    conversation.qualification.goal,
    conversation.qualification.timeline,
    conversation.qualification.business ?? null,
  ].filter((value) => value != null && value.trim() !== "").length;

  const outcome = conversation.qualification.outcome;
  const decision = outcome === "BOOK"
    ? { label: "Qualified for a call", tone: "good" as const }
    : outcome === "HARD_DQ"
      ? { label: "Not a fit", tone: "grey" as const }
      : outcome === "SOFT_DQ"
        ? { label: "Still deciding", tone: "amber" as const }
        : null;

  const proposed = conversation.proposedSlots?.slots.length ?? 0;
  const startedAt = conversation.appointment
    ? Date.parse(conversation.appointment.startAt)
    : Number.NaN;
  const booking = conversation.appointment
    ? Number.isFinite(startedAt)
      ? workspaceDateTimeFormat.format(new Date(startedAt))
      : "Booked, the time is not readable"
    : proposed > 0
      ? `${proposed} times offered, none confirmed`
      : "Not booked yet";

  return {
    rows: [
      { key: "credit", label: "Credit range", value: conversation.qualification.credit },
      { key: "goal", label: "Funding goal", value: conversation.qualification.goal },
      { key: "timeline", label: "Timeline", value: conversation.qualification.timeline },
      { key: "answered", label: "Questions answered", value: `${captured} of 4 answered` },
    ] as const,
    decision,
    booking,
  };
}

/**
 * What a system line says. The backend writes "Automation paused, <name> took over" on every
 * takeover, and the thread is where that record belongs, so the line is rendered rather than
 * summarised. When the current holder is the viewer, the most recent takeover line is theirs and
 * it is written in the second person, which is the shape Pipedrive's live chat uses and the one
 * the artboard draws.
 */
function systemLine(
  message: ConversationMessageRead,
  options: { mine: boolean; nowIso: string | null },
) {
  const body = displayText(message.body).trim();
  const stamp = messageStamp(message.createdAt, options.nowIso);
  const takeover = /took over/u.test(body);
  const text = takeover && options.mine ? "You joined the conversation" : body;
  return stamp ? `${text}, ${stamp}` : text;
}

function isTakeover(message: ConversationMessageRead) {
  return message.direction === "system" && /took over/u.test(message.body);
}

function isNote(message: ConversationMessageRead) {
  return message.direction === "system" && message.author.startsWith("human")
    && !isTakeover(message);
}

/**
 * What the thread band offers, which is one pressable thing whose state is the truth and whose
 * press is the only write the backend will accept in that state.
 *
 * A two-position switch was the first answer and it lied. "Your agent is answering" sat on and
 * green over a thread the agent had stopped on, because the switch was reading "nobody has taken
 * this" rather than "the agent is running it". The three states are not two:
 *
 *   - The agent is running the thread (`agent`). A switch, on. Pressing it claims the thread.
 *   - You are running it (`human`, and you are the holder). The same switch, off. Pressing it
 *     releases, and the agent resumes.
 *   - A handover rule stopped the agent and nobody has taken over (`needs_human`,
 *     `scope_blocked`). The agent is not answering and it may not resume: `release` requires a
 *     non-empty `expectedHolderId`, so the only write the route accepts here is `claim`. A switch
 *     in this state would either read as on while the agent is stopped, or sit off and refuse to
 *     move when pressed. So the band draws a button instead, and the transcript's centred line
 *     says why the agent stopped, so the state and the reason are each stated once.
 *
 * A closed or opted-out thread offers nothing: the first has nothing to answer and the second is
 * a lead who asked not to be messaged, so the band states the fact and stays unpressable.
 */
type BandControl =
  | { kind: "switch"; on: boolean; label: string; tone: "good" | "warning"; action: "claim" | "release" | null }
  | { kind: "button"; label: string; tone: "warning" | "neutral" }
  | { kind: "word"; label: string };

function bandControlFor(conversation: ConversationRead, mine: boolean): BandControl {
  switch (conversation.status) {
    case "agent":
      return { kind: "switch", on: true, label: "Your agent is answering", tone: "good", action: "claim" };
    case "human":
      return mine
        ? { kind: "switch", on: false, label: "You are answering", tone: "warning", action: "release" }
        : { kind: "switch", on: false, label: "Someone on your team is answering", tone: "warning", action: null };
    case "needs_human":
    case "scope_blocked":
      return { kind: "button", label: "Answer this yourself", tone: "warning" };
    case "nurture":
      return { kind: "button", label: "Answer this yourself", tone: "neutral" };
    case "closed":
      return { kind: "word", label: "This thread is closed" };
    case "opted_out":
      return { kind: "word", label: "This lead opted out" };
  }
}

/** The placeholder says why the field is shut, and "turn your agent off" is true in one state. */
function composerPlaceholder(
  conversation: ConversationRead | null,
  options: { readOnly: boolean; ready: boolean },
) {
  if (options.readOnly) return "This view is read only";
  if (options.ready) return "Type your message";
  if (!conversation) return "Pick a thread to write in";
  if (conversation.status === "agent") return "Turn your agent off to reply";
  if (conversation.status === "human") return "Someone on your team is answering this thread";
  if (conversation.status === "closed") return "This thread is closed";
  if (conversation.status === "opted_out") return "This lead opted out, so nothing can be sent";
  return "Take this thread to reply";
}

function ChevronIcon({ direction }: { direction: "left" | "right" | "down" }) {
  const path = direction === "left"
    ? "m15 18-6-6 6-6"
    : direction === "right" ? "m9 18 6-6-6-6" : "m6 9 6 6 6-6";
  return (
    <svg
      aria-hidden
      className="size-[20px]"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
    >
      <path d={path} />
    </svg>
  );
}

export function CoachInbox({
  initialConversations,
  viewIds,
  view = "needs-you",
  viewCounts = null,
  enabled = true,
  fixtureMode = false,
  impersonation = null,
  viewerId = null,
  nowIso = null,
}: CoachInboxProps) {
  const { account } = useWorkspaceEnv();
  const coachName = account?.firstName?.trim() || "you";

  const [persisted, setPersisted] = useState(initialConversations);
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState<ConversationRead["channel"] | "all">("all");
  const [channelOpen, setChannelOpen] = useState(false);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [quietHours, setQuietHours] = useState(false);
  const [audit, setAudit] = useState<AuditReceipt | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const inView = useMemo(() => {
    const allowed = viewIds ? new Set(viewIds) : null;
    return allowed ? persisted.filter((row) => allowed.has(row.id)) : persisted;
  }, [persisted, viewIds]);

  /*
   * The amber count on the Inbox pill, which every coach route has to carry so the coach's only
   * needs-you signal does not vanish when they walk off this screen. Server pages read
   * `coachNavCounts`; this one is a client component, so it counts the same predicate off the rows
   * it already holds. Two things make that equal to the helper's read rather than merely close to
   * it: `initialConversations` is the whole tenant set, filtered to a view here rather than in the
   * query, and the predicate is `needs_human` alone. It is deliberately not `viewCounts.needsYou`,
   * which is the Needs you *lane* and also holds `human` and `scope_blocked` threads, so wiring
   * the pill to it would over-count the queue by every thread someone is already answering.
   */
  const needsYou = useMemo(
    () => persisted.filter((row) => row.status === "needs_human").length,
    [persisted],
  );

  const query = search.trim().toLocaleLowerCase();
  const visible = inView.filter((conversation) => {
    if (channel !== "all" && conversation.channel !== channel) return false;
    if (!query) return true;
    const haystack = [
      conversation.contactName,
      CHANNEL_LABELS[conversation.channel],
      latestBody(conversation) ?? "",
    ].join(" ").toLocaleLowerCase();
    return haystack.includes(query);
  });

  const channelsPresent = CHANNEL_ORDER.filter((option) =>
    inView.some((conversation) => conversation.channel === option));

  const selected = visible.find((row) => row.id === chosenId) ?? visible[0] ?? null;
  const threadOpenOnPhone = chosenId !== null && selected !== null;
  const readOnly = impersonation !== null;
  const heldByViewer = heldByViewerOf(selected, viewerId, fixtureMode);
  const band = selected ? bandControlFor(selected, heldByViewer) : null;
  const handoff = selected ? handoffFor(selected.statusReason) : null;
  const stopped = selected !== null
    && (selected.status === "needs_human" || selected.status === "scope_blocked");
  const lastTakeoverId = selected
    ? [...selected.messages].reverse().find(isTakeover)?.id ?? null
    : null;

  /*
   * A thread opens on its newest message, the way every messaging app a coach already uses does.
   * Without this the transcript opens on the oldest line and the thing the lead actually said, the
   * reason the thread is in this list at all, is several scrolls away.
   */
  useEffect(() => {
    const pane = transcriptRef.current;
    if (!pane) return undefined;
    // After the frame that lays the bubbles out, not in the same one: on the first paint of a
    // thread the pane's scroll height is still the height of an empty box.
    const frame = requestAnimationFrame(() => {
      pane.scrollTop = pane.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.id, selected?.messages.length, threadOpenOnPhone]);

  useEffect(() => {
    if (!channelOpen) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setChannelOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [channelOpen]);

  useEffect(() => {
    if (!sheetOpen) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSheetOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  async function mutate(
    kind: "claim" | "release" | "reply" | "note",
    options: { body?: string; quietHoursOverride?: boolean } = {},
  ) {
    if (!selected || busy || readOnly) return;
    const original = persisted.find((row) => row.id === selected.id);
    if (!original) return;

    if (fixtureMode) {
      const now = new Date().toISOString();
      const next: ConversationRead = kind === "claim"
        ? { ...original, status: "human", takenOverBy: "fixture-coach" }
        : kind === "release"
          ? { ...original, status: "agent", takenOverBy: null, disclosurePending: true }
          : {
              ...original,
              messages: [...original.messages, {
                id: `${original.id}-message-${now}`,
                direction: kind === "note" ? "system" : "out",
                author: "human:fixture-coach",
                body: options.body?.trim() ?? "",
                createdAt: now,
                delivered: false,
              }],
            };
      setPersisted((rows) => rows.map((row) => row.id === original.id ? next : row));
      setFeedback("Demo-only change. No live tenant record was written.");
      setAudit(null);
      setQuietHours(false);
      if (kind === "reply" || kind === "note") setDraft("");
      return;
    }

    setBusy(true);
    setFeedback(null);
    setAudit(null);
    try {
      const path = kind === "claim" || kind === "release" ? kind : "messages";
      const payload = kind === "claim"
        ? {
            expectedState: original.status,
            expectedHolderId: original.takenOverBy,
            confirmDisplace: false,
          }
        : kind === "release"
          ? { expectedHolderId: original.takenOverBy }
          : kind === "note"
            ? { kind: "internal_note", body: options.body?.trim() ?? "", expectedState: "human" }
            : {
                kind: "reply",
                body: options.body?.trim() ?? "",
                expectedState: "human",
                ...(options.quietHoursOverride ? { quietHoursOverride: true } : {}),
              };
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(original.id)}/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body: unknown = await response.json();
      const readBack = readMutationResponse(body);
      if (!response.ok || !readBack) {
        const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const message = typeof record.message === "string"
          ? record.message
          : typeof record.error === "string"
            ? record.error
            : "The saved state could not be read back. Nothing changed here; retry when ready.";
        // The one refusal a coach can answer: outside the lead's messaging hours, the route asks
        // for a second, explicit confirmation rather than sending or silently queueing.
        setQuietHours(record.code === "HUMAN_REPLY_QUIET_HOURS_CONFIRMATION_REQUIRED");
        setFeedback(message);
        return;
      }
      setPersisted((rows) =>
        rows.map((row) => row.id === original.id ? readBack.conversation : row));
      setAudit(readBack.audit);
      setQuietHours(false);
      if (kind === "reply" || kind === "note") setDraft("");
    } catch {
      setFeedback("The request did not complete. Nothing changed here; retry when ready.");
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return (
      <AppShell
        activePath="/coach/conversations"
        crumbs={CRUMBS}
        nav={workspaceNavigationFor("coach")}
        role="coach"
      >
        <DataState
          body="This inbox is not active while conversations are disabled."
          kind="unavailable"
          title="Conversations are not enabled"
        />
      </AppShell>
    );
  }

  const facts = selected ? leadFacts(selected) : null;
  const leadFirstName = selected ? firstName(selected.contactName) : "";
  const composerReady = heldByViewer && !readOnly;

  const factRows = facts ? (
    <div className="flex flex-col gap-[18px]">
      {facts.rows.map((fact) => (
        <div key={fact.key}>
          <div className="text-[15px] text-[color:var(--muted)]">{fact.label}</div>
          <div
            className={fact.value
              ? "text-[17px] font-medium text-[color:var(--ink)]"
              : "text-[17px] text-[color:var(--muted)]"}
          >
            {fact.value ?? "Not asked yet"}
          </div>
        </div>
      ))}
      <div>
        <div className="text-[15px] text-[color:var(--muted)]">Decision</div>
        {facts.decision ? (
          <span className={`${PILL_CLASS} ${PILL_TONE[facts.decision.tone]} mt-[3px]`}>
            <StatusDot tone={facts.decision.tone} />
            {facts.decision.label}
          </span>
        ) : (
          <div className="text-[17px] text-[color:var(--muted)]">Not decided yet</div>
        )}
      </div>
      <div>
        <div className="text-[15px] text-[color:var(--muted)]">Booking</div>
        <div className="text-[17px] font-medium text-[color:var(--ink)]">{facts.booking}</div>
      </div>
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
        `data-layout="fixed"` is the shell's own hook for a page that owns the viewport: it pins
        `#content` to `h-svh` and turns `<main>` into a non-scrolling flex column, which is what
        lets the panes scroll independently instead of the page scrolling under them. The negative
        margins undo `<main>`'s padding, because the panes run edge to edge under the pill bar. The
        bottom one is undone at every width, and below `sm` the page reserves the phone tab bar
        itself: the bar is a fixed 56px strip on the bottom edge, the shell's reserve for it is a
        `<main>` padding that `coach.css` resets to nothing on a fixed-layout page, and without a
        replacement the composer sits under the bar, which is what the audit measured on the phone.
      */}
      <div
        className="relative -mx-[var(--s-4)] -my-[var(--s-6)] flex min-h-0 flex-1 flex-col overflow-hidden max-sm:pb-[calc(72px+env(safe-area-inset-bottom))] sm:-mx-[var(--s-6)] xl:-mx-[var(--page-x)]"
        data-layout="fixed"
        data-slot="coach-inbox"
      >
        <h1 className="sr-only">Inbox</h1>

        {/* --------------------------------------------------------------------- the one bar */}
        {/*
          The bar belongs to the list. On a phone the list hands the screen over to the thread, so
          the views, the search and the channel filter go with it: three rows of controls for a
          pane that is not on screen would cost the transcript half its height.
        */}
        <div
          className={[
            "shrink-0 flex-wrap items-center gap-[8px] border-b border-[var(--line)] bg-[var(--pane)] px-[16px] py-[14px] sm:flex sm:gap-[16px] sm:px-[28px] sm:py-[18px]",
            threadOpenOnPhone ? "hidden sm:flex" : "flex",
          ].join(" ")}
        >
          <nav
            aria-label="Which threads"
            className="flex max-w-full shrink-0 gap-[4px] overflow-x-auto rounded-full border border-[var(--line)] bg-[var(--well)] p-[4px]"
          >
            {([
              { key: "needs-you" as const, label: "Needs you", count: viewCounts?.needsYou ?? null },
              {
                key: "agent-handling" as const,
                label: "Agent handling",
                count: viewCounts?.agentHandling ?? null,
              },
              { key: "everything" as const, label: "Everything", count: null },
            ]).map((option) => {
              const active = view === option.key;
              const tone = active
                ? option.key === "needs-you"
                  ? "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[color:var(--warning-text)]"
                  : "border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] text-[color:var(--ink)]"
                : "border-transparent text-[color:var(--muted)]";
              return (
                <a
                  aria-current={active ? "page" : undefined}
                  className={`flex h-[44px] shrink-0 items-center gap-[10px] rounded-full border px-[15px] text-[16px] whitespace-nowrap no-underline hover:no-underline sm:px-[20px] ${tone} ${active ? "font-semibold" : "font-medium"}`}
                  href={`/coach/conversations?view=${option.key}`}
                  key={option.key}
                >
                  {option.label}
                  {option.count === null ? null : (
                    <span className="font-mono text-[15px]">{option.count}</span>
                  )}
                </a>
              );
            })}
          </nav>

          <div className="flex h-[48px] w-full items-center gap-[10px] rounded-[9px] border border-[var(--line-input)] bg-[var(--well)] px-[16px] sm:w-auto sm:min-w-[220px] sm:max-w-[380px] sm:flex-1">
            <svg
              aria-hidden
              className="size-[20px] shrink-0 text-[color:var(--faint)]"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.75"
              viewBox="0 0 24 24"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              aria-label="Search a name or a message"
              className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-[color:var(--ink)] outline-none placeholder:text-[color:var(--faint)]"
              data-coach-target="exempt"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search a name or a message"
              type="search"
              value={search}
            />
          </div>

          {/*
            The channel filter as a menu rather than a `<select>`: a native select is banned on
            live surfaces (`workspace-round4.test.ts`) and its options cannot carry the 44px target
            this surface owes every pressable thing.
          */}
          <div
            className="relative shrink-0"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setChannelOpen(false);
              }
            }}
          >
            <button
              aria-expanded={channelOpen}
              aria-haspopup="menu"
              className="inline-flex h-[48px] items-center gap-[12px] rounded-[9px] border border-[var(--line-input)] bg-[var(--well)] px-[16px] text-[16px] font-medium text-[color:var(--ink)] whitespace-nowrap"
              onClick={() => setChannelOpen((open) => !open)}
              type="button"
            >
              {channel === "all" ? "All channels" : CHANNEL_LABELS[channel]}
              <span className="text-[color:var(--faint)]"><ChevronIcon direction="down" /></span>
            </button>
            {channelOpen ? (
              <div
                aria-label="Channel"
                className="absolute top-[52px] right-0 z-30 flex w-[240px] flex-col rounded-[12px] border border-[var(--line)] bg-[var(--card-top)] p-[6px] shadow-[var(--shadow-raised)]"
                role="menu"
              >
                {[{ key: "all" as const, label: "All channels" },
                  ...channelsPresent.map((option) => ({
                    key: option,
                    label: CHANNEL_LABELS[option],
                  }))]
                  .map((option) => (
                    <button
                      className={`flex h-[44px] items-center rounded-[8px] px-[12px] text-left text-[16px] ${channel === option.key ? "bg-[var(--accent-wash)] font-semibold text-[color:var(--accent-text)]" : "text-[color:var(--body)]"}`}
                      key={option.key}
                      onClick={() => {
                        setChannel(option.key);
                        setChannelOpen(false);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
              </div>
            ) : null}
          </div>

          <ContextEye copy={COACH_INBOX_EYE_COPY} screen="coach-inbox" />
        </div>

        {/* ------------------------------------------------------------------- the three panes */}
        <div className="flex min-h-0 flex-1">
          {/* ------------------------------------------------------------------------- list */}
          <section
            aria-label="Conversations"
            className={[
              "min-h-0 min-w-0 flex-col border-r border-[var(--line)] bg-[var(--pane)] sm:flex sm:w-[380px] sm:flex-none",
              threadOpenOnPhone ? "hidden sm:flex" : "flex w-full",
            ].join(" ")}
          >
            <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
              {visible.map((row) => {
                /*
                 * The row draws through the shared view model rather than off the repository row,
                 * so provenance is derived in one place for every surface that shows a thread:
                 * `deriveConversationView` is what carries the repository's `isTest` to the label
                 * below, and a second local reading of the flag here is exactly how a test row
                 * ends up marked on one screen and unmarked on the next. The repository row stays
                 * the state this component holds, because the view model does not carry
                 * `proposedSlots`, which the lead details rail reads off the selected thread.
                 */
                const conversation = deriveConversationView(row);
                const active = selected?.id === conversation.id;
                const age = ageLabel(conversation.lastActivityAt, nowIso);
                const state = STATE_WORDS[conversation.status];
                return (
                  <li key={conversation.id}>
                    <button
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full gap-[14px] border-b border-[var(--line-soft)] px-[22px] py-[18px] text-left ${active ? "bg-[var(--accent-wash)]" : ""}`}
                      onClick={() => setChosenId(conversation.id)}
                      type="button"
                    >
                      <span
                        className={`grid size-[44px] shrink-0 place-items-center rounded-full border bg-[var(--well)] font-mono text-[15px] ${active ? "border-[var(--accent-edge)] text-[color:var(--accent-text)]" : "border-[var(--line)] text-[color:var(--muted)]"}`}
                      >
                        {initials(conversation.contactName)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-[6px]">
                        <span className="flex items-baseline justify-between gap-[10px]">
                          <span className="min-w-0 truncate text-[17px] font-semibold text-[color:var(--ink)]">
                            {conversation.contactName}
                          </span>
                          {age ? (
                            <span className="shrink-0 text-[14px] whitespace-nowrap text-[color:var(--muted)]">
                              {age}
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-[16px] text-[color:var(--body)]">
                          {/*
                            The seeders write a trailing marker onto every body on the measurement
                            tenant and the column keeps it. A coach reading a preview is not the
                            reader that marker is for, so it comes off here; the search haystack
                            above still matches the raw string.
                          */}
                          {displayTextOrNull(latestBody(conversation)) ?? "No messages yet"}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
                          <span className="text-[15px] text-[color:var(--muted)]">
                            {CHANNEL_LABELS[conversation.channel]}
                          </span>
                          {/*
                            The lane is a fact about a single-lane view, so a pill repeating it on
                            every row of Needs you or Agent handling is the screen saying one thing
                            forty times. Only Everything mixes lanes, so only Everything says which.
                          */}
                          {view === "everything" ? (
                            <span className={`${PILL_CLASS} ${PILL_TONE[state.tone]}`}>
                              <StatusDot tone={state.tone} />
                              {state.label}
                            </span>
                          ) : null}
                          {conversation.isTest ? (
                            <span
                              className="shrink-0 rounded-[6px] border border-[var(--line)] px-[6px] text-[14px] text-[color:var(--muted)]"
                              data-provenance="test"
                            >
                              Test data
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              <li className="px-[22px] py-[24px] text-center text-[16px] text-[color:var(--muted)]">
                {visible.length === 0
                  ? query || channel !== "all"
                    ? "No thread matches that search."
                    : view === "needs-you"
                      ? "Nothing is waiting on you."
                      : "No thread is in this view."
                  : view === "needs-you"
                    ? "That is everything waiting on you."
                    : "That is the whole list."}
              </li>
            </ul>
          </section>

          {/* ----------------------------------------------------------------------- thread */}
          <section
            aria-label="Thread"
            className={[
              "min-h-0 min-w-0 flex-1 flex-col bg-[var(--canvas)] sm:flex",
              threadOpenOnPhone ? "flex" : "hidden sm:flex",
            ].join(" ")}
            style={{ backgroundImage: "var(--pane-bloom)" }}
          >
            {selected ? (
              <>
                <header className="flex shrink-0 flex-col gap-[12px] border-b border-[var(--line)] px-[16px] py-[14px] sm:flex-row sm:items-center sm:gap-[24px] sm:px-[28px] sm:py-[16px]">
                  <div className="flex min-w-0 flex-1 items-center gap-[12px]">
                    <button
                      aria-label="Back to the list"
                      className={`${ICON_BUTTON_CLASS} sm:hidden`}
                      onClick={() => setChosenId(null)}
                      type="button"
                    >
                      <ChevronIcon direction="left" />
                    </button>
                    <div className="min-w-0 flex-1">
                      {/*
                        The thread's own title is the title-led card's title: 22px/600 at
                        -0.015em, imported rather than retyped so the two cannot drift.
                      */}
                      <h2
                        className={`${TITLE_PANEL_TITLE_CLASS} truncate text-[color:var(--ink)]`}
                      >
                        {selected.contactName}
                      </h2>
                      <p className="m-0 truncate text-[16px] text-[color:var(--muted)]">
                        {CHANNEL_LABELS[selected.channel]}
                        {ageLabel(threadStartAt(selected), nowIso)
                          ? `, first message ${ageLabel(threadStartAt(selected), nowIso)} ago`
                          : ""}
                      </p>
                    </div>
                  </div>
                  {/*
                    The one pressable thing this band offers. Which shape it takes is decided by
                    `bandControlFor`, which reads the thread's status rather than the absence of a
                    holder, so the control cannot say the agent is answering a thread the agent
                    has stopped on. Every arm's press is the one write the route accepts in that
                    state, and the write puts a named line in the transcript.
                  */}
                  {band?.kind === "switch" ? (
                    <button
                      aria-checked={band.on}
                      className={`inline-flex h-[52px] shrink-0 items-center justify-between gap-[14px] rounded-full border py-0 pr-[8px] pl-[18px] text-[16px] font-semibold disabled:cursor-not-allowed disabled:opacity-55 max-sm:w-full ${band.tone === "good" ? "border-[var(--good-line)] bg-[var(--good-wash)] text-[color:var(--good-text)]" : "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[color:var(--warning-text)]"}`}
                      disabled={busy || readOnly || band.action === null}
                      onClick={() => {
                        if (band.action) void mutate(band.action);
                      }}
                      role="switch"
                      type="button"
                    >
                      <span>{band.label}</span>
                      <span
                        aria-hidden
                        className={`relative block h-[36px] w-[64px] shrink-0 rounded-full border ${band.tone === "good" ? "border-[var(--good-line)] bg-[var(--good)]" : "border-[var(--warning-line)] bg-[var(--warning)]"}`}
                      >
                        <span
                          className={`absolute top-[3px] size-[28px] rounded-full bg-[var(--on-accent)] shadow-[0_1px_2px_rgba(28,42,82,0.3)] ${band.on ? "right-[3px]" : "left-[3px]"}`}
                        />
                      </span>
                    </button>
                  ) : band?.kind === "button" ? (
                    <button
                      className={`inline-flex h-[52px] shrink-0 items-center justify-center rounded-full border px-[22px] text-[16px] font-semibold disabled:cursor-not-allowed disabled:opacity-55 max-sm:w-full ${band.tone === "warning" ? "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[color:var(--warning-text)]" : "border-[var(--line)] bg-[var(--control-fill)] text-[color:var(--body)]"}`}
                      disabled={busy || readOnly}
                      onClick={() => void mutate("claim")}
                      type="button"
                    >
                      {band.label}
                    </button>
                  ) : band ? (
                    <span className="shrink-0 text-[16px] font-medium text-[color:var(--muted)]">
                      {band.label}
                    </span>
                  ) : null}
                </header>

                {/* Below the rail's breakpoint the facts are a sheet, reached from here. */}
                <button
                  className="flex h-[44px] shrink-0 items-center justify-between border-b border-[var(--line-soft)] px-[16px] text-[16px] font-medium text-[color:var(--body)] sm:px-[28px] xl:hidden"
                  onClick={() => setSheetOpen(true)}
                  type="button"
                >
                  Lead details
                  <span className="text-[color:var(--faint)]"><ChevronIcon direction="right" /></span>
                </button>

                {/*
                  `overflow-auto` rather than `overflow-y-auto` on purpose. `coach.css` appends a
                  108px spacer inside every `overflow-y-auto` region of a fixed-layout page to keep
                  the support launcher off the last row, and this region does not end at the
                  screen: the composer does, and it reserves the launcher's corner itself below.
                  A spacer here would only push 108px of nothing between the last message and the
                  composer.
                */}
                <div
                  className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-auto px-[16px] py-[24px] sm:px-[28px]"
                  ref={transcriptRef}
                >
                  {selected.messages.map((message) => {
                    if (isNote(message)) {
                      return (
                        <div
                          className="self-center rounded-[12px] border border-dashed border-[var(--line)] bg-[var(--well)] px-[16px] py-[12px] text-[16px] text-[color:var(--body)]"
                          key={message.id}
                        >
                          {displayText(message.body)}
                          <p className="m-0 mt-[8px] text-[14px] text-[color:var(--muted)]">
                            Your note, only you see this
                            {messageStamp(message.createdAt, nowIso)
                              ? `, ${messageStamp(message.createdAt, nowIso)}`
                              : ""}
                          </p>
                        </div>
                      );
                    }
                    if (message.direction === "system") {
                      return (
                        <div className="flex items-center gap-[14px] py-[4px]" key={message.id}>
                          <span className="h-px flex-1 bg-[var(--line-soft)]" />
                          <span className="max-w-[62%] text-center text-[15px] text-[color:var(--muted)]">
                            {systemLine(message, {
                              mine: heldByViewer && message.id === lastTakeoverId,
                              nowIso,
                            })}
                          </span>
                          <span className="h-px flex-1 bg-[var(--line-soft)]" />
                        </div>
                      );
                    }
                    const outbound = message.direction === "out";
                    const byHuman = outbound && message.author.startsWith("human");
                    const sender = !outbound
                      ? leadFirstName
                      : byHuman
                        ? viewerId && message.author === `human:${viewerId}`
                          ? coachName
                          : "Someone on your team"
                        : "Your agent";
                    const stamp = messageStamp(message.createdAt, nowIso);
                    return (
                      <div
                        className={[
                          "max-w-[86%] px-[18px] py-[14px] sm:max-w-[62%]",
                          outbound
                            ? "self-end rounded-[16px_16px_5px_16px] border border-[var(--accent-edge)] bg-[var(--accent-wash-strong)]"
                            : "self-start rounded-[16px_16px_16px_5px] border border-[var(--line-input)] bg-[var(--raised)] shadow-[var(--shadow-card)]",
                        ].join(" ")}
                        key={message.id}
                      >
                        <p className="m-0 text-[16px] leading-[1.5] text-[color:var(--ink)]">
                          {displayText(message.body)}
                        </p>
                        <p className="m-0 mt-[8px] text-[14px] text-[color:var(--muted)]">
                          {stamp ? `${sender}, ${stamp}` : sender}
                        </p>
                      </div>
                    );
                  })}
                  {/*
                    Why the agent stopped, in the thread and in its own words. It names the rule
                    the run recorded rather than a stock sentence, so a thread held for a tripwire
                    does not claim it was held over a price.
                  */}
                  {stopped ? (
                    <div className="flex items-center gap-[14px] py-[4px]" data-slot="inbox-stop">
                      <span className="h-px flex-1 bg-[var(--line-soft)]" />
                      <span className="max-w-[62%] text-center text-[15px] text-[color:var(--muted)]">
                        Your agent stopped here.
                        {" "}
                        {handoff?.behaviour ?? "No reason for the handoff is recorded."}
                      </span>
                      <span className="h-px flex-1 bg-[var(--line-soft)]" />
                    </div>
                  ) : null}
                </div>

                {/* ------------------------------------------------------------- composer */}
                <form
                  className={[
                    "shrink-0 border-t border-[var(--line)] bg-[var(--pane)] pt-[16px] pb-[20px] sm:pb-[24px]",
                    // The support launcher is `fixed` in the bottom-right corner of every coach
                    // page. Where the rail is not there to hold that corner, the composer keeps
                    // Send clear of it rather than letting the launcher sit on the one button
                    // that writes to the lead, which is what the audit measured on the phone.
                    "pl-[16px] sm:pl-[28px]",
                    railOpen ? "pr-[84px] sm:pr-[108px] xl:pr-[28px]" : "pr-[84px] sm:pr-[108px]",
                  ].join(" ")}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (draft.trim()) {
                      void mutate(mode === "note" ? "note" : "reply", { body: draft });
                    }
                  }}
                >
                  <div
                    aria-label="What you are writing"
                    className="mb-[12px] flex gap-[8px]"
                    role="group"
                  >
                    {([
                      { key: "reply" as const, label: `Reply to ${leadFirstName}` },
                      { key: "note" as const, label: "Note to yourself" },
                    ]).map((tab) => (
                      <button
                        aria-pressed={mode === tab.key}
                        className={`h-[44px] rounded-full border px-[20px] text-[16px] ${mode === tab.key ? "border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] font-semibold text-[color:var(--ink)]" : "border-transparent font-medium text-[color:var(--muted)]"} whitespace-nowrap`}
                        key={tab.key}
                        onClick={() => setMode(tab.key)}
                        type="button"
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                  {/*
                    Send drops under the field on a phone rather than sharing its line. At 390 the
                    two side by side leave the field about 150px wide, which is narrower than the
                    sentence the disabled state has to print, so the placeholder wrapped and was
                    clipped by the field's own height.
                  */}
                  <div className="flex flex-col items-stretch gap-[10px] rounded-[11px] border border-[var(--line-input)] bg-[var(--well)] py-[12px] pr-[12px] pl-[16px] sm:flex-row sm:items-end sm:gap-[14px]">
                    <textarea
                      aria-label={mode === "note" ? "Note to yourself" : `Reply to ${leadFirstName}`}
                      className="min-h-[48px] min-w-0 flex-1 resize-none bg-transparent py-[12px] text-[16px] text-[color:var(--ink)] outline-none placeholder:text-[color:var(--faint)] disabled:opacity-55"
                      data-coach-target="exempt"
                      disabled={!composerReady || busy}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder={composerPlaceholder(selected, {
                        readOnly,
                        ready: composerReady,
                      })}
                      rows={1}
                      value={draft}
                    />
                    <button
                      className={`${BUTTON_ACCENT_CLASS} max-sm:w-full`}
                      disabled={!composerReady || busy || !draft.trim()}
                      type="submit"
                    >
                      Send
                    </button>
                  </div>
                  {feedback ? (
                    <p className="m-0 mt-[10px] text-[16px] text-[color:var(--muted)]" role="status">
                      {feedback}
                    </p>
                  ) : null}
                  {quietHours ? (
                    <button
                      className={`${BUTTON_QUIET_CLASS} mt-[10px]`}
                      disabled={busy || !draft.trim()}
                      onClick={() => void mutate("reply", { body: draft, quietHoursOverride: true })}
                      type="button"
                    >
                      Send it now anyway
                    </button>
                  ) : null}
                  {audit ? (
                    <p
                      aria-label={audit.ariaLabel}
                      className="m-0 mt-[10px] text-[16px] font-medium text-[color:var(--good-text)]"
                      role="status"
                    >
                      {audit.label}
                    </p>
                  ) : null}
                </form>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-[28px] text-center text-[16px] text-[color:var(--muted)]">
                {inView.length === 0
                  ? "There is no thread in this view to read."
                  : "Pick a thread on the left."}
              </div>
            )}
          </section>

          {/* ------------------------------------------------------------------------- rail */}
          {selected ? (
            <aside
              aria-label="Lead details"
              className={`hidden min-h-0 shrink-0 flex-col border-l border-[var(--line)] bg-[var(--pane)] xl:flex ${railOpen ? "w-[320px]" : "w-[76px]"}`}
            >
              <div
                className={`flex shrink-0 items-center gap-[12px] px-[16px] pt-[20px] pb-[22px] ${railOpen ? "justify-between" : "justify-center"}`}
              >
                {railOpen ? (
                  <h2 className="m-0 text-[18px] font-semibold text-[color:var(--ink)]">
                    Lead details
                  </h2>
                ) : null}
                <button
                  aria-expanded={railOpen}
                  aria-label={railOpen ? "Hide lead details" : "Show lead details"}
                  className={ICON_BUTTON_CLASS}
                  onClick={() => setRailOpen((open) => !open)}
                  type="button"
                >
                  <ChevronIcon direction={railOpen ? "right" : "left"} />
                </button>
              </div>
              {railOpen ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-[24px] pb-[24px]">{factRows}</div>
              ) : null}
            </aside>
          ) : null}
        </div>

        {/* The same facts as a sheet wherever the rail does not fit. */}
        {sheetOpen && selected ? (
          <div className="fixed inset-0 z-[60] flex flex-col justify-end xl:hidden">
            <button
              aria-label="Close lead details"
              className="absolute inset-0 bg-[rgba(28,42,82,0.35)]"
              onClick={() => setSheetOpen(false)}
              type="button"
            />
            <div
              aria-label="Lead details"
              className="relative max-h-[80svh] overflow-y-auto rounded-t-[24px] border-t border-[var(--line)] bg-[var(--pane)] px-[24px] pt-[20px] pb-[calc(24px+56px+env(safe-area-inset-bottom))]"
              role="dialog"
            >
              <div className="mb-[22px] flex items-center justify-between gap-[12px]">
                <h2 className="m-0 text-[18px] font-semibold text-[color:var(--ink)]">
                  Lead details
                </h2>
                <button
                  className={ICON_BUTTON_CLASS}
                  onClick={() => setSheetOpen(false)}
                  type="button"
                >
                  <ChevronIcon direction="down" />
                </button>
              </div>
              {factRows}
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
