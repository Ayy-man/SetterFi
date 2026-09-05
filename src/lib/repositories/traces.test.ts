import { describe, expect, it } from "vitest";

import {
  TRACE_OUTCOMES,
  writeMessageTrace,
  type MessageTrace,
} from "@/lib/repositories/traces";

const trace: MessageTrace = {
  outcome: "successful",
  brainVersion: 4,
  offerVersion: 2,
  brainContentHash: "a".repeat(64),
  offerContentHash: "b".repeat(64),
  promptHash: "prompt-hash",
  ruleFired: null,
  retrievedEntryIds: ["entry-1"],
  retrievalCandidates: [{
    entryId: "entry-1",
    similarity: 0.8,
    categoryBoost: 0.05,
    score: 0.85,
    categoryAgreement: true,
  }],
  declaredEntryId: "entry-1",
  citationVerified: true,
  droppedEntryIds: ["entry-dropped"],
  numberSources: [{ kind: "brain_entry", value: "600" }],
  checks: [{ class: "NUM", passed: true }],
  violations: [],
  rejectedDrafts: [],
  model: "mock-generator",
  params: {},
  latencyMs: 10,
  usage: { totalTokens: 12 },
  cost: null,
  moderatorState: "allowed",
  moderatorClass: "JUDGE",
  moderatorRuleId: null,
  moderatorModelConfigId: "10000000-0000-4000-8000-000000000002",
  objection: null,
};

function dependencies(tenantId = "tenant-a") {
  const calls: Array<{ kind: string; value: unknown }> = [];
  return {
    calls,
    recordAgentTurn: async (args: Record<string, unknown>) => {
      calls.push({ kind: "rpc", value: args });
      return "message-1";
    },
    loadMessageLink: async (messageId: string) => ({
      messageId,
      tenantId,
      conversationId: "conversation-1",
    }),
    insertTrace: async (row: Record<string, unknown>) => {
      calls.push({ kind: "trace", value: row });
      return {
        messageId: String(row.message_id),
        tenantId: String(row.tenant_id),
        brainVersion: row.brain_version as number | null,
        offerVersion: row.offer_version as number | null,
        offerContentHash: row.offer_content_hash as string | null,
        promptHash: row.prompt_hash as string | null,
        ruleFired: row.rule_fired as string | null,
        retrievedEntryIds: row.retrieved_entry_ids as string[],
        retrievalCandidates: row.retrieval_candidates,
        declaredEntryId: row.declared_entry_id as string | null,
        citationVerified: Boolean(row.citation_verified),
        droppedEntryIds: row.dropped_entry_ids as string[],
        numberSources: row.number_sources,
        checks: row.checks,
        violations: row.violations,
        rejectedDrafts: row.rejected_drafts,
        model: row.model as string | null,
        params: row.params,
        latencyMs: row.latency_ms as number | null,
        usage: row.usage,
        cost: row.cost as number | null,
        moderatorState: row.moderator_state as string | null,
        moderatorClass: row.moderator_class as string | null,
        moderatorRuleId: row.moderator_rule_id as string | null,
        moderatorModelConfigId: row.moderator_model_config_id as string | null,
        objectionSnapshotId: (row.objection_snapshot_id as string | undefined) ?? null,
        objectionId: (row.objection_id as string | undefined) ?? null,
        objectionHandlingOutcome: (row.objection_handling_outcome as string | undefined) ?? null,
        objectionHardGate: (row.objection_hard_gate as boolean | undefined) ?? null,
        trace: row.trace,
      };
    },
  };
}

describe("writeMessageTrace", () => {
  it.each(TRACE_OUTCOMES)("uses the same trace path for %s turns", async (outcome) => {
    const deps = dependencies();
    await writeMessageTrace(
      "tenant-a",
      {
        kind: "agent_turn",
        conversationId: "conversation-1",
        body: "Reply",
        provider: "mock",
        providerMessageId: `provider-${outcome}`,
        disclosureConsumed: false,
      },
      { ...trace, outcome },
      deps,
    );

    expect(deps.calls.map((call) => call.kind)).toEqual(["rpc", "trace"]);
    expect(deps.calls[0].value).toMatchObject({ p_expected_tenant: "tenant-a" });
    expect(deps.calls[1].value).toEqual({
      message_id: "message-1",
      tenant_id: "tenant-a",
      brain_version: 4,
      offer_version: 2,
      prompt_hash: "prompt-hash",
      rule_fired: null,
      retrieved_entry_ids: ["entry-1"],
      offer_content_hash: "b".repeat(64),
      retrieval_candidates: trace.retrievalCandidates,
      declared_entry_id: "entry-1",
      citation_verified: true,
      dropped_entry_ids: ["entry-dropped"],
      number_sources: trace.numberSources,
      checks: trace.checks,
      violations: [],
      rejected_drafts: [],
      model: "mock-generator",
      params: {},
      latency_ms: 10,
      usage: { totalTokens: 12 },
      cost: null,
      moderator_state: "allowed",
      moderator_class: "JUDGE",
      moderator_rule_id: null,
      moderator_model_config_id: "10000000-0000-4000-8000-000000000002",
      trace: { outcome, brain_content_hash: "a".repeat(64) },
    });
  });

  it("traces the existing held message through the same writer without inserting another message", async () => {
    const deps = dependencies();
    await writeMessageTrace(
      "tenant-a",
      {
        kind: "existing_message",
        conversationId: "conversation-1",
        messageId: "message-1",
      },
      { ...trace, outcome: "held" },
      deps,
    );
    expect(deps.calls.map((call) => call.kind)).toEqual(["trace"]);
  });

  it("refuses a cross-tenant message link before writing telemetry", async () => {
    const deps = dependencies("tenant-b");
    await expect(
      writeMessageTrace(
        "tenant-a",
        {
          kind: "agent_turn",
          conversationId: "conversation-1",
          body: "Reply",
          provider: "mock",
          providerMessageId: "provider-1",
          disclosureConsumed: false,
        },
        trace,
        deps,
      ),
    ).rejects.toThrow("TRACE_MESSAGE_TENANT_MISMATCH");
    expect(deps.calls.map((call) => call.kind)).toEqual(["rpc"]);
  });

  it("refuses an optimistic success when the persisted retrieval receipt differs", async () => {
    const deps = dependencies();
    const insertTrace = deps.insertTrace;
    deps.insertTrace = async (row) => ({
      ...(await insertTrace(row)),
      citationVerified: false,
    });
    await expect(writeMessageTrace(
      "tenant-a",
      {
        kind: "existing_message",
        conversationId: "conversation-1",
        messageId: "message-1",
      },
      trace,
      deps,
    )).rejects.toThrow("TRACE_WRITE_READBACK_MISMATCH");
  });

  it("refuses an optimistic success when the persisted moderator receipt differs", async () => {
    const deps = dependencies();
    const insertTrace = deps.insertTrace;
    deps.insertTrace = async (row) => ({
      ...(await insertTrace(row)),
      moderatorRuleId: "CLAIM-001",
    });
    await expect(writeMessageTrace(
      "tenant-a",
      { kind: "existing_message", conversationId: "conversation-1", messageId: "message-1" },
      trace,
      deps,
    )).rejects.toThrow("TRACE_WRITE_READBACK_MISMATCH");
  });

  it("accepts an exact immutable replay even when jsonb object keys read back canonically", async () => {
    const deps = dependencies();
    const insertTrace = deps.insertTrace;
    deps.insertTrace = async (row) => ({
      ...(await insertTrace(row)),
      usage: { z: 2, a: 1 },
    });
    await expect(writeMessageTrace(
      "tenant-a",
      { kind: "existing_message", conversationId: "conversation-1", messageId: "message-1" },
      { ...trace, usage: { a: 1, z: 2 } },
      deps,
    )).resolves.toEqual({ messageId: "message-1", tenantId: "tenant-a" });
  });

  it("fails closed when an immutable prompt differs on replay", async () => {
    const deps = dependencies();
    const insertTrace = deps.insertTrace;
    deps.insertTrace = async (row) => ({ ...(await insertTrace(row)), promptHash: "other" });
    await expect(writeMessageTrace(
      "tenant-a",
      { kind: "existing_message", conversationId: "conversation-1", messageId: "message-1" },
      trace,
      deps,
    )).rejects.toThrow("TRACE_WRITE_READBACK_MISMATCH");
  });

  // Phase 10. The exact-payload assertion in the first case above is already the flag-off guard:
  // `trace` carries no objection, so the four objection columns must be absent from the insert
  // row entirely rather than present as nulls, and a `toEqual` is what proves it.
  const OBJECTION = {
    snapshotId: "snapshot-current",
    objectionId: "8a000000-0000-4000-8000-000000000101",
    handlingOutcome: "answered" as const,
    hardGate: false,
  };

  it("writes the four typed objection columns when the turn used an objection", async () => {
    const deps = dependencies();
    await writeMessageTrace(
      "tenant-a",
      { kind: "existing_message", conversationId: "conversation-1", messageId: "message-1" },
      { ...trace, objection: OBJECTION },
      deps,
    );
    expect(deps.calls[0].value).toMatchObject({
      objection_snapshot_id: "snapshot-current",
      objection_id: "8a000000-0000-4000-8000-000000000101",
      objection_handling_outcome: "answered",
      objection_hard_gate: false,
    });
  });

  it("refuses an optimistic success when the persisted objection identity differs", async () => {
    const deps = dependencies();
    const insertTrace = deps.insertTrace;
    deps.insertTrace = async (row) => ({
      ...(await insertTrace(row)),
      objectionId: "8a000000-0000-4000-8000-0000000009ff",
    });
    await expect(writeMessageTrace(
      "tenant-a",
      { kind: "existing_message", conversationId: "conversation-1", messageId: "message-1" },
      { ...trace, objection: OBJECTION },
      deps,
    )).rejects.toThrow("TRACE_WRITE_READBACK_MISMATCH");
  });
});
