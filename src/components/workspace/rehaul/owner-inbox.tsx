"use client";

/**
 * The owner Inbox, rehaul face.
 *
 * One card, three bands, one detail pane. The bands are the same three lanes the folded Inbox
 * already builds on the server -- client requests, system problems, lead handoffs -- and this
 * file adds no read of its own: every row here comes out of `inboxLanes()` exactly as the live
 * surface receives it.
 *
 * What the drawing asks for that the platform cannot say, and what stands in its place:
 *
 * - The detail grid is drawn as Calendar / Success owner / Tier. Nothing on a support thread
 *   carries a calendar provider or a price tier, so the grid shows the three the thread does
 *   record: the account, its success owner, and who the request is assigned to.
 * - A lead handoff has no detail to open. The cross-tenant projection refuses lead identity and
 *   message bodies on purpose, and the claim route only ever acts on the caller's own tenant, so
 *   that pane carries the account, the channel and the wait, and no action.
 * - Every explainer sentence the old surface printed under a heading is gone from the page; the
 *   two that a reader still needs are handed to the eye instead.
 */

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ExportMenu } from "@/components/kit/export-menu";
import { KitButton } from "@/components/kit/atomics";
import { SupportRequestSheet } from "@/components/workspace/live/admin-support";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { Figure, Pill, Seg, StatusDot } from "@/components/workspace/rehaul/_primitives";
import { workspaceCountFormat, workspaceTimestampFormat } from "@/lib/format/datetime";
import type { AttentionItem, AttentionQueue } from "@/lib/operations/attention-queue";
import { formatElapsed } from "@/lib/operations/attention-queue-format";
import type { PlatformSupportThreadRead } from "@/lib/repositories/support";
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
type LaneKey = "client" | "system" | "handoff";

type Row = {
  key: string;
  lane: LaneKey;
  title: string;
  context: string;
  /** Minutes waited, or null where nothing recorded one. */
  waitMinutes: number | null;
  /** True when this row is in the reader's own book. */
  mine: boolean;
  /** Amber when the row is the kind that should not be sitting there. */
  amber: boolean;
};

const LANE_TITLES: Record<LaneKey, string> = {
  client: "Client requests",
  system: "System problems",
  handoff: "Lead handoffs",
};

function wait(minutes: number | null) {
  return minutes === null ? "not recorded" : formatElapsed(minutes);
}

function timestamp(iso: string | null) {
  return iso ? workspaceTimestampFormat.format(new Date(iso)) : "not recorded";
}

function minutesBetween(fromIso: string, nowIso: string) {
  const from = new Date(fromIso).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - from) / 60_000));
}

function assignee(thread: PlatformSupportThreadRead) {
  return thread.assignedTo?.name?.trim() || (thread.assignedTo ? "Assigned team member" : "Unassigned");
}

function ownerName(thread: PlatformSupportThreadRead) {
  return thread.successOwner?.name?.trim() || (thread.successOwner ? "Named owner" : "Unassigned");
}

/**
 * Every visible row, in band order, already ranked by the server.
 *
 * `mine` is the only ownership each lane actually records: a support thread carries an assignee,
 * a notice carries the account's success owner, and a handoff carries neither, so a handoff is
 * never in anybody's book and the scope switch says so by leaving it out of "Assigned to me".
 */
function rowsFor(lanes: InboxLanes, queue: AttentionQueue, actorId: string): Row[] {
  const client = (lanes.clientRequests ?? [])
    .filter((thread) => thread.status !== "resolved")
    .map((thread) => ({
      key: `client:${thread.id}`,
      lane: "client" as const,
      title: thread.subject,
      context: `${thread.tenantName} · ${assignee(thread)}`,
      waitMinutes: minutesBetween(thread.updatedAt, queue.asOf),
      mine: thread.assignedTo?.id === actorId,
      amber: thread.status === "open",
    }));

  const system = lanes.system.map((item) => ({
    key: `system:${item.id}`,
    lane: "system" as const,
    title: item.title,
    context: [item.tenantName ?? "Platform", item.ruleDescription ?? item.body]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(" · "),
    waitMinutes: item.openForMinutes,
    mine: item.assignedToMe,
    amber: item.severity === "critical" || item.severity === "warning",
  }));

  const handoff = lanes.handoff.state === "available"
    ? lanes.handoff.rows.map((row) => ({
        key: `handoff:${row.conversationId}`,
        lane: "handoff" as const,
        title: row.tenantName,
        context: `${row.channelLabel} · ${row.handoff?.label ?? "No handoff reason recorded"}`,
        waitMinutes: row.waitMinutes,
        mine: false,
        amber: false,
      }))
    : [];

  return [...client, ...system, ...handoff];
}

export function OwnerInbox({ actorId, lanes, queue }: OwnerInboxProps) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();

  const [clientRequests, setClientRequests] = useState<readonly PlatformSupportThreadRead[]>(
    lanes.clientRequests ?? [],
  );
  const [sheetThreadId, setSheetThreadId] = useState<string | null>(null);
  const scope: Scope = params.get("scope") === "all" ? "all" : "mine";

  const allRows = useMemo(
    () => rowsFor({ ...lanes, clientRequests: lanes.clientRequests === undefined ? undefined : clientRequests }, queue, actorId),
    [actorId, clientRequests, lanes, queue],
  );
  const rows = useMemo(
    () => (scope === "mine" ? allRows.filter((row) => row.mine) : allRows),
    [allRows, scope],
  );
  const mineCount = useMemo(() => allRows.filter((row) => row.mine).length, [allRows]);

  const selectedKey = params.get("item");
  const selected = rows.find((row) => row.key === selectedKey) ?? rows[0] ?? null;

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

  const longest = lanes.longestWait;
  const exportRows = rows.map((row) => ({
    lane: LANE_TITLES[row.lane],
    title: row.title,
    context: row.context,
    waited_minutes: row.waitMinutes ?? "",
  }));

  return (
    <div className="relative flex min-h-0 flex-col gap-[16px]">
      <div className="flex items-end gap-[12px]">
        <h1 className="m-0 text-[30px] leading-[1.1] font-[600] tracking-[-0.02em] text-[color:var(--ink)]">
          Inbox
        </h1>
        <div className="ml-auto flex items-center gap-[8px]">
          <Seg
            items={[
              {
                active: scope === "mine",
                href: scopeHref("mine"),
                label: `Assigned to me · ${workspaceCountFormat.format(mineCount)}`,
              },
              {
                active: scope === "all",
                href: scopeHref("all"),
                label: `Everything · ${workspaceCountFormat.format(allRows.length)}`,
              },
            ]}
            label="Which rows this Inbox covers"
          />
          <ExportMenu filename="owner-inbox" mode="local" rows={exportRows} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-[16px] md:grid-cols-3">
        <Tile label="waiting on you" value={workspaceCountFormat.format(rows.length)} />
        <Tile
          label="longest wait"
          tone={longest === null ? undefined : "warning"}
          value={longest === null ? "none" : formatElapsed(longest.minutes)}
        />
        <Tile
          label="opened this week"
          value={workspaceCountFormat.format(queue.summary.clearedInWindow)}
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-[16px] xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] shadow-[var(--shadow-card)]">
          {(["client", "system", "handoff"] as const).map((lane) => {
            const laneRows = rows.filter((row) => row.lane === lane);
            if (lane === "client" && lanes.clientRequests === undefined) return null;
            return (
              <div key={lane}>
                <LaneBand
                  count={
                    lane === "handoff" && lanes.handoff.state === "unavailable"
                      ? "not counted"
                      : workspaceCountFormat.format(laneRows.length)
                  }
                  title={LANE_TITLES[lane]}
                />
                {lane === "handoff" && lanes.handoff.state === "unavailable" ? (
                  <p className="m-0 px-[16px] py-[12px] text-[12px] leading-[1.5] text-[color:var(--muted)]">
                    {lanes.handoff.reason}
                  </p>
                ) : null}
                <ul className="m-0 list-none p-0">
                  {laneRows.map((row) => (
                    <li key={row.key}>
                      <LaneRow
                        onSelect={() => select(row.key)}
                        row={row}
                        selected={selected?.key === row.key}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="flex min-h-0 flex-col gap-[14px] rounded-[14px] border border-[var(--line)] bg-[var(--card)] p-[18px_20px] shadow-[var(--shadow-card)]">
          {selected === null ? (
            <p className="m-0 text-[12.5px] leading-[1.5] text-[color:var(--muted)]">
              {scope === "mine" ? "Nothing here is assigned to you." : "Nothing is waiting on a person."}
            </p>
          ) : selected.lane === "client" ? (
            <ClientRequestDetail
              onOpenSheet={() => setSheetThreadId(selected.key.slice("client:".length))}
              onThreadChange={(thread) => setClientRequests((current) =>
                current.map((row) => (row.id === thread.id ? thread : row)))}
              row={selected}
              thread={clientRequests.find((thread) => `client:${thread.id}` === selected.key) ?? null}
            />
          ) : selected.lane === "system" ? (
            <SystemDetail
              item={lanes.system.find((item) => `system:${item.id}` === selected.key) ?? null}
              row={selected}
            />
          ) : (
            <HandoffDetail
              handoff={
                lanes.handoff.state === "available"
                  ? lanes.handoff.rows.find((row) => `handoff:${row.conversationId}` === selected.key) ?? null
                  : null
              }
              row={selected}
            />
          )}
        </div>
      </div>

      <SupportRequestSheet
        actorId={actorId}
        actorRole="admin"
        onOpenChange={(open) => { if (!open) setSheetThreadId(null); }}
        onThreadChange={(thread) => setClientRequests((current) =>
          current.map((row) => (row.id === thread.id ? thread : row)))}
        selected={clientRequests.find((thread) => thread.id === sheetThreadId) ?? null}
        threads={clientRequests}
      />

      <ContextEye copy={`${INBOX_RANKED_BY} ${INBOX_NO_CLAIM_REASON}`} screen="owner-inbox" />
    </div>
  );
}

function Tile({ label, tone, value }: { label: string; tone?: "warning"; value: string }) {
  return (
    <div
      className={[
        "flex items-baseline gap-[12px] rounded-[14px] border px-[18px] py-[14px] shadow-[var(--shadow-card)]",
        tone === "warning"
          ? "border-[var(--warning-line)] bg-[var(--warning-wash)]"
          : "border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))]",
      ].join(" ")}
    >
      <Figure
        className={tone === "warning" ? "text-[var(--warning-text)]" : "text-[var(--ink)]"}
        size="md"
      >
        {value}
      </Figure>
      <div className="text-[12.5px] font-[500] text-[color:var(--faint)]">{label}</div>
    </div>
  );
}

function LaneBand({ count, title }: { count: string; title: string }) {
  return (
    <div className="flex items-center gap-[8px] border-b border-[var(--line)] px-[16px] py-[12px]">
      <span className="text-[13.5px] font-[600] text-[color:var(--ink)]">{title}</span>
      <span className="mono text-[11.5px] text-[color:var(--meta)]">{count}</span>
    </div>
  );
}

function LaneRow({ onSelect, row, selected }: { onSelect: () => void; row: Row; selected: boolean }) {
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className={[
        "flex h-[52px] w-full cursor-pointer items-center gap-[12px] border-b border-[var(--line-soft)] px-[16px] text-left",
        selected ? "bg-[var(--row-selected)]" : "",
      ].join(" ")}
      onClick={onSelect}
      type="button"
    >
      <StatusDot tone={row.amber ? "amber" : "wait"} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-[500] text-[color:var(--ink)]">{row.title}</span>
        <span className="block truncate text-[12.5px] text-[color:var(--faint)]">{row.context}</span>
      </span>
      <span
        className={[
          "mono shrink-0 text-[11.5px]",
          row.amber ? "text-[color:var(--warning-text)]" : "text-[color:var(--meta)]",
        ].join(" ")}
      >
        {wait(row.waitMinutes)}
      </span>
    </button>
  );
}

function DetailHead({ overline, pills, title }: { overline: string; pills: readonly string[]; title: string }) {
  return (
    <div>
      <div className="text-[12.5px] font-[500] text-[color:var(--faint)]">{overline}</div>
      <div className="mt-[4px] text-[17px] leading-[1.25] font-[600] tracking-[-0.01em] text-[color:var(--ink)]">
        {title}
      </div>
      <div className="mt-[8px] flex flex-wrap gap-[8px]">
        {pills.map((pill, index) => (
          <Pill key={pill} tone={index === 0 ? "amber" : "neutral"}>
            {index === 0 ? <StatusDot tone="amber" /> : null}
            {pill}
          </Pill>
        ))}
      </div>
    </div>
  );
}

function CollectedGrid({ rows }: { rows: readonly { label: string; value: string }[] }) {
  return (
    <div>
      <div className="mb-[6px] text-[12.5px] font-[500] text-[color:var(--faint)]">
        Collected from this account
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-[16px] gap-y-[6px] text-[13px]">
        {rows.map((row) => (
          <div className="contents" key={row.label}>
            <dt className="text-[color:var(--meta)]">{row.label}</dt>
            <dd className="m-0 text-[color:var(--ink)]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Logged() {
  return <div className="mono text-[11px] text-[color:var(--overline)]">Logged</div>;
}

/**
 * The client-request pane.
 *
 * Reply and Reassign open the request sheet that already owns both writes -- the reply composer
 * and the success-owner confirm flow with its reason -- rather than a second copy of either.
 * Resolve is the thread lifecycle endpoint, which takes a reason and returns an audit id, so it
 * asks for the reason here before it sends anything.
 */
function ClientRequestDetail({
  onOpenSheet,
  onThreadChange,
  row,
  thread,
}: {
  onOpenSheet: () => void;
  onThreadChange: (thread: PlatformSupportThreadRead) => void;
  row: Row;
  thread: PlatformSupportThreadRead | null;
}) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");
  const request = thread?.messages.find((message) => !message.internal) ?? null;

  async function resolve() {
    if (!thread || !reason.trim()) return;
    setState("sending");
    try {
      const response = await fetch(`/api/platform/support/threads/${thread.id}`, {
        body: JSON.stringify({ kind: "status", reason: reason.trim(), status: "resolved" }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      if (!response.ok) throw new Error("REFUSED");
      onThreadChange({ ...thread, status: "resolved" });
      setConfirming(false);
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <DetailHead
        overline={`Client request · ${thread?.tenantName ?? row.context}`}
        pills={[`Open ${wait(row.waitMinutes)}`, thread ? assignee(thread) : "Unassigned"]}
        title={row.title}
      />

      <div className="rounded-[11px] border border-[var(--line-soft)] bg-[var(--well)] px-[14px] py-[12px] text-[13px] leading-[1.5] text-[color:var(--body)]">
        {request?.body ?? "No message is recorded on this request."}
        <div className="mt-[6px] text-[12.5px] text-[color:var(--faint)]">
          {request ? `${request.authorName ?? "Client"} · ${timestamp(request.createdAt)}` : "—"}
        </div>
      </div>

      <CollectedGrid
        rows={[
          { label: "Account", value: thread?.tenantName ?? "not recorded" },
          { label: "Success owner", value: thread ? ownerName(thread) : "not recorded" },
          { label: "Assigned to", value: thread ? assignee(thread) : "not recorded" },
          { label: "Opened", value: timestamp(thread?.createdAt ?? null) },
        ]}
      />

      {confirming ? (
        <div className="mt-auto flex flex-col gap-[9px] rounded-[11px] border border-[var(--warning-line)] bg-[var(--warning-wash)] p-[12px]">
          <label className="block">
            <span className="sr-only">Reason for resolving</span>
            <input
              className="h-[30px] w-full rounded-[8px] border border-[var(--line-input)] bg-[var(--control-fill)] px-[10px] text-[12.5px] text-[color:var(--ink)] placeholder:text-[color:var(--faint)]"
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why now? This is written to the audit log."
              value={reason}
            />
          </label>
          <div className="flex items-center gap-[8px]">
            <KitButton
              disabled={!reason.trim() || state === "sending"}
              onClick={resolve}
              size="md"
              variant="primary"
            >
              {state === "sending" ? "Resolving…" : "Resolve request"}
            </KitButton>
            <KitButton onClick={() => setConfirming(false)} size="md" variant="ghost">
              Cancel
            </KitButton>
          </div>
          {state === "failed" ? (
            <p className="m-0 text-[12px] text-[color:var(--failure-text)]">
              The change was refused. Nothing was recorded.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-auto flex gap-[8px]">
          <KitButton disabled={thread === null} onClick={onOpenSheet} size="md" variant="primary">
            Reply
          </KitButton>
          <KitButton disabled={thread === null} onClick={onOpenSheet} size="md" variant="secondary">
            Reassign
          </KitButton>
          <KitButton
            className="ml-auto"
            disabled={thread === null}
            onClick={() => setConfirming(true)}
            size="md"
            variant="secondary"
          >
            Resolve
          </KitButton>
        </div>
      )}
      <Logged />
    </>
  );
}

/**
 * The system-problem pane. The only write this queue records is that somebody opened the notice,
 * so the action says "Mark read" and never "Resolve": reading a notice does not fix the thing it
 * is about.
 */
function SystemDetail({ item, row }: { item: AttentionItem | null; row: Row }) {
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
    <>
      <DetailHead
        overline={`System problem · ${item?.tenantName ?? "Platform"}`}
        pills={[`Open ${wait(row.waitMinutes)}`, state === "done" ? "Read" : "Unread"]}
        title={row.title}
      />

      <div className="rounded-[11px] border border-[var(--line-soft)] bg-[var(--well)] px-[14px] py-[12px] text-[13px] leading-[1.5] text-[color:var(--body)]">
        {item?.body ?? item?.ruleDescription ?? "No detail is recorded on this notice."}
      </div>

      <CollectedGrid
        rows={[
          { label: "Account", value: item?.tenantName ?? "Platform" },
          { label: "Rule", value: item?.ruleName ?? item?.kind ?? "not recorded" },
          { label: "Recorded", value: timestamp(item?.createdAt ?? null) },
          { label: "Open for", value: wait(row.waitMinutes) },
        ]}
      />

      <div className="mt-auto flex gap-[8px]">
        <KitButton
          disabled={item === null || state === "sending" || state === "done"}
          onClick={markRead}
          size="md"
          variant="secondary"
        >
          {state === "done" ? "Marked read" : state === "failed" ? "Retry mark read" : "Mark read"}
        </KitButton>
        {item?.link ? (
          <KitButton
            className="ml-auto"
            onClick={() => { window.location.href = item.link as string; }}
            size="md"
            variant="secondary"
          >
            Open
          </KitButton>
        ) : null}
      </div>
      <Logged />
    </>
  );
}

/** The handoff pane: an account, a channel and a wait. There is nothing here a platform reader may act on. */
function HandoffDetail({ handoff, row }: { handoff: InboxHandoffRow | null; row: Row }) {
  return (
    <>
      <DetailHead
        overline={`Lead handoff · ${handoff?.channelLabel ?? "channel not recorded"}`}
        pills={[`Waiting ${wait(row.waitMinutes)}`, "Not taken over"]}
        title={row.title}
      />

      <div className="rounded-[11px] border border-[var(--line-soft)] bg-[var(--well)] px-[14px] py-[12px] text-[13px] leading-[1.5] text-[color:var(--body)]">
        {handoff?.handoff?.label ?? "No handoff reason is recorded."}
      </div>

      <CollectedGrid
        rows={[
          { label: "Account", value: handoff?.tenantName ?? row.title },
          { label: "Channel", value: handoff?.channelLabel ?? "not recorded" },
          { label: "Waiting", value: wait(row.waitMinutes) },
        ]}
      />

      <p className="mt-auto mb-0 text-[12px] leading-[1.5] text-[color:var(--muted)]">
        The coach takes this over in their own inbox.
      </p>
    </>
  );
}
