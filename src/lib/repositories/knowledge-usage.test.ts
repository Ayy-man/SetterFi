import { describe, expect, it, vi } from "vitest";

import { recordVerifiedCitationUsage, type KnowledgeUsageDependencies } from "./knowledge-usage";

const INPUT = {
  tenantId: "tenant-1",
  conversationId: "conversation-1",
  agentMessageId: "agent-message-1",
  knowledgeEntryId: "entry-1",
};

function dependencies(overrides: Partial<KnowledgeUsageDependencies> = {}) {
  const rows = new Map<string, string>();
  const deps: KnowledgeUsageDependencies = {
    loadAgentMessage: vi.fn(async () => ({
      conversationId: "conversation-1", createdAt: "2026-09-06T10:00:00.000Z", isTest: false,
    })),
    findEvent: vi.fn(async (key) => {
      const id = rows.get(JSON.stringify(key));
      return id ? { eventId: id } : null;
    }),
    insertEvent: vi.fn(async (row) => {
      const key = { tenantId: row.tenantId, conversationId: row.conversationId, knowledgeEntryId: row.knowledgeEntryId, usedAt: row.usedAt };
      const id = `event-${rows.size + 1}`;
      rows.set(JSON.stringify(key), id);
      return { eventId: id };
    }),
    ...overrides,
  };
  return { deps, rows };
}

describe("recordVerifiedCitationUsage", () => {
  it("writes one row keyed on the agent message's own instant and replays it on retry", async () => {
    const { deps, rows } = dependencies();
    const first = await recordVerifiedCitationUsage(INPUT, deps);
    const retry = await recordVerifiedCitationUsage(INPUT, deps);
    expect(first).toEqual({ state: "recorded", eventId: "event-1" });
    expect(retry).toEqual({ state: "replayed", eventId: "event-1" });
    expect(rows.size).toBe(1);
    expect(deps.insertEvent).toHaveBeenCalledTimes(1);
    expect(deps.insertEvent).toHaveBeenCalledWith({
      tenantId: "tenant-1", conversationId: "conversation-1", knowledgeEntryId: "entry-1",
      usedAt: "2026-09-06T10:00:00.000Z", isTest: false,
    });
  });

  it("carries the conversation's test flag onto the event so analytics can exclude it", async () => {
    const { deps } = dependencies({
      loadAgentMessage: async () => ({ conversationId: "conversation-1", createdAt: "2026-09-06T10:00:00.000Z", isTest: true }),
    });
    await recordVerifiedCitationUsage(INPUT, deps);
    expect(deps.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ isTest: true }));
  });

  it("reports a deleted knowledge entry as skipped instead of failing the receipt", async () => {
    const { deps } = dependencies({ insertEvent: async () => ({ missingEntry: true }) });
    await expect(recordVerifiedCitationUsage(INPUT, deps)).resolves.toEqual({
      state: "skipped", reason: "knowledge_entry_missing",
    });
  });

  it("refuses a message that belongs to another conversation before writing anything", async () => {
    const { deps } = dependencies({
      loadAgentMessage: async () => ({ conversationId: "conversation-2", createdAt: "2026-09-06T10:00:00.000Z", isTest: false }),
    });
    await expect(recordVerifiedCitationUsage(INPUT, deps)).rejects.toThrow("KNOWLEDGE_USAGE_CONVERSATION_MISMATCH");
    expect(deps.findEvent).not.toHaveBeenCalled();
    expect(deps.insertEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["tenant", { tenantId: " " }, "EXPECTED_TENANT_REQUIRED"],
    ["message", { agentMessageId: "" }, "KNOWLEDGE_USAGE_MESSAGE_REQUIRED"],
    ["entry", { knowledgeEntryId: "" }, "KNOWLEDGE_USAGE_ENTRY_REQUIRED"],
  ])("requires a %s id", async (_label, overrides, code) => {
    const { deps } = dependencies();
    await expect(recordVerifiedCitationUsage({ ...INPUT, ...overrides }, deps)).rejects.toThrow(code);
    expect(deps.loadAgentMessage).not.toHaveBeenCalled();
  });
});
