/**
 * Approved carrier-control replies are tenant artifacts, not platform settings.  A row remains
 * unusable until a human publication receipt binds its version, body hash, and approval reference.
 */

import { createHash } from "node:crypto";

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const CONTROL_REPLY_KINDS = ["stop", "help", "start"] as const;
export type ControlReplyKind = (typeof CONTROL_REPLY_KINDS)[number];

export type StoredControlReply = {
  kind: ControlReplyKind;
  version: number;
  body: string;
  bodyHash: string;
  approvalReference: string | null;
  approvalAuditId: number | null;
  publishedAt: string | null;
};

export type ControlReplyDatabaseRow = {
  kind: unknown;
  version: unknown;
  body: unknown;
  body_hash: unknown;
  approval_reference: unknown;
  approval_audit_id: unknown;
  published_at: unknown;
  is_published: unknown;
};

export type ControlReplyRepository = {
  loadCurrent(tenantId: string, kind: ControlReplyKind): Promise<ControlReplyDatabaseRow | null>;
};

const PLACEHOLDER_MARKER = "SETTERFI_DEMO_PLACEHOLDER_";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function approvedText(value: unknown) {
  return typeof value === "string" && value.trim() && !value.includes(PLACEHOLDER_MARKER)
    ? value.trim()
    : null;
}

/** Returns null for absent, draft, malformed, or tampered source rows; callers must refuse send. */
export function approvedControlReply(row: ControlReplyDatabaseRow | null): StoredControlReply | null {
  if (!row || row.is_published !== true || !CONTROL_REPLY_KINDS.includes(row.kind as ControlReplyKind)) {
    return null;
  }
  const body = approvedText(row.body);
  const bodyHash = typeof row.body_hash === "string" ? row.body_hash : "";
  const approvalReference = approvedText(row.approval_reference);
  const approvalAuditId = typeof row.approval_audit_id === "number" && row.approval_audit_id > 0
    ? row.approval_audit_id
    : null;
  const version = typeof row.version === "number" && Number.isInteger(row.version) && row.version > 0
    ? row.version
    : null;
  const publishedAt = typeof row.published_at === "string" && Number.isFinite(Date.parse(row.published_at))
    ? row.published_at
    : null;
  if (!body || !/^[0-9a-f]{64}$/.test(bodyHash) || sha256(body) !== bodyHash || !approvalReference ||
    approvalAuditId === null || !publishedAt || version === null) {
    return null;
  }
  return {
    kind: row.kind as ControlReplyKind,
    version,
    body,
    bodyHash,
    approvalReference,
    approvalAuditId,
    publishedAt,
  };
}

export async function loadApprovedControlReply(
  repository: ControlReplyRepository,
  tenantId: string,
  kind: ControlReplyKind,
) {
  return approvedControlReply(await repository.loadCurrent(tenantId, kind));
}

/** Service-only reader used by the outbound persistence lane once it is wired to this artifact. */
export function createLiveControlReplyRepository(): ControlReplyRepository {
  const client = createSupabaseServiceClient();
  return {
    async loadCurrent(tenantId, kind) {
      const { data, error } = await client.from("tenant_control_reply_artifacts")
        .select("kind,version,body,body_hash,approval_reference,approval_audit_id,published_at,is_published")
        .eq("tenant_id", tenantId)
        .eq("kind", kind)
        .eq("is_current", true)
        .maybeSingle();
      if (error) throw new Error("CONTROL_REPLY_READ_FAILED");
      return data as ControlReplyDatabaseRow | null;
    },
  };
}
