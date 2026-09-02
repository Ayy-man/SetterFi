/**
 * Minimal cross-tenant queue for platform staff to triage conversations that need a person.
 *
 * This deliberately projects queue metadata only. The normal conversation repository remains
 * tenant-explicit and owns transcript reads; this module cannot return a lead name, contact data,
 * message body, qualification, or any reply/takeover capability.
 */

import { platformConversationQueueLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const HUMAN_QUEUE_AUDIT = {
  actionKey: "platform.conversation_queue.read",
  microcopy: "Human queue view logged",
  ariaLabel: "Cross-tenant human conversation queue view recorded in the audit log",
} as const;

export { platformConversationQueueLive };

export type PlatformHumanConversation = {
  conversationId: string;
  tenantId: string;
  tenantName: string;
  channel: "sms" | "instagram" | "messenger" | "whatsapp" | "webchat";
  status: "needs_human";
  statusReason: string;
  waitingSince: string;
  waitingSeconds: number;
};

export type PlatformHumanConversationQueue = {
  conversations: PlatformHumanConversation[];
  audit: { id: string } & typeof HUMAN_QUEUE_AUDIT;
};

type QueueDependencies = {
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
};

type QueuePayload = {
  audit_id?: unknown;
  conversations?: unknown;
};

const CHANNELS = new Set<PlatformHumanConversation["channel"]>([
  "sms", "instagram", "messenger", "whatsapp", "webchat",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, error: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(error);
  return value;
}

function auditId(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new Error("PLATFORM_CONVERSATION_QUEUE_AUDIT_MISSING");
}

function positiveInteger(value: unknown, error: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(error);
  }
  return value;
}

function parseConversation(value: unknown): PlatformHumanConversation {
  if (!record(value)) throw new Error("PLATFORM_CONVERSATION_QUEUE_ROW_INVALID");
  const channel = requiredString(value.channel, "PLATFORM_CONVERSATION_QUEUE_CHANNEL_INVALID");
  if (!CHANNELS.has(channel as PlatformHumanConversation["channel"])) {
    throw new Error("PLATFORM_CONVERSATION_QUEUE_CHANNEL_INVALID");
  }
  if (value.status !== "needs_human") throw new Error("PLATFORM_CONVERSATION_QUEUE_STATUS_INVALID");
  return {
    conversationId: requiredString(value.conversation_id, "PLATFORM_CONVERSATION_QUEUE_ID_INVALID"),
    tenantId: requiredString(value.tenant_id, "PLATFORM_CONVERSATION_QUEUE_TENANT_INVALID"),
    tenantName: requiredString(value.tenant_name, "PLATFORM_CONVERSATION_QUEUE_TENANT_INVALID"),
    channel: channel as PlatformHumanConversation["channel"],
    status: "needs_human",
    statusReason: requiredString(value.status_reason, "PLATFORM_CONVERSATION_QUEUE_REASON_INVALID"),
    waitingSince: requiredString(value.waiting_since, "PLATFORM_CONVERSATION_QUEUE_WAIT_INVALID"),
    waitingSeconds: positiveInteger(value.waiting_seconds, "PLATFORM_CONVERSATION_QUEUE_WAIT_INVALID"),
  };
}

export function parsePlatformHumanConversationQueue(value: unknown): PlatformHumanConversationQueue {
  if (!record(value)) throw new Error("PLATFORM_CONVERSATION_QUEUE_INVALID");
  const payload = value as QueuePayload;
  if (!Array.isArray(payload.conversations)) throw new Error("PLATFORM_CONVERSATION_QUEUE_INVALID");
  return {
    conversations: payload.conversations.map(parseConversation),
    audit: {
      id: auditId(payload.audit_id),
      ...HUMAN_QUEUE_AUDIT,
    },
  };
}

async function liveDependencies(): Promise<QueueDependencies> {
  const client = createSupabaseServiceClient();
  return {
    rpc: async (name, args) => {
      const { data, error } = await client.rpc(name, args);
      if (error) throw new Error(`PLATFORM_CONVERSATION_QUEUE_READ_FAILED:${error.message}`);
      return data;
    },
  };
}

/**
 * The RPC owns both the cross-tenant authorization check and the audit insert. Supplying an actor
 * id is not an authority grant: it is checked against public.users inside the same SQL function.
 */
export async function readPlatformHumanConversationQueue(
  actorId: string,
  dependencies?: QueueDependencies,
): Promise<PlatformHumanConversationQueue> {
  const expectedActor = requiredString(actorId, "PLATFORM_CONVERSATION_QUEUE_ACTOR_REQUIRED");
  const deps = dependencies ?? await liveDependencies();
  return parsePlatformHumanConversationQueue(await deps.rpc(
    "read_platform_human_conversation_queue",
    { p_actor_id: expectedActor },
  ));
}
