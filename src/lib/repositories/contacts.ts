/**
 * Tenant-explicit contact reads for live lists and exports.
 *
 * Identity addresses come from contact_identities rather than contact.phone or contact.email; the
 * latter are possible duplicate signals and must never become an accidental merge key.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { setPipelineStage as setAuditedPipelineStage } from "@/lib/audit";
import { PIPELINE_STAGES, type PipelineStage } from "@/lib/pipeline/transitions";

export type ContactCursor = { lastActivityAt: string; id: string };

export type ContactRead = {
  id: string;
  name: string;
  channels: Array<{
    channel: "sms" | "instagram" | "messenger" | "whatsapp" | "webchat";
    address: string;
  }>;
  credit: string | null;
  goal: string | null;
  timeline: string | null;
  outcome: string | null;
  pipelineStage: string;
  optedOut?: boolean;
  timezone?: string | null;
  lastActivityAt: string;
  isDemo: boolean;
  isTest: boolean;
};

export type ContactIdentityView = {
  id: string;
  channel: ContactRead["channels"][number]["channel"];
  channelLabel: string;
  address: string;
  normalizedPhone: string | null;
  normalizedEmail: string | null;
  consentState: string;
};

export type DuplicateCandidateView = {
  id: string;
  otherContact: { id: string; name: string; isTest: boolean };
  source: "field_match" | "provider_asserted" | "lead_asserted" | "human_asserted";
  evidenceKey: string;
  evidence: Readonly<Record<string, unknown>>;
  state: "open" | "merged" | "dismissed";
  createdAt: string;
  testBoundary: "real" | "test" | "mixed";
  dataLabel: "Demo" | "Test" | null;
};

export type ContactIdentityDetail = {
  contactId: string;
  name: string;
  isDemo: boolean;
  isTest: boolean;
  identities: ContactIdentityView[];
  candidates: DuplicateCandidateView[];
  mergeState:
    | { status: "active"; mergedIntoContactId: null; mergedAt: null }
    | { status: "merged"; mergedIntoContactId: string; mergedAt: string };
  undo: { auditRowId: number } | null;
};

type ContactRow = {
  id: string;
  tenant_id: string;
  name: string | null;
  credit_range: string | null;
  funding_goal: string | null;
  timeline: string | null;
  outcome: string | null;
  pipeline_stage: string;
  opted_out?: boolean;
  timezone?: string | null;
  last_seen_at: string | null;
  created_at: string;
  is_test: boolean;
  merged_into_contact_id: string | null;
  tenant: { is_demo: boolean };
  identities: Array<{
    channel: ContactRead["channels"][number]["channel"];
    provider_identity_id: string;
  }>;
};

type ContactPageSource = (input: {
  tenantId: string;
  cursor: ContactCursor | null;
  limit: number;
}) => Promise<ContactRow[]>;

const CONTACT_SELECT = `
  id, tenant_id, name, credit_range, funding_goal, timeline, outcome, pipeline_stage,
  opted_out, timezone, last_seen_at, created_at, is_test, merged_into_contact_id,
  tenant:tenants!inner(is_demo),
  identities:contact_identities(channel, provider_identity_id)
`;

type ContactDetailRow = {
  id: string;
  tenant_id: string;
  name: string | null;
  is_test: boolean;
  merged_into_contact_id: string | null;
  merged_at: string | null;
  merge_audit_id: number | null;
  tenant: { is_demo: boolean };
  identities: Array<{
    id: string;
    tenant_id: string;
    channel: ContactIdentityView["channel"];
    provider_identity_id: string;
    normalized_phone: string | null;
    normalized_email: string | null;
    consent_state: string;
  }>;
};

type CandidateRow = {
  id: string;
  tenant_id: string;
  contact_a_id: string;
  contact_b_id: string;
  source: DuplicateCandidateView["source"];
  evidence_key: string;
  evidence: Readonly<Record<string, unknown>>;
  state: DuplicateCandidateView["state"];
  created_at: string;
  tenant: { is_demo: boolean };
  contact_a: { id: string; tenant_id: string; name: string | null; is_test: boolean };
  contact_b: { id: string; tenant_id: string; name: string | null; is_test: boolean };
};

type UndoAuditRow = { id: number; tenant_id: string; action: string };

type ContactDetailSource = (input: {
  tenantId: string;
  contactId: string;
}) => Promise<{
  contact: ContactDetailRow | null;
  candidates: CandidateRow[];
  mergeAudit: UndoAuditRow | null;
  unmergeExists: boolean;
}>;

async function loadLivePage(input: {
  tenantId: string;
  cursor: ContactCursor | null;
  limit: number;
}): Promise<ContactRow[]> {
  const client = createSupabaseServiceClient();
  let query = client
    .from("contacts")
    .select(CONTACT_SELECT)
    .eq("tenant_id", input.tenantId)
    .is("merged_into_contact_id", null)
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(input.limit + 1);
  if (input.cursor) {
    query = query.or(
      `last_seen_at.lt.${input.cursor.lastActivityAt},and(last_seen_at.eq.${input.cursor.lastActivityAt},id.lt.${input.cursor.id})`,
    );
  }
  const { data, error } = await query;
  if (error) throw new Error(`CONTACT_READ_FAILED:${error.message}`);
  return (data ?? []) as unknown as ContactRow[];
}

const CHANNEL_LABELS: Readonly<Record<ContactIdentityView["channel"], string>> = {
  instagram: "Instagram",
  messenger: "Facebook Messenger",
  sms: "Text messages (SMS)",
  whatsapp: "WhatsApp",
  webchat: "Web chat",
};

async function loadLiveDetail(input: {
  tenantId: string;
  contactId: string;
}): ReturnType<ContactDetailSource> {
  const client = createSupabaseServiceClient();
  const [contactResult, candidateResult] = await Promise.all([
    client
      .from("contacts")
      .select(`
        id, tenant_id, name, is_test, merged_into_contact_id, merged_at, merge_audit_id,
        tenant:tenants!inner(is_demo),
        identities:contact_identities(
          id, tenant_id, channel, provider_identity_id, normalized_phone, normalized_email,
          consent_state
        )
      `)
      .eq("tenant_id", input.tenantId)
      .eq("id", input.contactId)
      .maybeSingle(),
    client
      .from("contact_duplicate_candidates")
      .select(`
        id, tenant_id, contact_a_id, contact_b_id, source, evidence_key, evidence, state,
        created_at, tenant:tenants!inner(is_demo),
        contact_a:contacts!contact_duplicate_candidates_contact_a_id_fkey(
          id, tenant_id, name, is_test
        ),
        contact_b:contacts!contact_duplicate_candidates_contact_b_id_fkey(
          id, tenant_id, name, is_test
        )
      `)
      .eq("tenant_id", input.tenantId)
      .or(`contact_a_id.eq.${input.contactId},contact_b_id.eq.${input.contactId}`)
      .order("created_at", { ascending: false }),
  ]);
  if (contactResult.error) throw new Error("CONTACT_DETAIL_READ_FAILED");
  if (candidateResult.error) throw new Error("CONTACT_CANDIDATE_READ_FAILED");

  const contact = contactResult.data as unknown as ContactDetailRow | null;
  let mergeAudit: UndoAuditRow | null = null;
  let unmergeExists = false;
  if (contact?.merge_audit_id !== null && contact?.merge_audit_id !== undefined) {
    const [mergeResult, unmergeResult] = await Promise.all([
      client
        .from("audit_log")
        .select("id, tenant_id, action")
        .eq("tenant_id", input.tenantId)
        .eq("id", contact.merge_audit_id)
        .eq("action", "contact.merged")
        .maybeSingle(),
      client
        .from("audit_log")
        .select("id")
        .eq("tenant_id", input.tenantId)
        .eq("action", "contact.unmerged")
        .eq("payload->>mergeAuditId", String(contact.merge_audit_id))
        .limit(1),
    ]);
    if (mergeResult.error || unmergeResult.error) throw new Error("CONTACT_UNDO_READ_FAILED");
    mergeAudit = mergeResult.data as UndoAuditRow | null;
    unmergeExists = (unmergeResult.data?.length ?? 0) > 0;
  }
  return {
    contact,
    candidates: (candidateResult.data ?? []) as unknown as CandidateRow[],
    mergeAudit,
    unmergeExists,
  };
}

export async function listContacts(
  tenantId: string,
  options: { cursor?: ContactCursor | null; limit?: number } = {},
  source: ContactPageSource = loadLivePage,
): Promise<{ items: ContactRead[]; nextCursor: ContactCursor | null }> {
  const expectedTenant = tenantId.trim();
  if (!expectedTenant) throw new Error("EXPECTED_TENANT_REQUIRED");
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const rows = await source({ tenantId: expectedTenant, cursor: options.cursor ?? null, limit });
  if (rows.some((row) => row.tenant_id !== expectedTenant)) {
    throw new Error("CONTACT_TENANT_MISMATCH");
  }

  const activeRows = rows.filter((row) => row.merged_into_contact_id === null);

  const page = activeRows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      name: row.name ?? "Unknown lead",
      channels: row.identities.map((identity) => ({
        channel: identity.channel,
        address: identity.provider_identity_id,
      })),
      credit: row.credit_range,
      goal: row.funding_goal,
      timeline: row.timeline,
      outcome: row.outcome,
      pipelineStage: row.pipeline_stage,
      optedOut: row.opted_out ?? false,
      timezone: row.timezone ?? null,
      lastActivityAt: row.last_seen_at ?? row.created_at,
      isDemo: row.tenant.is_demo,
      isTest: row.is_test,
    })),
    nextCursor:
      activeRows.length > limit && last
        ? { lastActivityAt: last.last_seen_at ?? last.created_at, id: last.id }
        : null,
  };
}

function candidateTestBoundary(left: boolean, right: boolean) {
  if (left !== right) return "mixed" as const;
  return left ? "test" as const : "real" as const;
}

export async function getContactIdentityDetail(
  tenantId: string,
  contactId: string,
  source: ContactDetailSource = loadLiveDetail,
): Promise<ContactIdentityDetail> {
  const expectedTenant = tenantId.trim();
  const expectedContact = contactId.trim();
  if (!expectedTenant) throw new Error("EXPECTED_TENANT_REQUIRED");
  if (!expectedContact) throw new Error("CONTACT_ID_REQUIRED");
  const result = await source({ tenantId: expectedTenant, contactId: expectedContact });
  const contact = result.contact;
  if (!contact) throw new Error("CONTACT_NOT_FOUND");
  if (contact.tenant_id !== expectedTenant || contact.id !== expectedContact) {
    throw new Error("CONTACT_TENANT_MISMATCH");
  }
  if (contact.identities.some((identity) => identity.tenant_id !== expectedTenant)) {
    throw new Error("CONTACT_IDENTITY_TENANT_MISMATCH");
  }
  if (result.candidates.some((candidate) =>
    candidate.tenant_id !== expectedTenant || candidate.contact_a.tenant_id !== expectedTenant ||
    candidate.contact_b.tenant_id !== expectedTenant ||
    (candidate.contact_a_id !== expectedContact && candidate.contact_b_id !== expectedContact)
  )) {
    throw new Error("CONTACT_CANDIDATE_TENANT_MISMATCH");
  }

  const candidates = result.candidates.map((candidate): DuplicateCandidateView => {
    const other = candidate.contact_a_id === expectedContact
      ? candidate.contact_b
      : candidate.contact_a;
    const boundary = candidateTestBoundary(candidate.contact_a.is_test, candidate.contact_b.is_test);
    return {
      id: candidate.id,
      otherContact: {
        id: other.id,
        name: other.name ?? "Unknown lead",
        isTest: other.is_test,
      },
      source: candidate.source,
      evidenceKey: candidate.evidence_key,
      evidence: candidate.evidence,
      state: candidate.state,
      createdAt: candidate.created_at,
      testBoundary: boundary,
      dataLabel: candidate.tenant.is_demo ? "Demo" : boundary === "real" ? null : "Test",
    };
  });
  const merged = contact.merged_into_contact_id !== null && contact.merged_at !== null;
  const undoAudit = result.mergeAudit;
  if (undoAudit && (undoAudit.tenant_id !== expectedTenant || undoAudit.action !== "contact.merged")) {
    throw new Error("CONTACT_UNDO_TENANT_MISMATCH");
  }

  return {
    contactId: contact.id,
    name: contact.name ?? "Unknown lead",
    isDemo: contact.tenant.is_demo,
    isTest: contact.is_test,
    identities: contact.identities.map((identity) => ({
      id: identity.id,
      channel: identity.channel,
      channelLabel: CHANNEL_LABELS[identity.channel],
      address: identity.normalized_phone ?? identity.normalized_email ?? identity.provider_identity_id,
      normalizedPhone: identity.normalized_phone,
      normalizedEmail: identity.normalized_email,
      consentState: identity.consent_state,
    })),
    candidates,
    mergeState: merged
      ? {
          status: "merged",
          mergedIntoContactId: contact.merged_into_contact_id as string,
          mergedAt: contact.merged_at as string,
        }
      : { status: "active", mergedIntoContactId: null, mergedAt: null },
    undo: merged && undoAudit && !result.unmergeExists ? { auditRowId: undoAudit.id } : null,
  };
}

export async function setPipelineStage(
  ...args: Parameters<typeof setAuditedPipelineStage>
): ReturnType<typeof setAuditedPipelineStage> {
  return setAuditedPipelineStage(...args);
}

export type PipelineStageCounts = Readonly<Record<PipelineStage, number>>;

type StageCountRow = { tenant_id: string; pipeline_stage: string };
type StageCountSource = (tenantId: string) => Promise<StageCountRow[]>;

async function loadLiveStageCounts(tenantId: string): Promise<StageCountRow[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("contacts")
    .select("tenant_id, pipeline_stage")
    .eq("tenant_id", tenantId)
    .is("merged_into_contact_id", null);
  if (error) throw new Error(`CONTACT_STAGE_COUNT_READ_FAILED:${error.message}`);
  return (data ?? []) as unknown as StageCountRow[];
}

/**
 * Every board column, even one with zero leads, so the kanban never drops a stage the way a
 * derived-from-rows count would.
 */
export async function countContactsByStage(
  tenantId: string,
  source: StageCountSource = loadLiveStageCounts,
): Promise<PipelineStageCounts> {
  const expectedTenant = tenantId.trim();
  if (!expectedTenant) throw new Error("EXPECTED_TENANT_REQUIRED");
  const rows = await source(expectedTenant);
  if (rows.some((row) => row.tenant_id !== expectedTenant)) {
    throw new Error("CONTACT_TENANT_MISMATCH");
  }
  const counts = Object.fromEntries(
    PIPELINE_STAGES.map((stage) => [stage, 0]),
  ) as Record<PipelineStage, number>;
  for (const row of rows) {
    if (!PIPELINE_STAGES.includes(row.pipeline_stage as PipelineStage)) {
      throw new Error("CONTACT_STAGE_COUNT_STAGE_INVALID");
    }
    counts[row.pipeline_stage as PipelineStage] += 1;
  }
  return counts;
}
