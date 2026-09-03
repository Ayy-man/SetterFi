/**
 * What the Inbox list is made of, kept out of the component that draws it.
 *
 * The list is one continuous run of rows in lane order, and every fact a row carries has to come
 * out of a lane the server already built. Deriving that here rather than inside the surface keeps
 * the two questions the design review kept re-asking -- which rows are amber, and which rows a
 * search matches -- as plain functions a test can pin without mounting a router.
 */

import { displayName } from "@/lib/format/display-name";
import type { AttentionItem } from "@/lib/operations/attention-queue";
import type { PlatformSupportThreadRead } from "@/lib/repositories/support";
import type { InboxLanes } from "@/components/workspace/live/inbox-lanes";

export type InboxLaneKey = "client" | "system" | "handoff";

/** Uppercase in the artboard, sentence case in the string: the lane header owns the casing. */
export const INBOX_LANE_TITLES: Record<InboxLaneKey, string> = {
  client: "Client requests",
  system: "System problems",
  handoff: "Lead handoffs",
};

export type InboxRow = {
  key: string;
  lane: InboxLaneKey;
  title: string;
  context: string;
  /** Minutes waited, or null where nothing recorded one. */
  waitMinutes: number | null;
  /** True when this row is in the reader's own book. */
  mine: boolean;
  /**
   * True only when the row carries a recorded response target and has passed it.
   *
   * Amber used to mean "open", which made most of the list amber and told a reader nothing. The
   * artboard reserves the colour for a request that is late, so it is now spent on the one signal
   * the platform actually stores: `notifications` carries `breach_at` per rule, and the queue
   * loader turns it into `minutesToBreach`. Support threads and lead handoffs have no target
   * anywhere -- `INBOX_RANKED_BY` says so in as many words -- so they are never amber, and their
   * wait is read as elapsed time rather than as lateness.
   */
  overSla: boolean;
  /** True when the row's account or the row itself is seeded, which drives the one header pill. */
  demo: boolean;
};

function assigneeName(thread: PlatformSupportThreadRead) {
  const named = displayName(thread.assignedTo?.name?.trim() ?? "");
  return named || (thread.assignedTo ? "Assigned team member" : "Unassigned");
}

function noticeOverSla(item: AttentionItem, nowIso: string) {
  if (typeof item.minutesToBreach === "number") return item.minutesToBreach <= 0;
  if (!item.breachAt) return false;
  const breach = Date.parse(item.breachAt);
  const now = Date.parse(nowIso);
  return Number.isFinite(breach) && Number.isFinite(now) && breach <= now;
}

function minutesBetween(fromIso: string, nowIso: string) {
  const from = Date.parse(fromIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(from) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - from) / 60_000));
}

/**
 * Every visible row, in lane order, already ranked by the server.
 *
 * `mine` is the only ownership each lane actually records: a support thread carries an assignee,
 * a notice carries the account's success owner, and a handoff carries neither, so a handoff is
 * never in anybody's book and the scope switch says so by leaving it out of "Assigned to me".
 */
export function inboxRows(
  lanes: InboxLanes,
  now: { asOf: string },
  actorId: string,
): InboxRow[] {
  const client = (lanes.clientRequests ?? [])
    .filter((thread) => thread.status !== "resolved")
    .map((thread) => ({
      key: `client:${thread.id}`,
      lane: "client" as const,
      title: thread.subject,
      context: `${displayName(thread.tenantName)} · ${assigneeName(thread)}`,
      waitMinutes: minutesBetween(thread.updatedAt, now.asOf),
      mine: thread.assignedTo?.id === actorId,
      overSla: false,
      demo: thread.tenantIsDemo || thread.isTest,
    }));

  const system = lanes.system.map((item) => ({
    key: `system:${item.id}`,
    lane: "system" as const,
    title: item.title,
    context: [item.tenantName ? displayName(item.tenantName) : "Platform", item.ruleDescription ?? item.body]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(" · "),
    waitMinutes: item.openForMinutes,
    mine: item.assignedToMe,
    overSla: noticeOverSla(item, now.asOf),
    demo: item.isTest,
  }));

  const handoff = lanes.handoff.state === "available"
    ? lanes.handoff.rows.map((row) => ({
        key: `handoff:${row.conversationId}`,
        lane: "handoff" as const,
        title: displayName(row.tenantName),
        context: `${row.channelLabel} · ${row.handoff?.label ?? "No handoff reason recorded"}`,
        waitMinutes: row.waitMinutes,
        mine: false,
        overSla: false,
        demo: false,
      }))
    : [];

  return [...client, ...system, ...handoff];
}

/**
 * A row matches a search when the words a reader can see contain the query.
 *
 * Title and context only: the search box names people, clients and subjects, and those are exactly
 * the two lines a row prints. Matching against an id a row never shows would return rows the reader
 * cannot explain.
 */
export function inboxRowMatches(row: InboxRow, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${row.title} ${row.context}`.toLowerCase().includes(needle);
}
