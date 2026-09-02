/**
 * Audited mutation wrappers for conversation handoff and pipeline state.
 *
 * Domain changes go through the named transactional RPCs from Plan 01. This module never performs
 * a service-role update followed by a separate audit insert, and it only returns accountability
 * copy after reading the persisted audit row and its registry entry back successfully.
 */

import { AUDIT_ACTIONS, type AuditActionKey } from "@/lib/audit/actions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type AuditReceipt = {
  auditId: string;
  actionKey: AuditActionKey;
  label: string;
  ariaLabel: string;
};

export type ConversationMutationRead = {
  id: string;
  tenantId: string;
  status: "agent" | "needs_human" | "human" | "nurture" | "closed" | "scope_blocked" | "opted_out";
  statusReason: string | null;
  takenOverBy: string | null;
  disclosurePending: boolean;
  currentStepAsks: number;
};

export type ContactStageRead = {
  id: string;
  tenantId: string;
  pipelineStage: string;
  stageSetBy: "system" | "user";
  stageSetAt: string;
};

export type AuditDependencies = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  loadConversation: (conversationId: string) => Promise<ConversationMutationRead>;
  loadContactStage: (contactId: string) => Promise<ContactStageRead>;
  loadAuditReceipt: (
    auditId: string,
    expectedTenantId: string,
    expectedAction: AuditActionKey,
  ) => Promise<AuditReceipt | null>;
};

async function liveDependencies(): Promise<AuditDependencies> {
  const client = createSupabaseServiceClient();
  return {
    rpc: async (name, args) => {
      const { data, error } = await client.rpc(name, args);
      if (error) throw new Error(`${name.toUpperCase()}_FAILED:${error.message}`);
      return data;
    },
    loadConversation: async (conversationId) => {
      const { data, error } = await client
        .from("conversations")
        .select(
          "id, tenant_id, status, status_reason, taken_over_by, disclosure_pending, current_step_asks",
        )
        .eq("id", conversationId)
        .single();
      if (error || !data) throw new Error("CONVERSATION_READBACK_FAILED");
      return {
        id: data.id,
        tenantId: data.tenant_id,
        status: data.status,
        statusReason: data.status_reason,
        takenOverBy: data.taken_over_by,
        disclosurePending: data.disclosure_pending,
        currentStepAsks: data.current_step_asks,
      } as ConversationMutationRead;
    },
    loadContactStage: async (contactId) => {
      const { data, error } = await client
        .from("contacts")
        .select("id, tenant_id, pipeline_stage, stage_set_by, stage_set_at")
        .eq("id", contactId)
        .single();
      if (error || !data) throw new Error("CONTACT_STAGE_READBACK_FAILED");
      return {
        id: data.id,
        tenantId: data.tenant_id,
        pipelineStage: data.pipeline_stage,
        stageSetBy: data.stage_set_by,
        stageSetAt: data.stage_set_at,
      } as ContactStageRead;
    },
    loadAuditReceipt: async (auditId, expectedTenantId, expectedAction) => {
      const { data: audit, error: auditError } = await client
        .from("audit_log")
        .select("id, tenant_id, action")
        .eq("id", auditId)
        .single();
      if (
        auditError ||
        !audit ||
        audit.tenant_id !== expectedTenantId ||
        audit.action !== expectedAction
      ) {
        return null;
      }
      const { data: action, error: actionError } = await client
        .from("audit_actions")
        .select("key, microcopy, aria_label")
        .eq("key", expectedAction)
        .single();
      if (actionError || !action || action.key !== expectedAction) return null;
      return {
        auditId: String(audit.id),
        actionKey: expectedAction,
        label: action.microcopy,
        ariaLabel: action.aria_label,
      };
    },
  };
}

function required(value: string, error: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(error);
  return normalized;
}

function auditIdFrom(data: unknown) {
  if ((typeof data !== "string" && typeof data !== "number") || String(data).length === 0) {
    throw new Error("AUDIT_ID_MISSING");
  }
  return String(data);
}

async function receipt(
  deps: AuditDependencies,
  auditId: string,
  tenantId: string,
  actionKey: AuditActionKey,
) {
  const persisted = await deps.loadAuditReceipt(auditId, tenantId, actionKey);
  if (!persisted) throw new Error(`AUDIT_RECEIPT_MISSING:${actionKey}`);
  const registry = AUDIT_ACTIONS[actionKey];
  if (persisted.label !== registry.microcopy || persisted.ariaLabel !== registry.ariaLabel) {
    throw new Error(`AUDIT_REGISTRY_DRIFT:${actionKey}`);
  }
  return persisted;
}

async function conversationReadback(
  deps: AuditDependencies,
  tenantId: string,
  conversationId: string,
) {
  const conversation = await deps.loadConversation(conversationId);
  if (conversation.tenantId !== tenantId || conversation.id !== conversationId) {
    throw new Error("CONVERSATION_TENANT_MISMATCH");
  }
  return conversation;
}

export async function claim(
  tenantId: string,
  input: {
    conversationId: string;
    actorId: string;
    expectedStatus: ConversationMutationRead["status"];
    expectedHolderId: string | null;
    confirmDisplace: boolean;
  },
  dependencies?: AuditDependencies,
) {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  const auditId = auditIdFrom(
    await deps.rpc("claim_conversation", {
      p_expected_tenant: expectedTenant,
      p_conversation_id: input.conversationId,
      p_actor_id: input.actorId,
      p_expected_status: input.expectedStatus,
      p_expected_holder_id: input.expectedHolderId,
      p_confirm_displace: input.confirmDisplace,
    }),
  );
  const conversation = await conversationReadback(deps, expectedTenant, input.conversationId);
  if (conversation.status !== "human" || conversation.takenOverBy !== input.actorId) {
    throw new Error("CONVERSATION_CLAIM_READBACK_INVALID");
  }
  return {
    conversation,
    audit: await receipt(
      deps,
      auditId,
      expectedTenant,
      "conversation.takeover.claimed",
    ),
  };
}

export async function release(
  tenantId: string,
  input: { conversationId: string; actorId: string; expectedHolderId: string },
  dependencies?: AuditDependencies,
) {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  const auditId = auditIdFrom(
    await deps.rpc("release_conversation", {
      p_expected_tenant: expectedTenant,
      p_conversation_id: input.conversationId,
      p_actor_id: input.actorId,
      p_expected_holder_id: input.expectedHolderId,
    }),
  );
  const conversation = await conversationReadback(deps, expectedTenant, input.conversationId);
  if (
    conversation.status !== "agent" ||
    conversation.takenOverBy !== null ||
    !conversation.disclosurePending
  ) {
    throw new Error("CONVERSATION_RELEASE_READBACK_INVALID");
  }
  return {
    conversation,
    audit: await receipt(
      deps,
      auditId,
      expectedTenant,
      "conversation.takeover.released",
    ),
  };
}

export async function clearGuardrail(
  tenantId: string,
  input: { conversationId: string; actorId: string; reason: string },
  dependencies?: AuditDependencies,
) {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  const reason = required(input.reason, "GUARDRAIL_CLEAR_REASON_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  const auditId = auditIdFrom(
    await deps.rpc("clear_conversation_guardrail", {
      p_expected_tenant: expectedTenant,
      p_conversation_id: input.conversationId,
      p_actor_id: input.actorId,
      p_reason: reason,
    }),
  );
  const conversation = await conversationReadback(deps, expectedTenant, input.conversationId);
  if (conversation.status !== "agent" || !conversation.disclosurePending) {
    throw new Error("CONVERSATION_GUARDRAIL_READBACK_INVALID");
  }
  return {
    conversation,
    audit: await receipt(
      deps,
      auditId,
      expectedTenant,
      "conversation.guardrail.cleared",
    ),
  };
}

export async function setPipelineStage(
  tenantId: string,
  input: {
    contactId: string;
    expectedStage: string;
    stage: string;
    setBy: "system" | "user";
    actorId: string | null;
    reason: string | null;
    appointmentId: string | null;
    idempotencyKey: string;
  },
  dependencies?: AuditDependencies,
): Promise<{
  contact: ContactStageRead;
  audit: { id: number; actionKey: "contact.pipeline_stage.set" };
}> {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  if (input.setBy === "user" && !input.actorId) throw new Error("PIPELINE_ACTOR_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  const auditId = auditIdFrom(
    await deps.rpc("set_contact_pipeline_stage", {
      p_expected_tenant: expectedTenant,
      p_contact_id: input.contactId,
      p_expected_stage: input.expectedStage,
      p_stage: input.stage,
      p_set_by: input.setBy,
      p_actor_id: input.actorId,
      p_reason: input.reason,
      p_appointment_id: input.appointmentId,
      p_idempotency_key: input.idempotencyKey,
    }),
  );
  const contact = await deps.loadContactStage(input.contactId);
  if (contact.tenantId !== expectedTenant || contact.pipelineStage !== input.stage) {
    throw new Error("PIPELINE_STAGE_READBACK_INVALID");
  }
  const persisted = await receipt(
    deps,
    auditId,
    expectedTenant,
    "contact.pipeline_stage.set",
  );
  const numericAuditId = Number(persisted.auditId);
  if (!Number.isSafeInteger(numericAuditId) || numericAuditId <= 0) {
    throw new Error("AUDIT_ID_INVALID");
  }
  return {
    contact,
    audit: { id: numericAuditId, actionKey: "contact.pipeline_stage.set" },
  };
}
