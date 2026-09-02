/**
 * The two lanes of the platform Inbox (screen 5a), and what the merge is allowed to claim.
 *
 * 5a merges the attention queue and the escalation queue into one destination: things that broke
 * and need a fix, and threads the agent handed to a person. They stay two lanes rather than one
 * interleaved list because the verbs are different, and the artifact bands them that way too.
 *
 * Three things the drawing asserts that nothing in this platform stores, so none of them is here:
 *
 * - **Neither lane can be claimed from here, for two different reasons.** On the system lane
 *   nothing stores a claim at all: `notifications` carries `user_id`, `read_at`, `rule_id`,
 *   `source_event_id`, `content`, `is_test` and `recipient_email`, and no assignee, claimed_at or
 *   resolved_at column exists on it. On the handoff lane a claim mechanism does exist, but it is
 *   the coach's: `POST /api/conversations/[id]/claim` loads its actor through `loadRouteActor`,
 *   which requires a tenant in the claims, and claims against `actor.tenantId`. A platform reader
 *   has no tenant of their own, so the route can only ever act on the caller's own account, never
 *   on the account a queued row belongs to.
 *
 * - **"N in someone's hands" is not countable from what this page can read.** The projection
 *   filters `taken_over_by is null` in both its index and its query, so a thread stops appearing
 *   here the moment anybody takes it over. The lane is therefore unclaimed threads specifically,
 *   and it says so rather than implying it is every handoff.
 *
 * - **There is no promise.** Same wall the coach queue hit: no response target exists anywhere, so
 *   both lanes rank by how long a row has waited and the surface says so in a sentence.
 *
 * - **A lead's name and words stay inside their tenant.** The cross-tenant projection returns
 *   account, channel, reason and wait, and refuses lead identity and message bodies on purpose
 *   (`conversation-projection.ts`). The handoff lane is therefore about accounts, not people, and
 *   the artifact's "Marcus T." row with its verbatim quote is not something an admin may see.
 */

import { handoffFor, type EscalationHandoff } from "@/components/workspace/live/escalation-queue";
import type { PlatformHumanConversation } from "@/lib/platform/conversation-projection";
import type { AttentionItem } from "@/lib/operations/attention-queue";

const CHANNEL_LABELS: Record<PlatformHumanConversation["channel"], string> = {
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "Text messages (SMS)",
  whatsapp: "WhatsApp",
  webchat: "Web chat",
};

export function inboxChannelLabel(channel: PlatformHumanConversation["channel"]) {
  return CHANNEL_LABELS[channel];
}

export type InboxHandoffRow = {
  conversationId: string;
  tenantId: string;
  tenantName: string;
  channelLabel: string;
  /** Null when the thread carries a reason this build has not been taught a sentence for. */
  handoff: EscalationHandoff | null;
  /** Minutes since the agent handed the thread over. Null when the projection could not say. */
  waitMinutes: number | null;
};

/**
 * The lane is a state rather than an array, because "the queue is empty" and "the queue could not
 * be read" are different facts and a reader acts on them differently. An unreadable lane says so;
 * it never renders as nothing waiting.
 */
export type InboxHandoffLane =
  | { state: "available"; rows: readonly InboxHandoffRow[] }
  | { state: "unavailable"; reason: string };

export type InboxLanes = {
  system: readonly AttentionItem[];
  handoff: InboxHandoffLane;
  /** Rows waiting across both lanes, or null for the part that could not be counted. */
  waiting: { system: number; handoff: number | null };
  /** The longest wait anywhere in the Inbox, in minutes, with the lane it came from. */
  longestWait: { minutes: number; lane: "system" | "handoff" } | null;
  rankedBy: string;
};

export const INBOX_RANKED_BY =
  "Longest wait first, in both lanes. Nothing here stores a reply promise or a response target, "
  + "so the order is how long each row has waited and nothing else.";

export const INBOX_NO_CLAIM_REASON =
  "Nothing records who is working a system problem, so opened means somebody has read it, not that "
  + "it is fixed or that anybody owns it. A lead handoff leaves this lane the moment the coach "
  + "takes it over, so the lane counts threads nobody has picked up.";

export const INBOX_HANDOFF_LANE_OFF =
  "The cross-tenant handoff queue is switched off in this environment, so lead handoffs are not "
  + "counted here. Each coach still sees their own in their inbox.";

/** A wait the projection reported. Seconds land as whole minutes; anything unreadable is null. */
function waitMinutesFrom(seconds: number | null | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.floor(seconds / 60);
}

export function inboxHandoffRow(conversation: PlatformHumanConversation): InboxHandoffRow {
  return {
    conversationId: conversation.conversationId,
    tenantId: conversation.tenantId,
    tenantName: conversation.tenantName,
    channelLabel: inboxChannelLabel(conversation.channel),
    handoff: handoffFor(conversation.statusReason),
    waitMinutes: waitMinutesFrom(conversation.waitingSeconds),
  };
}

/**
 * Sorts a lane longest-wait-first, with unknown waits last.
 *
 * An unknown wait cannot be ranked against a known one, so it sits below every known one rather
 * than being treated as the newest thing in the queue. The tiebreak is the row's own id so the
 * order is stable across renders rather than dependent on read order.
 */
function byWaitDescending<T>(rows: readonly T[], wait: (row: T) => number | null, id: (row: T) => string) {
  return [...rows].sort((left, right) => {
    const leftWait = wait(left);
    const rightWait = wait(right);
    if (leftWait === null && rightWait === null) return id(left).localeCompare(id(right));
    if (leftWait === null) return 1;
    if (rightWait === null) return -1;
    return rightWait - leftWait || id(left).localeCompare(id(right));
  });
}

/**
 * Builds both lanes from what the page could actually read.
 *
 * `conversations` is null when the projection is switched off or the read failed; the lane then
 * carries the reason instead of an empty array, and the combined figures report the handoff count
 * as unknown rather than as zero. A merged inbox that quietly counts half of itself is worse than
 * one that admits which half it has.
 */
export function inboxLanes(input: {
  queue: { items: readonly AttentionItem[] };
  conversations: readonly PlatformHumanConversation[] | null;
  unavailableReason?: string;
}): InboxLanes {
  const system = byWaitDescending(
    input.queue.items,
    (item) => item.openForMinutes,
    (item) => item.id,
  );

  const handoff: InboxHandoffLane = input.conversations === null
    ? { state: "unavailable", reason: input.unavailableReason ?? INBOX_HANDOFF_LANE_OFF }
    : {
        state: "available",
        rows: byWaitDescending(
          input.conversations.map(inboxHandoffRow),
          (row) => row.waitMinutes,
          (row) => row.conversationId,
        ),
      };

  const systemLongest = system.reduce<number | null>(
    (longest, item) => (longest === null || item.openForMinutes > longest ? item.openForMinutes : longest),
    null,
  );
  const handoffLongest = handoff.state === "available"
    ? handoff.rows.reduce<number | null>(
        (longest, row) => (row.waitMinutes !== null && (longest === null || row.waitMinutes > longest)
          ? row.waitMinutes
          : longest),
        null,
      )
    : null;

  const longestWait = systemLongest === null && handoffLongest === null
    ? null
    : (handoffLongest ?? -1) > (systemLongest ?? -1)
      ? { minutes: handoffLongest as number, lane: "handoff" as const }
      : { minutes: systemLongest as number, lane: "system" as const };

  return {
    system,
    handoff,
    waiting: {
      system: system.filter((item) => item.readAt === null).length,
      handoff: handoff.state === "available" ? handoff.rows.length : null,
    },
    longestWait,
    rankedBy: INBOX_RANKED_BY,
  };
}
