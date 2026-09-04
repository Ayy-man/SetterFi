/**
 * Offer save and publish orchestration.
 *
 * Validation and canonical hashing happen before service-role use. The repository then reads the
 * committed row, children, and audit receipt back so callers cannot render optimistic success.
 */

import { createHash } from "node:crypto";

import type { PublishedCoachOffer } from "@/lib/brain/contracts";
import {
  createOfferLayerRepository,
  type OfferLayerRepository,
} from "@/lib/repositories/offer-layer";
import type {
  CoachOfferDraftInput,
  PublishedOfferResult,
  SavedOfferDraft,
} from "@/lib/offer/types";
import { validateCoachOfferDraft } from "@/lib/offer/validation";

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function ordered<T>(values: readonly T[], key: (value: T) => string) {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

/** Produces the cache identity from content alone; database ids and row order cannot change it. */
export function hashCoachOffer(offer: CoachOfferDraftInput) {
  const canonical = {
    ...offer,
    products: [...offer.products].sort(),
    prices: ordered(offer.prices, (price) => `${price.label}:${price.amountCents}:${price.billingPeriod ?? ""}`),
    proof: ordered(offer.proof, (proof) => `${proof.title}:${proof.detail}`),
    assets: ordered(offer.assets, (asset) => `${asset.slug}:${asset.url}`),
    cadencePurposes: ordered(
      offer.cadencePurposes,
      (purpose) => `${purpose.channelClass}:${String(purpose.touchNo).padStart(2, "0")}`,
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function assertDraftReadback(
  draft: Awaited<ReturnType<OfferLayerRepository["loadOffer"]>>,
  expected: { tenantId: string; draftId: string; contentHash: string },
): asserts draft is NonNullable<typeof draft> & { status: "draft" } {
  if (!draft) throw new Error("OFFER_DRAFT_READBACK_MISSING");
  if (
    draft.status !== "draft" ||
    draft.id !== expected.draftId ||
    draft.tenantId !== expected.tenantId ||
    draft.contentHash !== expected.contentHash
  ) throw new Error("OFFER_DRAFT_READBACK_MISMATCH");
}

export async function saveCoachOfferDraft(
  tenantId: string,
  input: {
    actorId: string;
    draftId?: string | null;
    expectedContentHash?: string | null;
    offer: unknown;
  },
  repository: OfferLayerRepository = createOfferLayerRepository(),
): Promise<SavedOfferDraft> {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  const actorId = required(input.actorId, "OFFER_ACTOR_REQUIRED");
  const draftId = input.draftId?.trim() || null;
  const expectedContentHash = input.expectedContentHash?.trim() || null;
  if (Boolean(draftId) !== Boolean(expectedContentHash)) {
    throw new Error("OFFER_DRAFT_ID_HASH_PAIR_REQUIRED");
  }
  const allowedHosts = await repository.loadAllowedHosts(expectedTenant);
  const offer = validateCoachOfferDraft(input.offer, allowedHosts);
  const contentHash = hashCoachOffer(offer);
  const savedId = await repository.saveDraft({
    tenantId: expectedTenant,
    actorId,
    draftId,
    expectedContentHash,
    offer,
    contentHash,
  });
  const draft = await repository.loadOffer({
    tenantId: expectedTenant,
    status: "draft",
    offerId: savedId,
  });
  assertDraftReadback(draft, { tenantId: expectedTenant, draftId: savedId, contentHash });
  return { draft };
}

export async function publishCoachOfferDraft(
  tenantId: string,
  input: { actorId: string; draftId: string; expectedContentHash: string },
  repository: OfferLayerRepository = createOfferLayerRepository(),
): Promise<PublishedOfferResult> {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  const actorId = required(input.actorId, "OFFER_ACTOR_REQUIRED");
  const draftId = required(input.draftId, "OFFER_DRAFT_REQUIRED");
  const expectedContentHash = required(input.expectedContentHash, "OFFER_CONTENT_HASH_REQUIRED");
  const transition = await repository.publishDraft({
    tenantId: expectedTenant,
    actorId,
    draftId,
    expectedContentHash,
  });
  const persisted = await repository.loadOffer({
    tenantId: expectedTenant,
    status: "published",
    offerId: transition.offerId,
  });
  if (
    !persisted ||
    persisted.status !== "published" ||
    persisted.id !== draftId ||
    persisted.tenantId !== expectedTenant ||
    persisted.version !== transition.offerVersion ||
    persisted.contentHash !== expectedContentHash
  ) throw new Error("PUBLISHED_OFFER_READBACK_MISMATCH");
  const receipt = await repository.loadPublishReceipt({
    tenantId: expectedTenant,
    offerId: persisted.id,
    auditId: transition.auditId,
  });
  if (!receipt) throw new Error("OFFER_PUBLISH_AUDIT_MISSING");
  const completedReceipt = {
    ...receipt,
    offerVersion: persisted.version,
    contentHash: persisted.contentHash,
  };
  return {
    offer: persisted as PublishedCoachOffer,
    receipt: completedReceipt,
  };
}

/**
 * Saves a draft and immediately publishes it, as one call. `SIMPLIFICATION-SPEC.md` Q4's chosen
 * default collapses the coach's separate Save-then-Publish steps into one Save button that the
 * coach never sees the word "publish" behind; platform review still runs on the publish, it is
 * just no longer a step the coach takes on their own. `saveCoachOfferDraft` and
 * `publishCoachOfferDraft` stay available and unchanged for any caller that still wants the
 * explicit two-step shape (the review-only guard in the offer editor and internal tooling do).
 */
export async function saveAndPublishCoachOffer(
  tenantId: string,
  input: {
    actorId: string;
    draftId?: string | null;
    expectedContentHash?: string | null;
    offer: unknown;
  },
  repository: OfferLayerRepository = createOfferLayerRepository(),
): Promise<PublishedOfferResult> {
  const { draft } = await saveCoachOfferDraft(tenantId, input, repository);
  return publishCoachOfferDraft(tenantId, {
    actorId: input.actorId,
    draftId: draft.id,
    expectedContentHash: draft.contentHash,
  }, repository);
}
