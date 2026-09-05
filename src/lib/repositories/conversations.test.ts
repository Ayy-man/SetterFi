import { describe, expect, it } from "vitest";

import {
  CONVERSATION_STATUSES,
  CONVERSATION_VIEWS,
  conversationViewStatuses,
  countConversationsByView,
  getConversation,
  listConversations,
  listConversationSet,
  persistDeferredWithAudit,
  persistedTemplateApproved,
  sendAuditActorFor,
} from "@/lib/repositories/conversations";

const OBJECTION_ID = "8a000000-0000-4000-8000-000000000102";

const SYSTEM_ACTOR_SEND_ACTIONS = [
  "send.refused.suppressed",
  "send.refused.no_consent",
  "send.refused.window_expired",
  "followup.deferred.quiet_hours",
  "followup.discarded.window_closed",
  "followup.completed",
];

function row(id: string, tenantId = "tenant-a") {
  return {
    id,
    tenant_id: tenantId,
    contact_id: `contact-${id}`,
    channel: "sms" as const,
    status: "agent" as const,
    status_reason: null,
    taken_over_by: null,
    unread_by_coach: false,
    disclosure_pending: true,
    current_step_asks: 2,
    scope_attack_count: 1,
    tripwire_count: 0,
    tripwire_classes: [],
    cadence_anchor_at: "2026-08-17T11:59:00.000Z",
    last_lead_inbound_at: "2026-08-17T11:59:00.000Z",
    is_test: true,
    last_message_at: "2026-08-17T12:00:00.000Z",
    created_at: "2026-08-17T11:00:00.000Z",
    proposed_slots: null,
    proposed_slots_at: null,
    contact: {
      name: "Alex",
      credit_range: "prime",
      funding_goal: "50k_100k",
      timeline: "1_3_months",
      business_stage: "established",
      outcome: null,
    },
    tenant: { is_demo: true },
    messages: [
      {
        id: "message-2",
        direction: "system" as const,
        author: "system",
        body: "Internal state change",
        created_at: "2026-08-17T12:00:00.000Z",
        provider_message_id: null,
      },
      {
        id: "message-1",
        direction: "in" as const,
        author: "lead",
        body: "Hello",
        created_at: "2026-08-17T11:59:00.000Z",
        provider_message_id: "provider-message",
      },
    ],
    appointments: [],
  };
}

describe("listConversations", () => {
  it("requires tenant scope and rejects a mismatched service-role row", async () => {
    await expect(
      listConversations("tenant-a", {}, async () => [row("one", "tenant-b")]),
    ).rejects.toThrow("CONVERSATION_TENANT_MISMATCH");
  });

  it("returns stable pagination and persisted ask count without step-advance behavior", async () => {
    const result = await listConversations(
      "tenant-a",
      { limit: 1 },
      async () => [row("conversation-b"), row("conversation-a")],
    );

    expect(result.items[0]).toMatchObject({
      id: "conversation-b",
      currentStepAsks: 2,
      scopeAttackCount: 1,
      tripwireCount: 0,
      isDemo: true,
      isTest: true,
    });
    expect(result.items[0].messages.map((message) => message.id)).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(result.items[0].messages[1].delivered).toBe(false);
    expect(result.nextCursor).toEqual({
      lastActivityAt: "2026-08-17T12:00:00.000Z",
      id: "conversation-b",
    });
  });

  it("carries the captured business stage into the rail's qualification block", async () => {
    const result = await listConversations(
      "tenant-a",
      { limit: 1 },
      async () => [row("conversation-a")],
    );

    expect(result.items[0].qualification).toMatchObject({ business: "established" });
  });

  it("reads a well-formed proposed-slots proposal into the rail's booking-status field", async () => {
    const proposal = {
      calendarConnectionId: "calendar-1",
      rangeStartAt: "2026-08-18T00:00:00.000Z",
      rangeEndAt: "2026-08-25T00:00:00.000Z",
      proposedAt: "2026-08-17T12:00:00.000Z",
      presentationTimezone: "America/New_York",
      slots: [
        { id: "slot-1", startAt: "2026-08-18T14:00:00.000Z", endAt: "2026-08-18T14:30:00.000Z",
          timezone: "America/New_York", display: "Tue 10:00am ET" },
      ],
    };
    const result = await listConversations(
      "tenant-a",
      { limit: 1 },
      async () => [{ ...row("conversation-a"), proposed_slots: proposal }],
    );

    expect(result.items[0].proposedSlots).toEqual(proposal);
  });

  it("drops a malformed proposed-slots row to null instead of guessing at its shape", async () => {
    const result = await listConversations(
      "tenant-a",
      { limit: 1 },
      async () => [{ ...row("conversation-a"), proposed_slots: { slots: "not-an-array" } }],
    );

    expect(result.items[0].proposedSlots).toBeNull();
  });

  it("carries the objection filter to the page source alongside cursor and limit", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const resolverCalls: Array<[string, string]> = [];
    const result = await listConversations(
      "tenant-a",
      { limit: 10, objectionId: OBJECTION_ID },
      async (input) => { calls.push(input); return [row("conversation-a")]; },
      async (tenantId, objectionId) => {
        resolverCalls.push([tenantId, objectionId]);
        return ["conversation-a"];
      },
    );

    expect(resolverCalls).toEqual([["tenant-a", OBJECTION_ID]]);
    expect(calls).toEqual([{
      tenantId: "tenant-a",
      cursor: null,
      limit: 10,
      conversationIds: ["conversation-a"],
    }]);
    expect(result.items.map((item) => item.id)).toEqual(["conversation-a"]);
  });

  it("returns an empty page for an unknown objection rather than an unfiltered one", async () => {
    // The failure this pins is the one that matters: a filter that silently degrades to "no
    // filter" would show a coach every conversation they own under a label claiming otherwise.
    let sourceCalls = 0;
    const result = await listConversations(
      "tenant-a",
      { objectionId: OBJECTION_ID },
      async () => { sourceCalls += 1; return [row("conversation-a")]; },
      async () => [],
    );

    expect(result).toEqual({ items: [], nextCursor: null });
    expect(sourceCalls).toBe(0);
  });

  it("keeps the tenant guard in force behind the filter", async () => {
    await expect(listConversations(
      "tenant-a",
      { objectionId: OBJECTION_ID },
      async () => [row("conversation-a", "tenant-b")],
      async () => ["conversation-a"],
    )).rejects.toThrow("CONVERSATION_TENANT_MISMATCH");
  });

  it("leaves every existing call site untouched when no objection is asked for", async () => {
    // New coverage rather than red: the option is optional, so the input shape a call site
    // without it produces must be byte-identical to today's.
    const calls: Array<Record<string, unknown>> = [];
    let resolverCalls = 0;
    await listConversations(
      "tenant-a",
      { limit: 25 },
      async (input) => { calls.push(input); return [row("conversation-a")]; },
      async () => { resolverCalls += 1; return []; },
    );

    expect(calls).toEqual([{ tenantId: "tenant-a", cursor: null, limit: 25 }]);
    expect(resolverCalls).toBe(0);
  });

  it("resolves the three inbox views to the right status set", () => {
    expect(CONVERSATION_VIEWS).toEqual(["needs_you", "agent_handling", "everything"]);
    expect(conversationViewStatuses("needs_you")).toEqual(["needs_human", "human", "scope_blocked"]);
    expect(conversationViewStatuses("agent_handling")).toEqual(["agent"]);
    expect(conversationViewStatuses("everything")).toBeNull();
  });

  it("carries the view filter to the page source as a status list", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await listConversations(
      "tenant-a",
      { limit: 10, view: "needs_you" },
      async (input) => { calls.push(input); return [row("conversation-a")]; },
    );

    expect(calls).toEqual([{
      tenantId: "tenant-a",
      cursor: null,
      limit: 10,
      statuses: ["needs_human", "human", "scope_blocked"],
    }]);
    expect(result.items.map((item) => item.id)).toEqual(["conversation-a"]);
  });

  it("asks for no status filter at all on the everything view", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await listConversations(
      "tenant-a",
      { limit: 10, view: "everything" },
      async (input) => { calls.push(input); return [row("conversation-a")]; },
    );

    expect(calls).toEqual([{ tenantId: "tenant-a", cursor: null, limit: 10 }]);
  });

  it("carries the view filter through listConversationSet the same way", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const items = await listConversationSet(
      "tenant-a",
      { view: "agent_handling" },
      async (input) => { calls.push(input); return [row("conversation-a")]; },
    );

    expect(calls).toEqual([{
      tenantId: "tenant-a",
      cursor: null,
      limit: 100,
      statuses: ["agent"],
    }]);
    expect(items.map((item) => item.id)).toEqual(["conversation-a"]);
  });

  it("pins all seven persisted states for schema drift", () => {
    expect(CONVERSATION_STATUSES).toEqual([
      "agent",
      "needs_human",
      "human",
      "nurture",
      "closed",
      "scope_blocked",
      "opted_out",
    ]);
  });
});

describe("getConversation", () => {
  it("carries the tenant's enabled question-set size alongside the qualification block", async () => {
    const conversation = await getConversation(
      "tenant-a",
      "conversation-a",
      "user-a",
      async () => row("conversation-a"),
      async (tenantId, actorId) => {
        expect(tenantId).toBe("tenant-a");
        expect(actorId).toBe("user-a");
        return 6;
      },
    );
    expect(conversation).toMatchObject({ id: "conversation-a", questionSetSize: 6 });
  });

  it("returns null without reading the question set for a conversation that does not exist", async () => {
    let questionSetSizeCalls = 0;
    const conversation = await getConversation(
      "tenant-a",
      "conversation-a",
      "user-a",
      async () => null,
      async () => { questionSetSizeCalls += 1; return 6; },
    );
    expect(conversation).toBeNull();
    expect(questionSetSizeCalls).toBe(0);
  });
});

describe("countConversationsByView", () => {
  it("counts every lane from one status read, summing to everything", async () => {
    const statuses = [
      "agent", "agent", "needs_human", "human", "human", "scope_blocked", "nurture", "closed",
      "opted_out",
    ] as const;
    const counts = await countConversationsByView("tenant-a", async (tenantId) => {
      expect(tenantId).toBe("tenant-a");
      return statuses;
    });
    expect(counts).toEqual({
      needs_you: 4, // needs_human, human, human, scope_blocked
      agent_handling: 2, // agent, agent
      everything: statuses.length,
    });
  });

  it("counts a quiet tenant as zero in every lane, not an absent read", async () => {
    const counts = await countConversationsByView("tenant-a", async () => []);
    expect(counts).toEqual({ needs_you: 0, agent_handling: 0, everything: 0 });
  });

  it("requires a non-blank tenant", async () => {
    await expect(countConversationsByView("  ", async () => []))
      .rejects.toThrow("EXPECTED_TENANT_REQUIRED");
  });
});

describe("sendAuditActorFor", () => {
  it("drops the attempting coach out of actor_id and into the payload for all six system keys", () => {
    for (const action of SYSTEM_ACTOR_SEND_ACTIONS) {
      expect(sendAuditActorFor(action, "20000000-0000-4000-8000-000000000030")).toEqual({
        actorId: null,
        attemptedBy: "20000000-0000-4000-8000-000000000030",
      });
    }
  });

  it("carries no attemptedBy when the AI cadence path supplies no actor", () => {
    for (const action of SYSTEM_ACTOR_SEND_ACTIONS) {
      expect(sendAuditActorFor(action, null)).toEqual({ actorId: null, attemptedBy: null });
      expect(sendAuditActorFor(action, undefined)).toEqual({ actorId: null, attemptedBy: null });
    }
  });

  it("refuses a key outside the set rather than silently nulling a human-registered actor", () => {
    expect(() => sendAuditActorFor("conversation.takeover.claimed", "coach-1")).toThrow(
      "SEND_AUDIT_ACTION_UNREGISTERED:conversation.takeover.claimed",
    );
  });
});

describe("persistedTemplateApproved", () => {
  const template = {
    kind: "approved_template" as const,
    templateKey: "template-1",
    variables: {},
  };

  it("accepts only the exact persisted approved template", () => {
    expect(persistedTemplateApproved(template, { id: "template-1", status: "approved" })).toBe(true);
    expect(persistedTemplateApproved(template, { id: "template-2", status: "approved" })).toBe(false);
    expect(persistedTemplateApproved(template, { id: "template-1", status: "draft" })).toBe(false);
    expect(persistedTemplateApproved(template, null)).toBe(false);
  });

  it("does not apply the template approval gate to freeform content", () => {
    expect(persistedTemplateApproved({ kind: "freeform", body: "Hello" }, null)).toBe(true);
  });
});

describe("persistDeferredWithAudit", () => {
  it("returns the followup and its audit id when both writes land", async () => {
    const calls: string[] = [];
    const result = await persistDeferredWithAudit({
      insertFollowup: async () => {
        calls.push("insert");
        return "followup-1";
      },
      insertAudit: async () => {
        calls.push("audit");
        return 77;
      },
      deleteFollowup: async () => {
        calls.push("delete");
      },
    });

    expect(result).toEqual({ followupId: "followup-1", auditId: 77 });
    expect(calls).toEqual(["insert", "audit"]);
  });

  it("deletes the scheduled followup after a failed audit write and rethrows", async () => {
    const calls: string[] = [];
    const deleted: string[] = [];

    await expect(
      persistDeferredWithAudit({
        insertFollowup: async () => {
          calls.push("insert");
          return "followup-2";
        },
        insertAudit: async () => {
          calls.push("audit");
          throw new Error("SEND_AUDIT_WRITE_FAILED");
        },
        deleteFollowup: async (followupId) => {
          calls.push("delete");
          deleted.push(followupId);
        },
      }),
    ).rejects.toThrow("SEND_AUDIT_WRITE_FAILED");

    expect(deleted).toEqual(["followup-2"]);
    expect(calls.indexOf("delete")).toBeGreaterThan(calls.indexOf("audit"));
  });

  it("names the orphan when compensation itself fails, so an operator is told rather than left to infer", async () => {
    await expect(
      persistDeferredWithAudit({
        insertFollowup: async () => "followup-3",
        insertAudit: async () => {
          throw new Error("SEND_AUDIT_WRITE_FAILED");
        },
        deleteFollowup: async () => {
          throw new Error("PGRST-boom");
        },
      }),
    ).rejects.toThrow("SEND_DEFERRAL_COMPENSATION_FAILED:followup-3");
  });

  it("returns null without an audit write when the followup insert is refused", async () => {
    const calls: string[] = [];
    const result = await persistDeferredWithAudit({
      insertFollowup: async () => null,
      insertAudit: async () => {
        calls.push("audit");
        return 1;
      },
      deleteFollowup: async () => {
        calls.push("delete");
      },
    });

    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });
});
