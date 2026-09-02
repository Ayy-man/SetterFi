/**
 * Contact management mutations are database-owned so identity uniqueness, tenant scope, audit
 * receipts, and import idempotency cannot be split across route instances.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const CONTACT_PROVIDERS = ["meta_direct", "ghl"] as const;
export const CONTACT_CHANNELS = ["instagram", "messenger", "sms", "whatsapp", "webchat"] as const;

export type ContactProvider = (typeof CONTACT_PROVIDERS)[number];
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export type ContactIdentityInput = {
  name: string | null;
  provider: ContactProvider;
  channel: ContactChannel;
  providerIdentityId: string;
  providerAccountId: string | null;
  normalizedPhone: string | null;
  normalizedEmail: string | null;
};

export type ContactCreationOutcome = {
  contactId: string;
  identityId: string;
  outcome: "created" | "merged_existing_identity";
  auditId: number;
};

export type ContactImportOutcome =
  | (ContactCreationOutcome & { row: number })
  | { row: number; outcome: "rejected"; reason: string };

export type ContactNote = {
  id: string;
  body: string;
  createdBy: string;
  createdAt: string;
};

export type ContactTag = { id: string; label: string; createdAt: string };

type ContactManagementDependencies = {
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
};

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function row(value: unknown, code: string): Record<string, unknown> {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(code);
  return candidate as Record<string, unknown>;
}

function validOutcome(value: unknown): value is ContactCreationOutcome["outcome"] {
  return value === "created" || value === "merged_existing_identity";
}

function contactOutcome(value: unknown, code: string): ContactCreationOutcome {
  const candidate = row(value, code);
  if (typeof candidate.contact_id !== "string" || typeof candidate.identity_id !== "string" ||
    !validOutcome(candidate.outcome) || typeof candidate.audit_id !== "number" ||
    candidate.audit_id <= 0) throw new Error(code);
  return {
    contactId: candidate.contact_id,
    identityId: candidate.identity_id,
    outcome: candidate.outcome,
    auditId: candidate.audit_id,
  };
}

async function liveDependencies(): Promise<ContactManagementDependencies> {
  const client = createSupabaseServiceClient();
  return {
    rpc: async (name, args) => {
      const { data, error } = await client.rpc(name, args);
      if (error) throw new Error(`${name.toUpperCase()}_FAILED:${error.message}`);
      return data;
    },
  };
}

export function parseContactIdentityInput(value: unknown): ContactIdentityInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const expected = [
    "name", "provider", "channel", "providerIdentityId", "providerAccountId",
    "normalizedPhone", "normalizedEmail",
  ];
  if (Object.keys(input).sort().join(",") !== expected.sort().join(",") ||
    (input.name !== null && typeof input.name !== "string") ||
    !CONTACT_PROVIDERS.includes(input.provider as ContactProvider) ||
    !CONTACT_CHANNELS.includes(input.channel as ContactChannel) ||
    typeof input.providerIdentityId !== "string" ||
    (input.providerAccountId !== null && typeof input.providerAccountId !== "string") ||
    (input.normalizedPhone !== null && typeof input.normalizedPhone !== "string") ||
    (input.normalizedEmail !== null && typeof input.normalizedEmail !== "string")) return null;
  const providerIdentityId = input.providerIdentityId.trim();
  const name = input.name === null ? null : input.name.trim() || null;
  const providerAccountId = input.providerAccountId === null ? null : input.providerAccountId.trim() || null;
  const normalizedPhone = input.normalizedPhone === null ? null : input.normalizedPhone.trim() || null;
  const normalizedEmail = input.normalizedEmail === null ? null : input.normalizedEmail.trim().toLowerCase() || null;
  if (!providerIdentityId || (input.provider === "ghl" && !providerAccountId) ||
    (input.provider !== "ghl" && providerAccountId !== null) ||
    (name !== null && name.length > 500)) return null;
  return {
    name,
    provider: input.provider as ContactProvider,
    channel: input.channel as ContactChannel,
    providerIdentityId,
    providerAccountId,
    normalizedPhone,
    normalizedEmail,
  };
}

export async function createContact(input: {
  tenantId: string;
  actorId: string;
  contact: ContactIdentityInput;
  idempotencyKey: string;
}, dependencies?: ContactManagementDependencies): Promise<ContactCreationOutcome> {
  const deps = dependencies ?? await liveDependencies();
  const contact = parseContactIdentityInput(input.contact);
  const idempotencyKey = required(input.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
  if (!contact || idempotencyKey.length > 128) throw new Error("CONTACT_CREATE_INPUT_INVALID");
  return contactOutcome(await deps.rpc("create_manual_contact", {
    p_expected_tenant: required(input.tenantId, "EXPECTED_TENANT_REQUIRED"),
    p_actor_id: required(input.actorId, "ACTOR_REQUIRED"),
    p_name: contact.name,
    p_provider: contact.provider,
    p_channel: contact.channel,
    p_provider_identity_id: contact.providerIdentityId,
    p_provider_account_id: contact.providerAccountId,
    p_normalized_phone: contact.normalizedPhone,
    p_normalized_email: contact.normalizedEmail,
    p_idempotency_key: idempotencyKey,
  }), "CONTACT_CREATE_RECEIPT_INVALID");
}

export async function importContacts(input: {
  tenantId: string;
  actorId: string;
  rows: unknown[];
  idempotencyKey: string;
}, dependencies?: ContactManagementDependencies): Promise<{ outcomes: ContactImportOutcome[]; auditId: number }> {
  const deps = dependencies ?? await liveDependencies();
  const idempotencyKey = required(input.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
  if (!Array.isArray(input.rows) || input.rows.length > 500 || idempotencyKey.length > 128) {
    throw new Error("CONTACT_IMPORT_INPUT_INVALID");
  }
  const receipt = row(await deps.rpc("import_contacts", {
    p_expected_tenant: required(input.tenantId, "EXPECTED_TENANT_REQUIRED"),
    p_actor_id: required(input.actorId, "ACTOR_REQUIRED"),
    p_rows: input.rows,
    p_idempotency_key: idempotencyKey,
  }), "CONTACT_IMPORT_RECEIPT_INVALID");
  if (!Array.isArray(receipt.outcomes) || typeof receipt.audit_id !== "number" || receipt.audit_id <= 0) {
    throw new Error("CONTACT_IMPORT_RECEIPT_INVALID");
  }
  const outcomes = receipt.outcomes.map((item): ContactImportOutcome => {
    const candidate = row(item, "CONTACT_IMPORT_RECEIPT_INVALID");
    if (!Number.isSafeInteger(candidate.row) || Number(candidate.row) < 0) {
      throw new Error("CONTACT_IMPORT_RECEIPT_INVALID");
    }
    if (candidate.outcome === "rejected" && typeof candidate.reason === "string") {
      return { row: Number(candidate.row), outcome: "rejected", reason: candidate.reason };
    }
    const parsed = contactOutcome(candidate, "CONTACT_IMPORT_RECEIPT_INVALID");
    return { row: Number(candidate.row), ...parsed };
  });
  return { outcomes, auditId: receipt.audit_id };
}

export async function addContactNote(input: {
  tenantId: string; contactId: string; actorId: string; body: string;
}, dependencies?: ContactManagementDependencies): Promise<{ noteId: string; createdAt: string; auditId: number }> {
  const deps = dependencies ?? await liveDependencies();
  const receipt = row(await deps.rpc("add_contact_note", {
    p_expected_tenant: required(input.tenantId, "EXPECTED_TENANT_REQUIRED"),
    p_contact_id: required(input.contactId, "CONTACT_ID_REQUIRED"),
    p_actor_id: required(input.actorId, "ACTOR_REQUIRED"),
    p_body: required(input.body, "CONTACT_NOTE_BODY_REQUIRED"),
  }), "CONTACT_NOTE_RECEIPT_INVALID");
  if (typeof receipt.note_id !== "string" || typeof receipt.created_at !== "string" ||
    typeof receipt.audit_id !== "number" || receipt.audit_id <= 0) throw new Error("CONTACT_NOTE_RECEIPT_INVALID");
  return { noteId: receipt.note_id, createdAt: receipt.created_at, auditId: receipt.audit_id };
}

export async function listContactNotes(input: {
  tenantId: string; contactId: string;
}, dependencies?: ContactManagementDependencies): Promise<ContactNote[]> {
  const deps = dependencies ?? await liveDependencies();
  const result = await deps.rpc("list_contact_notes", {
    p_expected_tenant: required(input.tenantId, "EXPECTED_TENANT_REQUIRED"),
    p_contact_id: required(input.contactId, "CONTACT_ID_REQUIRED"),
  });
  if (!Array.isArray(result)) throw new Error("CONTACT_NOTES_READBACK_INVALID");
  return result.map((item) => {
    const candidate = row(item, "CONTACT_NOTES_READBACK_INVALID");
    if (typeof candidate.id !== "string" || typeof candidate.body !== "string" ||
      typeof candidate.created_by !== "string" || typeof candidate.created_at !== "string") {
      throw new Error("CONTACT_NOTES_READBACK_INVALID");
    }
    return { id: candidate.id, body: candidate.body, createdBy: candidate.created_by, createdAt: candidate.created_at };
  });
}

export async function addContactTag(input: {
  tenantId: string; contactId: string; actorId: string; label: string;
}, dependencies?: ContactManagementDependencies): Promise<{ tag: ContactTag; added: boolean; auditId: number }> {
  const deps = dependencies ?? await liveDependencies();
  const receipt = row(await deps.rpc("add_contact_tag", {
    p_expected_tenant: required(input.tenantId, "EXPECTED_TENANT_REQUIRED"),
    p_contact_id: required(input.contactId, "CONTACT_ID_REQUIRED"),
    p_actor_id: required(input.actorId, "ACTOR_REQUIRED"),
    p_label: required(input.label, "CONTACT_TAG_LABEL_REQUIRED"),
  }), "CONTACT_TAG_RECEIPT_INVALID");
  if (typeof receipt.tag_id !== "string" || typeof receipt.label !== "string" ||
    typeof receipt.tag_created_at !== "string" ||
    typeof receipt.added !== "boolean" || typeof receipt.audit_id !== "number" || receipt.audit_id <= 0) {
    throw new Error("CONTACT_TAG_RECEIPT_INVALID");
  }
  return {
    tag: { id: receipt.tag_id, label: receipt.label, createdAt: receipt.tag_created_at },
    added: receipt.added,
    auditId: receipt.audit_id,
  };
}

export async function removeContactTag(input: {
  tenantId: string; contactId: string; actorId: string; tagId: string;
}, dependencies?: ContactManagementDependencies): Promise<{ removed: boolean; auditId: number }> {
  const deps = dependencies ?? await liveDependencies();
  const receipt = row(await deps.rpc("remove_contact_tag", {
    p_expected_tenant: required(input.tenantId, "EXPECTED_TENANT_REQUIRED"),
    p_contact_id: required(input.contactId, "CONTACT_ID_REQUIRED"),
    p_actor_id: required(input.actorId, "ACTOR_REQUIRED"),
    p_tag_id: required(input.tagId, "CONTACT_TAG_ID_REQUIRED"),
  }), "CONTACT_TAG_RECEIPT_INVALID");
  if (typeof receipt.removed !== "boolean" || typeof receipt.audit_id !== "number" || receipt.audit_id <= 0) {
    throw new Error("CONTACT_TAG_RECEIPT_INVALID");
  }
  return { removed: receipt.removed, auditId: receipt.audit_id };
}

export async function listContactTags(input: {
  tenantId: string; contactId: string;
}, dependencies?: ContactManagementDependencies): Promise<ContactTag[]> {
  const deps = dependencies ?? await liveDependencies();
  const result = await deps.rpc("list_contact_tags", {
    p_expected_tenant: required(input.tenantId, "EXPECTED_TENANT_REQUIRED"),
    p_contact_id: required(input.contactId, "CONTACT_ID_REQUIRED"),
  });
  if (!Array.isArray(result)) throw new Error("CONTACT_TAGS_READBACK_INVALID");
  return result.map((item) => {
    const candidate = row(item, "CONTACT_TAGS_READBACK_INVALID");
    if (typeof candidate.id !== "string" || typeof candidate.label !== "string" ||
      typeof candidate.created_at !== "string") throw new Error("CONTACT_TAGS_READBACK_INVALID");
    return { id: candidate.id, label: candidate.label, createdAt: candidate.created_at };
  });
}
