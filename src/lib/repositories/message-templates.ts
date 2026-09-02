/**
 * Tenant-scoped message-template lifecycle reads and submission receipts.
 *
 * Submission has no caller-controlled status. The RPC writes `submitted`, while provider-owned
 * status webhooks/readback remain the only path that can make a real tenant template approved.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

import type { IdentityProvider, MessagingChannel } from "@/lib/integrations/types";

export const MESSAGE_TEMPLATE_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "paused",
  "disabled",
] as const;
export type MessageTemplateStatus = (typeof MESSAGE_TEMPLATE_STATUSES)[number];

export const MESSAGE_TEMPLATE_CATEGORIES = ["authentication", "marketing", "utility"] as const;
export type MessageTemplateCategory = (typeof MESSAGE_TEMPLATE_CATEGORIES)[number];

export type MessageTemplateView = {
  id: string;
  channel: MessagingChannel;
  providerTemplateName: string;
  category: MessageTemplateCategory | null;
  locale: string | null;
  body: string | null;
  bodyHash: string | null;
  variables: readonly unknown[];
  status: MessageTemplateStatus;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  pausedAt: string | null;
  disabledAt: string | null;
  statusUpdatedAt: string | null;
  rejectionDetail: string | null;
  isDemo: boolean;
  dataLabel: "Demo" | null;
};

export type SubmitMessageTemplateInput = {
  expectedTenantId: string;
  channel: MessagingChannel;
  provider: IdentityProvider;
  providerTemplateId: string;
  providerTemplateName: string;
  category: MessageTemplateCategory;
  locale: string;
  body: string;
  variables: readonly unknown[];
  actorUserId: string;
  idempotencyKey: string;
};

type MessageTemplateRow = {
  id: string;
  tenant_id: string;
  channel: MessagingChannel;
  provider_template_name: string;
  category: MessageTemplateCategory | null;
  locale: string | null;
  body: string | null;
  body_hash: string | null;
  variables: unknown;
  status: MessageTemplateStatus;
  submitted_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  paused_at: string | null;
  disabled_at: string | null;
  status_updated_at: string | null;
  rejection_detail: string | null;
  is_demo: boolean;
};

type SubmitMessageTemplateRpcRow = { template_id: string; status: string; audit_id: number };

export type MessageTemplateDependencies = {
  submit(args: Record<string, unknown>): Promise<SubmitMessageTemplateRpcRow>;
  loadById(tenantId: string, templateId: string): Promise<MessageTemplateRow | null>;
  list(tenantId: string): Promise<readonly MessageTemplateRow[]>;
};

const TEMPLATE_SELECT = `
  id, tenant_id, channel, provider_template_name, category, locale, body, body_hash, variables,
  status, submitted_at, approved_at, rejected_at, paused_at, disabled_at, status_updated_at,
  rejection_detail, is_demo
`;

function singleSubmission(data: unknown): SubmitMessageTemplateRpcRow {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new Error("MESSAGE_TEMPLATE_SUBMIT_FAILED");
  const value = row as Record<string, unknown>;
  if (typeof value.template_id !== "string" || typeof value.status !== "string" ||
    typeof value.audit_id !== "number") {
    throw new Error("MESSAGE_TEMPLATE_SUBMIT_FAILED");
  }
  return {
    template_id: value.template_id,
    status: value.status,
    audit_id: value.audit_id,
  };
}

async function liveDependencies(): Promise<MessageTemplateDependencies> {
  const client = createSupabaseServiceClient();
  const loadById = async (tenantId: string, templateId: string) => {
    const { data, error } = await client
      .from("message_templates")
      .select(TEMPLATE_SELECT)
      .eq("tenant_id", tenantId)
      .eq("id", templateId)
      .maybeSingle();
    if (error) throw new Error("MESSAGE_TEMPLATE_READ_FAILED");
    return data as unknown as MessageTemplateRow | null;
  };
  return {
    submit: async (args) => {
      const { data, error } = await client.rpc("submit_message_template", args);
      if (error) throw new Error("MESSAGE_TEMPLATE_SUBMIT_FAILED");
      return singleSubmission(data);
    },
    loadById,
    list: async (tenantId) => {
      const { data, error } = await client
        .from("message_templates")
        .select(TEMPLATE_SELECT)
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false });
      if (error) throw new Error("MESSAGE_TEMPLATE_READ_FAILED");
      return (data ?? []) as unknown as MessageTemplateRow[];
    },
  };
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function mapTemplate(row: MessageTemplateRow): MessageTemplateView {
  if (!Array.isArray(row.variables)) throw new Error("MESSAGE_TEMPLATE_VARIABLES_INVALID");
  if (!MESSAGE_TEMPLATE_STATUSES.includes(row.status)) {
    throw new Error("MESSAGE_TEMPLATE_STATUS_INVALID");
  }
  if (row.is_demo && (
    !row.provider_template_name.startsWith("SETTERFI_DEMO_PLACEHOLDER_") ||
    !row.body?.startsWith("SETTERFI_DEMO_PLACEHOLDER_")
  )) {
    throw new Error("DEMO_TEMPLATE_PLACEHOLDER_REQUIRED");
  }
  return {
    id: row.id,
    channel: row.channel,
    providerTemplateName: row.provider_template_name,
    category: row.category,
    locale: row.locale,
    body: row.body,
    bodyHash: row.body_hash,
    variables: row.variables,
    status: row.status,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    pausedAt: row.paused_at,
    disabledAt: row.disabled_at,
    statusUpdatedAt: row.status_updated_at,
    rejectionDetail: row.rejection_detail,
    isDemo: row.is_demo,
    dataLabel: row.is_demo ? "Demo" : null,
  };
}

export async function submitMessageTemplate(
  input: SubmitMessageTemplateInput,
  dependencies?: MessageTemplateDependencies,
): Promise<MessageTemplateView> {
  const tenantId = required(input.expectedTenantId, "EXPECTED_TENANT_REQUIRED");
  const providerTemplateId = required(input.providerTemplateId, "PROVIDER_TEMPLATE_ID_REQUIRED");
  const providerTemplateName = required(input.providerTemplateName, "PROVIDER_TEMPLATE_NAME_REQUIRED");
  const locale = required(input.locale, "MESSAGE_TEMPLATE_LOCALE_REQUIRED");
  const body = required(input.body, "MESSAGE_TEMPLATE_BODY_REQUIRED");
  const actorUserId = required(input.actorUserId, "ACTOR_USER_ID_REQUIRED");
  const idempotencyKey = required(input.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
  if (!Array.isArray(input.variables)) throw new Error("MESSAGE_TEMPLATE_VARIABLES_INVALID");
  const deps = dependencies ?? (await liveDependencies());
  const receipt = await deps.submit({
    p_expected_tenant: tenantId,
    p_channel: input.channel,
    p_provider: input.provider,
    p_provider_template_id: providerTemplateId,
    p_provider_template_name: providerTemplateName,
    p_category: input.category,
    p_locale: locale,
    p_body: body,
    p_variables: [...input.variables],
    p_actor_id: actorUserId,
    p_idempotency_key: idempotencyKey,
  });
  if (receipt.status !== "submitted") throw new Error("MESSAGE_TEMPLATE_SUBMIT_STATUS_INVALID");
  const persisted = await deps.loadById(tenantId, receipt.template_id);
  if (!persisted || persisted.tenant_id !== tenantId || persisted.id !== receipt.template_id ||
    persisted.status !== receipt.status) {
    throw new Error("MESSAGE_TEMPLATE_READBACK_MISMATCH");
  }
  return mapTemplate(persisted);
}

export async function listMessageTemplates(
  tenantId: string,
  dependencies?: MessageTemplateDependencies,
): Promise<MessageTemplateView[]> {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  const rows = await deps.list(expectedTenant);
  if (rows.some((row) => row.tenant_id !== expectedTenant)) {
    throw new Error("MESSAGE_TEMPLATE_TENANT_MISMATCH");
  }
  return rows.map(mapTemplate);
}
