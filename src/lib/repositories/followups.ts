import type { MessagingChannel } from "@/lib/booking/types";
import type { FollowupSchedulerRepository } from "@/lib/followups/scheduler";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type FollowupRead = {
  id: string;
  conversationId: string;
  contactId: string;
  channel: MessagingChannel;
  purpose: string;
  touchNo: number;
  status: "scheduled" | "sent" | "canceled";
  scheduledAt: string;
  sentAt: string | null;
  canceledReason: string | null;
  pausedAt: string | null;
  deferredCount: number;
  attemptCount: number;
  isTest: boolean;
};

type FollowupRow = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  purpose: string;
  touch_no: number;
  status: FollowupRead["status"];
  scheduled_at: string;
  sent_at: string | null;
  canceled_reason: string | null;
  paused_at: string | null;
  deferred_count: number;
  attempt_count: number;
  is_test: boolean;
  conversation: { contact_id: string; channel: MessagingChannel };
};

type ListSource = (tenantId: string, limit: number) => Promise<FollowupRow[]>;

async function liveList(tenantId: string, limit: number) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("followups").select(`
    id,tenant_id,conversation_id,purpose,touch_no,status,scheduled_at,sent_at,canceled_reason,
    paused_at,deferred_count,attempt_count,is_test,
    conversation:conversations!inner(contact_id,channel)
  `).eq("tenant_id", tenantId).order("scheduled_at", { ascending: true }).limit(limit);
  if (error) throw new Error("FOLLOWUP_READ_FAILED");
  return (data ?? []) as unknown as FollowupRow[];
}

export async function listFollowups(
  tenantId: string,
  options: { limit?: number } = {},
  source: ListSource = liveList,
): Promise<FollowupRead[]> {
  const expectedTenant = tenantId.trim();
  if (!expectedTenant) throw new Error("EXPECTED_TENANT_REQUIRED");
  const rows = await source(expectedTenant, Math.max(1, Math.min(options.limit ?? 100, 500)));
  if (rows.some((row) => row.tenant_id !== expectedTenant)) throw new Error("FOLLOWUP_TENANT_MISMATCH");
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    contactId: row.conversation.contact_id,
    channel: row.conversation.channel,
    purpose: row.purpose,
    touchNo: row.touch_no,
    status: row.status,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    canceledReason: row.canceled_reason,
    pausedAt: row.paused_at,
    deferredCount: row.deferred_count,
    attemptCount: row.attempt_count,
    isTest: row.is_test,
  }));
}

function rpcRow(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

/** Service-role repository with an explicit tenant predicate at every boundary. */
export function createLiveFollowupSchedulerRepository(): FollowupSchedulerRepository {
  const client = createSupabaseServiceClient();
  return {
    claimDueFollowups: async (input) => {
      const { data, error } = await client.rpc("claim_due_followups", {
        p_expected_tenant: input.tenantId,
        p_worker_key: input.workerKey,
        p_limit: input.limit,
        p_lease_seconds: input.leaseSeconds,
        p_now: input.now,
      });
      if (error) throw new Error("FOLLOWUP_CLAIM_FAILED");
      return (data ?? []).map((row: Record<string, unknown>) => ({
        followupId: row.followup_id,
        leaseToken: row.lease_token,
        dueAt: row.due_at,
        auditId: String(row.audit_id),
      }));
    },
    loadClaimedFollowup: async (input) => {
      const { data, error } = await client.from("followups").select(`
        id,tenant_id,conversation_id,purpose,cadence_anchor_at,original_scheduled_at,
        deferred_count,is_test,channel_class,claim_token,
        conversation:conversations!inner(contact_id,channel,provider_window_expires_at)
      `).eq("tenant_id", input.tenantId).eq("id", input.followupId)
        .eq("claim_token", input.leaseToken).maybeSingle();
      if (error) throw new Error("FOLLOWUP_CLAIM_READ_FAILED");
      if (!data) return null;
      const conversation = data.conversation as unknown as {
        contact_id: string; channel: MessagingChannel; provider_window_expires_at: string | null;
      };
      return {
        id: data.id,
        tenantId: data.tenant_id,
        contactId: conversation.contact_id,
        conversationId: data.conversation_id,
        channel: conversation.channel,
        purpose: data.purpose,
        cadenceAnchorAt: data.cadence_anchor_at,
        providerWindowExpiresAt: conversation.provider_window_expires_at,
        originalScheduledAt: data.original_scheduled_at,
        deferredCount: data.deferred_count,
        isTest: data.is_test,
        storedChannelClass: data.channel_class,
      };
    },
    loadIdentityCandidates: async (input) => {
      const { data: conversation, error: conversationError } = await client.from("conversations")
        .select("channel").eq("tenant_id", input.tenantId).eq("id", input.conversationId)
        .eq("contact_id", input.contactId).single();
      const { data, error } = await client.from("contact_identities")
        .select("id,channel,consent_state,consent_source,consent_expires_at,provider_window_expires_at")
        .eq("tenant_id", input.tenantId).eq("contact_id", input.contactId);
      if (conversationError || !conversation || error) throw new Error("FOLLOWUP_IDENTITY_READ_FAILED");
      return (data ?? []).map((row) => ({
        id: row.id,
        channel: row.channel,
        consentState: row.consent_state,
        consentSource: row.consent_source,
        consentExpiresAt: row.consent_expires_at,
        providerWindowExpiresAt: row.provider_window_expires_at,
        isConversationIdentity: row.channel === conversation.channel,
      }));
    },
    loadApprovedFollowupContent: async ({ tenantId, purpose, destination }) => {
      const { data, error } = await client.from("message_templates")
        .select("id,status").eq("tenant_id", tenantId).eq("channel", destination.channel)
        .eq("name", `followup:${purpose}`).eq("status", "approved").limit(1).maybeSingle();
      if (error || !data) throw new Error("APPROVED_FOLLOWUP_COPY_REQUIRED");
      return { kind: "approved_template", templateKey: data.id, variables: {} };
    },
    recordResolvedIdentity: async (input) => {
      const { data, error } = await client.from("followups").update({ resolved_identity_id: input.identityId })
        .eq("tenant_id", input.tenantId).eq("id", input.followupId).eq("claim_token", input.leaseToken)
        .select("id").maybeSingle();
      if (error || !data) throw new Error("FOLLOWUP_IDENTITY_WRITE_FAILED");
    },
    ensureLinkedConversationIntent: async (input) => {
      const { data: existing, error: existingError } = await client.from("conversations")
        .select("id,tenant_id")
        .eq("tenant_id", input.tenantId)
        .eq("contact_id", input.contactId)
        .eq("channel", input.targetChannel)
        .neq("status", "opted_out")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingError) throw new Error("LINKED_CONVERSATION_FAILED");
      if (existing) return { conversationId: existing.id };
      const { data: contact, error: contactError } = await client.from("contacts")
        .select("tenant_id,is_test")
        .eq("tenant_id", input.tenantId)
        .eq("id", input.contactId)
        .single();
      if (contactError || !contact || contact.tenant_id !== input.tenantId) {
        throw new Error("LINKED_CONVERSATION_CONTACT_FAILED");
      }
      const { data, error } = await client.from("conversations").insert({
        tenant_id: input.tenantId,
        contact_id: input.contactId,
        channel: input.targetChannel,
        status: "agent",
        status_reason: null,
        cadence_anchor_at: input.cadenceAnchorAt,
        is_test: contact.is_test,
      }).select("id,tenant_id").single();
      if (error || !data || data.tenant_id !== input.tenantId) throw new Error("LINKED_CONVERSATION_FAILED");
      return { conversationId: data.id };
    },
    completeFollowupAttempt: async (input) => {
      const { data, error } = await client.rpc("complete_followup_attempt", {
        p_expected_tenant: input.tenantId,
        p_followup_id: input.followupId,
        p_claim_token: input.leaseToken,
        p_outcome: input.outcome,
        p_scheduled_at: input.scheduledAt,
        p_canceled_reason: input.canceledReason,
      });
      if (error || typeof data !== "number") throw new Error("FOLLOWUP_COMPLETION_FAILED");
      return { auditId: String(data) };
    },
    markNurtureIfExhausted: async ({ tenantId, conversationId, occurredAt }) => {
      const { count, error } = await client.from("followups").select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId).eq("conversation_id", conversationId).eq("status", "scheduled");
      if (error) throw new Error("FOLLOWUP_EXHAUSTION_READ_FAILED");
      if (count === 0) {
        const { error: updateError } = await client.from("conversations")
          .update({ status: "nurture", status_reason: "cadence_exhausted", status_changed_at: occurredAt })
          .eq("tenant_id", tenantId).eq("id", conversationId).eq("status", "agent");
        if (updateError) throw new Error("FOLLOWUP_NURTURE_WRITE_FAILED");
      }
    },
    cancelContactFollowupsOnInbound: async (input) => {
      const { data, error } = await client.rpc("cancel_contact_followups_on_inbound", {
        p_expected_tenant: input.tenantId,
        p_contact_id: input.contactId,
        p_inbound_message_id: input.inboundMessageId,
      });
      const row = rpcRow(data) as { canceled_count?: unknown; audit_id?: unknown } | null;
      if (error || !row) throw new Error("FOLLOWUP_INBOUND_CANCEL_FAILED");
      return {
        canceledCount: Number(row.canceled_count),
        auditId: row.audit_id === null ? null : String(row.audit_id),
      };
    },
    replaceFutureCadence: async (input) => {
      const { error: cancelError } = await client.from("followups")
        .update({ status: "canceled", canceled_reason: "lead_reply" })
        .eq("tenant_id", input.tenantId).eq("conversation_id", input.conversationId)
        .eq("status", "scheduled");
      if (cancelError) throw new Error("FOLLOWUP_REPLACE_FAILED");
      if (input.followups.length === 0) return;
      const { error } = await client.from("followups").insert(input.followups.map((row) => ({
        tenant_id: row.tenantId,
        conversation_id: row.conversationId,
        touch_no: row.touchNo,
        purpose: row.purpose,
        scheduled_at: row.scheduledAt,
        cadence_anchor_at: row.cadenceAnchorAt,
        channel_class: row.channelClass,
        status: "scheduled",
      })));
      if (error) throw new Error("FOLLOWUP_REPLACE_FAILED");
    },
    closeStaleConversations: async (input) => {
      const { data, error } = await client.from("conversations")
        .update({ status: "closed", status_reason: "stale", status_changed_at: input.occurredAt })
        .eq("tenant_id", input.tenantId).in("status", ["agent", "nurture"])
        .lt("last_lead_inbound_at", input.lastLeadInboundBefore).select("id");
      if (error) throw new Error("CONVERSATION_STALE_SWEEP_FAILED");
      return { closedCount: data?.length ?? 0 };
    },
    claimConversation: async (input) => {
      const { data, error } = await client.rpc("claim_conversation", {
        p_expected_tenant: input.tenantId,
        p_conversation_id: input.conversationId,
        p_actor_id: input.actorId,
        p_expected_status: input.expectedStatus,
        p_expected_holder_id: input.expectedHolderId,
        p_confirm_displace: input.confirmDisplace,
      });
      if (error || typeof data !== "number") throw new Error("CONVERSATION_CLAIM_FAILED");
      return { auditId: String(data) };
    },
    releaseConversationWithCadence: async (input) => {
      const { data, error } = await client.rpc("release_conversation", {
        p_expected_tenant: input.tenantId,
        p_conversation_id: input.conversationId,
        p_actor_id: input.actorId,
        p_expected_holder_id: input.expectedHolderId,
      });
      if (error || typeof data !== "number") throw new Error("CONVERSATION_RELEASE_FAILED");
      return { auditId: String(data) };
    },
  };
}
