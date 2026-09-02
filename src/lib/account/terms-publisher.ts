/**
 * The write half of the account-terms registry.
 *
 * `src/lib/account/terms.ts` reads the one published version; this creates drafts and publishes
 * one. It deliberately has no unpublish and no supersede: `account_terms_versions` carries a two
 * value state and a partial unique index over the published one, and nothing in the schema can
 * record a withdrawal, so offering the verb here would be inventing a state the database cannot
 * hold. A second publication is refused by the index and reaches the caller as
 * `ACCOUNT_TERMS_ALREADY_PUBLISHED`.
 *
 * Nothing in this module knows what the terms say. The copy is supplied by whoever is publishing,
 * and the content hash is computed here from the exact two bodies being stored so the value the
 * database re-derives in its own CHECK is the value the acceptance path will later compare.
 */

import { accountTermsContentHash } from "@/lib/account/terms";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type AccountTermsPublicationState = "draft" | "published";

export type AccountTermsVersionRow = {
  versionKey: string;
  contentHash: string;
  state: AccountTermsPublicationState;
  createdAt: string;
  publishedAt: string | null;
};

/** What the admin surface renders: the standing version, and every draft waiting behind it. */
export type AccountTermsRegistry = {
  published: AccountTermsVersionRow | null;
  drafts: readonly AccountTermsVersionRow[];
};

export type AccountTermsDraftInput = {
  actorId: string;
  versionKey: string;
  termsBody: string;
  privacyBody: string;
};

export type AccountTermsPublishInput = {
  actorId: string;
  versionKey: string;
  contentHash: string;
};

export type AccountTermsDraftReceipt = {
  versionKey: string;
  contentHash: string;
  auditId: string;
};

export type AccountTermsPublishReceipt = AccountTermsDraftReceipt & { publishedAt: string };

export type AccountTermsPublisherDependencies = {
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  listVersions(): Promise<readonly AccountTermsVersionRow[]>;
};

export class AccountTermsPublisherError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The version key is an identifier an admin types and the signup body later carries, so it is held
 * to the same 128 character ceiling `api/onboarding/signup` already enforces on the field. A key
 * the form can send but the registry cannot store would fail only at signup time.
 */
export const ACCOUNT_TERMS_VERSION_KEY_MAX = 128;
/** A document, not a paste of an entire site. Postgres would take more; a mistake this size is not copy. */
export const ACCOUNT_TERMS_BODY_MAX = 200_000;

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new AccountTermsPublisherError(code);
  return normalized;
}

function refusalCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const named = /ACCOUNT_TERMS_[A-Z_]+/u.exec(message);
  return named ? named[0] : "ACCOUNT_TERMS_WRITE_REFUSED";
}

function receiptRow(value: unknown, code: string): Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new AccountTermsPublisherError(code);
  return row as Record<string, unknown>;
}

function auditId(value: unknown, code: string) {
  if (typeof value !== "number" && typeof value !== "string") throw new AccountTermsPublisherError(code);
  const id = String(value).trim();
  if (!/^\d+$/.test(id)) throw new AccountTermsPublisherError(code);
  return id;
}

function versionRow(value: unknown): AccountTermsVersionRow {
  const row = value as Record<string, unknown>;
  const state = row.publication_state;
  const publishedAt = row.published_at;
  if (
    typeof row.version_key !== "string"
    || typeof row.content_hash !== "string"
    || !HEX64.test(row.content_hash)
    || typeof row.created_at !== "string"
    || (state !== "draft" && state !== "published")
    || (publishedAt !== null && typeof publishedAt !== "string")
    // A published row with no timestamp, or a draft carrying one, is the shape the table's own
    // CHECK forbids. Reading one back means something wrote around the constraint, and rendering
    // it would put a date next to a version nobody published.
    || (state === "published") !== (typeof publishedAt === "string")
  ) {
    throw new AccountTermsPublisherError("ACCOUNT_TERMS_VERSION_ROW_INVALID");
  }
  return {
    versionKey: row.version_key,
    contentHash: row.content_hash,
    state,
    createdAt: row.created_at,
    publishedAt: typeof publishedAt === "string" ? publishedAt : null,
  };
}

function liveDependencies(): AccountTermsPublisherDependencies {
  const client = createSupabaseServiceClient();
  return {
    rpc: async (name, args) => {
      const { data, error } = await client.rpc(name, args);
      if (error) throw new Error(error.message);
      return data;
    },
    listVersions: async () => {
      const { data, error } = await client
        .from("account_terms_versions")
        .select("version_key, content_hash, publication_state, created_at, published_at")
        .order("created_at", { ascending: false });
      if (error) throw new AccountTermsPublisherError("ACCOUNT_TERMS_REGISTRY_READ_FAILED");
      return (data ?? []).map(versionRow);
    },
  };
}

export async function createAccountTermsDraft(
  input: AccountTermsDraftInput,
  dependencies?: AccountTermsPublisherDependencies,
): Promise<AccountTermsDraftReceipt> {
  const actorId = required(input.actorId, "ACCOUNT_TERMS_ACTOR_REQUIRED");
  const versionKey = required(input.versionKey, "ACCOUNT_TERMS_VERSION_KEY_REQUIRED");
  const termsBody = required(input.termsBody, "ACCOUNT_TERMS_BODY_REQUIRED");
  const privacyBody = required(input.privacyBody, "ACCOUNT_PRIVACY_BODY_REQUIRED");
  if (versionKey.length > ACCOUNT_TERMS_VERSION_KEY_MAX) {
    throw new AccountTermsPublisherError("ACCOUNT_TERMS_VERSION_KEY_TOO_LONG");
  }
  if (termsBody.length > ACCOUNT_TERMS_BODY_MAX || privacyBody.length > ACCOUNT_TERMS_BODY_MAX) {
    throw new AccountTermsPublisherError("ACCOUNT_TERMS_BODY_TOO_LONG");
  }
  // Hashed from the exact strings being stored, so the database's own recomputation agrees.
  const contentHash = accountTermsContentHash(termsBody, privacyBody);
  const deps = dependencies ?? liveDependencies();
  let data: unknown;
  try {
    data = await deps.rpc("create_account_terms_draft", {
      p_actor_id: actorId,
      p_version_key: versionKey,
      p_terms_body: termsBody,
      p_privacy_body: privacyBody,
      p_content_hash: contentHash,
    });
  } catch (error) {
    throw new AccountTermsPublisherError(refusalCode(error));
  }
  const row = receiptRow(data, "ACCOUNT_TERMS_DRAFT_RECEIPT_INVALID");
  if (row.terms_version_key !== versionKey || row.terms_content_hash !== contentHash) {
    throw new AccountTermsPublisherError("ACCOUNT_TERMS_DRAFT_RECEIPT_INVALID");
  }
  return {
    versionKey,
    contentHash,
    auditId: auditId(row.audit_id, "ACCOUNT_TERMS_DRAFT_RECEIPT_INVALID"),
  };
}

export async function publishAccountTermsVersion(
  input: AccountTermsPublishInput,
  dependencies?: AccountTermsPublisherDependencies,
): Promise<AccountTermsPublishReceipt> {
  const actorId = required(input.actorId, "ACCOUNT_TERMS_ACTOR_REQUIRED");
  const versionKey = required(input.versionKey, "ACCOUNT_TERMS_VERSION_KEY_REQUIRED");
  const contentHash = required(input.contentHash, "ACCOUNT_TERMS_CONTENT_HASH_REQUIRED");
  if (!HEX64.test(contentHash)) throw new AccountTermsPublisherError("ACCOUNT_TERMS_CONTENT_HASH_INVALID");
  const deps = dependencies ?? liveDependencies();
  let data: unknown;
  try {
    data = await deps.rpc("publish_account_terms", {
      p_actor_id: actorId,
      p_version_key: versionKey,
      p_content_hash: contentHash,
    });
  } catch (error) {
    throw new AccountTermsPublisherError(refusalCode(error));
  }
  const row = receiptRow(data, "ACCOUNT_TERMS_PUBLISH_RECEIPT_INVALID");
  if (
    row.terms_version_key !== versionKey
    || row.terms_content_hash !== contentHash
    || typeof row.terms_published_at !== "string"
    || Number.isNaN(Date.parse(row.terms_published_at))
  ) {
    throw new AccountTermsPublisherError("ACCOUNT_TERMS_PUBLISH_RECEIPT_INVALID");
  }
  return {
    versionKey,
    contentHash,
    publishedAt: row.terms_published_at,
    auditId: auditId(row.audit_id, "ACCOUNT_TERMS_PUBLISH_RECEIPT_INVALID"),
  };
}

/**
 * Every version, split into the one that is published and the drafts behind it. More than one
 * published row cannot exist, so reading a second one is a corrupted registry rather than a list
 * to render.
 */
export async function loadAccountTermsRegistry(
  dependencies?: AccountTermsPublisherDependencies,
): Promise<AccountTermsRegistry> {
  const deps = dependencies ?? liveDependencies();
  const rows = await deps.listVersions();
  const published = rows.filter((row) => row.state === "published");
  if (published.length > 1) throw new AccountTermsPublisherError("ACCOUNT_TERMS_REGISTRY_AMBIGUOUS");
  return {
    published: published[0] ?? null,
    drafts: rows.filter((row) => row.state === "draft"),
  };
}
