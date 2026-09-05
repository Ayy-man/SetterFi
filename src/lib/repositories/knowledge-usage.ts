/**
 * The sole application writer for `brain_knowledge_usage_events`.
 *
 * One row per sent agent reply whose declared citation the engine verified against the retrieved
 * set. The table predates the trace columns and has no message id, so the message supplies the
 * identity instead: `used_at` is the agent message's own `created_at`, and a row with the same
 * tenant, conversation, entry and instant is the same usage. A retried receipt therefore replays
 * the existing row rather than counting the reply twice. Held replies never reach this module,
 * because a reply the lead did not receive is not a use of the knowledge.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type VerifiedCitationUsageInput = {
  tenantId: string;
  conversationId: string;
  agentMessageId: string;
  knowledgeEntryId: string;
};

export type KnowledgeUsageReceipt =
  | { state: "recorded"; eventId: string }
  | { state: "replayed"; eventId: string }
  /** The cited entry no longer exists in the library; the trace still holds the citation. */
  | { state: "skipped"; reason: "knowledge_entry_missing" };

export type KnowledgeUsageEventKey = {
  tenantId: string;
  conversationId: string;
  knowledgeEntryId: string;
  usedAt: string;
};

export type KnowledgeUsageDependencies = {
  loadAgentMessage(input: { tenantId: string; messageId: string }): Promise<{
    conversationId: string;
    createdAt: string;
    isTest: boolean;
  }>;
  findEvent(key: KnowledgeUsageEventKey): Promise<{ eventId: string } | null>;
  insertEvent(row: KnowledgeUsageEventKey & { isTest: boolean }): Promise<{ eventId: string } | { missingEntry: true }>;
};

const FOREIGN_KEY_VIOLATION = "23503";

function liveDependencies(): KnowledgeUsageDependencies {
  const client = createSupabaseServiceClient();
  return {
    loadAgentMessage: async ({ tenantId, messageId }) => {
      const message = await client.from("messages")
        .select("id, tenant_id, conversation_id, created_at")
        .eq("tenant_id", tenantId).eq("id", messageId).single();
      if (message.error || !message.data) throw new Error("KNOWLEDGE_USAGE_MESSAGE_READ_FAILED");
      const conversation = await client.from("conversations")
        .select("id, is_test")
        .eq("tenant_id", tenantId).eq("id", message.data.conversation_id).single();
      if (conversation.error || !conversation.data) throw new Error("KNOWLEDGE_USAGE_CONVERSATION_READ_FAILED");
      return {
        conversationId: String(message.data.conversation_id),
        createdAt: String(message.data.created_at),
        isTest: conversation.data.is_test === true,
      };
    },
    findEvent: async (key) => {
      const { data, error } = await client.from("brain_knowledge_usage_events")
        .select("id")
        .eq("tenant_id", key.tenantId)
        .eq("conversation_id", key.conversationId)
        .eq("knowledge_entry_id", key.knowledgeEntryId)
        .eq("used_at", key.usedAt)
        .limit(1).maybeSingle();
      if (error) throw new Error(`KNOWLEDGE_USAGE_READ_FAILED:${error.message}`);
      return data ? { eventId: String(data.id) } : null;
    },
    insertEvent: async (row) => {
      const { data, error } = await client.from("brain_knowledge_usage_events")
        .insert({
          tenant_id: row.tenantId,
          conversation_id: row.conversationId,
          knowledge_entry_id: row.knowledgeEntryId,
          used_at: row.usedAt,
          is_test: row.isTest,
        })
        .select("id").single();
      if (error) {
        if (error.code === FOREIGN_KEY_VIOLATION && error.message.includes("knowledge_entry")) {
          return { missingEntry: true };
        }
        throw new Error(`KNOWLEDGE_USAGE_WRITE_FAILED:${error.message}`);
      }
      if (!data) throw new Error("KNOWLEDGE_USAGE_WRITE_EMPTY");
      return { eventId: String(data.id) };
    },
  };
}

export async function recordVerifiedCitationUsage(
  input: VerifiedCitationUsageInput,
  dependencies: KnowledgeUsageDependencies = liveDependencies(),
): Promise<KnowledgeUsageReceipt> {
  const tenantId = input.tenantId.trim();
  const knowledgeEntryId = input.knowledgeEntryId.trim();
  if (!tenantId) throw new Error("EXPECTED_TENANT_REQUIRED");
  if (!input.agentMessageId.trim()) throw new Error("KNOWLEDGE_USAGE_MESSAGE_REQUIRED");
  if (!knowledgeEntryId) throw new Error("KNOWLEDGE_USAGE_ENTRY_REQUIRED");
  const message = await dependencies.loadAgentMessage({ tenantId, messageId: input.agentMessageId });
  if (message.conversationId !== input.conversationId) throw new Error("KNOWLEDGE_USAGE_CONVERSATION_MISMATCH");
  const key: KnowledgeUsageEventKey = {
    tenantId,
    conversationId: message.conversationId,
    knowledgeEntryId,
    usedAt: message.createdAt,
  };
  const existing = await dependencies.findEvent(key);
  if (existing) return { state: "replayed", eventId: existing.eventId };
  const inserted = await dependencies.insertEvent({ ...key, isTest: message.isTest });
  if ("missingEntry" in inserted) return { state: "skipped", reason: "knowledge_entry_missing" };
  return { state: "recorded", eventId: inserted.eventId };
}
