/**
 * Audited authority for platform review of one immutable, published offer revision.
 *
 * A decision is bound to the published row id, tenant-local version, and content hash. A later
 * publication has a different revision and therefore reads as unreviewed without mutating or
 * reinterpreting the earlier audit evidence.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type OfferReviewDecision = "clear" | "rejected";
export type OfferReviewStatus = "unreviewed" | OfferReviewDecision | "unavailable";

export type PublishedOfferRevision = {
  tenantId: string;
  offerId: string;
  version: number;
  contentHash: string;
  programName: string | null;
  bookingMode: string | null;
  updatedAt: string | null;
};

export type OfferReviewRecord = {
  id: string;
  tenantId: string;
  offerId: string;
  offerVersion: number;
  offerContentHash: string;
  decision: OfferReviewDecision;
  reason: string;
  reviewedBy: string;
  auditId: string;
  createdAt: string;
};

export type OfferReviewReadiness = {
  offer: PublishedOfferRevision | null;
  status: OfferReviewStatus;
  evidenceAt: string | null;
};

export type OfferReviewReceipt = {
  reviewId: string;
  auditId: string;
  decision: OfferReviewDecision;
};

export type RecordOfferReviewInput = {
  expectedTenant: string;
  actorId: string;
  offerId: string;
  offerVersion: number;
  offerContentHash: string;
  decision: OfferReviewDecision;
  reason: string;
};

type OfferReviewRpcRow = { offer_review_id: string; audit_id: string; decision: OfferReviewDecision };

type OfferReviewAudit = {
  id: string;
  action: string;
  actorId: string | null;
  tenantId: string | null;
  targetType: string | null;
  targetId: string | null;
};

type OfferReviewAction = { key: string; reasonRequired: boolean };

export type OfferReviewDependencies = {
  rpc(args: Record<string, unknown>): Promise<unknown>;
  loadReview(id: string): Promise<OfferReviewRecord | null>;
  loadAudit(id: string): Promise<OfferReviewAudit | null>;
  loadAction(key: string): Promise<OfferReviewAction | null>;
};

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function contentHash(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("OFFER_REVIEW_CONTENT_HASH_INVALID");
  return value;
}

function receipt(value: unknown): OfferReviewRpcRow {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") {
    throw new Error("OFFER_REVIEW_RECEIPT_INVALID");
  }
  const row = value[0] as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "audit_id,decision,offer_review_id" ||
    typeof row.offer_review_id !== "string" || typeof row.audit_id !== "number" ||
    (row.decision !== "clear" && row.decision !== "rejected")) {
    throw new Error("OFFER_REVIEW_RECEIPT_INVALID");
  }
  return { offer_review_id: row.offer_review_id, audit_id: String(row.audit_id), decision: row.decision };
}

function actionFor(decision: OfferReviewDecision) {
  return decision === "clear" ? "offer.review.cleared" : "offer.review.rejected";
}

function asPublishedOffer(row: Record<string, unknown>): PublishedOfferRevision {
  return {
    tenantId: String(row.tenant_id),
    offerId: String(row.id),
    version: Number(row.version),
    contentHash: String(row.content_hash),
    programName: row.program_name === null ? null : String(row.program_name),
    bookingMode: row.booking_mode === null ? null : String(row.booking_mode),
    updatedAt: row.updated_at === null ? null : String(row.updated_at),
  };
}

async function liveDependencies(): Promise<OfferReviewDependencies> {
  const client = createSupabaseServiceClient();
  return {
    rpc: async (args) => {
      const { data, error } = await client.rpc("record_offer_review", args);
      if (error) throw new Error("OFFER_REVIEW_REFUSED");
      return data;
    },
    loadReview: async (id) => {
      const { data, error } = await client.from("offer_reviews").select(
        "id,tenant_id,offer_id,offer_version,offer_content_hash,decision,reason,reviewed_by,audit_id,created_at",
      ).eq("id", id).maybeSingle();
      if (error || !data) return null;
      return {
        id: data.id,
        tenantId: data.tenant_id,
        offerId: data.offer_id,
        offerVersion: Number(data.offer_version),
        offerContentHash: data.offer_content_hash,
        decision: data.decision as OfferReviewDecision,
        reason: data.reason,
        reviewedBy: data.reviewed_by,
        auditId: String(data.audit_id),
        createdAt: data.created_at,
      };
    },
    loadAudit: async (id) => {
      const { data, error } = await client.from("audit_log")
        .select("id,action,actor_id,tenant_id,target_type,target_id").eq("id", id).maybeSingle();
      if (error || !data) return null;
      return {
        id: String(data.id),
        action: data.action,
        actorId: data.actor_id,
        tenantId: data.tenant_id,
        targetType: data.target_type,
        targetId: data.target_id,
      };
    },
    loadAction: async (key) => {
      const { data, error } = await client.from("audit_actions")
        .select("key,reason_required").eq("key", key).maybeSingle();
      if (error || !data) return null;
      return { key: data.key, reasonRequired: data.reason_required };
    },
  };
}

/** Writes through the RPC, then verifies the immutable decision and audit registry evidence. */
export async function recordOfferReview(
  input: RecordOfferReviewInput,
  dependencies?: OfferReviewDependencies,
): Promise<OfferReviewReceipt> {
  const expectedTenant = required(input.expectedTenant, "OFFER_REVIEW_TENANT_REQUIRED");
  const actorId = required(input.actorId, "OFFER_REVIEW_ACTOR_REQUIRED");
  const offerId = required(input.offerId, "OFFER_REVIEW_OFFER_REQUIRED");
  const reason = required(input.reason, "OFFER_REVIEW_REASON_REQUIRED");
  const offerContentHash = contentHash(input.offerContentHash);
  if (!Number.isSafeInteger(input.offerVersion) || input.offerVersion < 1) {
    throw new Error("OFFER_REVIEW_VERSION_INVALID");
  }
  if (input.decision !== "clear" && input.decision !== "rejected") {
    throw new Error("OFFER_REVIEW_DECISION_INVALID");
  }
  const deps = dependencies ?? await liveDependencies();
  const result = receipt(await deps.rpc({
    p_expected_tenant: expectedTenant,
    p_actor_id: actorId,
    p_offer_id: offerId,
    p_offer_version: input.offerVersion,
    p_offer_content_hash: offerContentHash,
    p_decision: input.decision,
    p_reason: reason,
  }));
  const [review, audit, action] = await Promise.all([
    deps.loadReview(result.offer_review_id),
    deps.loadAudit(result.audit_id),
    deps.loadAction(actionFor(input.decision)),
  ]);
  if (!review || review.id !== result.offer_review_id || review.tenantId !== expectedTenant ||
    review.offerId !== offerId || review.offerVersion !== input.offerVersion ||
    review.offerContentHash !== offerContentHash || review.decision !== input.decision ||
    review.reason !== reason || review.reviewedBy !== actorId || review.auditId !== result.audit_id ||
    !audit || audit.id !== result.audit_id || audit.action !== actionFor(input.decision) ||
    audit.actorId !== actorId || audit.tenantId !== expectedTenant || audit.targetType !== "offer_review" ||
    audit.targetId !== result.offer_review_id || !action || action.key !== actionFor(input.decision) ||
    !action.reasonRequired) {
    throw new Error("OFFER_REVIEW_READBACK_MISMATCH");
  }
  return { reviewId: result.offer_review_id, auditId: result.audit_id, decision: result.decision };
}

/** Reads the current published offer and its matching latest review without inferring success. */
export async function loadOfferReviewReadiness(tenantId: string): Promise<OfferReviewReadiness> {
  const client = createSupabaseServiceClient();
  const { data: offerData, error: offerError } = await client.from("offer_layers").select(
    "id,tenant_id,version,content_hash,program_name,booking_mode,updated_at",
  ).eq("tenant_id", tenantId).eq("status", "published").maybeSingle();
  if (offerError) throw new Error("OFFER_READINESS_OFFER_READ_FAILED");
  if (!offerData) return { offer: null, status: "unreviewed", evidenceAt: null };
  const offer = asPublishedOffer(offerData as Record<string, unknown>);
  if (offer.tenantId !== tenantId || !/^[0-9a-f]{64}$/.test(offer.contentHash)) {
    throw new Error("OFFER_READINESS_OFFER_INVALID");
  }
  const { data: reviewData, error: reviewError } = await client.from("offer_reviews")
    .select("decision,created_at")
    .eq("tenant_id", tenantId)
    .eq("offer_id", offer.offerId)
    .eq("offer_version", offer.version)
    .eq("offer_content_hash", offer.contentHash)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (reviewError) throw new Error("OFFER_READINESS_REVIEW_READ_FAILED");
  if (!reviewData) return { offer, status: "unreviewed", evidenceAt: null };
  if (reviewData.decision !== "clear" && reviewData.decision !== "rejected") {
    throw new Error("OFFER_READINESS_REVIEW_INVALID");
  }
  return {
    offer,
    status: reviewData.decision,
    // The review timestamp is the evidence that the exact immutable offer revision was cleared.
    evidenceAt: reviewData.created_at,
  };
}
