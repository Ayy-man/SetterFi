"use client";

/**
 * Screen 5a: the platform Inbox, where Attention and Escalations became one destination.
 *
 * Two lanes, one clock. System problems are things that broke and need a fix; lead handoffs are
 * threads the agent stopped on and handed to a person. They stay banded rather than interleaved
 * because the verbs are different, and both rank by how long a row has waited.
 *
 * Transcribed from `.planning/design/screens-r4/5a.html`, over the 2a transcription this file used
 * to be. Where it departs from the drawing it is because the drawing asserts something the
 * platform cannot know, and each departure is stated on the screen rather than papered over:
 *
 * - **The claim model is not built, because nothing stores a claim.** `notifications` has no
 *   assignee, no claimed_at and no resolved_at, and `assign_support_thread` assigns a support
 *   ticket rather than a notice. So "Claim", "Claim next", "3 in someone's hands" and a per-row
 *   owner name are absent. What the store records is whether a row has been opened, which is a
 *   weaker claim and a true one, and the strip says so in words. Logged in `docs/GAPS.md`.
 * - **"sorted by time to breach" is "longest wait first".** No alert rule stores a response
 *   target, so nothing can be breaching. `queue.responseTargets.configured` drives the copy, so
 *   the sentence corrects itself when a target column arrives.
 * - **"BREACHING / AT RISK" are "CRITICAL / WARNING."** Those are the `notification_severity`
 *   enum's own words for rows open right now, not a clock reading.
 * - **The handoff lane is about accounts, not leads.** The artifact draws a lead's name and their
 *   verbatim message in an admin rail. The cross-tenant projection refuses both on purpose, so a
 *   handoff row reads account, channel, what handed it over, and how long it has waited.
 * - **"Est. bookings lost" is absent.** It would need a per-account booking-rate model that does
 *   not exist. "Leads waiting" and "oldest wait" stay, because both are columns.
 * - **"Restart agent and replay queue" is not wired.** The row states what is available instead,
 *   and where that is an onboarding nudge it is a two-step confirm carrying "Logged".
 *
 * The One Fill Rule: the page spends its single accent fill on the confirm step of the one
 * command that exists, and spends none at all when no selected row offers one.
 */

import { useMemo, useState } from "react";

import { DataState } from "@/components/kit/data-state";
import { ExportMenu } from "@/components/kit/export-menu";
import {
  BarSparkline,
  IconTile,
  KeyValueList,
  KitButton,
  MetricCard,
  Monogram,
  MonoMeta,
  NoteStrip,
  Overline,
  QueueItem,
  Segmented,
  Status,
  StatusAbsent,
  StatusDot,
  Surface,
  SurfaceHeader,
  type Tone,
} from "@/components/kit/atomics";
import { PageHeader } from "@/components/kit/page-header";
import { wholePageProvenanceKind } from "@/components/kit/provenance-chip";
import { workspaceCountFormat, workspaceTimestampFormat } from "@/lib/format/datetime";
import type {
  AttentionItem,
  AttentionQueue,
  AttentionSeverity,
} from "@/lib/operations/attention-queue";
import { formatElapsed, formatQueueClock } from "@/lib/operations/attention-queue-format";
import {
  INBOX_NO_CLAIM_REASON,
  type InboxHandoffLane,
  type InboxLanes,
} from "@/components/workspace/live/inbox-lanes";

const CRUMBS = [{ label: "Run" }, { label: "Inbox" }] as const;

/**
 * Severity is the enum's word, and the tone is what that word looks like. `success` is a resolved
 * notice rather than something to do, so it takes `good` and never glows.
 */
const SEVERITY_TONE: Record<AttentionSeverity, Tone> = {
  critical: "failure",
  warning: "warning",
  info: "waiting",
  success: "good",
};

const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "For information",
  success: "Resolved",
};

type Scope = "all" | "mine";

/**
 * The switch this page offers, and the three the canvas draws that it does not.
 *
 * `AdminInbox.dc.html` puts Open / Snoozed / Resolved across the top, with counts, and none of
 * the three can be told the truth here:
 *
 *   **Snoozed** has no column. Nothing in `notifications` or the attention-queue projection
 *   records a defer-until instant, so a Snoozed view would either be permanently empty or would
 *   have to reuse `read_at`, which means something else entirely.
 *
 *   **Resolved** would have to be `read_at`, and this file already refuses that conflation
 *   deliberately -- the summary tile beside it says "Opened", not "Handled", because `read_at`
 *   records that somebody looked, not that anybody fixed it. A tab labelled Resolved over the
 *   same column would undo that in one word, on the queue whose whole job is to stop work being
 *   marked done before it is.
 *
 *   **Open** only means something against the other two, so it goes with them.
 *
 * What survives is the switch the platform can actually answer: whose book the row is in. The
 * canvas's counts are drawn from its own sample rows and are not a fourth claim.
 */
const SCOPE_OPTIONS = [
  { key: "all", label: "Everything" },
  { key: "mine", label: "Assigned to me" },
] as const;

function timestamp(iso: string | null) {
  return iso ? workspaceTimestampFormat.format(new Date(iso)) : null;
}

/**
 * The context line under a queue title: who it is about and what the rule says it means. The
 * rule's own authored description is preferred over the notification body, because the body is a
 * per-event sentence and the description is what the rule promises this alert always means.
 */
function contextFor(item: AttentionItem) {
  return [item.tenantName ?? "Platform", item.ruleDescription ?? item.body]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" · ");
}

export type AdminInboxProps = {
  queue: AttentionQueue;
  /** Both lanes, already ranked. Derived on the server so the two halves share one read. */
  lanes: InboxLanes;
  /** Present so a success reviewer's "assigned to me" filter has something real to compare. */
  actorId: string;
};

export function AdminInboxSurface({ lanes, queue }: AdminInboxProps) {
  const [scope, setScope] = useState<Scope>("all");
  const [selectedId, setSelectedId] = useState<string | null>(queue.items[0]?.id ?? null);

  /*
   * Scope narrows the system lane by the account's success owner, which is the only ownership this
   * platform actually records. The handoff lane carries no owner at all -- the projection returns
   * unclaimed threads and nothing else -- so it is left whole rather than filtered by a field that
   * would have to be invented.
   */
  const items = useMemo(
    () => (scope === "mine" ? lanes.system.filter((item) => item.assignedToMe) : lanes.system),
    [lanes.system, scope],
  );
  /*
   * The queue had no disclosure at all, on a surface whose rows are notices about named client
   * workspaces. Every notice on it seeded is a claim about the page and takes the chip; a queue
   * with real notices in it keeps the per-row "test data" tag the list already draws and says
   * nothing page-wide, because a chip over a mixed queue would tell a reader that a real client's
   * fault is excluded from analytics.
   */
  const queueProvenanceKind = wholePageProvenanceKind(
    items,
    (item) => (item.isTest ? "test" : null),
  );

  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  /* An unreadable lane is not an empty one, so it never lets the page call itself clear. */
  const handoffEmpty = lanes.handoff.state === "available" && lanes.handoff.rows.length === 0;

  const exportRows = items.map((item) => ({
    id: item.id,
    severity: item.severity,
    title: item.title,
    account: item.tenantName ?? "Platform",
    rule: item.ruleName ?? item.kind,
    category: item.ruleCategory ?? "",
    recorded_at: item.createdAt,
    open_for_minutes: item.openForMinutes,
    cleared_at: item.readAt ?? "",
    response_target: item.breachAt ?? "",
    test_data: item.isTest,
  }));

  return (
    <div className="@container/attention flex flex-col gap-[var(--s-4)]">
      <PageHeader
        actions={
          <>
            <Segmented
              label="Which accounts this queue covers"
              onValueChange={(value) => setScope(value as Scope)}
              options={SCOPE_OPTIONS}
              value={scope}
            />
            <ExportMenu filename="platform-inbox" mode="local" rows={exportRows} />
          </>
        }
        crumbs={CRUMBS}
        description="System problems and lead handoffs in one queue. Everything here is waiting on a person, not a job."
        provenanceKind={queueProvenanceKind ?? undefined}
        title="Inbox"
      />

      {queue.responseTargets.configured ? null : (
        <NoteStrip tone="waiting">{lanes.rankedBy}</NoteStrip>
      )}

      <SummaryStrip lanes={lanes} queue={queue} />

      {/* The page is only clear when both lanes are. An empty system lane over four waiting leads
          would have read as "nothing to do", which is the completion theatre the rules ban. */}
      {items.length === 0 && handoffEmpty ? (
        <DataState
          body={
            scope === "mine"
              ? "Nothing in your own book is waiting on you. Switch to Everything to see the rest of the platform."
              : "Nothing is broken and no thread is waiting on a person. Rules that fire land here."
          }
          kind="empty"
          title="The Inbox is clear"
        />
      ) : (
        <div className="grid grid-cols-1 gap-[13px] @min-[900px]/attention:grid-cols-[1.25fr_1fr]">
          <Surface variant="panel">
            <LaneHeader
              count={workspaceCountFormat.format(items.length)}
              meaning="need a fix, not a reply"
              title="System problems"
            />
            <ul className="m-0 list-none p-0">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    aria-current={selected?.id === item.id ? "true" : undefined}
                    className="block w-full cursor-pointer text-left"
                    onClick={() => setSelectedId(item.id)}
                    type="button"
                  >
                    <QueueItem
                      cleared={item.readAt !== null}
                      className={selected?.id === item.id ? "bg-[var(--row-hover)]" : undefined}
                      clock={formatQueueClock(item)}
                      context={
                        <>
                          {contextFor(item)}
                          {item.isTest ? (
                            <>
                              {" · "}
                              <span data-slot="test-data-label">Test data, excluded from real analytics</span>
                            </>
                          ) : null}
                        </>
                      }
                      title={item.title}
                      tone={SEVERITY_TONE[item.severity]}
                    />
                  </button>
                </li>
              ))}
            </ul>
            {queue.truncated ? (
              <div className="border-t border-[var(--line)] px-[14px] py-[10px]">
                <MonoMeta>Showing the newest {workspaceCountFormat.format(items.length)}. Older notices are not read.</MonoMeta>
              </div>
            ) : null}
          </Surface>

          <div className="flex flex-col gap-[13px]">
            {selected ? <DetailPanel item={selected} queue={queue} /> : null}
            <HandoffLane lane={lanes.handoff} />
            {/* Said once, at the foot of the page: what "opened" means and what nothing records. */}
            <NoteStrip tone="neutral">{INBOX_NO_CLAIM_REASON}</NoteStrip>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Three tiles, and every one of them is something the store actually records.
 *
 * The canvas draws two more panels under this strip and neither can be built from this read.
 *
 * **"What the queue is made of"** bars the queue across Channel faults, Lead handoffs and Model
 * degrades. Those three buckets are the drawing's taxonomy, not the platform's: an item carries
 * an open `kind` string and a nullable `rule_category`, and nothing maps either onto that trio.
 * Inventing the mapping here would produce a chart whose bars move when someone adds a
 * notification kind, with no test able to say the split had gone wrong.
 *
 * **"How long we take"** shows First touch, To resolved and Reopened. Only the middle one exists,
 * as `summary.medianMinutesToClear`, and it is already the third tile above. First touch needs a
 * first-response stamp nothing writes, and Reopened needs a state transition log this queue does
 * not keep -- an item is unread or read, and reading it twice is not recorded as reopening it.
 *
 * The artifact's fourth tile, "Claimed, in progress", is not here: nothing writes who is working a
 * row, so a count of claimed items would be a count of nothing. The third tile is deliberately
 * "Opened" rather than "Handled" for the same reason -- `read_at` records that somebody looked,
 * not that anybody fixed it -- and it names its seven-day window on screen so the figure cannot be
 * read as today's.
 */
function SummaryStrip({ lanes, queue }: { lanes: InboxLanes; queue: AttentionQueue }) {
  const { summary } = queue;
  const median = summary.medianMinutesToClear;
  const longest = lanes.longestWait;
  const handoffWaiting = lanes.waiting.handoff;

  return (
    <div className="grid grid-cols-1 gap-[12px] @min-[620px]/attention:grid-cols-3">
      <MetricCard
        note={
          handoffWaiting === null
            ? `${workspaceCountFormat.format(lanes.waiting.system)} problems · lead handoffs not counted`
            : `${workspaceCountFormat.format(lanes.waiting.system)} problems · ${workspaceCountFormat.format(handoffWaiting)} lead handoffs`
        }
        overline="Waiting on a person"
        tone={lanes.waiting.system + (handoffWaiting ?? 0) > 0 ? "warning" : "neutral"}
        value={
          handoffWaiting === null
            ? workspaceCountFormat.format(lanes.waiting.system)
            : workspaceCountFormat.format(lanes.waiting.system + handoffWaiting)
        }
      />
      <MetricCard
        note={
          longest === null
            ? "nothing is waiting"
            : longest.lane === "handoff"
              ? "a lead handoff"
              : "a system problem"
        }
        overline="Longest wait"
        tone={longest === null ? "neutral" : "warning"}
        value={longest === null ? "none" : formatElapsed(longest.minutes)}
      />
      <MetricCard
        note={
          median === null
            ? "nothing opened in the last 7 days"
            : `median ${formatElapsed(median)} to open`
        }
        overline="Opened in the last 7 days"
        value={workspaceCountFormat.format(summary.clearedInWindow)}
      />
    </div>
  );
}

/**
 * One lane's band header: what the rows are, how many, and what a reader is expected to do with
 * them. The count renders from the list beneath it rather than from a second source.
 */
function LaneHeader({ count, meaning, title }: { count: string; meaning: string; title: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-[var(--s-2)] gap-y-[2px] border-b border-[var(--line)] px-[14px] py-[10px]">
      <Overline>{title}</Overline>
      <MonoMeta>{count}</MonoMeta>
      <span className="text-[11.5px] leading-[1.45] text-[color:var(--faint)]">{meaning}</span>
    </div>
  );
}

/**
 * The lead-handoff lane.
 *
 * Every row is an account with a thread the agent stopped on and nobody has taken over. There is
 * no lead name and no message here, and that is the point rather than an omission: the cross-tenant
 * projection refuses both, so a platform reader learns that a coach has somebody waiting and goes
 * to the coach, not to the lead.
 *
 * Two things follow from the projection's own filters and both are said on screen. It returns only
 * `taken_over_by is null`, so a claimed thread leaves this lane rather than moving to a claimed
 * state, and the lane is threads nobody has picked up rather than every handoff. And there is no
 * claim verb here: the claim route acts on the caller's own tenant, so taking a thread over is the
 * coach's action on their own inbox, not something a platform reader can do to somebody else's.
 * Rows are not selectable because there is no further detail this page may open.
 */
function HandoffLane({ lane }: { lane: InboxHandoffLane }) {
  if (lane.state === "unavailable") {
    return (
      <Surface variant="panel">
        <LaneHeader count="not counted" meaning="" title="Lead handoffs" />
        <div className="px-[14px] py-[12px]">
          <p className="m-0 max-w-[var(--measure-prose)] text-[12px] leading-[1.5] text-[color:var(--muted)]">
            {lane.reason}
          </p>
        </div>
      </Surface>
    );
  }

  return (
    <Surface variant="panel">
      <LaneHeader
        count={workspaceCountFormat.format(lane.rows.length)}
        meaning="the agent stopped; nobody has taken these over"
        title="Lead handoffs"
      />
      {lane.rows.length === 0 ? (
        <div className="px-[14px] py-[12px]">
          <p className="m-0 text-[12px] leading-[1.5] text-[color:var(--muted)]">
            No thread anywhere on the platform is waiting on a person.
          </p>
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {lane.rows.map((row) => (
            <li key={row.conversationId}>
              <QueueItem
                clock={row.waitMinutes === null ? "wait not recorded" : formatElapsed(row.waitMinutes)}
                context={`${row.channelLabel} · ${row.handoff?.label ?? "No handoff reason recorded"}`}
                title={row.tenantName}
                tone="warning"
              />
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}

function DetailPanel({ item, queue }: { item: AttentionItem; queue: AttentionQueue }) {
  const radius = queue.blastRadius.find((entry) => entry.tenantId === item.tenantId) ?? null;
  const replies = queue.replyVolume.find((entry) => entry.tenantId === item.tenantId) ?? null;
  const tone = SEVERITY_TONE[item.severity];

  return (
    <Surface className="flex flex-col" variant="panel">
      <SurfaceHeader overline={`Selected · ${item.tenantName ?? "Platform"}`} />
      <div className="flex flex-col gap-[13px] p-[15px]">
        <div className="flex items-center gap-[11px]">
          {item.tenantName ? (
            <Monogram name={item.tenantName} />
          ) : (
            <IconTile size="md" tone={tone}>
              <StatusDot size={6} tone={tone} />
            </IconTile>
          )}
          <div className="min-w-0">
            <div className="text-[14px] leading-[1.3] font-[600] text-[color:var(--ink)]">{item.title}</div>
            <div className="mt-[2px] flex flex-wrap items-center gap-x-[var(--s-2)] gap-y-[2px]">
              <Status label={SEVERITY_LABEL[item.severity]} tone={tone} />
              <MonoMeta>Recorded {timestamp(item.createdAt)}</MonoMeta>
            </div>
          </div>
        </div>

        {item.body ? (
          <p className="m-0 max-w-[var(--measure-prose)] text-[12.5px] leading-[1.5] text-[color:var(--body)] text-pretty">
            {item.body}
          </p>
        ) : null}

        <Surface variant="well">
          <Overline className="mb-[9px] block">Blast radius</Overline>
          {radius === null || radius.state === "unavailable" ? (
            <p className="m-0 text-[12px] leading-[1.5] text-[color:var(--muted)]">
              {radius?.reason ?? "This notice is not about one account, so there is nothing to count."}
            </p>
          ) : (
            <KeyValueList
              rows={[
                {
                  label: "Threads waiting on a person",
                  tone: radius.leadsWaiting > 0 ? tone : "neutral",
                  value: workspaceCountFormat.format(radius.leadsWaiting),
                },
                {
                  label: "Oldest wait",
                  /* An absence is not a state: the bare em-rule carried no words, so a screen
                     reader heard nothing at all where the page meant "none recorded". */
                  value: radius.oldestWaitMinutes === null
                    ? <StatusAbsent label="No wait is recorded for this account" />
                    : formatElapsed(radius.oldestWaitMinutes),
                },
                { label: "This item open for", value: formatElapsed(item.openForMinutes) },
              ]}
            />
          )}
          {radius?.state === "available" ? (
            <p className="mt-[9px] mb-0 text-[11.5px] leading-[1.45] text-[color:var(--faint)]">
              Counted from threads the agent handed to a person and nobody has picked up. Bookings
              lost is not shown: nothing here measures it.
            </p>
          ) : null}
        </Surface>

        <Surface variant="well">
          <Overline className="mb-[10px] block">Last 24h agent replies</Overline>
          {replies === null || replies.state === "unavailable" || replies.hourly.length === 0 ? (
            <p className="m-0 text-[12px] leading-[1.5] text-[color:var(--muted)]">
              {replies?.reason ?? "No account is attached to this notice, so there is no reply series to draw."}
            </p>
          ) : (
            <>
              <BarSparkline
                emphasisCount={4}
                height={44}
                label={`Agent replies per hour for ${item.tenantName ?? "this account"}, last 24 hours`}
                points={replies.hourly}
                tone="accent"
              />
              <div className="mt-[8px]">
                <MonoMeta>
                  {workspaceCountFormat.format(replies.hourly.reduce((total, value) => total + value, 0))} replies since {timestamp(replies.fromIso)}
                </MonoMeta>
              </div>
            </>
          )}
        </Surface>

        <ItemActions item={item} />
      </div>
    </Surface>
  );
}

/**
 * The action block.
 *
 * A privileged command is never one press: pressing the control opens a confirm step that names
 * the account, takes the reason the endpoint requires, and carries the "Logged" microcopy every
 * privileged action in this product carries. When nothing is wired, the panel says so in a
 * sentence rather than rendering a disabled button that looks like a capability.
 */
function ItemActions({ item }: { item: AttentionItem }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">("idle");
  const action = item.primaryAction;

  async function submit() {
    if (!action.endpoint || !reason.trim()) return;
    setState("sending");
    try {
      const response = await fetch(action.endpoint, {
        body: JSON.stringify({ action: action.command, reason: reason.trim() }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      setState(response.ok ? "done" : "failed");
      if (response.ok) setConfirming(false);
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex flex-col gap-[8px]">
      {action.availability === "not-available" ? (
        <p
          className="m-0 text-[12px] leading-[1.5] text-[color:var(--muted)]"
          data-slot="no-action-reason"
        >
          {action.reason}
        </p>
      ) : confirming ? (
        <Surface tone="warning" variant="well">
          <Overline className="mb-[8px] block">Confirm · onboarding nudge</Overline>
          <p className="m-0 mb-[9px] text-[12px] leading-[1.5] text-[color:var(--body)]">
            This records the intent against {item.tenantName ?? "this account"}. It does not message
            the coach: no provider dispatch is wired to this command yet.
          </p>
          <label className="block">
            <span className="sr-only">Reason</span>
            <input
              className="h-[30px] w-full rounded-[var(--r-chip)] border border-[var(--line)] bg-[var(--control-fill)] px-[10px] text-[12.5px] text-[color:var(--ink)] placeholder:text-[color:var(--faint)]"
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why now? This is written to the audit log."
              value={reason}
            />
          </label>
          <div className="mt-[9px] flex items-center gap-[8px]">
            <KitButton
              disabled={!reason.trim() || state === "sending"}
              onClick={submit}
              size="md"
              variant="primary"
            >
              {state === "sending" ? "Recording…" : "Record nudge"}
            </KitButton>
            <KitButton onClick={() => setConfirming(false)} size="md" variant="ghost">
              Cancel
            </KitButton>
            <MonoMeta className="ml-auto" data-slot="audit-microcopy">
              Logged
            </MonoMeta>
          </div>
        </Surface>
      ) : (
        <KitButton onClick={() => setConfirming(true)} size="lg" variant="secondary">
          Nudge onboarding…
        </KitButton>
      )}

      {state === "done" ? (
        <Status label="Nudge intent recorded and logged" tone="good" />
      ) : null}
      {state === "failed" ? (
        <Status label="The command was refused. Nothing was recorded." tone="failure" />
      ) : null}

      <div className="flex flex-wrap gap-[8px]">
        {/*
         * Where the fix actually lives. A channel notice is fixed on Channel health, which already
         * holds the provider's own error text and the connection receipts for that account, so this
         * routes there rather than restating a read this page would have to duplicate. Only rendered
         * for a channel notice on a known account: a link that lands on a tenant picker is worse
         * than no link.
         */}
        {item.kind.startsWith("channel.") && item.tenantId ? (
          <KitButton
            className="flex-1"
            onClick={() => {
              window.location.href = `/admin/channel-health?client=${encodeURIComponent(item.tenantId as string)}`;
            }}
            size="md"
            variant="secondary"
          >
            Open channel health
          </KitButton>
        ) : null}
        {item.link ? (
          <KitButton
            className="flex-1"
            onClick={() => {
              window.location.href = item.link as string;
            }}
            size="md"
            variant="secondary"
          >
            Open
          </KitButton>
        ) : null}
        <ClearButton item={item} />
      </div>
    </div>
  );
}

/**
 * Clearing is marking the notice read, which is what the store actually records. It is not called
 * "resolve": nothing about reading a notice fixes the thing it is about, and a button that claims
 * otherwise is the same overstatement as a green tick over a provisioning step.
 */
function ClearButton({ item }: { item: AttentionItem }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">(
    item.readAt === null ? "idle" : "done",
  );

  async function clear() {
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

  if (state === "done") {
    return (
      <div className="flex flex-1 items-center">
        <MonoMeta>Marked read</MonoMeta>
      </div>
    );
  }
  return (
    <KitButton className="flex-1" disabled={state === "sending"} onClick={clear} size="md" variant="secondary">
      {state === "failed" ? "Retry mark read" : "Mark read"}
    </KitButton>
  );
}

/** The unavailable face, so the page never renders an empty queue when the read simply failed. */
export function AdminInboxUnavailable({ reason }: { reason: string }) {
  return (
    <>
      <PageHeader
        crumbs={CRUMBS}
        description="System problems and lead handoffs in one queue. Everything here is waiting on a person, not a job."
        title="Inbox"
      />
      <DataState body={reason} kind="unavailable" title="The Inbox could not load" />
    </>
  );
}
