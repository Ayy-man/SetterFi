/**
 * The escalation queue: the threads the agent handed to a person, ranked, and the handoff rules
 * that put them there.
 *
 * Screens 1a and 1l are transcribed here rather than in the surface, because almost every claim
 * either of them makes is a claim about data this platform may or may not have, and those
 * decisions belong somewhere they can be tested. Three of them are worth stating out loud:
 *
 * - **There is no promise anywhere in the schema.** The artifact ranks by broken promise -- "22m
 *   over", a PAST PROMISE tile, a 15-minute reply commitment -- and nothing in `conversations`,
 *   `alert_rules` or `notifications` stores a response target. `attention-queue.ts` reached the
 *   same wall on the platform queue and says so in the same words. So this ranks by how long each
 *   thread has waited, `rankedBy` says that in a sentence the surface renders verbatim, and no row
 *   is ever described as over or late.
 *
 * - **The clock is `conversations.needs_human_at` and nothing else.** Not the last inbound
 *   message, which is close enough to look right and wrong often enough to matter. A thread whose
 *   column is unset has an unknown wait, which sorts last and says "wait not measured" -- it is
 *   never drawn as zero, and never as "just now".
 *
 * - **That column has a maintenance gap, so the surface says what it measures.** Four functions
 *   put a conversation into `needs_human`, and three of them stamp the column: `enter_needs_human`
 *   (20260817000001:1447), `enter_needs_human_with_message` (20260904000003:231) and
 *   `record_tripwire_signal` (20260819000001:888-894). The fourth,
 *   `append_consumer_conversation_turn` (20260918000001:76), sets the status and the reason and
 *   never touches the stamp. Release does not clear it either: all three release paths
 *   (20260817000001:1559, 20260819000001:1006, 20260914000003:221) hand the thread back to the
 *   agent and leave `needs_human_at` where it was, and only the resume path at
 *   20260817000001:1599 nulls it. So a thread that was escalated once, handled, handed back, and
 *   escalated again through the consumer path carries the first handoff's stamp, and its wait
 *   reads longer than it has been. There is no honest way to detect that from here -- a lead who
 *   nudges while waiting makes a legitimate stamp look stale by exactly the same test -- so the
 *   panel states in one sentence what the clock is measured from, and the fix belongs in the
 *   migration rather than in a hedge on every row.
 *
 * - **The handoff rules are the `convo_status_reason` enum, not a settings table.** Nothing stores
 *   a per-coach escalation rule, so there is nothing to toggle, nothing to add in plain words, and
 *   no hit rate over any window: what a thread's reason column recorded is knowable, what fired
 *   last week on a thread that has since resumed is not, because resuming clears the reason. The
 *   counts here are therefore counts of the threads waiting right now, and `handoffs.basis` is the
 *   sentence that says so.
 */

import type { ConversationRead } from "@/lib/repositories/conversations";

export type EscalationHandoff = {
  /** The `convo_status_reason` value the escalation RPCs write. */
  reason: string;
  label: string;
  /** What the platform does when this fires, in the coach's language. */
  behaviour: string;
};

/**
 * The reasons a handoff is actually written with, in the order the migration lists them.
 *
 * `convo_status_reason` has sixteen arms and most of them are closing reasons -- `booked`,
 * `hard_dq`, `stop_keyword`, `human_closed` -- that a conversation carries on its way out rather
 * than on its way to a person. These five are the ones the escalation writers actually set:
 * `enter_needs_human_with_message` rejects anything outside this list, `enter_needs_human` is
 * called with the same set, `record_tripwire_signal` writes the two tripwire arms, and
 * `append_consumer_conversation_turn` writes `no_match_threshold`.
 *
 * This list is a description, never a filter. Whatever reason a queued thread is actually
 * carrying gets a row -- see `handoffFor` and the panel's `handoffRows` -- so an arm this build
 * has not been taught cannot disappear from the one page whose job is explaining why a thread was
 * handed over.
 */
export const ESCALATION_HANDOFFS: readonly EscalationHandoff[] = [
  {
    reason: "lead_requested_human",
    label: "The lead asked for a person",
    behaviour: "The agent stops and the thread comes to you. It does not try to talk them out of it.",
  },
  {
    reason: "no_match_threshold",
    label: "The Brain had no grounded answer",
    behaviour: "Nothing in the brain answered closely enough, so the agent hands over instead of guessing.",
  },
  {
    reason: "output_check_failed",
    label: "The drafted reply failed its own check",
    behaviour: "The reply was never sent to the lead. The thread comes to you with the last exchange intact.",
  },
  {
    reason: "tripwire_repeated",
    label: "A tripwire fired more than once",
    behaviour: "One trip is handled in the thread. A repeat is a person's call, so the agent pauses.",
  },
  {
    reason: "tripwire_escalate",
    label: "A tripwire that always needs a person",
    behaviour: "The agent pauses on the first hit and does not resume on its own.",
  },
] as const;

const HANDOFF_BY_REASON = new Map(ESCALATION_HANDOFFS.map((rule) => [rule.reason, rule]));

/** A reason the enum grew that this module has not been taught. Said plainly, never hidden. */
export function unknownHandoff(reason: string): EscalationHandoff {
  const words = reason.trim().replace(/[_-]+/gu, " ").toLowerCase();
  return {
    reason,
    label: words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Reason not recorded",
    behaviour: "SetterFi has not published what this one does yet. Ask your success owner.",
  };
}

export function handoffFor(reason: string | null): EscalationHandoff | null {
  if (!reason) return null;
  return HANDOFF_BY_REASON.get(reason) ?? unknownHandoff(reason);
}

export type EscalationRow = {
  conversationId: string;
  leadName: string;
  channel: ConversationRead["channel"];
  /** The last thing anyone said on the thread, which is usually why it escalated. */
  lastMessage: string | null;
  /** Null when the thread carries no reason column, which the row says rather than guesses. */
  handoff: EscalationHandoff | null;
  /** Null whenever the wait cannot be computed. Never zero standing in for unknown. */
  waitSeconds: number | null;
  waitingSince: string | null;
};

export type EscalationHandoffCount = {
  handoff: EscalationHandoff;
  waiting: number;
  /** Share of the waiting threads, 0-100. Derived from the same list, never stored. */
  share: number;
};

export type EscalationQueue = {
  asOf: string | null;
  rows: readonly EscalationRow[];
  waiting: number;
  /** The longest wait in the queue, or null when no row in it has a readable clock. */
  longestWaitSeconds: number | null;
  /** How many rows could not be given a clock. Rendered whenever it is above zero. */
  waitsNotRecorded: number;
  handoffs: {
    counts: readonly EscalationHandoffCount[];
    /** What the counts are counts of. The surface renders this rather than inventing a window. */
    basis: string;
  };
  /** What the order means, in words, because it is not what the reader may assume it is. */
  rankedBy: string;
};

export const ESCALATION_RANKED_BY =
  "Longest wait first. Nothing here stores a reply promise, so the order is how long each lead has "
  + "been waiting and nothing else.";

export const ESCALATION_HANDOFF_BASIS =
  "Counted across the threads waiting on you right now. Resuming a thread clears its reason, so "
  + "there is no record to count a past week from.";

/**
 * What a row says when `escalationWaitSeconds` cannot answer.
 *
 * "not measured" rather than "not recorded", because null has four causes and only one of them is
 * a missing stamp: the column can be unset, the page can have no server instant, either value can
 * fail to parse, and the stamp can sit ahead of the clock. Naming the missing stamp would report a
 * diagnosis the queue has not made -- in the skew case the stamp exists and it is the measurement
 * that failed. See `escalationWaitSeconds`.
 */
export const ESCALATION_WAIT_ABSENT = "wait not measured";

/**
 * What the clock is measured from, said once on the panel rather than hedged on every row.
 *
 * The second sentence is not defensive writing: one of the four escalation paths does not stamp
 * the column and none of the release paths clear it, so on a thread that has been handed over
 * before, this number can be older than the handoff the coach is looking at.
 *
 * The third sentence is what makes one disclosure honest rather than merely brief. `waitSeconds`
 * is the tile, the clock on every row, and the sort key all at once, so a caveat that read as
 * though it governed only the tile left the ranking uncovered -- and the ranking is where a coach
 * actually decides, since triaging longest-wait-first means trusting the order itself. Saying it
 * once here beats a cue per row, which would put the hedge in front of the lead's name on every
 * thread in the queue.
 */
export const ESCALATION_CLOCK_BASIS =
  "Measured from the moment the agent handed the thread over. A thread that has been handed over "
  + "more than once can still read from the earlier handoff, so treat a very long wait as a "
  + "question for your success owner rather than as a fact. Every wait below reads from that same "
  + "clock, and so does the order these threads are in.";

/**
 * Seconds a thread has been waiting, or null when that cannot be answered.
 *
 * A stamp ahead of the clock is null rather than zero: it means the two clocks disagree, and
 * "0s" would report a disagreement as an answer.
 *
 * The four causes are deliberately indistinguishable to callers -- no stamp, no server instant,
 * an unparseable value, and a stamp ahead of the clock all return null -- so nothing downstream
 * may name one of them. Anything rendering an absence here says the wait was not measured, never
 * why. `ESCALATION_WAIT_ABSENT` carries that wording.
 */
export function escalationWaitSeconds(
  waitingSince: string | null,
  nowIso: string | null,
): number | null {
  if (!waitingSince || !nowIso) return null;
  const from = Date.parse(waitingSince);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(from) || !Number.isFinite(now)) return null;
  const seconds = Math.floor((now - from) / 1000);
  return seconds < 0 ? null : seconds;
}

/** Position in ESCALATION_HANDOFFS, or past the end for a reason this module has not been taught. */
function declaredOrder(reason: string) {
  const index = ESCALATION_HANDOFFS.findIndex((rule) => rule.reason === reason);
  return index === -1 ? ESCALATION_HANDOFFS.length : index;
}

function lastMessageBody(conversation: ConversationRead): string | null {
  const body = conversation.messages.at(-1)?.body?.trim();
  return body ? body : null;
}

/**
 * Builds the queue from whatever conversations the page already loaded.
 *
 * It reads the same rows the list renders, so the count in the strip and the rows beneath it
 * cannot disagree -- the failure `docs/DESIGN.md` names when it says every count renders from the
 * list it describes.
 */
export function escalationQueue(
  conversations: readonly ConversationRead[],
  nowIso: string | null,
): EscalationQueue {
  const rows = conversations
    .filter((conversation) => conversation.status === "needs_human")
    .map<EscalationRow>((conversation) => ({
      conversationId: conversation.id,
      leadName: conversation.contactName,
      channel: conversation.channel,
      lastMessage: lastMessageBody(conversation),
      handoff: handoffFor(conversation.statusReason),
      waitSeconds: escalationWaitSeconds(conversation.needsHumanAt ?? null, nowIso),
      waitingSince: conversation.needsHumanAt ?? null,
    }))
    .sort((left, right) => {
      // An unknown wait cannot be ranked against a known one, so it sits below every known one
      // rather than being treated as the newest thing in the queue.
      if (left.waitSeconds === null && right.waitSeconds === null) {
        return left.conversationId.localeCompare(right.conversationId);
      }
      if (left.waitSeconds === null) return 1;
      if (right.waitSeconds === null) return -1;
      return right.waitSeconds - left.waitSeconds
        || left.conversationId.localeCompare(right.conversationId);
    });

  const known = rows.map((row) => row.waitSeconds).filter((value): value is number => value !== null);

  const tally = new Map<string, { handoff: EscalationHandoff; waiting: number }>();
  for (const row of rows) {
    if (!row.handoff) continue;
    const entry = tally.get(row.handoff.reason) ?? { handoff: row.handoff, waiting: 0 };
    entry.waiting += 1;
    tally.set(row.handoff.reason, entry);
  }
  const counts = [...tally.values()]
    .map<EscalationHandoffCount>((entry) => ({
      handoff: entry.handoff,
      waiting: entry.waiting,
      share: rows.length === 0 ? 0 : (entry.waiting / rows.length) * 100,
    }))
    // Ties fall back to the order the migration lists the reasons in, so two equal counts do not
    // reorder themselves alphabetically between renders.
    .sort((left, right) => right.waiting - left.waiting
      || declaredOrder(left.handoff.reason) - declaredOrder(right.handoff.reason)
      || left.handoff.label.localeCompare(right.handoff.label));

  return {
    asOf: nowIso,
    rows,
    waiting: rows.length,
    longestWaitSeconds: known.length === 0 ? null : Math.max(...known),
    waitsNotRecorded: rows.length - known.length,
    handoffs: { counts, basis: ESCALATION_HANDOFF_BASIS },
    rankedBy: ESCALATION_RANKED_BY,
  };
}
