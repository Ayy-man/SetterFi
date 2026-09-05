import type { MessagingChannel } from "@/lib/booking/types";
import {
  OFFER_CADENCE_SENDING_PURPOSES,
  type OfferCadencePurpose,
} from "@/lib/offer/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type FollowupCopyStatus = "draft" | "submitted" | "approved" | "rejected";

export type FollowupCopy = {
  id: string;
  tenantId: string;
  tenantName?: string;
  channel: MessagingChannel;
  purpose: Exclude<OfferCadencePurpose, "none">;
  body: string;
  status: FollowupCopyStatus;
  rejectionDetail: string | null;
  updatedAt: string;
};

type Row = {
  id: string; tenant_id: string; channel: MessagingChannel; name: string; body: string | null;
  status: string; rejection_detail: string | null; updated_at: string;
};

const PURPOSES = new Set<string>(OFFER_CADENCE_SENDING_PURPOSES);
const SELECT = "id,tenant_id,channel,name,body,status,rejection_detail,updated_at";

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function purposeOf(name: string): Exclude<OfferCadencePurpose, "none"> {
  const purpose = name.replace(/^followup:/u, "");
  if (!name.startsWith("followup:") || !PURPOSES.has(purpose)) throw new Error("FOLLOWUP_COPY_PURPOSE_INVALID");
  return purpose as Exclude<OfferCadencePurpose, "none">;
}

export function mapFollowupCopy(row: Row): FollowupCopy {
  if (!row.body || !["draft", "submitted", "approved", "rejected"].includes(row.status)) {
    throw new Error("FOLLOWUP_COPY_ROW_INVALID");
  }
  return {
    id: row.id, tenantId: row.tenant_id, channel: row.channel, purpose: purposeOf(row.name),
    body: row.body, status: row.status as FollowupCopyStatus, rejectionDetail: row.rejection_detail,
    updatedAt: row.updated_at,
  };
}

type FollowupCopySource = (tenantId: string) => Promise<readonly Row[]>;

async function liveFollowupCopySource(tenantId: string): Promise<readonly Row[]> {
  const { data, error } = await createSupabaseServiceClient().from("message_templates").select(SELECT)
    .eq("tenant_id", tenantId).like("name", "followup:%").order("channel").order("name");
  if (error) throw new Error("FOLLOWUP_COPY_READ_FAILED");
  return (data ?? []) as Row[];
}

export async function listFollowupCopy(tenantId: string, source: FollowupCopySource = liveFollowupCopySource): Promise<FollowupCopy[]> {
  const expectedTenant = required(tenantId, "FOLLOWUP_COPY_TENANT_REQUIRED");
  const rows = await source(expectedTenant);
  if (rows.some((row) => row.tenant_id !== expectedTenant)) {
    throw new Error("FOLLOWUP_COPY_READ_FAILED");
  }
  return rows.map(mapFollowupCopy);
}

export async function listPendingFollowupCopy(): Promise<FollowupCopy[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("message_templates").select(SELECT)
    .eq("status", "submitted").like("name", "followup:%").order("updated_at", { ascending: true });
  if (error) throw new Error("FOLLOWUP_COPY_PENDING_READ_FAILED");
  const rows = (data ?? []).map((row) => mapFollowupCopy(row as Row));
  const ids = [...new Set(rows.map((row) => row.tenantId))];
  if (ids.length === 0) return rows;
  const { data: tenants, error: tenantError } = await client.from("tenants").select("id,name").in("id", ids);
  if (tenantError) throw new Error("FOLLOWUP_COPY_TENANT_READ_FAILED");
  const names = new Map((tenants ?? []).map((tenant) => [String(tenant.id), String(tenant.name)]));
  return rows.map((row) => ({ ...row, tenantName: names.get(row.tenantId) ?? "Workspace unavailable" }));
}

type Receipt = { template_id: string; status: FollowupCopyStatus; audit_id: number };

function receipt(data: unknown): Receipt {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new Error("FOLLOWUP_COPY_RECEIPT_INVALID");
  const value = row as Record<string, unknown>;
  if (typeof value.template_id !== "string" || typeof value.audit_id !== "number" ||
    !["draft", "submitted", "approved", "rejected"].includes(String(value.status))) {
    throw new Error("FOLLOWUP_COPY_RECEIPT_INVALID");
  }
  return value as Receipt;
}

export async function saveFollowupCopyDraft(input: {
  tenantId: string; actorId: string; channel: MessagingChannel;
  purpose: Exclude<OfferCadencePurpose, "none">; body: string;
}) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("save_followup_copy_draft", {
    p_expected_tenant: required(input.tenantId, "FOLLOWUP_COPY_TENANT_REQUIRED"), p_channel: input.channel,
    p_purpose: input.purpose, p_body: required(input.body, "FOLLOWUP_COPY_BODY_REQUIRED"),
    p_actor_id: required(input.actorId, "FOLLOWUP_COPY_ACTOR_REQUIRED"),
  });
  if (error) throw new Error("FOLLOWUP_COPY_DRAFT_REFUSED");
  const result = receipt(data);
  if (result.status !== "draft") throw new Error("FOLLOWUP_COPY_DRAFT_RECEIPT_INVALID");
  return { templateId: result.template_id, status: result.status, auditId: String(result.audit_id) };
}

export async function submitFollowupCopy(input: { tenantId: string; actorId: string; templateId: string }) {
  const { data, error } = await createSupabaseServiceClient().rpc("submit_followup_copy", {
    p_expected_tenant: required(input.tenantId, "FOLLOWUP_COPY_TENANT_REQUIRED"),
    p_template_id: required(input.templateId, "FOLLOWUP_COPY_TEMPLATE_REQUIRED"),
    p_actor_id: required(input.actorId, "FOLLOWUP_COPY_ACTOR_REQUIRED"),
  });
  if (error) throw new Error("FOLLOWUP_COPY_SUBMIT_REFUSED");
  const result = receipt(data);
  if (result.status !== "submitted") throw new Error("FOLLOWUP_COPY_SUBMIT_RECEIPT_INVALID");
  return { templateId: result.template_id, status: result.status, auditId: String(result.audit_id) };
}

export async function decideFollowupCopy(input: {
  tenantId: string; actorId: string; templateId: string; decision: "approved" | "rejected"; reason: string;
}) {
  const { data, error } = await createSupabaseServiceClient().rpc("decide_followup_copy", {
    p_expected_tenant: required(input.tenantId, "FOLLOWUP_COPY_TENANT_REQUIRED"),
    p_template_id: required(input.templateId, "FOLLOWUP_COPY_TEMPLATE_REQUIRED"), p_decision: input.decision,
    p_reason: required(input.reason, "FOLLOWUP_COPY_REASON_REQUIRED"),
    p_actor_id: required(input.actorId, "FOLLOWUP_COPY_ACTOR_REQUIRED"),
  });
  if (error) throw new Error("FOLLOWUP_COPY_DECISION_REFUSED");
  const result = receipt(data);
  if (result.status !== input.decision) throw new Error("FOLLOWUP_COPY_DECISION_RECEIPT_INVALID");
  return { templateId: result.template_id, status: result.status, auditId: String(result.audit_id) };
}
