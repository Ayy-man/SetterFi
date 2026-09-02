import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  recordOfferReview,
  type OfferReviewDependencies,
  type RecordOfferReviewInput,
} from "./offer-review";

const tenantId = "tenant-synthetic";
const actorId = "admin-synthetic";
const offerId = "offer-synthetic";
const reviewId = "review-synthetic";
const auditId = "91";
const offerContentHash = "a".repeat(64);

function input(overrides: Partial<RecordOfferReviewInput> = {}): RecordOfferReviewInput {
  return {
    expectedTenant: tenantId,
    actorId,
    offerId,
    offerVersion: 4,
    offerContentHash,
    decision: "clear",
    reason: "Checked the published offer against the platform policy.",
    ...overrides,
  };
}

function dependencies(overrides: Partial<OfferReviewDependencies> = {}) {
  const rpc = vi.fn(async () => [{ offer_review_id: reviewId, audit_id: 91, decision: "clear" }]);
  const values: OfferReviewDependencies = {
    rpc,
    loadReview: async () => ({
      id: reviewId,
      tenantId,
      offerId,
      offerVersion: 4,
      offerContentHash,
      decision: "clear",
      reason: "Checked the published offer against the platform policy.",
      reviewedBy: actorId,
      auditId,
      createdAt: "2026-08-30T12:00:00.000Z",
    }),
    loadAudit: async () => ({
      id: auditId,
      action: "offer.review.cleared",
      actorId,
      tenantId,
      targetType: "offer_review",
      targetId: reviewId,
    }),
    loadAction: async () => ({ key: "offer.review.cleared", reasonRequired: true }),
    ...overrides,
  };
  return { rpc, values };
}

describe("audited offer-review repository", () => {
  it("binds a clearance to the expected tenant, immutable offer revision, reason, and audit receipt", async () => {
    const deps = dependencies();
    await expect(recordOfferReview(input(), deps.values)).resolves.toEqual({
      reviewId,
      auditId,
      decision: "clear",
    });
    expect(deps.rpc).toHaveBeenCalledWith({
      p_expected_tenant: tenantId,
      p_actor_id: actorId,
      p_offer_id: offerId,
      p_offer_version: 4,
      p_offer_content_hash: offerContentHash,
      p_decision: "clear",
      p_reason: "Checked the published offer against the platform policy.",
    });
  });

  it("requires an explicit reason and refuses a malformed revision before SQL", async () => {
    const deps = dependencies();
    await expect(recordOfferReview(input({ reason: " " }), deps.values))
      .rejects.toThrow("OFFER_REVIEW_REASON_REQUIRED");
    await expect(recordOfferReview(input({ offerContentHash: "stale" }), deps.values))
      .rejects.toThrow("OFFER_REVIEW_CONTENT_HASH_INVALID");
    expect(deps.rpc).not.toHaveBeenCalled();
  });

  it("does not report success when decision, audit, or action-registry evidence disagrees", async () => {
    const deps = dependencies({
      loadReview: async () => ({
        id: reviewId,
        tenantId,
        offerId,
        offerVersion: 5,
        offerContentHash,
        decision: "clear",
        reason: "Checked the published offer against the platform policy.",
        reviewedBy: actorId,
        auditId,
        createdAt: "2026-08-30T12:00:00.000Z",
      }),
    });
    await expect(recordOfferReview(input(), deps.values))
      .rejects.toThrow("OFFER_REVIEW_READBACK_MISMATCH");
  });

  it("keeps the database authority revision-bound, append-only, owner/admin-only, and rechecks it at go-live", () => {
    const migration = readFileSync(
      new URL("../../../supabase/migrations/20260919000002_offer_review_authority.sql", import.meta.url),
      "utf8",
    );
    const custodyGate = readFileSync(
      new URL("../../../supabase/migrations/20260927000003_offer_review_authority_gate.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("foreign key (offer_id, tenant_id) references public.offer_layers(id, tenant_id)");
    expect(migration).toContain("offer_row.version <> p_offer_version or offer_row.content_hash <> p_offer_content_hash");
    expect(migration).toContain("actor.role not in ('owner', 'admin')");
    expect(migration).toContain("OFFER_REVIEWS_APPEND_ONLY");
    expect(migration).toContain("'offer.review.cleared'");
    expect(migration).toContain("'offer.review.rejected'");
    expect(migration).toContain("review.created_at = p_offer_review_evidence_at");
    expect(custodyGate).toContain("alter table public.offer_reviews force row level security");
    expect(custodyGate).toContain("revoke all on public.offer_reviews from service_role");
    expect(custodyGate).toContain("grant select on public.offer_reviews to service_role");
  });
});
