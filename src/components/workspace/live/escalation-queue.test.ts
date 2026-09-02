import { describe, expect, it } from "vitest";

import {
  ESCALATION_HANDOFFS,
  escalationQueue,
  escalationWaitSeconds,
  handoffFor,
} from "@/components/workspace/live/escalation-queue";
import type { ConversationRead } from "@/lib/repositories/conversations";

function thread(overrides: Partial<ConversationRead> & { id: string }): ConversationRead {
  return {
    contactId: `contact-${overrides.id}`,
    contactName: "Marcus T.",
    channel: "instagram",
    status: "needs_human",
    statusReason: "lead_requested_human",
    needsHumanAt: null,
    takenOverBy: null,
    unreadByCoach: false,
    disclosurePending: false,
    currentStepAsks: 2,
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-08-30T10:00:00.000Z",
    qualification: { credit: null, goal: null, timeline: null, outcome: null },
    appointment: null,
    messages: [],
    ...overrides,
  };
}

const NOW = "2026-08-30T12:00:00.000Z";

describe("escalationWaitSeconds", () => {
  // Honest states: a wait that cannot be computed is absent, never zero and never "just now".
  it("returns null rather than zero when the handoff stamp is missing or unreadable", () => {
    expect(escalationWaitSeconds(null, NOW)).toBeNull();
    expect(escalationWaitSeconds("not a timestamp", NOW)).toBeNull();
    expect(escalationWaitSeconds("2026-08-30T11:00:00.000Z", null)).toBeNull();
  });

  // A stamp ahead of the clock means the two clocks disagree; reporting 0s would call that an
  // answer.
  it("returns null when the handoff stamp is ahead of the clock", () => {
    expect(escalationWaitSeconds("2026-08-30T12:05:00.000Z", NOW)).toBeNull();
  });

  it("measures against the supplied instant, never the wall clock", () => {
    expect(escalationWaitSeconds("2026-08-30T11:38:00.000Z", NOW)).toBe(22 * 60);
  });
});

describe("escalationQueue ranking", () => {
  // The queue ranks by wait, because no promise exists to rank by. The sentence has to say so.
  it("ranks longest wait first and says that is what the order means", () => {
    const queue = escalationQueue([
      thread({ id: "b", needsHumanAt: "2026-08-30T11:51:00.000Z" }),
      thread({ id: "a", needsHumanAt: "2026-08-30T11:38:00.000Z" }),
      thread({ id: "c", needsHumanAt: "2026-08-30T11:56:00.000Z" }),
    ], NOW);

    expect(queue.rows.map((row) => row.conversationId)).toEqual(["a", "b", "c"]);
    expect(queue.rankedBy).toContain("Longest wait first");
    expect(queue.rankedBy).toContain("promise");
  });

  // An unknown wait cannot be ranked against a known one, so it must not read as the newest row.
  it("sorts threads with no recorded wait below every thread that has one", () => {
    const queue = escalationQueue([
      thread({ id: "unknown", needsHumanAt: null }),
      thread({ id: "known", needsHumanAt: "2026-08-30T11:59:00.000Z" }),
    ], NOW);

    expect(queue.rows.map((row) => row.conversationId)).toEqual(["known", "unknown"]);
    expect(queue.rows[1].waitSeconds).toBeNull();
    expect(queue.waitsNotRecorded).toBe(1);
  });

  it("only queues threads waiting on a person", () => {
    const queue = escalationQueue([
      thread({ id: "waiting" }),
      thread({ id: "agent", status: "agent", statusReason: null }),
      thread({ id: "held", status: "human", statusReason: "human_takeover" }),
    ], NOW);

    expect(queue.rows.map((row) => row.conversationId)).toEqual(["waiting"]);
    expect(queue.waiting).toBe(1);
  });

  it("reports no longest wait at all when nothing in the queue has a readable clock", () => {
    const queue = escalationQueue([thread({ id: "a" }), thread({ id: "b" })], NOW);
    expect(queue.longestWaitSeconds).toBeNull();
    expect(queue.waitsNotRecorded).toBe(2);
  });
});

describe("escalationQueue handoffs", () => {
  // No hardcoded hit rate: every count and share is derived from the rows in the queue.
  it("counts handoffs from the queued rows and shares them against the queue depth", () => {
    const queue = escalationQueue([
      thread({ id: "a", statusReason: "lead_requested_human", needsHumanAt: "2026-08-30T11:00:00.000Z" }),
      thread({ id: "b", statusReason: "lead_requested_human", needsHumanAt: "2026-08-30T11:10:00.000Z" }),
      thread({ id: "c", statusReason: "no_match_threshold", needsHumanAt: "2026-08-30T11:20:00.000Z" }),
      thread({ id: "d", statusReason: "no_match_threshold", needsHumanAt: "2026-08-30T11:30:00.000Z" }),
    ], NOW);

    expect(queue.handoffs.counts.map((count) => [count.handoff.reason, count.waiting, count.share]))
      .toEqual([
        ["lead_requested_human", 2, 50],
        ["no_match_threshold", 2, 50],
      ]);
    expect(queue.handoffs.basis).toContain("waiting on you right now");
  });

  it("leaves a thread with no recorded reason out of the counts rather than bucketing it", () => {
    const queue = escalationQueue([
      thread({ id: "a", statusReason: null }),
      thread({ id: "b", statusReason: "lead_requested_human" }),
    ], NOW);

    expect(queue.rows.find((row) => row.conversationId === "a")?.handoff).toBeNull();
    expect(queue.handoffs.counts).toHaveLength(1);
    expect(queue.handoffs.counts[0].waiting).toBe(1);
  });
});

describe("handoffFor", () => {
  it("describes every reason the escalation RPC accepts", () => {
    // Pinned to the migration: enter_needs_human_with_message rejects anything outside this set.
    expect(ESCALATION_HANDOFFS.map((rule) => rule.reason)).toEqual([
      "lead_requested_human",
      "no_match_threshold",
      "output_check_failed",
      "tripwire_repeated",
      "tripwire_escalate",
    ]);
    for (const rule of ESCALATION_HANDOFFS) {
      expect(handoffFor(rule.reason)).toEqual(rule);
    }
  });

  it("says plainly that an unpublished reason is unpublished instead of inventing behaviour", () => {
    const handoff = handoffFor("scope_exit_cap");
    expect(handoff?.label).toBe("Scope exit cap");
    expect(handoff?.behaviour).toContain("not published");
  });

  it("has nothing to say about a thread with no reason", () => {
    expect(handoffFor(null)).toBeNull();
  });

  // The published list is a description, not a filter. `convo_status_reason` has sixteen arms and
  // this build knows five, so an arm it has never seen must still reach the queue and be counted:
  // vanishing from the page that explains handoffs is the worst outcome here.
  it("counts a reason the build has never seen instead of dropping the thread", () => {
    const queue = escalationQueue([
      thread({ id: "a", statusReason: "tenant_suspended", needsHumanAt: "2026-08-30T11:00:00.000Z" }),
      thread({ id: "b", statusReason: "lead_requested_human", needsHumanAt: "2026-08-30T11:30:00.000Z" }),
    ], NOW);

    expect(queue.rows.map((row) => row.handoff?.reason))
      .toEqual(["tenant_suspended", "lead_requested_human"]);
    expect(queue.handoffs.counts.map((count) => count.handoff.reason))
      .toContain("tenant_suspended");
    // An unpublished arm sorts after the published ones on a tie rather than leading the list.
    expect(queue.handoffs.counts.at(-1)?.handoff.reason).toBe("tenant_suspended");
  });
});
