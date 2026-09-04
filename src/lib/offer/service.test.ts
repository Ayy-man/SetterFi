import { describe, expect, it } from "vitest";

import { OFFER_BOUNDS, OFFER_PRODUCTS } from "@/lib/brain/contracts";
import {
  hashCoachOffer,
  publishCoachOfferDraft,
  saveAndPublishCoachOffer,
  saveCoachOfferDraft,
} from "@/lib/offer/service";
import type {
  CoachOfferDraftInput,
  OfferPublishReceipt,
  PersistedOfferLayer,
} from "@/lib/offer/types";
import { OfferValidationError } from "@/lib/offer/validation";
import type { OfferLayerRepository } from "@/lib/repositories/offer-layer";

const TENANT = "tenant-a";
const ACTOR = "actor-a";

const validOffer: CoachOfferDraftInput = {
  programName: "Synthetic growth program",
  programDescription: "A synthetic description used only by the test suite.",
  creditMin: 640,
  fundingGoalMinCents: 5_000_000,
  fundingGoalMaxCents: 10_000_000,
  monthlyRevenueMinCents: 500_000,
  creditRepair: "no_refer_out",
  products: [OFFER_PRODUCTS[2]],
  bookingHorizonDays: 21,
  bookingMode: "direct",
  brandVoice: "professional",
  resultsTimelineMinDays: 30,
  resultsTimelineMaxDays: 90,
  refundPosture: "conditional",
  voiceStyleAnswer: "Use concise, calm language.",
  voiceObjectionAnswer: "Acknowledge the concern before explaining the next step.",
  voiceFollowupAnswer: "Keep follow-ups useful and brief.",
  prices: [{ label: "Program fee", amountCents: 250_000, billingPeriod: "one_time" }],
  proof: [{ title: "Synthetic example", detail: "The example contains no client source text." }],
  assets: [{ slug: "readiness-guide", label: "Readiness guide", url: "https://example.invalid/guide" }],
  cadencePurposes: [{ channelClass: "durable", touchNo: 1, purpose: "lead_magnet", assetId: null }],
};

type MemoryStore = {
  offers: PersistedOfferLayer[];
  audits: OfferPublishReceipt[];
  saves: number;
};

function persistedOffer(
  offer: CoachOfferDraftInput,
  input: { id: string; version: number; hash: string; status?: PersistedOfferLayer["status"] },
): PersistedOfferLayer {
  return {
    id: input.id,
    tenantId: TENANT,
    status: input.status ?? "draft",
    version: input.version,
    contentHash: input.hash,
    programName: offer.programName,
    programDescription: offer.programDescription,
    creditMin: offer.creditMin,
    fundingGoalMinCents: offer.fundingGoalMinCents,
    fundingGoalMaxCents: offer.fundingGoalMaxCents,
    monthlyRevenueMinCents: offer.monthlyRevenueMinCents,
    businessRevenueRequired: false,
    creditRepair: offer.creditRepair,
    products: offer.products,
    bookingHorizonDays: offer.bookingHorizonDays,
    bookingMode: offer.bookingMode,
    brandVoice: offer.brandVoice,
    resultsTimelineMinDays: offer.resultsTimelineMinDays,
    resultsTimelineMaxDays: offer.resultsTimelineMaxDays,
    refundPosture: offer.refundPosture,
    voiceStyleAnswer: offer.voiceStyleAnswer,
    voiceObjectionAnswer: offer.voiceObjectionAnswer,
    voiceFollowupAnswer: offer.voiceFollowupAnswer,
    offerPrices: offer.prices.map((price, index) => ({ id: `price-${index}`, ...price })),
    proof: offer.proof.map((proof, index) => ({ id: `proof-${index}`, ...proof })),
    assets: offer.assets.map((asset, index) => ({ id: `asset-${index}`, ...asset })),
    cadencePurposes: offer.cadencePurposes,
  };
}

function memoryRepository(store: MemoryStore): OfferLayerRepository {
  return {
    loadAllowedHosts: async () => ["example.invalid"],
    saveDraft: async ({ draftId, expectedContentHash, offer, contentHash }) => {
      store.saves += 1;
      if (draftId) {
        const draft = store.offers.find((candidate) => candidate.id === draftId && candidate.status === "draft");
        if (!draft || draft.contentHash !== expectedContentHash) throw new Error("OFFER_DRAFT_STALE");
        const next = persistedOffer(offer, { id: draftId, version: draft.version, hash: contentHash });
        store.offers.splice(store.offers.indexOf(draft), 1, next);
        return draftId;
      }
      const version = Math.max(0, ...store.offers.map((offer) => offer.version)) + 1;
      const id = `offer-${version}`;
      store.offers.push(persistedOffer(offer, { id, version, hash: contentHash }));
      return id;
    },
    loadOffer: async ({ tenantId, status, offerId }) =>
      store.offers.find((offer) =>
        offer.tenantId === tenantId && offer.status === status && (!offerId || offer.id === offerId),
      ) ?? null,
    publishDraft: async ({ draftId, expectedContentHash }) => {
      const draft = store.offers.find((offer) => offer.id === draftId && offer.status === "draft");
      if (!draft || draft.contentHash !== expectedContentHash) throw new Error("OFFER_DRAFT_HASH_MISMATCH");
      const current = store.offers.find((offer) => offer.status === "published");
      if (current) current.status = "superseded";
      draft.status = "published";
      const receipt = {
        auditId: `audit-${draft.version}`,
        actionKey: "offer.published" as const,
        offerId: draft.id,
        offerVersion: draft.version,
        contentHash: draft.contentHash,
      };
      store.audits.push(receipt);
      return { offerId: draft.id, offerVersion: draft.version, auditId: receipt.auditId };
    },
    loadPublishReceipt: async ({ tenantId, offerId, auditId }) => {
      if (tenantId !== TENANT) return null;
      return store.audits.find((receipt) => receipt.offerId === offerId && receipt.auditId === auditId) ?? null;
    },
  };
}

function emptyStore(): MemoryStore {
  return { offers: [], audits: [], saves: 0 };
}

describe("offer service", () => {
  it("round-trips a valid draft through a new repository instance rather than browser storage", async () => {
    const store = emptyStore();
    const saved = await saveCoachOfferDraft(
      TENANT,
      { actorId: ACTOR, offer: validOffer },
      memoryRepository(store),
    );
    const reloaded = await memoryRepository(store).loadOffer({
      tenantId: TENANT,
      status: "draft",
      offerId: saved.draft.id,
    });
    expect(reloaded).toEqual(saved.draft);
    expect(saved.draft).toMatchObject({ status: "draft", version: 1, proof: [{ title: "Synthetic example" }] });
  });

  it.each([
    "status",
    "version",
    "contentHash",
    "businessRevenueRequired",
    "cadence",
    "cadenceTiming",
    "linkWhitelist",
    "qualificationOutcomes",
    "reviewState",
    "pricePosture",
    "pricingGate",
    "creditMinEnforced",
  ])("rejects platform-owned key %s before service-role persistence", async (platformKey) => {
    const store = emptyStore();
    await expect(saveCoachOfferDraft(
      TENANT,
      { actorId: ACTOR, offer: { ...validOffer, [platformKey]: "attempted" } },
      memoryRepository(store),
    )).rejects.toThrow(new RegExp(`OFFER_PLATFORM_FIELD_FORBIDDEN:offer\\.${platformKey}`));
    expect(store.saves).toBe(0);
  });

  it("imports shared bounds and vocabulary for freeform, children, products, URLs, and ranges", async () => {
    const store = emptyStore();
    const invalidCases: unknown[] = [
      { ...validOffer, voiceStyleAnswer: "x".repeat(OFFER_BOUNDS.voiceAnswerMax + 1) },
      { ...validOffer, prices: Array.from({ length: OFFER_BOUNDS.price.maxRows + 1 }, () => validOffer.prices[0]) },
      { ...validOffer, products: ["freeform product"] },
      { ...validOffer, assets: [{ ...validOffer.assets[0], slug: "Unstable Slug" }] },
      { ...validOffer, assets: [{ ...validOffer.assets[0], url: "http://example.invalid/guide" }] },
      { ...validOffer, assets: [{ ...validOffer.assets[0], url: "https://unlisted.invalid/guide" }] },
      { ...validOffer, fundingGoalMinCents: 2, fundingGoalMaxCents: 1 },
      { ...validOffer, resultsTimelineMinDays: 2, resultsTimelineMaxDays: 1 },
      { ...validOffer, bookingHorizonDays: 0 },
    ];
    for (const offer of invalidCases) {
      await expect(saveCoachOfferDraft(TENANT, { actorId: ACTOR, offer }, memoryRepository(store)))
        .rejects.toBeInstanceOf(OfferValidationError);
    }
    expect(store.saves).toBe(0);
  });

  it("keeps the prior publication current while a new draft awaits publish", async () => {
    const store = emptyStore();
    const first = await saveCoachOfferDraft(TENANT, { actorId: ACTOR, offer: validOffer }, memoryRepository(store));
    await publishCoachOfferDraft(TENANT, {
      actorId: ACTOR,
      draftId: first.draft.id,
      expectedContentHash: first.draft.contentHash,
    }, memoryRepository(store));
    const held = await saveCoachOfferDraft(TENANT, {
      actorId: ACTOR,
      offer: { ...validOffer, programDescription: "A flagged draft remains isolated." },
    }, memoryRepository(store));
    expect(store.offers.find((offer) => offer.status === "published")?.id).toBe(first.draft.id);
    expect(held.draft).toMatchObject({ status: "draft", version: 2 });
  });

  it("publishes one audited version and supersedes the prior row after a proof edit", async () => {
    const store = emptyStore();
    const firstDraft = await saveCoachOfferDraft(TENANT, { actorId: ACTOR, offer: validOffer }, memoryRepository(store));
    const first = await publishCoachOfferDraft(TENANT, {
      actorId: ACTOR,
      draftId: firstDraft.draft.id,
      expectedContentHash: firstDraft.draft.contentHash,
    }, memoryRepository(store));
    const editedOffer = {
      ...validOffer,
      proof: [{ ...validOffer.proof[0], detail: "A changed synthetic proof detail." }],
    };
    const secondDraft = await saveCoachOfferDraft(TENANT, { actorId: ACTOR, offer: editedOffer }, memoryRepository(store));
    const second = await publishCoachOfferDraft(TENANT, {
      actorId: ACTOR,
      draftId: secondDraft.draft.id,
      expectedContentHash: secondDraft.draft.contentHash,
    }, memoryRepository(store));
    expect(second.offer.version).toBe(first.offer.version + 1);
    expect(second.offer.contentHash).not.toBe(first.offer.contentHash);
    expect(second.receipt).toEqual({
      auditId: "audit-2",
      actionKey: "offer.published",
      offerId: second.offer.id,
      offerVersion: 2,
      contentHash: second.offer.contentHash,
    });
    expect(store.offers.filter((offer) => offer.status === "published")).toHaveLength(1);
    expect(store.offers.find((offer) => offer.id === first.offer.id)?.status).toBe("superseded");
  });

  it("saves and publishes in one call, with no draft left as the coach-visible state", async () => {
    // Q4's chosen default (docs/SIMPLIFICATION-SPEC.md): one Save, no draft step the coach takes
    // on their own. This composes saveCoachOfferDraft then publishCoachOfferDraft against the
    // just-saved draft's own id and hash, so the caller never handles an intermediate draft id.
    const store = emptyStore();
    const result = await saveAndPublishCoachOffer(TENANT, {
      actorId: ACTOR, draftId: null, expectedContentHash: null, offer: validOffer,
    }, memoryRepository(store));

    expect(result.offer.status).toBe("published");
    expect(result.receipt.actionKey).toBe("offer.published");
    expect(store.saves).toBe(1);
    expect(store.offers.filter((offer) => offer.status === "draft")).toHaveLength(0);
    expect(store.offers.filter((offer) => offer.status === "published")).toHaveLength(1);

    // A second save-and-publish edits the same published offer's next version, the same way an
    // explicit save-then-publish already does.
    const edited = { ...validOffer, programName: "Synthetic growth program v2" };
    const second = await saveAndPublishCoachOffer(TENANT, {
      actorId: ACTOR, draftId: null, expectedContentHash: null, offer: edited,
    }, memoryRepository(store));
    expect(second.offer.version).toBe(result.offer.version + 1);
    expect(second.offer.programName).toBe("Synthetic growth program v2");
    expect(store.offers.filter((offer) => offer.status === "published")).toHaveLength(1);
    expect(store.offers.find((offer) => offer.id === result.offer.id)?.status).toBe("superseded");
  });

  it("hashes canonical content independently of bounded child ordering", () => {
    const reordered = {
      ...validOffer,
      products: [...validOffer.products].reverse(),
      prices: [...validOffer.prices].reverse(),
      proof: [...validOffer.proof].reverse(),
      assets: [...validOffer.assets].reverse(),
      cadencePurposes: [...validOffer.cadencePurposes].reverse(),
    };
    expect(hashCoachOffer(reordered)).toBe(hashCoachOffer(validOffer));
  });
});
