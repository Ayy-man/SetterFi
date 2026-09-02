import { createHash } from "node:crypto";

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type PublishedAccountTerms = {
  state: "published";
  versionKey: string;
  contentHash: string;
  publishedAt: string;
  termsBody: string;
  privacyBody: string;
};

export type AccountTermsState = PublishedAccountTerms | { state: "none_published" };

type AccountTermsRow = {
  version_key: unknown;
  content_hash: unknown;
  published_at: unknown;
  terms_body: unknown;
  privacy_body: unknown;
};

export class AccountTermsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function requiredString(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new AccountTermsError(code);
  return value.trim();
}

function validTimestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new AccountTermsError("ACCOUNT_TERMS_PUBLISHED_AT_INVALID");
  }
  return value;
}

export function accountTermsContentHash(termsBody: string, privacyBody: string) {
  return createHash("sha256")
    .update(`${termsBody}\u001f${privacyBody}`, "utf8")
    .digest("hex");
}

export function publishedAccountTerms(row: AccountTermsRow): PublishedAccountTerms {
  const versionKey = requiredString(row.version_key, "ACCOUNT_TERMS_VERSION_KEY_INVALID");
  const termsBody = requiredString(row.terms_body, "ACCOUNT_TERMS_BODY_INVALID");
  const privacyBody = requiredString(row.privacy_body, "ACCOUNT_PRIVACY_BODY_INVALID");
  const contentHash = requiredString(row.content_hash, "ACCOUNT_TERMS_CONTENT_HASH_INVALID");
  if (!/^[0-9a-f]{64}$/.test(contentHash) || contentHash !== accountTermsContentHash(termsBody, privacyBody)) {
    throw new AccountTermsError("ACCOUNT_TERMS_CONTENT_HASH_INVALID");
  }
  return {
    state: "published",
    versionKey,
    contentHash,
    publishedAt: validTimestamp(row.published_at),
    termsBody,
    privacyBody,
  };
}

async function loadPublishedAccountTermsRow(): Promise<AccountTermsRow | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("account_terms_versions")
    .select("version_key, content_hash, published_at, terms_body, privacy_body")
    .eq("publication_state", "published")
    .maybeSingle();
  if (error) throw new AccountTermsError("ACCOUNT_TERMS_READ_FAILED");
  return data as AccountTermsRow | null;
}

/** An absent or draft-only registry is an explicit state, never an implied legal document. */
export async function loadCurrentAccountTerms(
  source: () => Promise<AccountTermsRow | null> = loadPublishedAccountTermsRow,
): Promise<AccountTermsState> {
  const row = await source();
  return row ? publishedAccountTerms(row) : { state: "none_published" };
}
