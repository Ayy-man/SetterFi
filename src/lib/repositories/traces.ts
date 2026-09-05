/**
 * The sole application writer for platform-only message traces.
 *
 * Outbound messages are created through record_agent_turn so state and disclosure checks remain
 * database-owned. The trace then verifies that message's tenant link before writing telemetry;
 * this module intentionally exports no tenant-facing read operation.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { ModeratorEvidenceClass } from "@/lib/engine/types";

export const TRACE_OUTCOMES = [
  "successful",
  "refused",
  "regenerated",
  "held",
  "moderator_unavailable",
] as const;
export type TraceOutcome = (typeof TRACE_OUTCOMES)[number];

export type MessageTrace = {
  outcome: TraceOutcome;
  brainVersion: number | null;
  offerVersion: number | null;
  brainContentHash: string | null;
  offerContentHash: string | null;
  promptHash: string;
  ruleFired: string | null;
  retrievedEntryIds: string[];
  retrievalCandidates: Array<{
    entryId: string;
    similarity: number;
    categoryBoost: 0 | 0.05;
    score: number;
    categoryAgreement: boolean;
  }>;
  declaredEntryId: string | null;
  citationVerified: boolean;
  droppedEntryIds: string[];
  numberSources: Array<Record<string, unknown>>;
  checks: Array<Record<string, unknown>>;
  violations: Array<Record<string, unknown>>;
  rejectedDrafts: string[];
  model: string | null;
  params: Record<string, unknown> | null;
  latencyMs: number | null;
  usage: Record<string, unknown> | null;
  cost: number | null;
  moderatorState: "allowed" | "blocked" | "unavailable" | null;
  moderatorClass: ModeratorEvidenceClass | null;
  moderatorRuleId: string | null;
  moderatorModelConfigId: string | null;
  /**
   * Null unless the turn genuinely used a published snapshot objection. When it is set, the
   * database validates the declared gate against `brain_snapshot_objections` and then creates the
   * usage event inside this same insert — there is no second application call to get out of step.
   */
  objection: {
    snapshotId: string;
    objectionId: string;
    handlingOutcome: "answered" | "held_safely";
    hardGate: boolean;
  } | null;
};

export type TraceMessageTarget =
  | {
      kind: "agent_turn";
      conversationId: string;
      body: string;
      provider: string;
      providerMessageId: string;
      disclosureConsumed: boolean;
    }
  | {
      kind: "existing_message";
      conversationId: string;
      messageId: string;
    };

type MessageLink = { messageId: string; tenantId: string; conversationId: string };

type TraceReadback = {
  messageId: string;
  tenantId: string;
  brainVersion: number | null;
  offerVersion: number | null;
  offerContentHash: string | null;
  promptHash: string | null;
  ruleFired: string | null;
  retrievedEntryIds: string[];
  retrievalCandidates: unknown;
  declaredEntryId: string | null;
  citationVerified: boolean;
  droppedEntryIds: string[];
  numberSources: unknown;
  checks: unknown;
  violations: unknown;
  rejectedDrafts: unknown;
  model: string | null;
  params: unknown;
  latencyMs: number | null;
  usage: unknown;
  cost: number | null;
  moderatorState: string | null;
  moderatorClass: string | null;
  moderatorRuleId: string | null;
  moderatorModelConfigId: string | null;
  objectionSnapshotId: string | null;
  objectionId: string | null;
  objectionHandlingOutcome: string | null;
  objectionHardGate: boolean | null;
  trace: unknown;
};

type TraceDependencies = {
  recordAgentTurn: (args: Record<string, unknown>) => Promise<string>;
  loadMessageLink: (messageId: string) => Promise<MessageLink>;
  insertTrace: (row: Record<string, unknown>) => Promise<TraceReadback>;
};

async function liveDependencies(): Promise<TraceDependencies> {
  const client = createSupabaseServiceClient();
  return {
    recordAgentTurn: async (args) => {
      const { data, error } = await client.rpc("record_agent_turn", args);
      if (error) throw new Error(`RECORD_AGENT_TURN_FAILED:${error.message}`);
      if (typeof data !== "string") throw new Error("RECORD_AGENT_TURN_EMPTY");
      return data;
    },
    loadMessageLink: async (messageId) => {
      const { data, error } = await client
        .from("messages")
        .select("id, tenant_id, conversation_id")
        .eq("id", messageId)
        .single();
      if (error || !data) throw new Error("TRACE_MESSAGE_LINK_READ_FAILED");
      return {
        messageId: data.id,
        tenantId: data.tenant_id,
        conversationId: data.conversation_id,
      };
    },
    insertTrace: async (row) => {
      const columns = "message_id, tenant_id, brain_version, offer_version, prompt_hash, rule_fired, retrieved_entry_ids, number_sources, checks, violations, rejected_drafts, model, params, latency_ms, usage, cost, moderator_state, moderator_class, moderator_rule_id, moderator_model_config_id, offer_content_hash, retrieval_candidates, declared_entry_id, citation_verified, dropped_entry_ids, objection_snapshot_id, objection_id, objection_handling_outcome, objection_hard_gate, trace";
      const inserted = await client
        .from("message_traces")
        .insert(row)
        .select(columns)
        .single();
      let data = inserted.data;
      if (inserted.error || !data) {
        const replay = await client.from("message_traces").select(columns)
          .eq("tenant_id", row.tenant_id).eq("message_id", row.message_id).maybeSingle();
        if (replay.error || !replay.data) {
          throw new Error(`MESSAGE_TRACE_WRITE_FAILED:${inserted.error?.message ?? "empty"}`);
        }
        data = replay.data;
      }
      return {
        messageId: data.message_id,
        tenantId: data.tenant_id,
        brainVersion: data.brain_version,
        offerVersion: data.offer_version,
        offerContentHash: data.offer_content_hash,
        promptHash: data.prompt_hash,
        ruleFired: data.rule_fired,
        retrievedEntryIds: data.retrieved_entry_ids,
        retrievalCandidates: data.retrieval_candidates,
        declaredEntryId: data.declared_entry_id,
        citationVerified: data.citation_verified,
        droppedEntryIds: data.dropped_entry_ids,
        numberSources: data.number_sources,
        checks: data.checks,
        violations: data.violations,
        rejectedDrafts: data.rejected_drafts,
        model: data.model,
        params: data.params,
        latencyMs: data.latency_ms,
        usage: data.usage,
        cost: data.cost === null ? null : Number(data.cost),
        moderatorState: data.moderator_state,
        moderatorClass: data.moderator_class,
        moderatorRuleId: data.moderator_rule_id,
        moderatorModelConfigId: data.moderator_model_config_id,
        objectionSnapshotId: data.objection_snapshot_id,
        objectionId: data.objection_id,
        objectionHandlingOutcome: data.objection_handling_outcome,
        objectionHardGate: data.objection_hard_gate,
        trace: data.trace,
      };
    },
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]));
  }
  return value;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export async function writeMessageTrace(
  tenantId: string,
  target: TraceMessageTarget,
  trace: MessageTrace,
  dependencies?: TraceDependencies,
): Promise<{ messageId: string; tenantId: string }> {
  const expectedTenant = tenantId.trim();
  if (!expectedTenant) throw new Error("EXPECTED_TENANT_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  const messageId =
    target.kind === "agent_turn"
      ? await deps.recordAgentTurn({
          p_expected_tenant: expectedTenant,
          p_conversation_id: target.conversationId,
          p_body: target.body,
          p_provider: target.provider,
          p_provider_message_id: target.providerMessageId,
          p_disclosure_consumed: target.disclosureConsumed,
        })
      : target.messageId;
  const link = await deps.loadMessageLink(messageId);
  if (
    link.tenantId !== expectedTenant ||
    link.conversationId !== target.conversationId ||
    link.messageId !== messageId
  ) {
    throw new Error("TRACE_MESSAGE_TENANT_MISMATCH");
  }

  const persisted = await deps.insertTrace({
    message_id: messageId,
    tenant_id: expectedTenant,
    brain_version: trace.brainVersion,
    offer_version: trace.offerVersion,
    prompt_hash: trace.promptHash,
    rule_fired: trace.ruleFired,
    retrieved_entry_ids: trace.retrievedEntryIds,
    retrieval_candidates: trace.retrievalCandidates,
    declared_entry_id: trace.declaredEntryId,
    citation_verified: trace.citationVerified,
    dropped_entry_ids: trace.droppedEntryIds,
    offer_content_hash: trace.offerContentHash,
    number_sources: trace.numberSources,
    checks: trace.checks,
    violations: trace.violations,
    rejected_drafts: trace.rejectedDrafts,
    model: trace.model,
    params: trace.params,
    latency_ms: trace.latencyMs,
    usage: trace.usage,
    cost: trace.cost,
    moderator_state: trace.moderatorState,
    moderator_class: trace.moderatorClass,
    moderator_rule_id: trace.moderatorRuleId,
    moderator_model_config_id: trace.moderatorModelConfigId,
    // Spread only when the turn used one, so a flag-off insert is the same object literal it was
    // before Phase 10 — the four keys are absent, not present as nulls.
    ...(trace.objection
      ? {
          objection_snapshot_id: trace.objection.snapshotId,
          objection_id: trace.objection.objectionId,
          objection_handling_outcome: trace.objection.handlingOutcome,
          objection_hard_gate: trace.objection.hardGate,
        }
      : {}),
    trace: { outcome: trace.outcome, brain_content_hash: trace.brainContentHash },
  });
  if (
    persisted.tenantId !== expectedTenant || persisted.messageId !== messageId ||
    persisted.brainVersion !== trace.brainVersion ||
    persisted.offerVersion !== trace.offerVersion ||
    persisted.offerContentHash !== trace.offerContentHash ||
    persisted.promptHash !== trace.promptHash || persisted.ruleFired !== trace.ruleFired ||
    !sameJson(persisted.retrievedEntryIds, trace.retrievedEntryIds) ||
    !sameJson(persisted.retrievalCandidates, trace.retrievalCandidates) ||
    persisted.declaredEntryId !== trace.declaredEntryId ||
    persisted.citationVerified !== trace.citationVerified ||
    !sameJson(persisted.droppedEntryIds, trace.droppedEntryIds) ||
    !sameJson(persisted.numberSources, trace.numberSources) ||
    !sameJson(persisted.checks, trace.checks) || !sameJson(persisted.violations, trace.violations) ||
    !sameJson(persisted.rejectedDrafts, trace.rejectedDrafts) || persisted.model !== trace.model ||
    !sameJson(persisted.params, trace.params) || persisted.latencyMs !== trace.latencyMs ||
    !sameJson(persisted.usage, trace.usage) || persisted.cost !== trace.cost ||
    persisted.moderatorState !== trace.moderatorState ||
    persisted.moderatorClass !== trace.moderatorClass ||
    persisted.moderatorRuleId !== trace.moderatorRuleId ||
    persisted.moderatorModelConfigId !== trace.moderatorModelConfigId ||
    persisted.objectionSnapshotId !== (trace.objection?.snapshotId ?? null) ||
    persisted.objectionId !== (trace.objection?.objectionId ?? null) ||
    persisted.objectionHandlingOutcome !== (trace.objection?.handlingOutcome ?? null) ||
    persisted.objectionHardGate !== (trace.objection?.hardGate ?? null) ||
    !sameJson(persisted.trace, {
      outcome: trace.outcome,
      brain_content_hash: trace.brainContentHash,
    })
  ) {
    throw new Error("TRACE_WRITE_READBACK_MISMATCH");
  }
  return { messageId: persisted.messageId, tenantId: persisted.tenantId };
}
