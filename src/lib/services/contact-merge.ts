/**
 * Receipt-checked wrappers for the reversible contact merge RPCs.
 *
 * Mutation stays inside the database transaction. This layer validates sanctioned evidence, maps
 * value-free conflict codes, and proves the audit before-image and relation readback before a route
 * can render Merged, Undo, or Logged.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const CONTACT_MERGE_SOURCES = [
  "provider_asserted",
  "lead_asserted",
  "human_asserted",
] as const;
export type ContactMergeSource = (typeof CONTACT_MERGE_SOURCES)[number];

export type MergeContactsInput = {
  expectedTenantId: string;
  winnerId: string;
  loserId: string;
  source: ContactMergeSource;
  evidenceId: string | null;
  actorUserId: string;
  reason: string;
  idempotencyKey: string;
};

export type UnmergeContactInput = {
  expectedTenantId: string;
  mergeAuditId: number;
  actorUserId: string;
  reason: string;
  idempotencyKey: string;
};

export type MergeResult = {
  winnerId: string;
  loserId: string;
  mergeAuditId: number;
  movedIdentityCount: number;
  movedConversationCount: number;
};

export type UnmergeResult = {
  winnerId: string;
  loserId: string;
  unmergeAuditId: number;
  restoredIdentityCount: number;
  restoredConversationCount: number;
};

type QualificationValues = {
  creditRange: string | null;
  fundingGoal: string | null;
  timeline: string | null;
  businessStage: string | null;
  annualRevenueCents: number | null;
  businessContext: string | null;
  dqReason: string | null;
};

export type ContactMutationContact = {
  id: string;
  tenantId: string;
  isTest: boolean;
  optedOut: boolean;
  qualification: QualificationValues;
  outcome: string | null;
  updatedAt: string;
  mergedIntoContactId: string | null;
  mergeAuditId: number | null;
};

type RelationFact = { id: string; contactId: string };
type MessageFact = { id: string; conversationId: string };
type AppointmentFact = { id: string; contactId: string };
type BillableFact = { id: string; appointmentId: string | null };

export type ContactMutationSnapshot = {
  contacts: readonly ContactMutationContact[];
  identities: readonly RelationFact[];
  conversations: readonly RelationFact[];
  messages: readonly MessageFact[];
  appointments: readonly AppointmentFact[];
  billableEvents: readonly BillableFact[];
};

type ContactAudit = {
  id: number;
  tenantId: string;
  action: string;
  targetId: string | null;
  payload: Readonly<Record<string, unknown>>;
};

type MergeRpcRow = {
  winner_id: string;
  loser_id: string;
  merge_audit_id: number;
  moved_identity_count: number;
  moved_conversation_count: number;
};

type UnmergeRpcRow = {
  winner_id: string;
  loser_id: string;
  unmerge_audit_id: number;
  restored_identity_count: number;
  restored_conversation_count: number;
};

export type ContactMergeDependencies = {
  merge(args: Record<string, unknown>): Promise<MergeRpcRow>;
  unmerge(args: Record<string, unknown>): Promise<UnmergeRpcRow>;
  loadSnapshot(tenantId: string, contactIds: readonly string[]): Promise<ContactMutationSnapshot>;
  loadAudit(tenantId: string, auditId: number): Promise<ContactAudit | null>;
};

export class ContactMergeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ContactMergeError";
  }
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new ContactMergeError(code);
  return normalized;
}

function singleMerge(data: unknown): MergeRpcRow {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new ContactMergeError("MERGE_CONFLICT");
  const value = row as Record<string, unknown>;
  if (typeof value.winner_id !== "string" || typeof value.loser_id !== "string" ||
    typeof value.merge_audit_id !== "number" || typeof value.moved_identity_count !== "number" ||
    typeof value.moved_conversation_count !== "number") {
    throw new ContactMergeError("MERGE_CONFLICT");
  }
  return value as MergeRpcRow;
}

function singleUnmerge(data: unknown): UnmergeRpcRow {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new ContactMergeError("UNMERGE_CONFLICT");
  const value = row as Record<string, unknown>;
  if (typeof value.winner_id !== "string" || typeof value.loser_id !== "string" ||
    typeof value.unmerge_audit_id !== "number" ||
    typeof value.restored_identity_count !== "number" ||
    typeof value.restored_conversation_count !== "number") {
    throw new ContactMergeError("UNMERGE_CONFLICT");
  }
  return value as UnmergeRpcRow;
}

async function liveDependencies(): Promise<ContactMergeDependencies> {
  const client = createSupabaseServiceClient();
  return {
    merge: async (args) => {
      const { data, error } = await client.rpc("merge_contacts", args);
      if (error) throw new Error(error.message);
      return singleMerge(data);
    },
    unmerge: async (args) => {
      const { data, error } = await client.rpc("unmerge_contact", args);
      if (error) throw new Error(error.message);
      return singleUnmerge(data);
    },
    loadSnapshot: async (tenantId, contactIds) => {
      const [contactsResult, identitiesResult, conversationsResult, appointmentsResult] =
        await Promise.all([
          client
            .from("contacts")
            .select(`
              id, tenant_id, is_test, opted_out, credit_range, funding_goal, timeline,
              business_stage, annual_revenue_cents, business_context, dq_reason, outcome,
              updated_at, merged_into_contact_id, merge_audit_id
            `)
            .eq("tenant_id", tenantId)
            .in("id", [...contactIds]),
          client
            .from("contact_identities")
            .select("id, contact_id")
            .eq("tenant_id", tenantId)
            .in("contact_id", [...contactIds]),
          client
            .from("conversations")
            .select("id, contact_id")
            .eq("tenant_id", tenantId)
            .in("contact_id", [...contactIds]),
          client
            .from("appointments")
            .select("id, contact_id")
            .eq("tenant_id", tenantId)
            .in("contact_id", [...contactIds]),
        ]);
      if (contactsResult.error || identitiesResult.error || conversationsResult.error ||
        appointmentsResult.error) {
        throw new ContactMergeError("CONTACT_MERGE_READBACK_FAILED");
      }
      const conversations = (conversationsResult.data ?? []).map((row) => ({
        id: String(row.id),
        contactId: String(row.contact_id),
      }));
      const appointments = (appointmentsResult.data ?? []).map((row) => ({
        id: String(row.id),
        contactId: String(row.contact_id),
      }));
      const [messagesResult, billableResult] = await Promise.all([
        conversations.length === 0
          ? Promise.resolve({ data: [], error: null })
          : client
              .from("messages")
              .select("id, conversation_id")
              .eq("tenant_id", tenantId)
              .in("conversation_id", conversations.map((row) => row.id)),
        appointments.length === 0
          ? Promise.resolve({ data: [], error: null })
          : client
              .from("billable_events")
              .select("id, appointment_id")
              .eq("tenant_id", tenantId)
              .in("appointment_id", appointments.map((row) => row.id)),
      ]);
      if (messagesResult.error || billableResult.error) {
        throw new ContactMergeError("CONTACT_MERGE_READBACK_FAILED");
      }
      const contacts = (contactsResult.data ?? []).map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        isTest: Boolean(row.is_test),
        optedOut: Boolean(row.opted_out),
        qualification: {
          creditRange: typeof row.credit_range === "string" ? row.credit_range : null,
          fundingGoal: typeof row.funding_goal === "string" ? row.funding_goal : null,
          timeline: typeof row.timeline === "string" ? row.timeline : null,
          businessStage: typeof row.business_stage === "string" ? row.business_stage : null,
          annualRevenueCents: typeof row.annual_revenue_cents === "number"
            ? row.annual_revenue_cents
            : null,
          businessContext: typeof row.business_context === "string" ? row.business_context : null,
          dqReason: typeof row.dq_reason === "string" ? row.dq_reason : null,
        },
        outcome: typeof row.outcome === "string" ? row.outcome : null,
        updatedAt: String(row.updated_at),
        mergedIntoContactId: typeof row.merged_into_contact_id === "string"
          ? row.merged_into_contact_id
          : null,
        mergeAuditId: typeof row.merge_audit_id === "number" ? row.merge_audit_id : null,
      }));
      return {
        contacts,
        identities: (identitiesResult.data ?? []).map((row) => ({
          id: String(row.id),
          contactId: String(row.contact_id),
        })),
        conversations,
        messages: (messagesResult.data ?? []).map((row) => ({
          id: String(row.id),
          conversationId: String(row.conversation_id),
        })),
        appointments,
        billableEvents: (billableResult.data ?? []).map((row) => ({
          id: String(row.id),
          appointmentId: typeof row.appointment_id === "string" ? row.appointment_id : null,
        })),
      };
    },
    loadAudit: async (tenantId, auditId) => {
      const { data, error } = await client
        .from("audit_log")
        .select("id, tenant_id, action, target_id, payload")
        .eq("tenant_id", tenantId)
        .eq("id", auditId)
        .maybeSingle();
      if (error) throw new ContactMergeError("CONTACT_MERGE_READBACK_FAILED");
      return data
        ? {
            id: Number(data.id),
            tenantId: String(data.tenant_id),
            action: String(data.action),
            targetId: typeof data.target_id === "string" ? data.target_id : null,
            payload: data.payload as Readonly<Record<string, unknown>>,
          }
        : null;
    },
  };
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContactMergeError(code);
  return value as Record<string, unknown>;
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function contactFromAudit(value: unknown): ContactMutationContact {
  const row = object(value, "MERGE_AUDIT_INVALID");
  if (typeof row.id !== "string" || typeof row.tenant_id !== "string" ||
    typeof row.is_test !== "boolean" || typeof row.opted_out !== "boolean" ||
    typeof row.updated_at !== "string") {
    throw new ContactMergeError("MERGE_AUDIT_INVALID");
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    isTest: row.is_test,
    optedOut: row.opted_out,
    qualification: {
      creditRange: nullableString(row.credit_range),
      fundingGoal: nullableString(row.funding_goal),
      timeline: nullableString(row.timeline),
      businessStage: nullableString(row.business_stage),
      annualRevenueCents: typeof row.annual_revenue_cents === "number"
        ? row.annual_revenue_cents
        : null,
      businessContext: nullableString(row.business_context),
      dqReason: nullableString(row.dq_reason),
    },
    outcome: nullableString(row.outcome),
    updatedAt: row.updated_at,
    mergedIntoContactId: nullableString(row.merged_into_contact_id),
    mergeAuditId: typeof row.merge_audit_id === "number" ? row.merge_audit_id : null,
  };
}

function relationFromAudit(value: unknown) {
  const row = object(value, "MERGE_AUDIT_INVALID");
  if (typeof row.id !== "string" || typeof row.contact_id !== "string") {
    throw new ContactMergeError("MERGE_AUDIT_INVALID");
  }
  return { id: row.id, contactId: row.contact_id };
}

function mergePrior(audit: ContactAudit) {
  const prior = object(audit.payload.prior, "MERGE_AUDIT_INVALID");
  const identities = Array.isArray(prior.identities) ? prior.identities.map(relationFromAudit) : null;
  const conversations = Array.isArray(prior.conversations)
    ? prior.conversations.map(relationFromAudit)
    : null;
  if (!identities || !conversations) throw new ContactMergeError("MERGE_AUDIT_INVALID");
  return {
    winner: contactFromAudit(prior.winner),
    loser: contactFromAudit(prior.loser),
    identities,
    conversations,
  };
}

function contact(snapshot: ContactMutationSnapshot, id: string, tenantId: string) {
  const row = snapshot.contacts.find((candidate) => candidate.id === id);
  if (!row || row.tenantId !== tenantId) throw new ContactMergeError("MERGE_CONFLICT");
  return row;
}

function expectedQualification(winner: ContactMutationContact, loser: ContactMutationContact) {
  const newer = loser.updatedAt > winner.updatedAt ? loser.qualification : winner.qualification;
  const older = newer === loser.qualification ? winner.qualification : loser.qualification;
  return Object.fromEntries(
    Object.keys(newer).map((key) => {
      const field = key as keyof QualificationValues;
      return [field, newer[field] ?? older[field]];
    }),
  ) as QualificationValues;
}

function expectedOutcome(left: string | null, right: string | null) {
  return ["BOOK", "SOFT_DQ", "HARD_DQ"].find((value) => left === value || right === value) ?? null;
}

function sortedFacts<T>(rows: readonly T[], read: (row: T) => string) {
  return rows.map(read).sort();
}

function unchangedNonContactFacts(before: ContactMutationSnapshot, after: ContactMutationSnapshot) {
  return JSON.stringify({
    messages: sortedFacts(before.messages, (row) => `${row.id}:${row.conversationId}`),
    appointments: sortedFacts(before.appointments, (row) => `${row.id}:${row.contactId}`),
    billableEvents: sortedFacts(before.billableEvents, (row) => `${row.id}:${row.appointmentId}`),
  }) === JSON.stringify({
    messages: sortedFacts(after.messages, (row) => `${row.id}:${row.conversationId}`),
    appointments: sortedFacts(after.appointments, (row) => `${row.id}:${row.contactId}`),
    billableEvents: sortedFacts(after.billableEvents, (row) => `${row.id}:${row.appointmentId}`),
  });
}

function sameContactBeforeImage(left: ContactMutationContact, right: ContactMutationContact) {
  return left.id === right.id && left.tenantId === right.tenantId && left.isTest === right.isTest &&
    left.optedOut === right.optedOut && left.outcome === right.outcome &&
    left.updatedAt === right.updatedAt && left.mergedIntoContactId === right.mergedIntoContactId &&
    left.mergeAuditId === right.mergeAuditId &&
    JSON.stringify(left.qualification) === JSON.stringify(right.qualification);
}

function assertAudit(audit: ContactAudit | null, expected: {
  id: number;
  tenantId: string;
  action: string;
  targetId: string;
}) {
  if (!audit || audit.id !== expected.id || audit.tenantId !== expected.tenantId ||
    audit.action !== expected.action || audit.targetId !== expected.targetId) {
    throw new ContactMergeError(
      expected.action === "contact.merged" ? "MERGE_CONFLICT" : "UNMERGE_CONFLICT",
    );
  }
  return audit;
}

function mapMergeError(error: unknown, operation: "merge" | "unmerge"): never {
  if (error instanceof ContactMergeError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("IDEMPOTENCY_PAYLOAD_MISMATCH")) {
    throw new ContactMergeError("IDEMPOTENCY_PAYLOAD_MISMATCH");
  }
  if (message.includes("CONTACT_MERGE_TEST_MISMATCH")) {
    throw new ContactMergeError("TEST_BOUNDARY_MISMATCH");
  }
  throw new ContactMergeError(operation === "merge" ? "MERGE_CONFLICT" : "UNMERGE_CONFLICT");
}

export async function mergeContacts(
  input: MergeContactsInput,
  dependencies?: ContactMergeDependencies,
): Promise<MergeResult> {
  const tenantId = required(input.expectedTenantId, "EXPECTED_TENANT_REQUIRED");
  const winnerId = required(input.winnerId, "WINNER_CONTACT_ID_REQUIRED");
  const loserId = required(input.loserId, "LOSER_CONTACT_ID_REQUIRED");
  if (winnerId === loserId) throw new ContactMergeError("MERGE_CONFLICT");
  if (!CONTACT_MERGE_SOURCES.includes(input.source)) throw new ContactMergeError("MERGE_CONFLICT");
  const evidenceId = input.evidenceId?.trim() || null;
  if (input.source !== "human_asserted" && !evidenceId) {
    throw new ContactMergeError("MERGE_EVIDENCE_REQUIRED");
  }
  const actorUserId = required(input.actorUserId, "ACTOR_USER_ID_REQUIRED");
  const reason = required(input.reason, "CONTACT_MERGE_REASON_REQUIRED");
  const idempotencyKey = required(input.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());

  try {
    const before = await deps.loadSnapshot(tenantId, [winnerId, loserId]);
    const winnerBefore = contact(before, winnerId, tenantId);
    const loserBefore = contact(before, loserId, tenantId);
    if (winnerBefore.isTest !== loserBefore.isTest) {
      throw new ContactMergeError("TEST_BOUNDARY_MISMATCH");
    }
    const row = await deps.merge({
      p_expected_tenant: tenantId,
      p_winner_id: winnerId,
      p_loser_id: loserId,
      p_source: input.source,
      p_evidence_id: evidenceId,
      p_actor_id: actorUserId,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
    });
    if (row.winner_id !== winnerId || row.loser_id !== loserId) {
      throw new ContactMergeError("MERGE_CONFLICT");
    }
    const [after, auditResult] = await Promise.all([
      deps.loadSnapshot(tenantId, [winnerId, loserId]),
      deps.loadAudit(tenantId, row.merge_audit_id),
    ]);
    const audit = assertAudit(auditResult, {
      id: row.merge_audit_id,
      tenantId,
      action: "contact.merged",
      targetId: winnerId,
    });
    const prior = mergePrior(audit);
    if (prior.winner.tenantId !== tenantId || prior.loser.tenantId !== tenantId ||
      prior.winner.id !== winnerId || prior.loser.id !== loserId ||
      prior.winner.isTest !== prior.loser.isTest) {
      throw new ContactMergeError("MERGE_CONFLICT");
    }
    const firstApplication = loserBefore.mergedIntoContactId === null;
    const beforeLoserIdentities = before.identities.filter((relation) => relation.contactId === loserId);
    const beforeLoserConversations = before.conversations.filter(
      (relation) => relation.contactId === loserId,
    );
    if (firstApplication && (
      !sameContactBeforeImage(prior.winner, winnerBefore) ||
      !sameContactBeforeImage(prior.loser, loserBefore) ||
      JSON.stringify(sortedFacts(prior.identities, (row) => `${row.id}:${row.contactId}`)) !==
        JSON.stringify(sortedFacts(beforeLoserIdentities, (row) => `${row.id}:${row.contactId}`)) ||
      JSON.stringify(sortedFacts(prior.conversations, (row) => `${row.id}:${row.contactId}`)) !==
        JSON.stringify(sortedFacts(beforeLoserConversations, (row) => `${row.id}:${row.contactId}`))
    )) {
      throw new ContactMergeError("MERGE_CONFLICT");
    }
    const winnerAfter = contact(after, winnerId, tenantId);
    const loserAfter = contact(after, loserId, tenantId);
    if (winnerAfter.optedOut !== (prior.winner.optedOut || prior.loser.optedOut) ||
      JSON.stringify(winnerAfter.qualification) !==
        JSON.stringify(expectedQualification(prior.winner, prior.loser)) ||
      winnerAfter.outcome !== expectedOutcome(prior.winner.outcome, prior.loser.outcome) ||
      loserAfter.mergedIntoContactId !== winnerId || loserAfter.mergeAuditId !== row.merge_audit_id) {
      throw new ContactMergeError("MERGE_CONFLICT");
    }
    if (prior.identities.some((relation) => !after.identities.some((candidate) =>
      candidate.id === relation.id && candidate.contactId === winnerId
    )) || prior.conversations.some((relation) => !after.conversations.some((candidate) =>
      candidate.id === relation.id && candidate.contactId === winnerId
    ))) {
      throw new ContactMergeError("MERGE_CONFLICT");
    }
    if (row.moved_identity_count !== prior.identities.length ||
      row.moved_conversation_count !== prior.conversations.length ||
      !unchangedNonContactFacts(before, after)) {
      throw new ContactMergeError("MERGE_CONFLICT");
    }
    return {
      winnerId,
      loserId,
      mergeAuditId: row.merge_audit_id,
      movedIdentityCount: row.moved_identity_count,
      movedConversationCount: row.moved_conversation_count,
    };
  } catch (error) {
    mapMergeError(error, "merge");
  }
}

export async function unmergeContact(
  input: UnmergeContactInput,
  dependencies?: ContactMergeDependencies,
): Promise<UnmergeResult> {
  const tenantId = required(input.expectedTenantId, "EXPECTED_TENANT_REQUIRED");
  if (!Number.isSafeInteger(input.mergeAuditId) || input.mergeAuditId <= 0) {
    throw new ContactMergeError("MERGE_AUDIT_ID_REQUIRED");
  }
  const actorUserId = required(input.actorUserId, "ACTOR_USER_ID_REQUIRED");
  const reason = required(input.reason, "CONTACT_UNMERGE_REASON_REQUIRED");
  const idempotencyKey = required(input.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());

  try {
    const mergeAuditResult = await deps.loadAudit(tenantId, input.mergeAuditId);
    const mergeAudit = assertAudit(mergeAuditResult, {
      id: input.mergeAuditId,
      tenantId,
      action: "contact.merged",
      targetId: mergeAuditResult?.targetId ?? "",
    });
    const prior = mergePrior(mergeAudit);
    if (mergeAudit.targetId !== prior.winner.id || prior.winner.tenantId !== tenantId ||
      prior.loser.tenantId !== tenantId) {
      throw new ContactMergeError("UNMERGE_CONFLICT");
    }
    const before = await deps.loadSnapshot(tenantId, [prior.winner.id, prior.loser.id]);
    const row = await deps.unmerge({
      p_expected_tenant: tenantId,
      p_merge_audit_id: input.mergeAuditId,
      p_actor_id: actorUserId,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
    });
    if (row.winner_id !== prior.winner.id || row.loser_id !== prior.loser.id ||
      row.restored_identity_count !== prior.identities.length ||
      row.restored_conversation_count !== prior.conversations.length) {
      throw new ContactMergeError("UNMERGE_CONFLICT");
    }
    const [after, unmergeAuditResult] = await Promise.all([
      deps.loadSnapshot(tenantId, [prior.winner.id, prior.loser.id]),
      deps.loadAudit(tenantId, row.unmerge_audit_id),
    ]);
    assertAudit(unmergeAuditResult, {
      id: row.unmerge_audit_id,
      tenantId,
      action: "contact.unmerged",
      targetId: prior.loser.id,
    });
    const winnerAfter = contact(after, prior.winner.id, tenantId);
    const loserAfter = contact(after, prior.loser.id, tenantId);
    if (winnerAfter.optedOut !== prior.winner.optedOut ||
      JSON.stringify(winnerAfter.qualification) !== JSON.stringify(prior.winner.qualification) ||
      winnerAfter.outcome !== prior.winner.outcome || loserAfter.optedOut !== prior.loser.optedOut ||
      JSON.stringify(loserAfter.qualification) !== JSON.stringify(prior.loser.qualification) ||
      loserAfter.outcome !== prior.loser.outcome || loserAfter.mergedIntoContactId !== null ||
      loserAfter.mergeAuditId !== null) {
      throw new ContactMergeError("UNMERGE_CONFLICT");
    }
    if (prior.identities.some((relation) => !after.identities.some((candidate) =>
      candidate.id === relation.id && candidate.contactId === prior.loser.id
    )) || prior.conversations.some((relation) => !after.conversations.some((candidate) =>
      candidate.id === relation.id && candidate.contactId === prior.loser.id
    )) || !unchangedNonContactFacts(before, after)) {
      throw new ContactMergeError("UNMERGE_CONFLICT");
    }
    return {
      winnerId: row.winner_id,
      loserId: row.loser_id,
      unmergeAuditId: row.unmerge_audit_id,
      restoredIdentityCount: row.restored_identity_count,
      restoredConversationCount: row.restored_conversation_count,
    };
  } catch (error) {
    mapMergeError(error, "unmerge");
  }
}
