import type { AuditReceipt } from "@/lib/audit";
import { createHash } from "node:crypto";
import { AUDIT_ACTIONS, type AuditActionKey } from "@/lib/audit/actions";
import { isSimulatedProviderMessageId } from "@/lib/integrations/simulated";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { canWriteConversation, conversationMutationRefusal } from "@/lib/conversation-state";
import { inboxVerbsLive, phase3Live } from "@/lib/env-contract";
import { createLiveSendToLeadGateway, type ConversationMessageRead } from "@/lib/repositories/conversations";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import {
  conversationResponse,
  loadConversationForRoute,
} from "../claim/handler";

const MAX_MESSAGE_LENGTH = 800;
const noStoreHeaders = { "Cache-Control": "no-store" };

type HumanMessageDependencies = {
  enabled?(): boolean;
  session(): Promise<RouteActor | null>;
  write(input: {
    tenantId: string;
    actorId: string;
    conversationId: string;
    kind: "reply" | "internal_note";
    body: string;
    expectedState: "human";
  }): Promise<{ message: ConversationMessageRead; audit: AuditReceipt | null }>;
  sendReply?(input: {
    tenantId: string;
    actorId: string;
    conversationId: string;
    body: string;
    quietHoursOverride: boolean;
  }): Promise<HumanReplyResult | HumanReplySent>;
  loadConversation: typeof loadConversationForRoute;
};

type HumanReplySent = { message: ConversationMessageRead; audit: AuditReceipt | null };
type HumanReplyResult =
  | ({ kind: "sent" } & HumanReplySent)
  | {
      kind: "confirmation_required";
      scheduledAt: string;
      timezoneSource: "contact" | "npa" | "continental_intersection";
      leadLocalTimes: readonly string[];
      allowedWindow: string;
    };

type HumanMessageRpcRow = {
  message_id: string;
  audit_id: string | number;
  action_key: AuditActionKey;
};

export async function writeHumanMessage(input: {
  tenantId: string;
  actorId: string;
  conversationId: string;
  kind: "reply" | "internal_note";
  body: string;
  expectedState: "human";
}): Promise<{ message: ConversationMessageRead; audit: AuditReceipt }> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("send_human_message", {
    p_expected_tenant: input.tenantId,
    p_conversation_id: input.conversationId,
    p_actor_id: input.actorId,
    p_kind: input.kind,
    p_body: input.body,
    p_expected_state: input.expectedState,
  });
  if (error) throw new Error(`SEND_HUMAN_MESSAGE_FAILED:${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as HumanMessageRpcRow | null;
  const expectedAction: AuditActionKey = input.kind === "reply"
    ? "conversation.message.sent.human"
    : "conversation.internal_note.added";
  if (!row || row.action_key !== expectedAction) throw new Error("HUMAN_MESSAGE_RPC_RECEIPT_INVALID");

  const [{ data: message, error: messageError }, { data: audit, error: auditError }] = await Promise.all([
    client
      .from("messages")
      .select("id, tenant_id, conversation_id, direction, author, body, created_at, provider_message_id")
      .eq("id", row.message_id)
      .single(),
    client
      .from("audit_log")
      .select("id, tenant_id, action")
      .eq("id", row.audit_id)
      .single(),
  ]);
  if (
    messageError || !message || message.tenant_id !== input.tenantId ||
    message.conversation_id !== input.conversationId
  ) throw new Error("HUMAN_MESSAGE_READBACK_INVALID");
  if (
    auditError || !audit || audit.tenant_id !== input.tenantId ||
    audit.action !== expectedAction || String(audit.id) !== String(row.audit_id)
  ) throw new Error("HUMAN_MESSAGE_AUDIT_READBACK_INVALID");
  const registry = AUDIT_ACTIONS[expectedAction];
  return {
    message: {
      id: message.id,
      direction: message.direction as ConversationMessageRead["direction"],
      author: message.author,
      body: message.body,
      createdAt: message.created_at,
      delivered: message.direction === "out" && message.provider_message_id !== null,
      simulated: isSimulatedProviderMessageId(message.provider_message_id),
    },
    audit: {
      auditId: String(audit.id),
      actionKey: expectedAction,
      label: registry.microcopy,
      ariaLabel: registry.ariaLabel,
    },
  };
}

export async function sendHumanReply(input: {
  tenantId: string;
  actorId: string;
  conversationId: string;
  body: string;
  quietHoursOverride: boolean;
}): Promise<HumanReplyResult> {
  const conversation = await loadConversationForRoute(input.tenantId, input.conversationId, input.actorId);
  if (conversation.status !== "human" || conversation.takenOverBy !== input.actorId) {
    throw new Error("CONVERSATION_REPLY_STALE");
  }
  const idempotencyKey = `human:${createHash("sha256")
    .update(`${input.actorId}:${input.conversationId}:${input.body}`, "utf8").digest("hex")}`;
  const result = await createLiveSendToLeadGateway({ humanActorId: input.actorId })({
    tenantId: input.tenantId,
    contactId: conversation.contactId,
    conversationId: input.conversationId,
    nominatedIdentityId: null,
    purpose: "human_reply",
    content: { kind: "freeform", body: input.body },
    idempotencyKey,
    occurredAt: new Date().toISOString(),
    isTest: conversation.isTest,
    humanQuietHoursOverride: input.quietHoursOverride,
  });
  if (result.kind === "confirmation_required") {
    return {
      kind: "confirmation_required",
      scheduledAt: result.scheduledAt,
      timezoneSource: result.timezoneSource,
      leadLocalTimes: result.leadLocalTimes,
      allowedWindow: result.allowedWindow,
    };
  }
  if (result.kind !== "sent" || !result.receipt.providerMessageId) {
    throw new Error(`HUMAN_REPLY_${result.kind.toUpperCase()}`);
  }
  const client = createSupabaseServiceClient();
  const [{ data: message, error: messageError }, { data: audit, error: auditError }] = await Promise.all([
    client.from("messages")
      .select("id,tenant_id,conversation_id,direction,author,body,created_at,provider_message_id")
      .eq("tenant_id", input.tenantId).eq("id", result.receipt.messageId).single(),
    client.from("audit_log").select("id,tenant_id,action")
      .eq("tenant_id", input.tenantId).eq("id", result.receipt.auditId).single(),
  ]);
  if (messageError || !message || message.conversation_id !== input.conversationId ||
    message.provider_message_id !== result.receipt.providerMessageId ||
    auditError || !audit || audit.action !== "conversation.message.sent.human") {
    throw new Error("HUMAN_REPLY_READBACK_INVALID");
  }
  const registry = AUDIT_ACTIONS["conversation.message.sent.human"];
  return {
    kind: "sent",
    message: {
      id: message.id,
      direction: "out",
      author: message.author,
      body: message.body,
      createdAt: message.created_at,
      delivered: true,
      simulated: isSimulatedProviderMessageId(result.receipt.providerMessageId),
    },
    audit: {
      auditId: String(audit.id),
      actionKey: "conversation.message.sent.human",
      label: registry.microcopy,
      ariaLabel: registry.ariaLabel,
    },
  };
}

export function createHumanMessageHandler(dependencies: HumanMessageDependencies) {
  return async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!(dependencies.enabled ?? (() => true))()) {
      return Response.json({
        code: "INBOX_VERBS_DISABLED",
        message: "Conversation actions are disabled until the controlled inbox rollout is enabled.",
      }, { status: 409, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    if (hasImpersonationMarker(actor)) {
      return Response.json({ message: "Impersonated sessions are read-only" }, { status: 403, headers: noStoreHeaders });
    }
    if (!canWriteConversation(actor.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    try {
      const raw: unknown = await request.json();
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_BODY");
      const body = raw as Record<string, unknown>;
      const keys = Object.keys(body).sort().join(",");
      const replyKeysValid = body.kind === "reply" && (
        keys === "body,expectedState,kind" || keys === "body,expectedState,kind,quietHoursOverride"
      );
      const noteKeysValid = body.kind === "internal_note" && keys === "body,expectedState,kind";
      if (
        (!replyKeysValid && !noteKeysValid) ||
        (body.kind !== "reply" && body.kind !== "internal_note") ||
        body.expectedState !== "human" ||
        (body.quietHoursOverride !== undefined && typeof body.quietHoursOverride !== "boolean") ||
        typeof body.body !== "string" ||
        !body.body.trim() ||
        body.body.trim().length > MAX_MESSAGE_LENGTH
      ) throw new Error("INVALID_BODY");
      const { id } = await context.params;
      const persisted = body.kind === "reply"
        ? await (dependencies.sendReply ?? (async () => {
            throw new Error("HUMAN_REPLY_GATEWAY_REQUIRED");
          }))({
            tenantId: actor.tenantId,
            actorId: actor.userId,
            conversationId: id,
            body: body.body.trim(),
            quietHoursOverride: body.quietHoursOverride === true,
          })
        : { kind: "sent" as const, ...await dependencies.write({
            tenantId: actor.tenantId,
            actorId: actor.userId,
            conversationId: id,
            kind: "internal_note",
            body: body.body.trim(),
            expectedState: "human",
          }) };
      if ("kind" in persisted && persisted.kind === "confirmation_required") {
        return Response.json({
          code: "HUMAN_REPLY_QUIET_HOURS_CONFIRMATION_REQUIRED",
          message: "This is outside the lead's allowed messaging hours. Confirm to send now.",
          scheduledAt: persisted.scheduledAt,
          timezoneSource: persisted.timezoneSource,
          leadLocalTimes: persisted.leadLocalTimes,
          allowedWindow: persisted.allowedWindow,
        }, { status: 409, headers: noStoreHeaders });
      }
      const sent = persisted as HumanReplySent;
      if (body.kind === "internal_note" && sent.message.direction !== "system") {
        throw new Error("INTERNAL_NOTE_DELIVERY_INVALID");
      }
      const conversation = await dependencies.loadConversation(actor.tenantId, id, actor.userId);
      return Response.json({
        message: { ...sent.message },
        conversation: conversationResponse(conversation),
        audit: sent.audit,
      }, { headers: noStoreHeaders });
    } catch (error) {
      return Response.json(conversationMutationRefusal(error), { status: 409, headers: noStoreHeaders });
    }
  };
}

export const POST = createHumanMessageHandler({
  enabled: () => phase3Live() && inboxVerbsLive(),
  session: loadRouteActor,
  write: writeHumanMessage,
  sendReply: sendHumanReply,
  loadConversation: loadConversationForRoute,
});
