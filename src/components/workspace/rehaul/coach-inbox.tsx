"use client";

import { useMemo, useState } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { LEAD_FACT_LABELS } from "@/components/workspace/live/coach-type";
import { handoffFor } from "@/components/workspace/live/escalation-queue";
import {
  deriveConversationView,
  type ConversationView,
} from "@/components/workspace/live/view-models";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";
import type { AuditReceipt } from "@/lib/audit";
import { workspaceDateFormat, workspaceDateTimeFormat } from "@/lib/format/datetime";
import type { ConversationRead } from "@/lib/repositories/conversations";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";
import { Pill, StatusDot, type StatusTone } from "./_primitives";
import { ContextEye } from "./context-eye";

/**
 * The coach Inbox as `CoachInbox.body.html` draws it: three panes filling the viewport under the
 * pill bar, with the list on the left, the thread in the middle and the lead beside it.
 *
 * It reads the same rows `CoachConversations` reads -- `listConversationSet` on the server, the
 * same `deriveConversationView`, the same claim/release/messages routes -- and adds no query of
 * its own. What changed is the shape: the console's filter bar, facet popover, record sheet and
 * accordions are gone, and the three things a coach actually does (find the thread, read it,
 * answer it) each own a pane. Every sentence the old surface printed as help text moved into the
 * context eye at the bottom right.
 */

export type CoachInboxProps = {
  initialConversations: ConversationRead[];
  /** Ids surviving the server's own `?q=`/`?objection=` narrowing, when the page passed them. */
  filteredConversationIds?: readonly string[];
  enabled?: boolean;
  fixtureMode?: boolean;
  impersonation?: { sessionId: string; tenantId: string } | null;
  viewerId?: string | null;
  /** The instant every wait is measured against, resolved on the server so both passes agree. */
  nowIso?: string | null;
};

type MutationResponse = { conversation: ConversationRead; audit: AuditReceipt | null };

const CRUMBS = [{ label: "Inbox" }, { label: "Conversations" }] as const;

const CHANNEL_LABELS: Record<ConversationRead["channel"], string> = {
  sms: "Text messages (SMS)",
  instagram: "Instagram",
  messenger: "Messenger",
  whatsapp: "WhatsApp",
  webchat: "Web chat",
};

/** The mono tag on a list row's meta line. The channel, never a vendor. */
const CHANNEL_TAGS: Record<ConversationRead["channel"], string> = {
  sms: "SMS",
  instagram: "IG",
  messenger: "MSG",
  whatsapp: "WA",
  webchat: "WEB",
};

type StatusReadout = { label: string; tone: StatusTone; text: string };

/**
 * What a row's coloured dot says. Amber is the only persistent colour and it is spent on the
 * states that are the coach's to act on; everything the agent is still running stays grey, so a
 * full inbox never reads as a backlog it is not.
 */
const STATUS_READOUTS: Record<ConversationRead["status"], StatusReadout> = {
  agent: { label: "Agent handling", tone: "grey", text: "text-[color:var(--faint)]" },
  needs_human: { label: "Needs you", tone: "amber", text: "text-[color:var(--warning-text)]" },
  human: { label: "A person has it", tone: "amber", text: "text-[color:var(--warning-text)]" },
  nurture: { label: "Follow-up", tone: "grey", text: "text-[color:var(--faint)]" },
  closed: { label: "Closed", tone: "grey", text: "text-[color:var(--faint)]" },
  scope_blocked: { label: "Held for you", tone: "amber", text: "text-[color:var(--warning-text)]" },
  opted_out: { label: "Opted out", tone: "grey", text: "text-[color:var(--faint)]" },
};

const MONO_CLASS = "font-mono font-medium tracking-[-0.05em]";

const AVATAR_CLASS =
  "flex shrink-0 items-center justify-center rounded-full border border-[var(--accent-edge)] "
  + "bg-[var(--accent-wash)] font-mono font-medium tracking-[-0.02em] text-[color:var(--accent-text)]";

const BUTTON_CLASS =
  "inline-flex h-[46px] min-w-0 items-center justify-center gap-[8px] rounded-[12px] border "
  + "border-[var(--line-input)] bg-[var(--card)] px-[20px] text-[16px] font-medium "
  + "text-[color:var(--ink)] disabled:cursor-not-allowed disabled:opacity-55";

function initials(name: string) {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "??";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return `${first}${last}`.toLocaleUpperCase() || "??";
}

/** A short wait, and null whenever the clock is unavailable rather than a "0m" standing in. */
function elapsedLabel(iso: string, nowIso: string | null) {
  const then = Date.parse(iso);
  const now = nowIso ? Date.parse(nowIso) : Number.NaN;
  if (!Number.isFinite(then) || !Number.isFinite(now) || now < then) return null;
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function latestBody(conversation: ConversationView) {
  return conversation.messages.at(-1)?.body ?? null;
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

function dayLabel(iso: string | undefined) {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? workspaceDateFormat.format(new Date(parsed)) : null;
}

function appointmentLabel(startAt: string) {
  const parsed = Date.parse(startAt);
  return Number.isFinite(parsed) ? workspaceDateTimeFormat.format(new Date(parsed)) : null;
}

/**
 * The collected answers, in the artboard's order, with everything the agent has not captured said
 * as "not asked yet" rather than left blank -- a blank row and an unasked question look the same
 * on screen, and only one of them is true. The labels are `LEAD_FACT_LABELS`, so a coach reads the
 * same four words here and on the Leads table.
 */
function leadFacts(conversation: ConversationView) {
  const outcome = conversation.qualification.outcome;
  const outcomeLabel = outcome === "BOOK"
    ? "Qualified"
    : outcome === "HARD_DQ"
      ? "Not a fit"
      : outcome === "SOFT_DQ"
        ? "Still deciding"
        : null;
  return [
    { key: "goal", label: LEAD_FACT_LABELS.goal, value: conversation.qualification.goal, mono: false },
    { key: "timeline", label: LEAD_FACT_LABELS.timeline, value: conversation.qualification.timeline, mono: false },
    { key: "credit", label: LEAD_FACT_LABELS.credit, value: conversation.qualification.credit, mono: true },
    { key: "outcome", label: LEAD_FACT_LABELS.outcome, value: outcomeLabel, mono: false },
  ] as const;
}

export function CoachInbox({
  initialConversations,
  filteredConversationIds,
  enabled = true,
  fixtureMode = false,
  impersonation = null,
  viewerId = null,
  nowIso = null,
}: CoachInboxProps) {
  const { account } = useWorkspaceEnv();
  const coachName = account?.firstName?.trim() || "you";

  const [persisted, setPersisted] = useState(initialConversations);
  const [segment, setSegment] = useState<"needs-you" | "all">(
    () => initialConversations.some((row) => row.status === "needs_human") ? "needs-you" : "all",
  );
  const [search, setSearch] = useState("");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditReceipt | null>(null);

  const conversations = useMemo(
    () => persisted.map((row) => deriveConversationView(row)),
    [persisted],
  );

  const serverIds = filteredConversationIds ? new Set(filteredConversationIds) : null;
  const query = search.trim().toLocaleLowerCase();
  const needsYou = conversations.filter((row) => row.status === "needs_human").length;

  const visible = conversations.filter((conversation) => {
    if (serverIds && !serverIds.has(conversation.id)) return false;
    if (segment === "needs-you" && conversation.status !== "needs_human") return false;
    if (!query) return true;
    const haystack = [
      conversation.contactName,
      CHANNEL_LABELS[conversation.channel],
      STATUS_READOUTS[conversation.status].label,
      latestBody(conversation) ?? "",
    ].join(" ").toLocaleLowerCase();
    return haystack.includes(query);
  });

  const selected = visible.find((row) => row.id === chosenId) ?? visible[0] ?? null;
  const readOnly = impersonation !== null;
  // Held by a person is not held by me: another coach's takeover offers Take over, never Reply.
  const heldByViewer = selected !== null && selected.isHuman
    && (fixtureMode
      ? selected.takenOverBy === "fixture-coach"
      : viewerId !== null && selected.takenOverBy === viewerId);
  const handoff = selected ? handoffFor(selected.statusReason) : null;
  const threadStart = selected?.messages[0]?.createdAt ?? selected?.lastActivityAt;

  async function mutate(kind: "claim" | "release" | "message", body?: string) {
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
                direction: "out",
                author: "human:fixture-coach",
                body: body?.trim() ?? "",
                createdAt: now,
                delivered: false,
              }],
            };
      setPersisted((rows) => rows.map((row) => row.id === original.id ? next : row));
      setFeedback("Demo-only change. No live tenant record was written.");
      setAudit(null);
      if (kind === "message") setDraft("");
      return;
    }

    setBusy(true);
    setFeedback(null);
    setAudit(null);
    try {
      const path = kind === "message" ? "messages" : kind;
      const payloadBody = kind === "claim"
        ? { expectedState: original.status, expectedHolderId: original.takenOverBy, confirmDisplace: false }
        : kind === "release"
          ? { expectedHolderId: original.takenOverBy }
          : { kind: "reply", body: body?.trim() ?? "", expectedState: "human" };
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(original.id)}/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadBody),
        },
      );
      const payload: unknown = await response.json();
      const readBack = readMutationResponse(payload);
      if (!response.ok || !readBack) {
        const message = payload && typeof payload === "object"
          && typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : "The saved state could not be read back. Nothing changed here; retry when ready.";
        setFeedback(message);
        return;
      }
      setPersisted((rows) =>
        rows.map((row) => row.id === original.id ? readBack.conversation : row));
      setAudit(readBack.audit);
      if (kind === "message") setDraft("");
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
        lets the three panes scroll independently instead of the page scrolling under them. The
        negative margins undo `<main>`'s page padding, because the artboard runs the panes edge to
        edge under the pill bar.
      */}
      <div
        className="relative @container/inbox -mx-[var(--s-4)] -my-[var(--s-6)] flex min-h-0 flex-1 flex-col overflow-hidden sm:-mx-[var(--s-6)] xl:-mx-[var(--page-x)]"
        data-layout="fixed"
        data-slot="coach-inbox"
      >
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden @3xl/inbox:grid-cols-[380px_minmax(0,1fr)] @6xl/inbox:grid-cols-[380px_minmax(0,1fr)_360px]">
          {/* ------------------------------------------------------------------- list */}
          <section
            aria-label="Conversations"
            className="flex min-h-0 min-w-0 flex-col border-r border-[var(--line)] bg-[var(--well)]"
          >
            <div className="shrink-0 px-[24px] pt-[24px] pb-[16px]">
              <h1 className="m-0 text-[32px] leading-[1.1] font-semibold tracking-[-0.025em] text-[color:var(--ink)]">
                Inbox
              </h1>
              {/*
                A stateful two-way switch, so it is buttons rather than the `Seg` primitive: `Seg`
                renders spans and links for a control whose state lives in the URL, and this one
                filters a list that is already in memory.
              */}
              <div
                aria-label="Which threads"
                className="mt-[14px] flex rounded-[10px] border border-[var(--line-input)] bg-[var(--card)] p-[3px]"
                role="group"
              >
                {([
                  { key: "needs-you" as const, label: "Needs you", count: needsYou },
                  { key: "all" as const, label: "All", count: null },
                ]).map((option) => (
                  <button
                    aria-pressed={segment === option.key}
                    className={[
                      "flex h-[44px] flex-1 items-center justify-center gap-[8px] rounded-[8px] px-[16px] text-[15px]",
                      segment === option.key
                        ? "bg-[var(--accent-wash-strong)] font-medium text-[color:var(--accent-text)]"
                        : "text-[color:var(--muted)]",
                    ].join(" ")}
                    key={option.key}
                    onClick={() => setSegment(option.key)}
                    type="button"
                  >
                    {option.label}
                    {option.count !== null ? (
                      <span className={`${MONO_CLASS} text-[14px] text-[color:var(--warning-text)]`}>
                        {option.count}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
              <div className="mt-[12px] flex h-[44px] items-center gap-[10px] rounded-[10px] border border-[var(--line-input)] bg-[var(--card)] px-[14px]">
                <svg
                  aria-hidden
                  className="size-[16px] shrink-0 text-[color:var(--faint)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  aria-label="Search leads"
                  className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-[color:var(--ink)] outline-none placeholder:text-[color:var(--faint)]"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search leads"
                  type="search"
                  value={search}
                />
              </div>
            </div>

            <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
              {visible.map((conversation) => {
                const readout = STATUS_READOUTS[conversation.status];
                const active = selected?.id === conversation.id;
                const wait = elapsedLabel(conversation.lastActivityAt, nowIso);
                const booked = conversation.appointment
                  ? appointmentLabel(conversation.appointment.startAt)
                  : null;
                return (
                  <li key={conversation.id}>
                    <button
                      aria-current={active ? "true" : undefined}
                      className={[
                        "flex w-full gap-[14px] py-[16px] text-left",
                        active
                          ? "border-l-[3px] border-l-[var(--accent)] bg-[var(--accent-wash)] pr-[24px] pl-[21px]"
                          : "border-b border-b-[var(--line-soft)] px-[24px]",
                        conversation.status === "closed" || conversation.status === "opted_out"
                          ? "opacity-75"
                          : "",
                      ].join(" ")}
                      onClick={() => setChosenId(conversation.id)}
                      type="button"
                    >
                      <span className={`${AVATAR_CLASS} size-[44px] text-[14px]`}>
                        {initials(conversation.contactName)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-baseline gap-[8px]">
                          <span className="min-w-0 truncate text-[17px] font-semibold text-[color:var(--ink)]">
                            {conversation.contactName}
                          </span>
                          <span className={`ml-auto shrink-0 ${MONO_CLASS} text-[14px] text-[color:var(--faint)]`}>
                            {wait ?? "—"}
                          </span>
                        </span>
                        <span className="mt-[2px] truncate text-[15px] text-[color:var(--muted)]">
                          {booked
                            ? `Booked · ${booked}`
                            : latestBody(conversation) ?? "No messages yet"}
                        </span>
                        <span className="mt-[6px] flex items-center gap-[8px] text-[14px]">
                          <span className={`flex items-center gap-[6px] ${readout.text}`}>
                            <StatusDot tone={readout.tone} />
                            {readout.label}
                          </span>
                          <span className={`${MONO_CLASS} text-[color:var(--faint)]`}>
                            {CHANNEL_TAGS[conversation.channel]}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {visible.length === 0 ? (
                <li className="px-[24px] py-[24px] text-[15px] text-[color:var(--muted)]">
                  {query ? "No lead matches that search." : "Nothing is waiting on you."}
                </li>
              ) : null}
            </ul>
          </section>

          {/* ----------------------------------------------------------------- thread */}
          <section aria-label="Thread" className="flex min-h-0 min-w-0 flex-col">
            {selected ? (
              <>
                <header className="flex h-[72px] shrink-0 items-center gap-[14px] border-b border-[var(--line)] px-[28px]">
                  <div className="min-w-0">
                    <div className="truncate text-[18px] font-semibold text-[color:var(--ink)]">
                      {selected.contactName}
                    </div>
                    <div className="truncate text-[14px] text-[color:var(--faint)]">
                      {CHANNEL_LABELS[selected.channel]}
                      {dayLabel(threadStart) ? ` · ${dayLabel(threadStart)}` : ""}
                    </div>
                  </div>
                  <button
                    className={`ml-auto shrink-0 ${BUTTON_CLASS} border-transparent bg-[var(--ink)] text-[color:var(--card)]`}
                    disabled={busy || readOnly}
                    onClick={() => void mutate(heldByViewer ? "release" : "claim")}
                    type="button"
                  >
                    {heldByViewer ? "Hand back" : "Take over"}
                  </button>
                </header>

                <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto p-[28px]">
                  {dayLabel(threadStart) ? (
                    <div className={`self-center ${MONO_CLASS} text-[14px] text-[color:var(--faint)]`}>
                      {dayLabel(threadStart)}
                    </div>
                  ) : null}
                  {selected.messages.map((message) => {
                    if (message.direction === "system") {
                      return (
                        <div
                          className="max-w-[70%] self-center text-center text-[14px] text-[color:var(--faint)]"
                          key={message.id}
                        >
                          {message.body}
                        </div>
                      );
                    }
                    const outbound = message.direction === "out";
                    return (
                      <div
                        className={[
                          "max-w-[60%] px-[16px] py-[12px] text-[16px] leading-[1.45]",
                          outbound
                            ? "self-end rounded-[18px_18px_6px_18px] bg-[var(--ink)] text-[color:var(--card)]"
                            : "self-start rounded-[18px_18px_18px_6px] border border-[var(--line)] bg-[var(--card)] text-[color:var(--ink)]",
                        ].join(" ")}
                        key={message.id}
                      >
                        {message.body}
                      </div>
                    );
                  })}
                  {/*
                    The held line, and only where the agent has actually stopped. It names the
                    handoff rule the run recorded rather than a stock sentence about prices, so a
                    thread held for a tripwire does not claim it was held over a quote.
                  */}
                  {selected.status === "needs_human" || selected.status === "scope_blocked" ? (
                    <div
                      className="flex items-center gap-[10px] self-end text-[14px] text-[color:var(--warning-text)]"
                      data-slot="inbox-held"
                    >
                      <StatusDot tone="amber" />
                      Held. {handoff?.label ?? "No reason is recorded for this handoff"}, this one is yours.
                    </div>
                  ) : null}
                </div>

                {feedback ? (
                  <p
                    className="m-0 shrink-0 px-[28px] pb-[8px] text-[15px] text-[color:var(--muted)]"
                    role="status"
                  >
                    {feedback}
                  </p>
                ) : null}
                {audit ? (
                  <p
                    aria-label={audit.ariaLabel}
                    className="m-0 shrink-0 px-[28px] pb-[8px] text-[15px] font-medium text-[color:var(--good-text)]"
                    role="status"
                  >
                    {audit.label}
                  </p>
                ) : null}

                <form
                  className="flex shrink-0 items-start gap-[12px] border-t border-[var(--line)] px-[28px] pt-[16px] pb-[24px]"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (draft.trim()) void mutate("message", draft);
                  }}
                >
                  <textarea
                    aria-label={`Reply as ${coachName}`}
                    className="min-h-[52px] min-w-0 flex-1 resize-none rounded-[12px] border border-[var(--line-input)] bg-[var(--card)] px-[16px] py-[14px] text-[16px] text-[color:var(--ink)] outline-none placeholder:text-[color:var(--faint)] disabled:opacity-55"
                    disabled={!heldByViewer || readOnly || busy}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={
                      readOnly
                        ? "Replies are blocked in a read-only impersonated view"
                        : heldByViewer
                          ? `Reply as ${coachName}`
                          : "Take over to reply"
                    }
                    rows={1}
                    value={draft}
                  />
                  {/* Privileged send: it writes to the lead, so it keeps the Logged microcopy. */}
                  <div className="flex shrink-0 flex-col items-center gap-[4px]">
                    <button
                      className={`${BUTTON_CLASS} border-transparent bg-[image:var(--accent-fill)] text-[color:var(--on-accent)]`}
                      disabled={!heldByViewer || readOnly || busy || !draft.trim()}
                      type="submit"
                    >
                      Send
                    </button>
                    <span className="text-[14px] text-[color:var(--faint)]">Logged</span>
                  </div>
                </form>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-[28px] text-[16px] text-[color:var(--muted)]">
                Pick a thread on the left.
              </div>
            )}
          </section>

          {/* ------------------------------------------------------------------- lead */}
          <aside
            aria-label="Lead"
            className="hidden min-h-0 min-w-0 flex-col gap-[22px] overflow-y-auto border-l border-[var(--line)] bg-[var(--well)] p-[24px] @6xl/inbox:flex"
          >
            {selected ? (
              <>
                <div>
                  <span className={`${AVATAR_CLASS} size-[56px] text-[17px]`}>
                    {initials(selected.contactName)}
                  </span>
                  <div className="mt-[10px] text-[18px] font-semibold text-[color:var(--ink)]">
                    {selected.contactName}
                  </div>
                  <div className="text-[14px] text-[color:var(--faint)]">
                    {CHANNEL_LABELS[selected.channel]}
                  </div>
                  <div className="mt-[10px] flex flex-wrap gap-[8px]">
                    <Pill
                      className="rounded-[8px] px-[10px] py-[4px] text-[14px]"
                      tone={STATUS_READOUTS[selected.status].tone === "amber" ? "amber" : "neutral"}
                    >
                      <StatusDot tone={STATUS_READOUTS[selected.status].tone} />
                      <span data-slot="inbox-stage">{STATUS_READOUTS[selected.status].label}</span>
                    </Pill>
                  </div>
                </div>

                <div>
                  <h2 className="m-0 mb-[8px] text-[length:var(--coach-eyebrow)] leading-[1.4] font-medium text-[color:var(--muted)]">
                    What your agent learned
                  </h2>
                  <dl className="m-0 flex flex-col text-[15px]">
                    {leadFacts(selected).map((fact) => (
                      <div
                        className="flex items-baseline justify-between gap-[12px] border-b border-[var(--line-soft)] py-[10px]"
                        key={fact.key}
                      >
                        <dt className="text-[color:var(--faint)]">{fact.label}</dt>
                        <dd
                          className={[
                            "m-0 text-right",
                            fact.value
                              ? fact.mono
                                ? `${MONO_CLASS} text-[color:var(--ink)]`
                                : "text-[color:var(--ink)]"
                              : "text-[color:var(--faint)]",
                          ].join(" ")}
                        >
                          {fact.value ?? "not asked yet"}
                        </dd>
                      </div>
                    ))}
                    <div className="flex items-baseline justify-between gap-[12px] py-[10px]">
                      <dt className="text-[color:var(--faint)]">Call booked</dt>
                      <dd
                        className={[
                          "m-0 text-right",
                          selected.appointment
                            ? `${MONO_CLASS} text-[color:var(--ink)]`
                            : "text-[color:var(--faint)]",
                        ].join(" ")}
                      >
                        {selected.appointment
                          ? appointmentLabel(selected.appointment.startAt) ?? "not readable"
                          : "not yet"}
                      </dd>
                    </div>
                  </dl>
                </div>

                {/*
                  The two actions the artboard draws, and the honest state of both.

                  Neither is a write a coach can make from a conversation row today. There is no
                  create-appointment route under `src/app/api` at all, and `pipeline-stage` needs
                  the contact's current stage as `expectedStage`, which `listConversationSet` does
                  not return -- and a second query is not this component's to add. So they are
                  named and disabled rather than wired to something that would fail on click, with
                  a link to the board where the stage actually moves.
                */}
                <div className="mt-auto flex flex-col gap-[8px]">
                  <button className={`${BUTTON_CLASS} w-full`} disabled type="button">
                    Book a call
                  </button>
                  <button className={`${BUTTON_CLASS} w-full`} disabled type="button">
                    Move to Not a fit
                  </button>
                  <a
                    className="text-[14px] text-[color:var(--accent-text)] underline-offset-2 hover:underline"
                    href="/coach/pipelines"
                  >
                    Move this lead on the board
                  </a>
                </div>
              </>
            ) : null}
          </aside>
        </div>

        <ContextEye
          copy={
            "Every thread your agent is running, and the ones it has handed to you. Search reads "
            + "the lead's name, the channel, the thread's state and the most recent message on it; "
            + "earlier messages are not loaded here, so a phrase from further back in a thread "
            + "will not match. Taking over pauses the agent for this lead only, and the thread "
            + "shows you as the sender. Hand back any time."
          }
          screen="coach-inbox"
        />
      </div>
    </AppShell>
  );
}
