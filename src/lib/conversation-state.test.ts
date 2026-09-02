import { describe, expect, it } from "vitest";

import {
  CONVERSATION_STATES,
  CONVERSATION_STATUS_REASONS,
  classifyMessageDelivery,
  decideBeforePrompt,
  enterNeedsHuman,
  type ConversationState,
  type ConversationStateSnapshot,
  type ConversationStatusReason,
} from "@/lib/conversation-state";
import { CONVERSATION_STATUSES } from "@/lib/repositories/conversations";

const reasonByState: Record<Exclude<ConversationState, "agent">, ConversationStatusReason> = {
  needs_human: "lead_requested_human",
  human: "lead_requested_human",
  nurture: "soft_dq",
  closed: "stale",
  scope_blocked: "scope_exit_cap",
  opted_out: "stop_keyword",
};

function snapshot(status: ConversationState): ConversationStateSnapshot {
  return {
    id: "conversation-1",
    tenantId: "tenant-a",
    status,
    statusReason: status === "agent" ? null : reasonByState[status],
    currentStepAsks: 2,
    unreadByCoach: false,
  };
}

describe("decideBeforePrompt", () => {
  it("covers the same seven states as live conversation reads", () => {
    expect(CONVERSATION_STATES).toEqual(CONVERSATION_STATUSES);
  });

  it("pins every persisted status reason used by services", () => {
    expect(CONVERSATION_STATUS_REASONS).toEqual([
      "lead_requested_human",
      "no_match_threshold",
      "output_check_failed",
      "tripwire_repeated",
      "tripwire_escalate",
      "tenant_suspended",
      "scope_exit_cap",
      "booked",
      "hard_dq",
      "soft_dq",
      "human_closed",
      "stale",
      "cadence_exhausted",
      "stop_keyword",
      "manual_dnc",
    ]);
  });

  it.each(CONVERSATION_STATES)("decides %s before prompt assembly", (status) => {
    const decision = decideBeforePrompt(snapshot(status));
    if (status === "agent") expect(decision.kind).toBe("run");
    else if (status === "nurture" || status === "closed") expect(decision.kind).toBe("resume");
    else expect(decision.kind).toBe("hold");
    expect(decision.currentStepAsks).toBe(2);
  });

  it.each(["needs_human", "human", "scope_blocked", "opted_out"] as const)(
    "exposes no prompt input or outbound command while %s",
    (status) => {
      const decision = decideBeforePrompt(snapshot(status));
      expect(decision).toMatchObject({ kind: "hold", status });
      expect(Object.keys(decision).sort()).toEqual([
        "currentStepAsks",
        "kind",
        "reason",
        "status",
      ]);
    },
  );

  it("rejects any state/reason pair the database equality check would reject", () => {
    expect(() =>
      decideBeforePrompt({ ...snapshot("agent"), statusReason: "stale" }),
    ).toThrow("CONVERSATION_STATUS_REASON_INVALID");
    expect(() =>
      decideBeforePrompt({ ...snapshot("closed"), statusReason: null }),
    ).toThrow("CONVERSATION_STATUS_REASON_INVALID");
  });

  it("classifies system rows as internal so they cannot reach a send adapter", () => {
    expect(classifyMessageDelivery("system")).toEqual({ kind: "internal", send: false });
    expect(classifyMessageDelivery("out")).toEqual({ kind: "channel", send: true });
  });
});

describe("enterNeedsHuman", () => {
  it("persists one holding message and returns the existing entry on replay", async () => {
    let entered = false;
    let calls = 0;
    const dependencies = {
      enter: async () => {
        calls += 1;
        if (entered) return { messageId: "holding-1", auditId: null, transitioned: false };
        entered = true;
        return { messageId: "holding-1", auditId: "audit-1", transitioned: true };
      },
      loadConversation: async () => ({
        ...snapshot("needs_human"),
        unreadByCoach: true,
      }),
    };
    const input = {
      conversationId: "conversation-1",
      reason: "output_check_failed" as const,
      holdingBody: "A person will follow up.",
      entryKey: "turn-1:held",
    };
    const first = await enterNeedsHuman("tenant-a", input, dependencies);
    const replay = await enterNeedsHuman("tenant-a", input, dependencies);
    expect(first).toMatchObject({ messageId: "holding-1", transitioned: true });
    expect(replay).toMatchObject({ messageId: "holding-1", transitioned: false });
    expect(calls).toBe(2);
  });
});
