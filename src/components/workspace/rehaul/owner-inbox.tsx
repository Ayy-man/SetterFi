"use client";

/**
 * The owner Inbox, rehaul face.
 *
 * One continuous list and one detail pane. The list is the same three lanes the folded Inbox
 * already builds on the server -- client requests, system problems, lead handoffs -- and this file
 * adds no read of its own: every row comes out of `inboxLanes()` through `owner-inbox-rows.ts`
 * exactly as the live surface receives it.
 *
 * What the drawing asks for that the platform cannot say, and what stands in its place:
 *
 * - A lane is a header and its rows, never a band with a box under it. A lane with nothing in it
 *   collapses to the header alone, because an empty framed area reads as a thing that failed to
 *   load rather than as a queue that is clear.
 * - Amber is spent on lateness and nothing else. Only a notice carries a recorded response target
 *   (`breach_at` per rule), so only a notice can be late; see `InboxRow.overSla`.
 * - A lead handoff has no detail to open. The cross-tenant projection refuses lead identity and
 *   message bodies on purpose, and the claim route only ever acts on the caller's own tenant, so
 *   that pane carries the account, the channel and the wait, and no action.
 * - Reassign stays in the request sheet. The owner change is a confirm flow with a reason and an
 *   audit read-back that `SupportRequestSheet` already owns; a second copy of it in this pane
 *   would be a second chance to get that wrong.
 * - Every explainer sentence the old surface printed under a heading is gone from the page; the
 *   two that a reader still needs are handed to the eye, which is docked in the header row so it
 *   cannot sit on the pane's action row.
 */

import { CircleCheck, Search, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ExportMenu } from "@/components/kit/export-menu";
import { KitButton } from "@/components/kit/atomics";
import { SupportRequestSheet } from "@/components/workspace/live/admin-support";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { Pill, StatusDot } from "@/components/workspace/rehaul/_primitives";
import {
  INBOX_LANE_TITLES,
  inboxRowMatches,
  inboxRows,
  type InboxLaneKey,
  type InboxRow,
} from "@/components/workspace/rehaul/owner-inbox-rows";
import { displayName } from "@/lib/format/display-name";
import {
  workspaceCountFormat,
  workspaceDateTimeFormat,
  workspaceTimestampFormat,
} from "@/lib/format/datetime";
import type { AttentionItem, AttentionQueue } from "@/lib/operations/attention-queue";
import { formatElapsed } from "@/lib/operations/attention-queue-format";
import type { PlatformSupportMessageRead, PlatformSupportThreadRead } from "@/lib/repositories/support";
import {
  INBOX_NO_CLAIM_REASON,
  INBOX_RANKED_BY,
  type InboxHandoffRow,
  type InboxLanes,
} from "@/components/workspace/live/inbox-lanes";

export type OwnerInboxProps = {
  actorId: string;
  lanes: InboxLanes;
  queue: AttentionQueue;
};

type Scope = "mine" | "all";
type MessageKind = "reply" | "internal_note";

const LANE_ORDER: readonly InboxLaneKey[] = ["client", "system", "handoff"];

const SUPPORT_STATE: Record<PlatformSupportThreadRead["status"], string> = {
  open: "Open",
  resolved: "Resolved",
  waiting_on_coach: "Waiting on coach",
};

function wait(minutes: number | null) {
  return minutes === null ? "not recorded" : formatElapsed(minutes);
}

function timestamp(iso: string | null) {
  return iso ? workspaceTimestampFormat.format(new Date(iso)) : "not recorded";
}

function shortTimestamp(iso: string | null) {
  return iso ? workspaceDateTimeFormat.format(new Date(iso)) : "not recorded";
}

function assignee(thread: PlatformSupportThreadRead) {
  const named = displayName(thread.assignedTo?.name?.trim() ?? "");
  return named || (thread.assignedTo ? "Assigned team member" : "Unassigned");
}

function ownerName(thread: PlatformSupportThreadRead) {
  const named = displayName(thread.successOwner?.name?.trim() ?? "");
  return named || (thread.successOwner ? "Named owner" : "Unassigned");
}

/** Two letters off a person's name, for the avatar the thread draws beside each message. */
function initials(name: string) {
  const parts = name.split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  return `${parts[0][0] ?? ""}${parts.length > 1 ? parts[parts.length - 1][0] ?? "" : ""}`.toUpperCase();
}

export function OwnerInbox({ actorId, lanes, queue }: OwnerInboxProps) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();

  const [clientRequests, setClientRequests] = useState<readonly PlatformSupportThreadRead[]>(
    lanes.clientRequests ?? [],
  );
  const [sheetThreadId, setSheetThreadId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const scope: Scope = params.get("scope") === "all" ? "all" : "mine";

  const allRows = useMemo(
    () => inboxRows(
      { ...lanes, clientRequests: lanes.clientRequests === undefined ? undefined : clientRequests },
      queue,
      actorId,
    ),
    [actorId, clientRequests, lanes, queue],
  );
  const scopeRows = useMemo(
    () => (scope === "mine" ? allRows.filter((row) => row.mine) : allRows),
    [allRows, scope],
  );
  const rows = useMemo(
    () => scopeRows.filter((row) => inboxRowMatches(row, search)),
    [scopeRows, search],
  );

  const selectedKey = params.get("item");
  // An empty `item` is an explicit "nothing open", so the close control has somewhere to land: a
  // missing parameter falls back to the first row, and clearing it would only re-open that row.
  const selected = selectedKey === ""
    ? null
    : rows.find((row) => row.key === selectedKey) ?? rows[0] ?? null;

  /** Selection is a URL fact, so a reader can hand somebody the row they are looking at. */
  function select(item: string) {
    const query = new URLSearchParams(params.toString());
    query.set("item", item);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  }

  function scopeHref(next: Scope) {
    const query = new URLSearchParams(params.toString());
    query.set("scope", next);
    query.delete("item");
    return `${pathname}?${query.toString()}`;
  }

  function onThreadChange(thread: PlatformSupportThreadRead) {
    setClientRequests((current) => current.map((row) => (row.id === thread.id ? thread : row)));
  }

  const longest = lanes.longestWait;
  const clear = scopeRows.length === 0;
  const anyDemo = allRows.some((row) => row.demo);
  const exportRows = rows.map((row) => ({
    lane: INBOX_LANE_TITLES[row.lane],
    title: row.title,
    context: row.context,
    waited_minutes: row.waitMinutes ?? "",
  }));

  const summary = clear
    ? "Nothing is waiting on a person"
    : [
        `${workspaceCountFormat.format(scopeRows.length)} waiting on a person`,
        longest === null ? null : `longest wait ${formatElapsed(longest.minutes)}`,
      ].filter(Boolean).join(" · ");

  return (
    <div className="relative flex min-h-0 flex-col gap-[16px]">
      <div className="flex items-start justify-between gap-[16px]">
        <div>
          <h1 className="m-0 text-[26px] leading-[1.15] font-[600] tracking-[-0.01em] text-[color:var(--ink)]">
            Inbox
          </h1>
          <p className="mt-[4px] mb-0 text-[13px] text-[color:var(--muted)]">{summary}</p>
        </div>
        <div className="flex items-center gap-[10px]">
          {/*
            * One pill for the whole screen rather than a marker per row. The seeders staple
            * "(demo)" onto every name they write and `display-name.ts` strips it here, so this
            * pill is the only thing on the page saying the data is seeded.
            */}
          {anyDemo ? <Pill>Demo data</Pill> : null}
          <ScopeSwitch mineHref={scopeHref("mine")} scope={scope} allHref={scopeHref("all")} />
          <ExportMenu filename="owner-inbox" mode="local" rows={exportRows} />
          <ContextEye
            copy={`${INBOX_RANKED_BY} ${INBOX_NO_CLAIM_REASON}`}
            placement="header"
            screen="owner-inbox"
          />
        </div>
      </div>

      <div
        className={[
          "grid min-h-0 flex-1 grid-cols-1 gap-[16px]",
          clear ? "" : "xl:grid-cols-[minmax(0,1fr)_420px]",
        ].join(" ")}
      >
        <div className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)] shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-[10px] border-b border-[var(--line)] px-[14px] py-[8px]">
            <label className="flex h-[30px] flex-1 items-center gap-[8px] rounded-lg border border-[var(--line-input)] bg-[var(--well)] px-[10px]">
              <Search aria-hidden="true" className="size-[14px] shrink-0 text-[color:var(--faint)]" strokeWidth={1.75} />
              <span className="sr-only">Search people, clients or subjects</span>
              <input
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[color:var(--ink)] outline-none placeholder:text-[color:var(--faint)]"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search people, clients or subjects"
                type="search"
                value={search}
              />
            </label>
          </div>

          {clear ? (
            <ClearPanel
              asOf={queue.asOf}
              cleared={queue.summary.clearedInWindow}
              lanes={lanes}
            />
          ) : rows.length === 0 ? (
            <p className="m-0 px-[14px] py-[28px] text-center text-[13px] text-[color:var(--muted)]">
              No row matches that search.
            </p>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto pb-[8px]">
              {LANE_ORDER.map((lane, index) => {
                if (lane === "client" && lanes.clientRequests === undefined) return null;
                const laneRows = rows.filter((row) => row.lane === lane);
                const unavailable = lane === "handoff" && lanes.handoff.state === "unavailable";
                return (
                  <div key={lane}>
                    <LaneHeader
                      count={unavailable ? "not counted" : workspaceCountFormat.format(laneRows.length)}
                      first={index === (lanes.clientRequests === undefined ? 1 : 0)}
                      note={unavailable
                        ? lanes.handoff.state === "unavailable" ? lanes.handoff.reason : null
                        : laneRows.length === 0 ? "none open" : null}
                      title={INBOX_LANE_TITLES[lane]}
                    />
                    {laneRows.length === 0 ? null : (
                      <ul className="m-0 list-none p-0">
                        {laneRows.map((row, rowIndex) => (
                          <li
                            className={[
                              "px-[6px]",
                              rowIndex === laneRows.length - 1 || selected?.key === row.key
                                ? ""
                                : "border-b border-[var(--line-soft)]",
                            ].join(" ")}
                            key={row.key}
                          >
                            <LaneRow
                              onSelect={() => select(row.key)}
                              row={row}
                              selected={selected?.key === row.key}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {clear || selected === null ? null : selected.lane === "client" ? (
          <RequestDetail
            actorId={actorId}
            key={selected.key}
            onClose={() => select("")}
            onOpenSheet={() => setSheetThreadId(selected.key.slice("client:".length))}
            onThreadChange={onThreadChange}
            row={selected}
            thread={clientRequests.find((thread) => `client:${thread.id}` === selected.key) ?? null}
          />
        ) : selected.lane === "system" ? (
          <NoticeDetail
            item={lanes.system.find((item) => `system:${item.id}` === selected.key) ?? null}
            key={selected.key}
            onClose={() => select("")}
            row={selected}
          />
        ) : (
          <HandoffDetail
            handoff={
              lanes.handoff.state === "available"
                ? lanes.handoff.rows.find((row) => `handoff:${row.conversationId}` === selected.key) ?? null
                : null
            }
            key={selected.key}
            onClose={() => select("")}
            row={selected}
          />
        )}
      </div>

      <SupportRequestSheet
        actorId={actorId}
        actorRole="admin"
        onOpenChange={(open) => { if (!open) setSheetThreadId(null); }}
        onThreadChange={onThreadChange}
        selected={clientRequests.find((thread) => thread.id === sheetThreadId) ?? null}
        threads={clientRequests}
      />
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * The list
 * ------------------------------------------------------------------------------------------ */

/** The scope switch. A local segmented control rather than `Seg`, because both cells are links. */
function ScopeSwitch({ allHref, mineHref, scope }: { allHref: string; mineHref: string; scope: Scope }) {
  const cell = "inline-flex items-center rounded-md px-2.5 py-[5px] text-[12.5px]";
  const on = "bg-[var(--accent-wash-strong)] font-medium text-[color:var(--accent-text)]";
  return (
    <div
      aria-label="Which rows this Inbox covers"
      className="inline-flex rounded-lg border border-[var(--line-input)] bg-[var(--card)] p-0.5"
      role="group"
    >
      <Link
        aria-current={scope === "mine" ? "true" : undefined}
        className={[cell, scope === "mine" ? on : "text-[color:var(--muted)]", "no-underline hover:no-underline"].join(" ")}
        href={mineHref}
      >
        Assigned to me
      </Link>
      <Link
        aria-current={scope === "all" ? "true" : undefined}
        className={[cell, scope === "all" ? on : "text-[color:var(--muted)]", "no-underline hover:no-underline"].join(" ")}
        href={allHref}
      >
        All
      </Link>
    </div>
  );
}

/**
 * A lane header, and the whole of a lane that has nothing in it.
 *
 * The count is mono so the three lanes' figures line up under each other, and the trailing note is
 * where an empty lane says "none open" and an unreadable one says why. Neither case draws a body:
 * an empty framed area under a header reads as a failed load.
 */
function LaneHeader({
  count,
  first,
  note,
  title,
}: { count: string; first: boolean; note: string | null; title: string }) {
  return (
    <div
      className={[
        "flex items-baseline gap-[8px] px-[14px]",
        first ? "pt-[12px]" : "mt-[8px] border-t border-[var(--line)] pt-[16px]",
        // A lane with no rows under it owns the space a list would have taken, so the header does
        // not read as a heading whose content failed to arrive.
        note === null ? "pb-[4px]" : "pb-[14px]",
      ].join(" ")}
      data-slot="inbox-lane-header"
    >
      <span className="text-[11px] font-[500] tracking-[0.08em] text-[color:var(--faint)] uppercase">
        {title}
      </span>
      <span className="font-mono text-[11.5px] tabular-nums text-[color:var(--faint)]">{count}</span>
      {note === null ? null : (
        <span className="min-w-0 text-[12.5px] text-[color:var(--faint)]">{note}</span>
      )}
    </div>
  );
}

/**
 * One row: a state dot, two lines of text, one relative time.
 *
 * Selection is an accent wash inside a full accent hairline rather than a thick left edge. A
 * side stripe reads as a nesting level on a list that already has lane headers doing that job.
 */
function LaneRow({ onSelect, row, selected }: { onSelect: () => void; row: InboxRow; selected: boolean }) {
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className={[
        "flex w-full cursor-pointer items-center gap-[12px] rounded-[10px] border px-[14px] py-[10px] text-left",
        selected
          ? "border-[var(--accent-edge)] bg-[var(--accent-wash)]"
          : "border-transparent",
      ].join(" ")}
      data-lane={row.lane}
      data-slot="inbox-row"
      onClick={onSelect}
      type="button"
    >
      <StatusDot tone={row.overSla ? "amber" : "wait"} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-[500] text-[color:var(--ink)]">{row.title}</span>
        <span className="block truncate text-[12.5px] text-[color:var(--muted)]">{row.context}</span>
      </span>
      <span
        className={[
          "shrink-0 font-mono text-[12px] tabular-nums",
          row.overSla ? "text-[color:var(--warning-text)]" : "text-[color:var(--faint)]",
        ].join(" ")}
      >
        {wait(row.waitMinutes)}
      </span>
    </button>
  );
}

/**
 * The whole-Inbox empty state: the three lane counts on one strip, then one panel.
 *
 * The panel says when the Inbox was read rather than "you're all caught up", because the only
 * thing the page can honestly claim is the instant its queue was sampled at.
 */
function ClearPanel({ asOf, cleared, lanes }: { asOf: string; cleared: number; lanes: InboxLanes }) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3">
        {LANE_ORDER.map((lane) => {
          if (lane === "client" && lanes.clientRequests === undefined) return null;
          return (
            <div
              className="flex items-baseline gap-[8px] px-[16px] py-[14px] sm:[&:not(:last-child)]:border-r sm:[&:not(:last-child)]:border-[var(--line-soft)]"
              data-slot="inbox-lane-header"
              key={lane}
            >
              <span className="text-[11px] font-[500] tracking-[0.08em] text-[color:var(--faint)] uppercase">
                {INBOX_LANE_TITLES[lane]}
              </span>
              <span className="font-mono text-[11.5px] tabular-nums text-[color:var(--faint)]">
                {lane === "handoff" && lanes.handoff.state === "unavailable" ? "not counted" : "0"}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-col items-center gap-[10px] border-t border-[var(--line)] px-[24px] pt-[56px] pb-[60px] text-center">
        <CircleCheck aria-hidden="true" className="size-7 text-[color:var(--good)]" strokeWidth={1.5} />
        <div className="text-[14px] font-[500] text-[color:var(--ink)]">
          Clear as of {shortTimestamp(asOf)}
        </div>
        <p className="m-0 max-w-[var(--measure-tight)] text-[13px] text-[color:var(--muted)]">
          Nothing in the three lanes is waiting on a person. {workspaceCountFormat.format(cleared)} notices
          were cleared in the last week.
        </p>
      </div>
    </>
  );
}

/* --------------------------------------------------------------------------------------------
 * The detail pane
 * ------------------------------------------------------------------------------------------ */

function DetailShell({
  children,
  footer,
  onClose,
  pills,
  title,
}: {
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  pills: ReactNode;
  title: string;
}) {
  return (
    <aside
      className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)] shadow-[var(--shadow-card)]"
      data-slot="inbox-detail"
    >
      <div className="border-b border-[var(--line)] px-[18px] pt-[16px] pb-[14px]">
        <div className="flex items-start justify-between gap-[12px]">
          <h2 className="m-0 text-[15px] leading-[1.3] font-[600] text-[color:var(--ink)]">{title}</h2>
          <button
            aria-label="Close this request"
            className="mt-[2px] shrink-0 cursor-pointer text-[color:var(--faint)] hover:text-[color:var(--ink)]"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-[14px]" strokeWidth={1.75} />
          </button>
        </div>
        <div className="mt-[10px] flex flex-wrap gap-[6px]">{pills}</div>
      </div>
      {children}
      {footer}
    </aside>
  );
}

/**
 * The pane's footer: who opened the record, and the identifiers a support conversation needs.
 *
 * Collapsed, because an id is what a reader reaches for once a week and the row above it is what
 * they read every time. `<details>` rather than state: the disclosure is the browser's.
 */
function TechnicalDetail({
  created,
  rows,
}: { created: string; rows: readonly { label: string; value: string }[] }) {
  return (
    <details className="border-t border-[var(--line-soft)] px-[18px] py-[8px]" data-slot="inbox-technical">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-[8px] [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-[11px] text-[color:var(--overline)]">{created}</span>
        <span className="text-[11.5px] text-[color:var(--faint)]">Technical detail</span>
      </summary>
      <dl className="m-0 mt-[8px] grid grid-cols-[auto_1fr] gap-x-[12px] gap-y-[4px] text-[12px]">
        {rows.map((row) => (
          <div className="contents" key={row.label}>
            <dt className="text-[color:var(--meta)]">{row.label}</dt>
            <dd className="m-0 truncate font-mono text-[color:var(--ink)]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function FactList({ rows }: { rows: readonly { label: string; value: string }[] }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-[16px] gap-y-[6px] text-[13px]">
      {rows.map((row) => (
        <div className="contents" key={row.label}>
          <dt className="text-[color:var(--meta)]">{row.label}</dt>
          <dd className="m-0 text-[color:var(--ink)]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Avatar({ mine, name }: { mine: boolean; name: string }) {
  return (
    <span
      aria-hidden="true"
      className={[
        "inline-flex size-[26px] shrink-0 items-center justify-center rounded-full border text-[10.5px] font-[600]",
        mine
          ? "border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] text-[color:var(--accent-text)]"
          : "border-[var(--line-strong)] bg-[var(--raised)] text-[color:var(--muted)]",
      ].join(" ")}
    >
      {initials(name)}
    </span>
  );
}

/**
 * One message in the thread.
 *
 * An internal note is drawn as a dashed rule with its own label rather than as another bubble,
 * because the one thing a reader must never get wrong here is which lines the coach can see. It
 * also stays flat on the card, with no lifted ground and no shadow, so the visual weight itself
 * says the note is not part of the conversation the coach reads.
 */
function ThreadMessage({ actorId, message }: { actorId: string; message: PlatformSupportMessageRead }) {
  const name = displayName(message.authorName?.trim() ?? "") || "Author not recorded";
  const mine = message.authorId === actorId;

  if (message.internal) {
    return (
      <div className="flex flex-col gap-[8px]" data-slot="inbox-internal-note">
        <div className="flex items-center gap-[10px] py-[6px]">
          <span aria-hidden="true" className="h-px flex-1 bg-[var(--line-soft)]" />
          <span className="text-[11.5px] text-[color:var(--faint)]">
            Internal note · {shortTimestamp(message.createdAt)}
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-[var(--line-soft)]" />
        </div>
        <div className="rounded-lg border border-dashed border-[var(--line)] px-[12px] py-[8px] text-[12.5px] text-[color:var(--muted)]">
          {displayName(message.body)}
        </div>
      </div>
    );
  }

  return (
    <div className={["flex gap-[10px]", mine ? "flex-row-reverse" : ""].join(" ")}>
      <Avatar mine={mine} name={mine ? "You" : name} />
      <div className={["min-w-0", mine ? "text-right" : ""].join(" ")}>
        <div className={["flex items-baseline gap-[8px]", mine ? "justify-end" : ""].join(" ")}>
          <span className="text-[12.5px] font-[500] text-[color:var(--ink)]">{mine ? "You" : name}</span>
          <span className="font-mono text-[11px] text-[color:var(--faint)]">
            {shortTimestamp(message.createdAt)}
          </span>
        </div>
        {/*
          The bubble surfaces.

          These used to sit on --well, which is the recessed ground: it is a step down from --card
          in the light palette and only a hair above it in the dark one, so the bubble was painted
          at very nearly the value of the pane it sits on and the thread read as loose text inside
          faint rectangles. --raised is the only surface token that sits above --card in both
          palettes, 0.9975 against 0.9905 in light and 0.2196 against 0.1802 in dark, so it is the
          one value that lifts the bubble whichever theme the reader has on. The hairline moves
          with it to --line-strong and the bubble picks up --shadow-card, the page's own material
          rather than a popover shadow, because the lift only reads as a surface when the edge and
          the shadow agree with the ground.

          The reader's own messages keep the accent instead of the neutral lift, at
          --accent-wash-strong rather than --accent-wash so the tint survives sitting on a lifted
          card, which is what makes the two sides read as a conversation with a speaker on each
          side rather than as two grey boxes in a column. The asymmetric corner stays: the square
          corner points at the avatar, so a reader can tell who is talking before reading a word.

          The body text moves from --body to --ink and from the 13px body role to the 15px read
          role, which is what the shared transcript already uses for a message. A message is text
          someone reads rather than a label they scan, and the two chat surfaces in the console
          should not disagree about that.
        */}
        <div
          className={[
            "mt-[4px] px-[12px] py-[10px] text-left text-[15px] leading-[1.55] text-[color:var(--ink)] shadow-[var(--shadow-card)]",
            mine
              ? "rounded-[12px_12px_4px_12px] border border-[var(--accent-edge)] bg-[var(--accent-wash-strong)]"
              : "rounded-[12px_12px_12px_4px] border border-[var(--line-strong)] bg-[var(--raised)]",
          ].join(" ")}
          data-mine={mine ? "true" : "false"}
          data-slot="inbox-bubble"
        >
          {displayName(message.body)}
        </div>
      </div>
    </div>
  );
}

/**
 * The client-request pane.
 *
 * The composer writes through the same thread endpoint the request sheet uses, with the same
 * `kind` the sheet sends, so a reply typed here and a reply typed there are one write with one
 * audit trail. Reassign hands off to the sheet, which owns the confirm flow and the read-back.
 * Resolve is the thread lifecycle endpoint, which takes a reason and returns an audit id, so it
 * asks for the reason here before it sends anything.
 */
function RequestDetail({
  actorId,
  onClose,
  onOpenSheet,
  onThreadChange,
  row,
  thread,
}: {
  actorId: string;
  onClose: () => void;
  onOpenSheet: () => void;
  onThreadChange: (thread: PlatformSupportThreadRead) => void;
  row: InboxRow;
  thread: PlatformSupportThreadRead | null;
}) {
  const [tab, setTab] = useState<"request" | "owner">("request");
  const [kind, setKind] = useState<MessageKind>("reply");
  const [draft, setDraft] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending" | "failed">("idle");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [resolveState, setResolveState] = useState<"idle" | "sending" | "failed">("idle");

  async function send() {
    if (!thread || !draft.trim()) return;
    setSendState("sending");
    try {
      const response = await fetch(`/api/platform/support/threads/${thread.id}`, {
        body: JSON.stringify({ body: draft.trim(), kind }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const value = await response.json() as { thread?: PlatformSupportThreadRead };
      if (!response.ok || !value.thread) throw new Error("SUPPORT_WRITE_FAILED");
      onThreadChange(value.thread);
      setDraft("");
      setSendState("idle");
    } catch {
      setSendState("failed");
    }
  }

  async function resolve() {
    if (!thread || !reason.trim()) return;
    setResolveState("sending");
    try {
      const response = await fetch(`/api/platform/support/threads/${thread.id}`, {
        body: JSON.stringify({ kind: "status", reason: reason.trim(), status: "resolved" }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      if (!response.ok) throw new Error("REFUSED");
      onThreadChange({ ...thread, status: "resolved" });
      setConfirming(false);
      setResolveState("idle");
    } catch {
      setResolveState("failed");
    }
  }

  const state = thread ? SUPPORT_STATE[thread.status] : "Open";
  const waiting = thread?.status === "waiting_on_coach";

  return (
    <DetailShell
      footer={
        <TechnicalDetail
          created={`created ${shortTimestamp(thread?.createdAt ?? null)} · ${
            displayName(thread?.messages.at(0)?.authorName?.trim() ?? "") || "author not recorded"
          }`}
          rows={[
            { label: "Thread ID", value: thread?.id ?? "not recorded" },
            { label: "Client ID", value: thread?.tenantId ?? "not recorded" },
          ]}
        />
      }
      onClose={onClose}
      pills={
        <>
          <Pill tone={waiting ? "amber" : "neutral"}>
            {waiting ? <StatusDot tone="amber" /> : null}
            {state}
          </Pill>
          <Pill>{displayName(thread?.tenantName ?? row.context)}</Pill>
          <Pill>{thread ? assignee(thread) : "Unassigned"}</Pill>
        </>
      }
      title={row.title}
    >
      <div className="flex gap-[20px] border-b border-[var(--line)] px-[18px]" role="tablist">
        {([["request", "Request"], ["owner", "Success owner"]] as const).map(([id, label]) => (
          <button
            aria-selected={tab === id}
            className={[
              "-mb-px cursor-pointer border-b-2 pt-[8px] pb-[10px] text-[13px]",
              tab === id
                ? "border-[var(--accent-text)] text-[color:var(--ink)]"
                : "border-transparent text-[color:var(--muted)]",
            ].join(" ")}
            key={id}
            onClick={() => setTab(id)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "owner" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-auto px-[18px] py-[16px]">
          <FactList
            rows={[
              { label: "Account", value: displayName(thread?.tenantName ?? "not recorded") },
              { label: "Success owner", value: thread ? ownerName(thread) : "not recorded" },
              { label: "Assigned to", value: thread ? assignee(thread) : "not recorded" },
              { label: "Opened", value: timestamp(thread?.createdAt ?? null) },
              { label: "Waiting", value: wait(row.waitMinutes) },
            ]}
          />
          <div>
            <KitButton disabled={thread === null} onClick={onOpenSheet} size="md" variant="secondary">
              Reassign
            </KitButton>
          </div>
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-auto px-[18px] py-[16px]">
            {thread === null || thread.messages.length === 0 ? (
              <p className="m-0 text-[13px] text-[color:var(--muted)]">
                No message is recorded on this request.
              </p>
            ) : (
              thread.messages.map((message) => (
                <ThreadMessage actorId={actorId} key={message.id} message={message} />
              ))
            )}
          </div>

          <div className="flex flex-col gap-[8px] border-t border-[var(--line)] px-[18px] pt-[12px] pb-[14px]">
            {confirming ? (
              <div className="flex flex-col gap-[9px] rounded-[11px] border border-[var(--warning-line)] bg-[var(--warning-wash)] p-[12px]">
                <label className="block">
                  <span className="sr-only">Reason for resolving</span>
                  <input
                    className="h-[30px] w-full rounded-lg border border-[var(--line-input)] bg-[var(--control-fill)] px-[10px] text-[12.5px] text-[color:var(--ink)] placeholder:text-[color:var(--faint)]"
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Why now? This is written to the audit log."
                    value={reason}
                  />
                </label>
                <div className="flex items-center gap-[8px]">
                  <KitButton
                    disabled={!reason.trim() || resolveState === "sending"}
                    onClick={resolve}
                    size="md"
                    variant="primary"
                  >
                    {resolveState === "sending" ? "Resolving…" : "Resolve request"}
                  </KitButton>
                  <KitButton onClick={() => setConfirming(false)} size="md" variant="ghost">
                    Cancel
                  </KitButton>
                </div>
                {resolveState === "failed" ? (
                  <p className="m-0 text-[12px] text-[color:var(--failure-text)]">
                    The change was refused. Nothing was recorded.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div
              aria-label="What this message is"
              className="inline-flex self-start rounded-lg border border-[var(--line-input)] bg-[var(--well)] p-0.5"
              role="group"
            >
              {([["reply", "Reply to coach"], ["internal_note", "Internal note"]] as const).map(([id, label]) => (
                <button
                  aria-pressed={kind === id}
                  className={[
                    "cursor-pointer rounded-md px-2.5 py-[4px] text-[12.5px]",
                    kind === id
                      ? "bg-[var(--accent-wash-strong)] font-medium text-[color:var(--accent-text)]"
                      : "text-[color:var(--muted)]",
                  ].join(" ")}
                  key={id}
                  onClick={() => setKind(id)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>

            <label className="block">
              <span className="sr-only">
                {kind === "reply" ? "Write a reply to the coach" : "Write an internal note"}
              </span>
              <textarea
                className="min-h-[64px] w-full rounded-lg border border-[var(--line-input)] bg-[var(--well)] px-[10px] py-[8px] text-[13px] text-[color:var(--ink)] placeholder:text-[color:var(--faint)]"
                onChange={(event) => setDraft(event.target.value)}
                placeholder={kind === "reply" ? "Write a reply to the coach" : "Write an internal note"}
                value={draft}
              />
            </label>

            {sendState === "failed" ? (
              <p className="m-0 text-[12px] text-[color:var(--failure-text)]">
                The message was not saved. The thread is unchanged.
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-[8px]">
              <span className="text-[11.5px] text-[color:var(--faint)]">Logged to the audit trail</span>
              <div className="flex gap-[8px]">
                <KitButton
                  disabled={thread === null || thread.status === "resolved"}
                  onClick={() => setConfirming(true)}
                  size="md"
                  variant="ghost"
                >
                  Resolve
                </KitButton>
                <KitButton disabled={thread === null} onClick={onOpenSheet} size="md" variant="secondary">
                  Reassign
                </KitButton>
                <KitButton
                  disabled={thread === null || !draft.trim() || sendState === "sending"}
                  onClick={send}
                  size="md"
                  variant="primary"
                >
                  {kind === "reply" ? "Send reply" : "Save note"}
                </KitButton>
              </div>
            </div>
          </div>
        </>
      )}
    </DetailShell>
  );
}

/**
 * The system-problem pane. The only write this queue records is that somebody opened the notice,
 * so the action says "Mark read" and never "Resolve": reading a notice does not fix the thing it
 * is about.
 */
function NoticeDetail({
  item,
  onClose,
  row,
}: { item: AttentionItem | null; onClose: () => void; row: InboxRow }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">(
    item?.readAt ? "done" : "idle",
  );

  async function markRead() {
    if (!item) return;
    setState("sending");
    try {
      const response = await fetch("/api/notifications", {
        body: JSON.stringify({ notificationId: item.id }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      setState(response.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <DetailShell
      footer={
        <TechnicalDetail
          created={`recorded ${shortTimestamp(item?.createdAt ?? null)}`}
          rows={[
            { label: "Notice ID", value: item?.id ?? "not recorded" },
            { label: "Rule", value: item?.ruleName ?? item?.kind ?? "not recorded" },
          ]}
        />
      }
      onClose={onClose}
      pills={
        <>
          <Pill tone={row.overSla ? "amber" : "neutral"}>
            {row.overSla ? <StatusDot tone="amber" /> : null}
            {row.overSla ? "Past its response target" : `Open ${wait(row.waitMinutes)}`}
          </Pill>
          <Pill>{item?.tenantName ? displayName(item.tenantName) : "Platform"}</Pill>
          <Pill>{state === "done" ? "Read" : "Unread"}</Pill>
        </>
      }
      title={row.title}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-auto px-[18px] py-[16px]">
        <div className="rounded-[11px] border border-[var(--line-soft)] bg-[var(--well)] px-[14px] py-[12px] text-[13px] leading-[1.5] text-[color:var(--body)]">
          {displayName(item?.body ?? item?.ruleDescription ?? "No detail is recorded on this notice.")}
        </div>
        <FactList
          rows={[
            { label: "Account", value: item?.tenantName ? displayName(item.tenantName) : "Platform" },
            { label: "Recorded", value: timestamp(item?.createdAt ?? null) },
            { label: "Open for", value: wait(row.waitMinutes) },
          ]}
        />
      </div>

      <div className="flex items-center justify-between gap-[8px] border-t border-[var(--line)] px-[18px] pt-[12px] pb-[14px]">
        <span className="text-[11.5px] text-[color:var(--faint)]">Logged to the audit trail</span>
        <div className="flex gap-[8px]">
          {item?.link ? (
            <KitButton
              onClick={() => { window.location.href = item.link as string; }}
              size="md"
              variant="secondary"
            >
              Open
            </KitButton>
          ) : null}
          <KitButton
            disabled={item === null || state === "sending" || state === "done"}
            onClick={markRead}
            size="md"
            variant="primary"
          >
            {state === "done" ? "Marked read" : state === "failed" ? "Retry mark read" : "Mark read"}
          </KitButton>
        </div>
      </div>
    </DetailShell>
  );
}

/** The handoff pane: an account, a channel and a wait. There is nothing here a platform reader may act on. */
function HandoffDetail({
  handoff,
  onClose,
  row,
}: { handoff: InboxHandoffRow | null; onClose: () => void; row: InboxRow }) {
  return (
    <DetailShell
      footer={
        <TechnicalDetail
          created={`waiting ${wait(row.waitMinutes)}`}
          rows={[
            { label: "Conversation ID", value: handoff?.conversationId ?? "not recorded" },
            { label: "Client ID", value: handoff?.tenantId ?? "not recorded" },
          ]}
        />
      }
      onClose={onClose}
      pills={
        <>
          <Pill>Waiting {wait(row.waitMinutes)}</Pill>
          <Pill>{handoff?.channelLabel ?? "channel not recorded"}</Pill>
          <Pill>Not taken over</Pill>
        </>
      }
      title={row.title}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-auto px-[18px] py-[16px]">
        <div className="rounded-[11px] border border-[var(--line-soft)] bg-[var(--well)] px-[14px] py-[12px] text-[13px] leading-[1.5] text-[color:var(--body)]">
          {handoff?.handoff?.label ?? "No handoff reason is recorded."}
        </div>
        <FactList
          rows={[
            { label: "Account", value: displayName(handoff?.tenantName ?? row.title) },
            { label: "Channel", value: handoff?.channelLabel ?? "not recorded" },
            { label: "Waiting", value: wait(row.waitMinutes) },
          ]}
        />
      </div>
    </DetailShell>
  );
}
