/**
 * Pure pre-prompt conversation-state policy plus the needs-human RPC boundary.
 *
 * The state decision happens before prompt assembly and exposes no prompt or send command on held
 * paths. Typed extraction and the three-asks advancement rule belong to Plan 04; this module only
 * carries the database-owned current_step_asks counter through its result.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const CONVERSATION_STATES = [
  "agent",
  "needs_human",
  "human",
  "nurture",
  "closed",
  "scope_blocked",
  "opted_out",
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const CONVERSATION_STATUS_REASONS = [
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
] as const;
export type ConversationStatusReason = (typeof CONVERSATION_STATUS_REASONS)[number];

const CONVERSATION_WRITE_REFUSALS: Record<string, string> = {
  CONVERSATION_CLAIM_STALE: "This conversation changed before takeover could complete. Refresh and try again.",
  CONVERSATION_DISPLACE_CONFIRMATION_REQUIRED: "Another teammate holds this conversation. Confirm takeover to replace them.",
  CONVERSATION_RELEASE_STALE: "This conversation is no longer held by you, so it cannot be handed back.",
  CONVERSATION_RELEASE_REPLY_PENDING: "Your reply is still being recorded. Wait for its receipt before handing the conversation back.",
  HUMAN_MESSAGE_STATE_STALE: "This conversation is no longer in human takeover mode.",
  HUMAN_MESSAGE_ACTOR_NOT_HOLDER: "Only the coach currently holding this conversation can send or add notes.",
  HUMAN_REPLY_STALE: "This conversation changed before the reply could be sent.",
  EXPECTED_TENANT_MISMATCH: "This conversation is not available in this workspace.",
  CONVERSATION_NOT_FOUND: "This conversation no longer exists in this workspace.",
};

const CONVERSATION_WRITE_ROLES = new Set([
  "coach",
  "coach_member",
  "owner",
  "admin",
  "success",
]);

export function canWriteConversation(role: string | null) {
  return role !== null && CONVERSATION_WRITE_ROLES.has(role);
}

/**
 * A mutation refusal must be actionable without exposing another tenant's state. The database
 * remains the authority for the exact code; routes only translate it into safe operator copy.
 */
export function conversationMutationRefusal(error: unknown) {
  const code = error instanceof Error ? error.message : "CONVERSATION_MUTATION_REFUSED";
  const match = Object.keys(CONVERSATION_WRITE_REFUSALS)
    .find((candidate) => code.includes(candidate));
  return {
    code: match ?? "CONVERSATION_MUTATION_REFUSED",
    message: match
      ? CONVERSATION_WRITE_REFUSALS[match]
      : "The conversation changed or could not be written. Refresh before trying again.",
  };
}

export type ConversationStateSnapshot = {
  id: string;
  tenantId: string;
  status: ConversationState;
  statusReason: ConversationStatusReason | null;
  currentStepAsks: number;
  unreadByCoach: boolean;
};

export type PrePromptDecision =
  | { kind: "run"; currentStepAsks: number }
  | { kind: "resume"; from: "nurture" | "closed"; currentStepAsks: number }
  | {
      kind: "hold";
      status: "needs_human" | "human" | "scope_blocked" | "opted_out";
      reason: ConversationStatusReason;
      currentStepAsks: number;
    };

export function decideBeforePrompt(snapshot: ConversationStateSnapshot): PrePromptDecision {
  if ((snapshot.status === "agent") !== (snapshot.statusReason === null)) {
    throw new Error("CONVERSATION_STATUS_REASON_INVALID");
  }
  switch (snapshot.status) {
    case "agent":
      return { kind: "run", currentStepAsks: snapshot.currentStepAsks };
    case "nurture":
    case "closed":
      return {
        kind: "resume",
        from: snapshot.status,
        currentStepAsks: snapshot.currentStepAsks,
      };
    case "needs_human":
    case "human":
    case "scope_blocked":
    case "opted_out": {
      const reason = snapshot.statusReason;
      if (!reason) throw new Error("CONVERSATION_STATUS_REASON_INVALID");
      return {
        kind: "hold",
        status: snapshot.status,
        reason,
        currentStepAsks: snapshot.currentStepAsks,
      };
    }
  }
}

export function classifyMessageDelivery(direction: "in" | "out" | "system") {
  return direction === "system"
    ? { kind: "internal", send: false } as const
    : { kind: "channel", send: direction === "out" } as const;
}

type NeedsHumanDependencies = {
  enter: (args: Record<string, unknown>) => Promise<{
    messageId: string;
    auditId: string | null;
    transitioned: boolean;
  }>;
  loadConversation: (conversationId: string) => Promise<ConversationStateSnapshot>;
};

async function liveNeedsHumanDependencies(): Promise<NeedsHumanDependencies> {
  const client = createSupabaseServiceClient();
  return {
    enter: async (args) => {
      const { data, error } = await client.rpc("enter_needs_human", args);
      if (error) throw new Error(`ENTER_NEEDS_HUMAN_FAILED:${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("ENTER_NEEDS_HUMAN_EMPTY");
      return {
        messageId: row.message_id,
        auditId: row.audit_id === null ? null : String(row.audit_id),
        transitioned: row.transitioned,
      };
    },
    loadConversation: async (conversationId) => {
      const { data, error } = await client
        .from("conversations")
        .select("id, tenant_id, status, status_reason, current_step_asks, unread_by_coach")
        .eq("id", conversationId)
        .single();
      if (error || !data) throw new Error("CONVERSATION_READBACK_FAILED");
      return {
        id: data.id,
        tenantId: data.tenant_id,
        status: data.status,
        statusReason: data.status_reason,
        currentStepAsks: data.current_step_asks,
        unreadByCoach: data.unread_by_coach,
      } as ConversationStateSnapshot;
    },
  };
}

export async function enterNeedsHuman(
  tenantId: string,
  input: {
    conversationId: string;
    reason:
      | "lead_requested_human"
      | "no_match_threshold"
      | "output_check_failed"
      | "tripwire_repeated"
      | "tripwire_escalate";
    holdingBody: string;
    entryKey: string;
    payload?: Record<string, unknown>;
  },
  dependencies?: NeedsHumanDependencies,
) {
  const expectedTenant = tenantId.trim();
  if (!expectedTenant) throw new Error("EXPECTED_TENANT_REQUIRED");
  if (!input.holdingBody.trim() || !input.entryKey.trim()) {
    throw new Error("NEEDS_HUMAN_ENTRY_REQUIRED");
  }
  const deps = dependencies ?? (await liveNeedsHumanDependencies());
  const result = await deps.enter({
    p_expected_tenant: expectedTenant,
    p_conversation_id: input.conversationId,
    p_reason: input.reason,
    p_holding_body: input.holdingBody,
    p_entry_key: input.entryKey,
    p_payload: input.payload ?? {},
  });
  const conversation = await deps.loadConversation(input.conversationId);
  if (
    conversation.id !== input.conversationId ||
    conversation.tenantId !== expectedTenant ||
    conversation.status !== "needs_human" ||
    !conversation.unreadByCoach
  ) {
    throw new Error("NEEDS_HUMAN_READBACK_INVALID");
  }
  if (result.transitioned && result.auditId === null) {
    throw new Error("NEEDS_HUMAN_AUDIT_MISSING");
  }
  return { ...result, conversation };
}
