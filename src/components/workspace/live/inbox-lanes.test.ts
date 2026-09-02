import { describe, expect, it } from "vitest";

import {
  INBOX_HANDOFF_LANE_OFF,
  inboxHandoffRow,
  inboxLanes,
} from "@/components/workspace/live/inbox-lanes";
import type { AttentionItem } from "@/lib/operations/attention-queue";
import type { PlatformHumanConversation } from "@/lib/platform/conversation-projection";

function notice(id: string, openForMinutes: number, readAt: string | null = null): AttentionItem {
  return {
    id,
    kind: "channel.disconnected",
    severity: "critical",
    title: `Notice ${id}`,
    body: null,
    link: null,
    tenantId: `tenant-${id}`,
    tenantName: `Account ${id}`,
    assignedToMe: false,
    isTest: false,
    createdAt: "2026-08-31T09:00:00.000Z",
    readAt,
    openForMinutes,
    breachAt: null,
    minutesToBreach: null,
    ruleName: null,
    ruleDescription: null,
    ruleCategory: null,
    primaryAction: { availability: "not-available", command: null, endpoint: null, reason: "none" },
  };
}

function handoff(
  id: string,
  waitingSeconds: number,
  statusReason = "lead_requested_human",
): PlatformHumanConversation {
  return {
    conversationId: id,
    tenantId: `tenant-${id}`,
    tenantName: `Account ${id}`,
    channel: "instagram",
    status: "needs_human",
    statusReason,
    waitingSince: "2026-08-31T09:00:00.000Z",
    waitingSeconds,
  };
}

describe("inboxLanes ranking", () => {
  // One clock across a merged inbox: both lanes rank by how long a row has waited, and the page
  // has to say that is what the order means, because no response target exists to rank against.
  it("ranks each lane longest wait first and says what the order means", () => {
    const lanes = inboxLanes({
      queue: { items: [notice("a", 12), notice("b", 41), notice("c", 3)] },
      conversations: [handoff("x", 600), handoff("y", 2_460), handoff("z", 60)],
    });

    expect(lanes.system.map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(lanes.handoff.state).toBe("available");
    if (lanes.handoff.state !== "available") throw new Error("lane unavailable");
    expect(lanes.handoff.rows.map((row) => row.conversationId)).toEqual(["y", "x", "z"]);
    expect(lanes.rankedBy).toContain("Longest wait first");
    expect(lanes.rankedBy).toContain("promise");
  });

  it("reports the longest wait across both lanes and names the lane it came from", () => {
    const lanes = inboxLanes({
      queue: { items: [notice("a", 34)] },
      conversations: [handoff("x", 41 * 60)],
    });
    expect(lanes.longestWait).toEqual({ minutes: 41, lane: "handoff" });
  });

  // An unreadable wait cannot be ranked against a readable one and must not read as the newest row.
  it("sorts a handoff with an unreadable wait below every readable one", () => {
    const lanes = inboxLanes({
      queue: { items: [] },
      conversations: [
        { ...handoff("unknown", 0), waitingSeconds: -1 as unknown as number },
        handoff("known", 300),
      ],
    });
    if (lanes.handoff.state !== "available") throw new Error("lane unavailable");
    expect(lanes.handoff.rows.map((row) => row.conversationId)).toEqual(["known", "unknown"]);
    expect(lanes.handoff.rows[1].waitMinutes).toBeNull();
  });
});

describe("inboxLanes availability", () => {
  // An empty lane and a lane nobody could read are different facts. Counting the second as zero
  // would let a merged inbox quietly report half of itself as all of itself.
  it("carries a reason instead of an empty lane, and refuses to count it as zero", () => {
    const lanes = inboxLanes({ queue: { items: [notice("a", 5)] }, conversations: null });

    expect(lanes.handoff).toEqual({ state: "unavailable", reason: INBOX_HANDOFF_LANE_OFF });
    expect(lanes.waiting.handoff).toBeNull();
    expect(lanes.waiting.system).toBe(1);
  });

  it("counts an empty but readable lane as zero", () => {
    const lanes = inboxLanes({ queue: { items: [] }, conversations: [] });
    expect(lanes.waiting.handoff).toBe(0);
    expect(lanes.longestWait).toBeNull();
  });

  // read_at is the only per-row state the store keeps, and it means opened, not fixed.
  it("counts only unopened notices as waiting", () => {
    const lanes = inboxLanes({
      queue: { items: [notice("a", 5), notice("b", 6, "2026-08-31T10:00:00.000Z")] },
      conversations: [],
    });
    expect(lanes.waiting.system).toBe(1);
    expect(lanes.system).toHaveLength(2);
  });
});

describe("inboxHandoffRow", () => {
  // The cross-tenant projection refuses lead identity on purpose. The row is about an account.
  it("carries the account, the channel and the reason, and no lead identity", () => {
    const row = inboxHandoffRow(handoff("x", 2_460, "output_check_failed"));

    expect(row.tenantName).toBe("Account x");
    expect(row.channelLabel).toBe("Instagram");
    expect(row.handoff?.label).toBe("The drafted reply failed its own check");
    expect(row.waitMinutes).toBe(41);
    expect(Object.keys(row)).not.toContain("leadName");
  });

  it("describes a reason this build has not been taught rather than dropping the row", () => {
    const row = inboxHandoffRow(handoff("x", 60, "scope_exit_cap"));
    expect(row.handoff?.label).toBe("Scope exit cap");
  });
});
