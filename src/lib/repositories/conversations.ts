/**
 * Tenant-explicit conversation reads for live routes and exports.
 *
 * The service client bypasses RLS, so the tenant predicate and returned-row check both live here;
 * callers cannot accidentally turn an admin read into an unscoped lead-data query.
 */

import { createHash } from "node:crypto";

import type { ProposedSlotSet } from "@/lib/booking/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { inboxVerbsLive, phase1Live, phase3Live } from "@/lib/env-contract";
import { tenantSimulates } from "@/lib/sends/simulated-tenant";
import { isSimulatedProviderMessageId } from "@/lib/integrations/simulated";
import { createMockGhlDriver, createRealGhlDriver } from "@/lib/integrations/ghl";
import { createMockMetaDriver, createRealMetaDriver } from "@/lib/integrations/meta";
import { resolveMetaConnection } from "@/lib/integrations/connection-resolver";
import { authorizeHumanActor } from "@/lib/integrations/types";
import { authorizeWithOutboundPolicy } from "@/lib/messaging/outbound-policy";
import { createQuietHoursPort } from "@/lib/quiet-hours/window";
import type { SendContent, SendToLeadRequest, SendToLeadResult } from "@/lib/sends/contracts";
import { createProviderDispatchPort } from "@/lib/sends/provider-dispatch";
import { sendToLead, type SendPersistencePort } from "@/lib/sends/send-to-lead";

export const CONVERSATION_STATUSES = [
  "agent",
  "needs_human",
  "human",
  "nurture",
  "closed",
  "scope_blocked",
  "opted_out",
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export function persistedTemplateApproved(
  content: SendContent,
  persisted: { id: string; status: string } | null,
) {
  return content.kind === "freeform" ||
    (persisted?.id === content.templateKey && persisted.status === "approved");
}

// lastActivityAt is null when the cursor row sits in the null-activity tail, which sorts last.
export type ConversationCursor = { lastActivityAt: string | null; id: string };

export type ConversationMessageRead = {
  id: string;
  direction: "in" | "out" | "system";
  author: string;
  body: string;
  createdAt: string;
  delivered: boolean;
  /** The row went to the simulated arm (a demo tenant's rehearsal), never to a provider. */
  simulated: boolean;
};

export type ConversationRead = {
  id: string;
  contactId: string;
  contactName: string;
  channel: "sms" | "instagram" | "messenger" | "whatsapp" | "webchat";
  status: ConversationStatus;
  statusReason: string | null;
  /**
   * When the thread was handed to a person, straight off `conversations.needs_human_at`. The
   * escalation queue's clock reads this and nothing else: the last inbound message is close enough
   * to look right and wrong often enough to matter, and a wait a coach acts on may not be a guess.
   * Null on every thread the agent still holds, and on an escalated thread whose column is unset.
   * Optional in the shape rather than required, matching the other columns added after the first
   * pass, so a fixture written before this existed is still a conversation.
   */
  needsHumanAt?: string | null;
  takenOverBy: string | null;
  unreadByCoach: boolean;
  disclosurePending: boolean;
  currentStepAsks: number;
  scopeAttackCount?: number;
  tripwireCount?: number;
  tripwireClasses?: string[];
  cadenceAnchorAt?: string | null;
  lastLeadInboundAt?: string | null;
  isDemo: boolean;
  isTest: boolean;
  lastActivityAt: string;
  qualification: {
    credit: string | null;
    goal: string | null;
    timeline: string | null;
    business?: string | null;
    outcome: string | null;
  };
  appointment: {
    id: string;
    startAt: string;
    endAt: string;
    timezone: string;
    attributedToAgent: boolean;
    status: "scheduled" | "confirmed";
    provider: string;
    externalId: string | null;
    updatedAt: string;
  } | null;
  /**
   * The rail's "proposed slots" reading of booking status: the candidate times the agent offered
   * that have not (or not yet) resolved into a confirmed appointment. Null once nothing has been
   * proposed, or once the row fails the same shape check the booking service itself applies to
   * this jsonb column: a malformed proposal reads as absent rather than as a guess at its slots.
   */
  proposedSlots?: ProposedSlotSet | null;
  /**
   * The count of enabled questions in the tenant's own question set, off `read_coach_questions`
   * (`src/lib/repositories/coach-questions.ts`). The rail's "questions answered" count already
   * reads a denominator of 4 off the fixed `qualification` block; the artboard's "N of M answered"
   * needs this instead, since a tenant's enabled set is rarely exactly four. Optional in the type
   * for source compatibility with fixtures written before this field existed -- `getConversation`
   * always populates it.
   */
  questionSetSize?: number;
  messages: ConversationMessageRead[];
};

type ConversationRow = {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel: ConversationRead["channel"];
  status: ConversationStatus;
  status_reason: string | null;
  needs_human_at?: string | null;
  taken_over_by: string | null;
  unread_by_coach: boolean;
  disclosure_pending: boolean;
  current_step_asks: number;
  scope_attack_count?: number;
  tripwire_count?: number;
  tripwire_classes?: string[];
  cadence_anchor_at?: string | null;
  last_lead_inbound_at?: string | null;
  is_test: boolean;
  last_message_at: string | null;
  created_at: string;
  proposed_slots?: unknown;
  proposed_slots_at?: string | null;
  contact: {
    name: string | null;
    credit_range: string | null;
    funding_goal: string | null;
    timeline: string | null;
    business_stage: string | null;
    outcome: string | null;
  };
  tenant: { is_demo: boolean };
  messages: Array<{
    id: string;
    direction: ConversationMessageRead["direction"];
    author: string;
    body: string;
    created_at: string;
    provider_message_id: string | null;
  }>;
  appointments: Array<{
    id: string;
    start_at: string;
    end_at: string;
    timezone: string;
    attributed_to_agent: boolean;
    status: string;
    provider: string;
    external_id: string | null;
    updated_at: string;
  }>;
};

type ConversationPageSource = (input: {
  tenantId: string;
  cursor: ConversationCursor | null;
  limit: number;
  conversationIds?: readonly string[];
  statuses?: readonly ConversationStatus[];
}) => Promise<ConversationRow[]>;

export type ConversationByIdSource = (input: {
  tenantId: string;
  conversationId: string;
}) => Promise<ConversationRow | null>;

/**
 * The Inbox's three tabs are a status filter, not three screens. "Needs you" is every status the
 * agent is not actively holding on its own (a human already has it, or the agent handed it off),
 * "agent handling" is the agent's own status, and "everything" applies no filter at all. Kept as
 * a lookup rather than three ad hoc predicates so the tab boundary and the status enum cannot
 * drift apart from each other.
 */
export const CONVERSATION_VIEWS = ["needs_you", "agent_handling", "everything"] as const;
export type CoachConversationView = (typeof CONVERSATION_VIEWS)[number];

const CONVERSATION_VIEW_STATUSES: Record<
  Exclude<CoachConversationView, "everything">,
  readonly ConversationStatus[]
> = {
  needs_you: ["needs_human", "human", "scope_blocked"],
  agent_handling: ["agent"],
};

export function conversationViewStatuses(
  view: CoachConversationView,
): readonly ConversationStatus[] | null {
  if (view === "everything") return null;
  return CONVERSATION_VIEW_STATUSES[view];
}

export type ConversationViewCounts = Record<CoachConversationView, number>;

export type ConversationStatusListSource = (tenantId: string) => Promise<readonly ConversationStatus[]>;

async function loadAllConversationStatuses(tenantId: string): Promise<readonly ConversationStatus[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("conversations")
    .select("status")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`CONVERSATION_READ_FAILED:${error.message}`);
  return (data ?? []).map((row) => row.status as ConversationStatus);
}

/**
 * The Inbox prints the size of the two lanes it is not showing, which a filtered read cannot
 * answer without a second and third round trip. One read of every status in the tenant, counted
 * in memory against the same `CONVERSATION_VIEW_STATUSES` lookup the filtered reads use, keeps
 * this at the one round trip `listConversationSet` already pays for its own lane.
 */
export async function countConversationsByView(
  tenantId: string,
  source: ConversationStatusListSource = loadAllConversationStatuses,
): Promise<ConversationViewCounts> {
  const expectedTenant = requiredTenant(tenantId);
  const statuses = await source(expectedTenant);
  const needsYouSet = new Set(CONVERSATION_VIEW_STATUSES.needs_you);
  const agentHandlingSet = new Set(CONVERSATION_VIEW_STATUSES.agent_handling);
  let needsYou = 0;
  let agentHandling = 0;
  for (const status of statuses) {
    if (needsYouSet.has(status)) needsYou += 1;
    if (agentHandlingSet.has(status)) agentHandling += 1;
  }
  return { needs_you: needsYou, agent_handling: agentHandling, everything: statuses.length };
}

/**
 * A coach at the cap sees the 500 most recent conversations carrying the objection, and the
 * panel's own count stays the authority on how many there are. Saying so is the point: a silent
 * cap would make the number on the panel and the number of rows behind it disagree with nothing
 * explaining why.
 */
export const OBJECTION_FILTER_CONVERSATION_CAP = 500;

export type ObjectionConversationResolver = (
  tenantId: string,
  objectionId: string,
) => Promise<readonly string[]>;

const CONVERSATION_SELECT = `
  id, tenant_id, contact_id, channel, status, status_reason, needs_human_at, taken_over_by,
  unread_by_coach, disclosure_pending, current_step_asks, is_test, last_message_at, created_at,
  scope_attack_count, tripwire_count, tripwire_classes, cadence_anchor_at, last_lead_inbound_at,
  proposed_slots, proposed_slots_at,
  contact:contacts!inner(name, credit_range, funding_goal, timeline, business_stage, outcome),
  tenant:tenants!inner(is_demo),
  messages!messages_conversation_id_fkey(
    id, direction, author, body, created_at, provider_message_id
  ),
  appointments(id, start_at, end_at, timezone, attributed_to_agent, status, provider, external_id, updated_at)
`;

function requiredTenant(tenantId: string) {
  const value = tenantId.trim();
  if (!value) throw new Error("EXPECTED_TENANT_REQUIRED");
  return value;
}

/**
 * Resolves an objection id to the conversations that carry an event for it.
 *
 * This reads `analytics_brain_objection_usage_events` — the same view the Top objections rollup
 * reads — and that is deliberate rather than convenient: the coach clicks a count and lands on
 * the cohort that produced it, so a test or demo conversation cannot appear under a number that
 * excluded it.
 */
async function objectionConversationIds(
  tenantId: string,
  objectionId: string,
): Promise<readonly string[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("analytics_brain_objection_usage_events")
    .select("conversation_id, used_at")
    .eq("tenant_id", tenantId)
    .eq("objection_id", objectionId)
    .order("used_at", { ascending: false })
    .limit(OBJECTION_FILTER_CONVERSATION_CAP);
  if (error) throw new Error(`OBJECTION_CONVERSATION_READ_FAILED:${error.message}`);
  return [...new Set((data ?? []).map((row) => row.conversation_id as string))];
}

async function loadLivePage(input: {
  tenantId: string;
  cursor: ConversationCursor | null;
  limit: number;
  conversationIds?: readonly string[];
  statuses?: readonly ConversationStatus[];
}): Promise<ConversationRow[]> {
  const client = createSupabaseServiceClient();
  let query = client
    .from("conversations")
    .select(CONVERSATION_SELECT)
    .eq("tenant_id", input.tenantId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(input.limit + 1);

  // The tenant predicate stays: the filter narrows an already-scoped query rather than
  // replacing its scope.
  if (input.conversationIds) query = query.in("id", [...input.conversationIds]);
  if (input.statuses) query = query.in("status", [...input.statuses]);

  // Rows without a last_message_at sort last (NULLS LAST), so a null-blind lt/eq predicate would
  // drop them after the first page boundary and a "complete set" read would silently be partial.
  if (input.cursor) {
    if (input.cursor.lastActivityAt === null) {
      query = query.is("last_message_at", null).lt("id", input.cursor.id);
    } else {
      query = query.or(
        `last_message_at.lt.${input.cursor.lastActivityAt},and(last_message_at.eq.${input.cursor.lastActivityAt},id.lt.${input.cursor.id}),last_message_at.is.null`,
      );
    }
  }

  const { data, error } = await query;
  if (error) throw new Error(`CONVERSATION_READ_FAILED:${error.message}`);
  return (data ?? []) as unknown as ConversationRow[];
}

async function loadLiveConversation(input: {
  tenantId: string;
  conversationId: string;
}): Promise<ConversationRow | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("conversations")
    .select(CONVERSATION_SELECT)
    .eq("tenant_id", input.tenantId)
    .eq("id", input.conversationId)
    .maybeSingle();
  if (error) throw new Error(`CONVERSATION_READ_FAILED:${error.message}`);
  return data as unknown as ConversationRow | null;
}

/**
 * Reads `conversations.proposed_slots` the same defensive way the booking service reads it before
 * offering it to a lead: a shape that fails any part of the check is not a partial proposal, it is
 * no proposal, so the rail falls back to nothing rather than rendering a broken slot list.
 */
function parseProposedSlots(value: unknown): ProposedSlotSet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.calendarConnectionId !== "string" ||
    typeof row.rangeStartAt !== "string" ||
    typeof row.rangeEndAt !== "string" ||
    typeof row.proposedAt !== "string" ||
    typeof row.presentationTimezone !== "string" ||
    !Array.isArray(row.slots)
  ) return null;
  const slots = row.slots.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const slot = candidate as Record<string, unknown>;
    return typeof slot.id === "string" && typeof slot.startAt === "string" &&
      typeof slot.endAt === "string" && typeof slot.timezone === "string" &&
      typeof slot.display === "string"
      ? [{ id: slot.id, startAt: slot.startAt, endAt: slot.endAt, timezone: slot.timezone, display: slot.display }]
      : [];
  });
  return slots.length === row.slots.length ? { ...row, slots } as ProposedSlotSet : null;
}

function mapConversation(row: ConversationRow): ConversationRead {
  const messages = [...row.messages]
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map((message) => ({
      id: message.id,
      direction: message.direction,
      author: message.author,
      body: message.body,
      createdAt: message.created_at,
      delivered:
        message.direction === "in" ||
        (message.direction === "out" && message.provider_message_id !== null),
      simulated: isSimulatedProviderMessageId(message.provider_message_id),
    }));
  const appointment = [...row.appointments]
    .filter((candidate) => candidate.status !== "canceled")
    .sort((left, right) => right.start_at.localeCompare(left.start_at))[0];

  return {
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact.name ?? "Unknown lead",
    channel: row.channel,
    status: row.status,
    statusReason: row.status_reason,
    needsHumanAt: row.needs_human_at ?? null,
    takenOverBy: row.taken_over_by,
    unreadByCoach: row.unread_by_coach,
    disclosurePending: row.disclosure_pending,
    currentStepAsks: row.current_step_asks,
    scopeAttackCount: row.scope_attack_count ?? 0,
    tripwireCount: row.tripwire_count ?? 0,
    tripwireClasses: row.tripwire_classes ?? [],
    cadenceAnchorAt: row.cadence_anchor_at ?? null,
    lastLeadInboundAt: row.last_lead_inbound_at ?? null,
    isDemo: row.tenant.is_demo,
    isTest: row.is_test,
    lastActivityAt: row.last_message_at ?? row.created_at,
    qualification: {
      credit: row.contact.credit_range,
      goal: row.contact.funding_goal,
      timeline: row.contact.timeline,
      business: row.contact.business_stage,
      outcome: row.contact.outcome,
    },
    appointment: appointment
      ? {
          id: appointment.id,
          startAt: appointment.start_at,
          endAt: appointment.end_at,
          timezone: appointment.timezone,
          attributedToAgent: appointment.attributed_to_agent,
          status: appointment.status as "scheduled" | "confirmed",
          provider: appointment.provider,
          externalId: appointment.external_id,
          updatedAt: appointment.updated_at,
        }
      : null,
    proposedSlots: parseProposedSlots(row.proposed_slots),
    messages,
  };
}

type LiveGatewayOptions = { humanActorId?: string | null };

/**
 * Every outcome this gateway writes is registered `actor_kind = 'system'`, and
 * `app.enforce_audit_insert` rejects any actor on a system key. The registration is right: these
 * record what the outbound policy engine decided, not something a human did, and each is written
 * from both the coach-reply path and the actorless AI cadence path. So the attempting coach goes
 * into the payload, and `actor_id` stays null.
 */
const SYSTEM_ACTOR_SEND_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  "send.refused.suppressed",
  "send.refused.no_consent",
  "send.refused.window_expired",
  "followup.deferred.quiet_hours",
  "followup.discarded.window_closed",
  "followup.completed",
]);

export function sendAuditActorFor(
  action: string,
  humanActorId: string | null | undefined,
): { actorId: null; attemptedBy: string | null } {
  if (!SYSTEM_ACTOR_SEND_AUDIT_ACTIONS.has(action)) {
    throw new Error(`SEND_AUDIT_ACTION_UNREGISTERED:${action}`);
  }
  return { actorId: null, attemptedBy: humanActorId ?? null };
}

/**
 * A scheduled followup must never outlive a failed audit write. `sendToLead` reads the returned
 * audit id straight into the deferred receipt, so swallowing the failure would hand the caller a
 * receipt pointing at an audit row that does not exist; the row goes away instead and the failure
 * stands. A compensation that itself fails leaves scheduled work with no audit record, which is a
 * state an operator has to be told about by name.
 */
export async function persistDeferredWithAudit(ports: {
  insertFollowup: () => Promise<string | null>;
  insertAudit: (followupId: string) => Promise<number>;
  deleteFollowup: (followupId: string) => Promise<void>;
}): Promise<{ followupId: string; auditId: number } | null> {
  const followupId = await ports.insertFollowup();
  if (!followupId) return null;
  try {
    return { followupId, auditId: await ports.insertAudit(followupId) };
  } catch (auditError) {
    try {
      await ports.deleteFollowup(followupId);
    } catch {
      throw new Error(`SEND_DEFERRAL_COMPENSATION_FAILED:${followupId}`);
    }
    throw auditError;
  }
}

async function insertAudit(input: {
  tenantId: string;
  humanActorId: string | null | undefined;
  action: string;
  conversationId: string;
  payload: Record<string, unknown>;
}) {
  const { actorId, attemptedBy } = sendAuditActorFor(input.action, input.humanActorId);
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("audit_log").insert({
    tenant_id: input.tenantId,
    actor_id: actorId,
    action: input.action,
    target_type: "conversation",
    target_id: input.conversationId,
    reason: null,
    payload: attemptedBy ? { ...input.payload, attemptedBy } : input.payload,
  }).select("id").single();
  if (error || !data) throw new Error("SEND_AUDIT_WRITE_FAILED");
  return Number(data.id);
}

function refusalAction(reason: string) {
  if (reason === "suppressed") return "send.refused.suppressed";
  if (reason === "no_consent_basis") return "send.refused.no_consent";
  return null;
}

function outboundPayloadHash(input: {
  request: SendToLeadRequest;
  identityId: string;
  channel: string;
  content: SendContent;
}) {
  const content = input.content.kind === "freeform"
    ? { kind: input.content.kind, body: input.content.body }
    : {
        kind: input.content.kind,
        templateKey: input.content.templateKey,
        variables: Object.fromEntries(Object.entries(input.content.variables).sort(([a], [b]) => a.localeCompare(b))),
      };
  return createHash("sha256").update(JSON.stringify({
    tenantId: input.request.tenantId,
    contactId: input.request.contactId,
    conversationId: input.request.conversationId,
    identityId: input.identityId,
    purpose: input.request.purpose,
    channel: input.channel,
    content,
    isTest: input.request.isTest,
  })).digest("hex");
}

/** Live composition for the one lead-facing outbound gateway. */
export function createLiveSendToLeadGateway(options: LiveGatewayOptions = {}) {
  const client = createSupabaseServiceClient();
  const persistence: SendPersistencePort = {
    loadReplay: async ({ request, target, content }) => {
      const { data: attempt, error: attemptError } = await client.from("outbound_send_attempts")
        .select("status,payload_hash,identity_id,channel,provider_message_id,message_id,audit_id,accepted_at,persisted_at")
        .eq("tenant_id", request.tenantId).eq("idempotency_key", request.idempotencyKey).maybeSingle();
      if (attemptError) throw new Error("SEND_ATTEMPT_READ_FAILED");
      if (attempt && attempt.payload_hash !== outboundPayloadHash({
        request,
        identityId: target.identityId,
        channel: target.channel,
        content,
      })) throw new Error("OUTBOUND_SEND_IDEMPOTENCY_CONFLICT");
      if (attempt?.status === "persisted" && attempt.provider_message_id && attempt.message_id &&
        attempt.audit_id && attempt.persisted_at) {
        return {
          kind: "sent",
          channel: attempt.channel,
          receipt: {
            tenantId: request.tenantId,
            contactId: request.contactId,
            conversationId: request.conversationId,
            identityId: attempt.identity_id,
            purpose: request.purpose,
            idempotencyKey: request.idempotencyKey,
            decidedAt: attempt.accepted_at ?? attempt.persisted_at,
            auditId: Number(attempt.audit_id),
            providerMessageId: attempt.provider_message_id,
            messageId: attempt.message_id,
            persistedAt: attempt.persisted_at,
          },
        } as SendToLeadResult;
      }

      // Migration compatibility: messages sent before outbound_send_attempts was introduced still
      // replay from their unique state-entry key and must never be dispatched a second time.
      const { data, error } = await client.from("messages")
        .select("id,provider_message_id,created_at")
        .eq("tenant_id", request.tenantId)
        .eq("conversation_id", request.conversationId)
        .eq("state_entry_key", request.idempotencyKey)
        .maybeSingle();
      if (error) throw new Error("SEND_ATTEMPT_READ_FAILED");
      if (!data?.provider_message_id) return null;
      const { data: conversation } = await client.from("conversations")
        .select("channel").eq("tenant_id", request.tenantId).eq("id", request.conversationId).single();
      if (!conversation) throw new Error("SEND_REPLAY_SCOPE_FAILED");
      const { data: audit, error: auditError } = await client.from("audit_log").select("id")
        .eq("tenant_id", request.tenantId).eq("target_id", request.conversationId)
        .eq("payload->>messageId", data.id).order("id", { ascending: false }).limit(1).maybeSingle();
      if (auditError || !audit) throw new Error("SEND_REPLAY_AUDIT_REQUIRED");
      return {
        kind: "sent",
        channel: conversation.channel,
        receipt: {
          tenantId: request.tenantId,
          contactId: request.contactId,
          conversationId: request.conversationId,
          identityId: request.nominatedIdentityId,
          purpose: request.purpose,
          idempotencyKey: request.idempotencyKey,
          decidedAt: data.created_at,
          auditId: Number(audit.id),
          providerMessageId: data.provider_message_id,
          messageId: data.id,
          persistedAt: data.created_at,
        },
      } as SendToLeadResult;
    },
    resolveTarget: async (request) => {
      const { data: conversation, error: conversationError } = await client.from("conversations")
        .select("tenant_id,contact_id,channel").eq("tenant_id", request.tenantId)
        .eq("id", request.conversationId).eq("contact_id", request.contactId).single();
      if (conversationError || !conversation) return null;
      let query = client.from("contact_identities")
        .select("id,tenant_id,contact_id,provider,channel,provider_identity_id,normalized_phone,normalized_email")
        .eq("tenant_id", request.tenantId).eq("contact_id", request.contactId);
      query = request.nominatedIdentityId
        ? query.eq("id", request.nominatedIdentityId)
        : query.eq("channel", conversation.channel).order("created_at", { ascending: true }).limit(1);
      const { data, error } = await query.maybeSingle();
      if (error || !data) return null;
      return {
        tenantId: data.tenant_id,
        contactId: data.contact_id,
        identityId: data.id,
        provider: data.provider,
        channel: data.channel,
        recipientExternalId: data.provider_identity_id,
        normalizedIdentifier: data.normalized_phone ?? data.normalized_email ?? data.provider_identity_id,
      };
    },
    isTestRecipientVerified: async ({ tenantId, channel, identifierHash }) => {
      const { data, error } = await client.from("tenant_test_recipients").select("id")
        .eq("tenant_id", tenantId).eq("channel", channel).eq("identifier_hash", identifierHash)
        .not("verified_at", "is", null).maybeSingle();
      if (error) throw new Error("TEST_RECIPIENT_READ_FAILED");
      return Boolean(data);
    },
    hasDeletionTombstone: async ({ tenantId, channel, identifierHash }) => {
      const { data, error } = await client.from("suppression_tombstones").select("id")
        .eq("tenant_id", tenantId).eq("channel", channel).eq("identifier_hash", identifierHash).maybeSingle();
      if (error) throw new Error("SUPPRESSION_TOMBSTONE_READ_FAILED");
      return Boolean(data);
    },
    hasLiveSuppression: async ({ tenantId, channel, identifierHash, contactId }) => {
      const { data, error } = await client.from("suppression_entries").select("id")
        .eq("tenant_id", tenantId).eq("contact_id", contactId).eq("channel", channel)
        .eq("identifier_hash", identifierHash).maybeSingle();
      if (error) throw new Error("SUPPRESSION_READ_FAILED");
      return Boolean(data);
    },
    loadEligibility: async (request, target) => {
      const [identityResult, conversationResult, followupResult, templateResult] = await Promise.all([
        client.from("contact_identities")
          .select("consent_state,consent_source,consent_expires_at,consent_evidence")
          .eq("tenant_id", request.tenantId).eq("id", target.identityId).single(),
        client.from("conversations").select("provider_window_expires_at,channel")
          .eq("tenant_id", request.tenantId).eq("id", request.conversationId).single(),
        request.purpose === "follow_up"
          ? client.from("followups").select("id,original_scheduled_at,deferred_count")
              .eq("tenant_id", request.tenantId).eq("attempt_idempotency_key", request.idempotencyKey).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        request.content.kind === "approved_template"
          ? client.from("message_templates").select("id,status")
              .eq("tenant_id", request.tenantId).eq("id", request.content.templateKey)
              .eq("channel", target.channel).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (identityResult.error || conversationResult.error || followupResult.error || templateResult.error ||
        !identityResult.data || !conversationResult.data) return null;
      const identity = identityResult.data;
      const windowAt = conversationResult.data.provider_window_expires_at as string | null;
      return {
        state: identity.consent_state,
        source: identity.consent_source,
        expiresAt: identity.consent_expires_at,
        evidence: identity.consent_evidence,
        replyInTurn: request.purpose === "agent_reply",
        conversationChannel: conversationResult.data.channel,
        targetChannel: target.channel,
        providerWindowOpen: windowAt === null || Date.parse(windowAt) > Date.now(),
        capabilityFeed: {},
        templateApproved: persistedTemplateApproved(request.content, templateResult.data),
        originalScheduledAt: followupResult.data?.original_scheduled_at ?? null,
        deferredCount: Number(followupResult.data?.deferred_count ?? 0),
        followupId: followupResult.data?.id ?? null,
      };
    },
    loadControlCopy: async (purpose) => {
      const { data, error } = await client.from("platform_settings").select("approved,agent_content")
        .eq("singleton", true).single();
      if (error || !data) return null;
      const key = purpose.split("_")[0].toUpperCase();
      const content = data.agent_content as { controlCopy?: Record<string, unknown> };
      const body = content.controlCopy?.[key];
      return typeof body === "string" ? { approved: data.approved, body } : null;
    },
    recordRefusal: async ({ request, target, reason }) => {
      const action = refusalAction(reason);
      if (!action) return null;
      return insertAudit({
        tenantId: request.tenantId,
        humanActorId: options.humanActorId,
        action,
        conversationId: request.conversationId,
        payload: { purpose: request.purpose, reason, identityId: target?.identityId ?? null },
      });
    },
    persistDeferred: async ({ request, target, scheduledAt }) => persistDeferredWithAudit({
      insertFollowup: async () => {
        const { data, error } = await client.from("followups").insert({
          tenant_id: request.tenantId,
          conversation_id: request.conversationId,
          purpose: "value_nudge",
          touch_no: 1,
          channel_class: ["sms", "whatsapp"].includes(target.channel) ? "durable" : "window_bound",
          cadence_anchor_at: request.occurredAt,
          scheduled_at: scheduledAt,
          status: "scheduled",
          is_test: request.isTest,
          original_scheduled_at: request.occurredAt,
          deferred_count: 1,
          attempt_idempotency_key: request.idempotencyKey,
        }).select("id").single();
        if (error || !data) return null;
        return String(data.id);
      },
      insertAudit: (followupId) => insertAudit({
        tenantId: request.tenantId, humanActorId: options.humanActorId,
        action: "followup.deferred.quiet_hours", conversationId: request.conversationId,
        payload: { followupId, scheduledAt },
      }),
      deleteFollowup: async (followupId) => {
        const { error } = await client.from("followups").delete()
          .eq("tenant_id", request.tenantId).eq("id", followupId);
        if (error) throw new Error("SEND_DEFERRAL_DELETE_FAILED");
      },
    }),
    persistDiscarded: async ({ request, eligibility, reason }) => ({
      followupId: eligibility.followupId,
      auditId: await insertAudit({
        tenantId: request.tenantId, humanActorId: options.humanActorId,
        action: reason === "provider_window_closed" ? "followup.discarded.window_closed" : "followup.completed",
        conversationId: request.conversationId, payload: { reason },
      }),
    }),
    claimDispatch: async ({ request, target, content, campaignInitiated }) => {
      const { data, error } = await client.rpc("claim_outbound_send", {
        p_expected_tenant: request.tenantId,
        p_conversation_id: request.conversationId,
        p_contact_id: request.contactId,
        p_identity_id: target.identityId,
        p_purpose: request.purpose,
        p_channel: target.channel,
        p_provider: target.provider,
        p_body: content.kind === "freeform" ? content.body : `[approved template:${content.templateKey}]`,
        p_idempotency_key: request.idempotencyKey,
        p_payload_hash: outboundPayloadHash({ request, identityId: target.identityId, channel: target.channel, content }),
        // Neither current live provider documents a client idempotency primitive for this send
        // endpoint. The key still reaches the adapter contract, but stale claims are held for
        // reconciliation instead of being retried optimistically.
        p_provider_idempotency_supported: false,
        p_origin_receipt_id: request.originReceipt?.receiptId ?? null,
        p_origin_lease_token: request.originReceipt?.leaseToken ?? null,
        p_origin_attempt_number: request.originReceipt?.attemptNumber ?? null,
        p_human_actor_id: request.purpose === "human_reply" ? options.humanActorId ?? null : null,
        p_campaign_initiated: campaignInitiated,
        p_content_kind: content.kind,
      });
      const row = data?.[0];
      if (error || !row) throw new Error("SEND_ATTEMPT_CLAIM_FAILED");
      if (row.disposition === "claimed") {
        return {
          kind: "claimed",
          claimToken: row.claim_token,
          dispatchContent: content.kind === "freeform"
            ? { kind: "freeform", body: row.effective_body }
            : content,
        };
      }
      if (row.disposition === "accepted") {
        return {
          kind: "resume_accepted",
          claimToken: row.claim_token,
          dispatch: { providerMessageId: row.provider_message_id, acceptedAt: row.accepted_at },
        };
      }
      if (row.disposition === "persisted") {
        return {
          kind: "replay",
          result: {
            kind: "sent",
            channel: row.channel,
            receipt: {
              tenantId: request.tenantId,
              contactId: request.contactId,
              conversationId: request.conversationId,
              identityId: row.identity_id,
              purpose: request.purpose,
              idempotencyKey: request.idempotencyKey,
              decidedAt: row.accepted_at ?? row.persisted_at,
              auditId: Number(row.audit_id),
              providerMessageId: row.provider_message_id,
              messageId: row.message_id,
              persistedAt: row.persisted_at,
            },
          },
        };
      }
      return { kind: row.disposition === "indeterminate" ? "indeterminate" : "in_progress" };
    },
    recordProviderAcceptance: async ({ request, claimToken, dispatch }) => {
      const { data, error } = await client.rpc("record_outbound_provider_acceptance", {
        p_expected_tenant: request.tenantId,
        p_idempotency_key: request.idempotencyKey,
        p_claim_token: claimToken,
        p_provider_message_id: dispatch.providerMessageId,
        p_accepted_at: dispatch.acceptedAt,
      });
      return !error && data === true;
    },
    markDispatchIndeterminate: async ({ request, claimToken, errorCode }) => {
      const { error } = await client.rpc("mark_outbound_dispatch_indeterminate", {
        p_expected_tenant: request.tenantId,
        p_idempotency_key: request.idempotencyKey,
        p_claim_token: claimToken,
        p_error_code: errorCode,
      });
      if (error) throw new Error("SEND_INDETERMINATE_WRITE_FAILED");
    },
    releaseUndispatchedClaim: async ({ request, claimToken }) => {
      const { error } = await client.rpc("release_outbound_send_claim", {
        p_expected_tenant: request.tenantId,
        p_idempotency_key: request.idempotencyKey,
        p_claim_token: claimToken,
      });
      if (error) throw new Error("SEND_CLAIM_RELEASE_FAILED");
    },
    persistSend: async ({ request, dispatch, claimToken }) => {
      const { data, error } = await client.rpc("persist_claimed_outbound_send", {
        p_expected_tenant: request.tenantId,
        p_actor_id: options.humanActorId ?? null,
        p_provider_message_id: dispatch.providerMessageId,
        p_idempotency_key: request.idempotencyKey,
        p_is_test: request.isTest,
        p_claim_token: claimToken,
      });
      const persisted = data?.[0];
      if (error || !persisted) return null;
      return {
        providerMessageId: dispatch.providerMessageId,
        messageId: persisted.message_id,
        auditId: Number(persisted.audit_id),
        persistedAt: persisted.persisted_at,
      };
    },
  };

  const quietHours = createQuietHoursPort(async (input) => {
    const [contactResult, settingsResult] = await Promise.all([
      client.from("contacts").select("timezone").eq("tenant_id", input.tenantId).eq("id", input.contactId).single(),
      client.from("tenant_settings").select("quiet_hours_start,quiet_hours_end")
        .eq("tenant_id", input.tenantId).single(),
    ]);
    if (contactResult.error || settingsResult.error || !settingsResult.data) {
      throw new Error("QUIET_HOURS_CONTEXT_REQUIRED");
    }
    const { data: identity } = await client.from("contact_identities").select("normalized_phone")
      .eq("tenant_id", input.tenantId).eq("contact_id", input.contactId).eq("channel", input.channel)
      .limit(1).maybeSingle();
    return {
      followupId: `${input.contactId}:${input.purpose}`,
      contactTimezone: contactResult.data?.timezone ?? null,
      normalizedPhone: identity?.normalized_phone ?? null,
      quietHoursStart: settingsResult.data.quiet_hours_start,
      quietHoursEnd: settingsResult.data.quiet_hours_end,
    };
  });

  // The demo decision is read from the tenant row on every send rather than trusted from the
  // caller, so it is the same fact the analytics exclusion and the demo login already use.
  const tenantSendsSimulated = (tenantId: string) => tenantSimulates(client, tenantId);
  const dispatch = createProviderDispatchPort({
    simulatedTenant: tenantSendsSimulated,
    resolveRoute: async (input) => {
      const [identityResult, contactResult, installResult, simulated] = await Promise.all([
        client.from("contact_identities").select("provider")
          .eq("tenant_id", input.tenantId).eq("id", input.identityId).single(),
        client.from("contacts").select("is_test").eq("tenant_id", input.tenantId)
          .eq("id", (await client.from("conversations").select("contact_id")
            .eq("tenant_id", input.tenantId).eq("id", input.conversationId).single()).data?.contact_id ?? "")
          .single(),
        client.from("ghl_installs").select("location_id").eq("tenant_id", input.tenantId).limit(1).maybeSingle(),
        tenantSendsSimulated(input.tenantId),
      ]);
      if (identityResult.error || !identityResult.data || contactResult.error || !contactResult.data) {
        throw new Error("PROVIDER_ROUTE_SCOPE_FAILED");
      }
      const provider = identityResult.data.provider;
      const actor = input.purpose === "human_reply" && options.humanActorId
        ? { kind: "human" as const, proof: authorizeHumanActor({ userId: options.humanActorId, authorized: true }) }
        : { kind: "ai" as const };
      const policy = await authorizeWithOutboundPolicy({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        channel: input.channel,
        recipientExternalId: input.recipientExternalId,
        body: input.content.kind === "freeform" ? input.content.body : "",
        isTest: contactResult.data.is_test,
        actor,
        ...(input.content.kind === "approved_template"
          ? { template: { id: input.content.templateKey, variables: input.content.variables } }
          : {}),
      }, provider, {
        authorizeExisting: async () => ({ allowed: true }),
        loadTemplate: async ({ templateId }) => {
          const { data, error } = await client.from("message_templates")
            .select("id,tenant_id,channel,provider,provider_template_name,locale,body_hash,status")
            .eq("tenant_id", input.tenantId).eq("id", templateId).maybeSingle();
          if (error || !data) return null;
          return {
            id: data.id, tenantId: data.tenant_id, channel: data.channel, provider: data.provider,
            providerTemplateName: data.provider_template_name, locale: data.locale ?? "",
            bodyHash: data.body_hash ?? "", status: data.status,
          };
        },
        recordWindowRefusal: async (refusal) => {
          await insertAudit({
            tenantId: refusal.tenantId, humanActorId: options.humanActorId,
            action: "send.refused.window_expired", conversationId: refusal.conversationId,
            payload: { channel: refusal.channel, reason: refusal.reason },
          });
        },
        emitWindowExpired: async () => undefined,
        now: () => new Date(),
      });
      if (policy.kind === "refused") throw new Error(policy.reason);
      return {
        provider,
        tenantId: input.tenantId,
        simulated,
        approvedTemplate: null,
        authorizedCommand: policy.command,
        externalAccountId: installResult.data?.location_id ?? undefined,
      };
    },
    createMock: (provider) => provider === "ghl" ? createMockGhlDriver() : createMockMetaDriver(),
    createReal: (configuration, route) => configuration.provider === "ghl"
      ? createRealGhlDriver({
          clientId: configuration.values.GHL_CLIENT_ID,
          clientSecret: configuration.values.GHL_CLIENT_SECRET,
          webhookPublicKey: configuration.values.GHL_WEBHOOK_PUBLIC_KEY,
        }, { locationId: route.externalAccountId })
      : createRealMetaDriver({
          appId: configuration.values.META_APP_ID,
          appSecret: configuration.values.META_APP_SECRET,
          systemUserToken: configuration.values.META_SYSTEM_USER_TOKEN,
          webhookVerifyToken: configuration.values.META_WEBHOOK_VERIFY_TOKEN,
        }, {
          resolveConnection: (channel) => resolveMetaConnection(route.tenantId ?? "", channel),
        }),
  });

  return (request: SendToLeadRequest): Promise<SendToLeadResult> => sendToLead(request, {
    phaseEnabled: () => phase1Live() && phase3Live() &&
      (options.humanActorId ? inboxVerbsLive() : true),
    persistence,
    quietHours,
    dispatch,
  });
}

export async function listConversations(
  tenantId: string,
  options: {
    cursor?: ConversationCursor | null;
    limit?: number;
    objectionId?: string | null;
    view?: CoachConversationView;
  } = {},
  source: ConversationPageSource = loadLivePage,
  resolveObjectionConversations: ObjectionConversationResolver = objectionConversationIds,
): Promise<{ items: ConversationRead[]; nextCursor: ConversationCursor | null }> {
  const expectedTenant = requiredTenant(tenantId);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const objectionId = options.objectionId ?? null;
  const statuses = options.view ? conversationViewStatuses(options.view) : null;

  // The restriction is enforced here, where the rows are fetched, rather than implied by the URL
  // that prepared it. An unknown or foreign objection resolves to nothing and short-circuits to
  // an empty page instead of degrading into an unfiltered read of everything the coach owns.
  let conversationIds: readonly string[] | null = null;
  if (objectionId) {
    conversationIds = await resolveObjectionConversations(expectedTenant, objectionId);
    if (conversationIds.length === 0) return { items: [], nextCursor: null };
  }

  const rows = await source({
    tenantId: expectedTenant,
    cursor: options.cursor ?? null,
    limit,
    ...(conversationIds ? { conversationIds } : {}),
    ...(statuses ? { statuses } : {}),
  });
  if (rows.some((row) => row.tenant_id !== expectedTenant)) {
    throw new Error("CONVERSATION_TENANT_MISMATCH");
  }

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(mapConversation),
    nextCursor:
      rows.length > limit && last
        ? { lastActivityAt: last.last_message_at, id: last.id }
        : null,
  };
}

/**
 * Reads one durable conversation identifier directly, rather than finding it in the current
 * inbox page. The identifier stays addressable when a filter hides the thread or its activity
 * moves it beyond a pagination cursor.
 */
export type QuestionSetSizeSource = (tenantId: string, actorId: string) => Promise<number>;

/**
 * The service client carries no JWT, so the question read names its reader through the
 * `_for_actor` wrapper; the bare RPC refuses with PHASE7_SESSION_ACTOR_REQUIRED otherwise.
 */
async function loadEnabledQuestionSetSize(tenantId: string, actorId: string): Promise<number> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("read_coach_questions_for_actor", {
    p_actor_id: actorId,
    p_expected_tenant: tenantId,
  });
  if (error) throw new Error(`COACH_QUESTION_READ_FAILED:${error.message}`);
  const snapshot = data as { tenantId?: string; questions?: unknown } | null;
  if (!snapshot || snapshot.tenantId !== tenantId || !Array.isArray(snapshot.questions)) {
    throw new Error("COACH_QUESTION_SNAPSHOT_INVALID");
  }
  return snapshot.questions.filter((question) => (
    Boolean(question) && typeof question === "object" &&
    (question as { enabled?: unknown }).enabled === true
  )).length;
}

export async function getConversation(
  tenantId: string,
  conversationId: string,
  actorId: string,
  source: ConversationByIdSource = loadLiveConversation,
  questionSetSizeSource: QuestionSetSizeSource = loadEnabledQuestionSetSize,
): Promise<ConversationRead | null> {
  const expectedTenant = requiredTenant(tenantId);
  const expectedConversationId = conversationId.trim();
  if (!expectedConversationId) throw new Error("CONVERSATION_ID_REQUIRED");
  if (!actorId.trim()) throw new Error("CONVERSATION_READER_REQUIRED");
  const row = await source({ tenantId: expectedTenant, conversationId: expectedConversationId });
  if (!row) return null;
  if (row.id !== expectedConversationId || row.tenant_id !== expectedTenant) {
    throw new Error("CONVERSATION_TENANT_MISMATCH");
  }
  const questionSetSize = await questionSetSizeSource(expectedTenant, actorId);
  return { ...mapConversation(row), questionSetSize };
}

export type ConversationReadAcknowledgement = {
  conversationId: string;
  unreadByCoach: false;
  status: ConversationStatus;
  takenOverBy: string | null;
};

type ConversationReadAcknowledgementRow = {
  conversation_id: string;
  unread_by_coach: boolean;
  status: ConversationStatus;
  taken_over_by: string | null;
};

/**
 * The persisted unread flag is thread-scoped, so acknowledgement deliberately changes no
 * ownership or lifecycle fields. Authorization and the tenant assertion happen in the RPC under
 * the same row lock as the false transition.
 */
export async function acknowledgeConversationRead(input: {
  tenantId: string;
  conversationId: string;
  actorId: string;
}): Promise<ConversationReadAcknowledgement> {
  const tenantId = requiredTenant(input.tenantId);
  const conversationId = input.conversationId.trim();
  const actorId = input.actorId.trim();
  if (!conversationId) throw new Error("CONVERSATION_ID_REQUIRED");
  if (!actorId) throw new Error("CONVERSATION_ACTOR_REQUIRED");

  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("acknowledge_conversation_read", {
    p_expected_tenant: tenantId,
    p_conversation_id: conversationId,
    p_actor_id: actorId,
  });
  const row = (Array.isArray(data) ? data[0] : data) as ConversationReadAcknowledgementRow | null;
  if (error || !row) {
    throw new Error(`CONVERSATION_READ_ACKNOWLEDGEMENT_FAILED:${error?.message ?? "empty"}`);
  }
  if (
    row.conversation_id !== conversationId ||
    row.unread_by_coach !== false ||
    !CONVERSATION_STATUSES.includes(row.status)
  ) {
    throw new Error("CONVERSATION_READ_ACKNOWLEDGEMENT_INVALID");
  }
  return {
    conversationId: row.conversation_id,
    unreadByCoach: false,
    status: row.status,
    takenOverBy: row.taken_over_by,
  };
}

/**
 * Reads the complete tenant-scoped conversation set for inbox selection and exact filtered
 * exports. The regular page reader remains capped for API cursors; this helper deliberately
 * consumes every cursor so a select-all control never substitutes the first 100 rows for the
 * complete cohort.
 */
export async function listConversationSet(
  tenantId: string,
  options: { objectionId?: string | null; view?: CoachConversationView } = {},
  source: ConversationPageSource = loadLivePage,
  resolveObjectionConversations: ObjectionConversationResolver = objectionConversationIds,
): Promise<ConversationRead[]> {
  const expectedTenant = requiredTenant(tenantId);
  const objectionId = options.objectionId ?? null;
  const statuses = options.view ? conversationViewStatuses(options.view) : null;
  let conversationIds: readonly string[] | null = null;

  if (objectionId) {
    conversationIds = await resolveObjectionConversations(expectedTenant, objectionId);
    if (conversationIds.length === 0) return [];
  }

  const items: ConversationRead[] = [];
  const seenCursors = new Set<string>();
  let cursor: ConversationCursor | null = null;

  do {
    const rows = await source({
      tenantId: expectedTenant,
      cursor,
      limit: 100,
      ...(conversationIds ? { conversationIds } : {}),
      ...(statuses ? { statuses } : {}),
    });
    if (rows.some((row) => row.tenant_id !== expectedTenant)) {
      throw new Error("CONVERSATION_TENANT_MISMATCH");
    }

    const page = rows.slice(0, 100);
    items.push(...page.map(mapConversation));
    const last = page.at(-1);
    if (rows.length <= 100 || !last) break;

    cursor = { lastActivityAt: last.last_message_at, id: last.id };
    const cursorKey = `${cursor.lastActivityAt}:${cursor.id}`;
    if (seenCursors.has(cursorKey)) throw new Error("CONVERSATION_CURSOR_STALLED");
    seenCursors.add(cursorKey);
  } while (cursor);

  return items;
}
