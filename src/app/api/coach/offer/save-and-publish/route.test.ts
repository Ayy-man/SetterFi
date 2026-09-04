import { describe, expect, it, vi } from "vitest";

import type { PersistedOfferLayer } from "@/lib/offer/types";

import { createCoachOfferSaveAndPublishHandler } from "./handler";

const actor = {
  userId: "coach-1",
  role: "coach" as const,
  tenantId: "tenant-session",
  impersonatingTenant: null,
  impersonationSessionId: null,
};
const offerInput = {
  programName: "Synthetic Funding Program",
  programDescription: null,
  creditMin: null,
  fundingGoalMinCents: null,
  fundingGoalMaxCents: null,
  monthlyRevenueMinCents: null,
  creditRepair: null,
  products: [],
  bookingHorizonDays: 14,
  bookingMode: "direct",
  brandVoice: "professional",
  resultsTimelineMinDays: null,
  resultsTimelineMaxDays: null,
  refundPosture: null,
  voiceStyleAnswer: null,
  voiceObjectionAnswer: null,
  voiceFollowupAnswer: null,
  prices: [],
  proof: [],
  assets: [],
  cadencePurposes: [],
};
const persisted = {
  id: "offer-1",
  tenantId: actor.tenantId,
  status: "published" as const,
  version: 1,
  contentHash: "a".repeat(64),
  businessRevenueRequired: false,
  offerPrices: [],
  ...offerInput,
} as PersistedOfferLayer & { status: "published" };

const request = (body: unknown) => new Request("http://localhost/api/coach/offer/save-and-publish", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("coach offer save-and-publish route", () => {
  it("404s before auth or service work when Phase 2 is off", async () => {
    const saveAndPublish = vi.fn();
    const { POST } = { POST: createCoachOfferSaveAndPublishHandler({
      enabled: () => false, session: vi.fn(), saveAndPublish,
    }) };
    const response = await POST(request({}));
    expect(response.status).toBe(404);
    expect(saveAndPublish).not.toHaveBeenCalled();
  });

  it("refuses platform roles before tenant work", async () => {
    const saveAndPublish = vi.fn();
    const POST = createCoachOfferSaveAndPublishHandler({
      enabled: () => true,
      session: async () => ({ ...actor, role: "admin" }),
      saveAndPublish,
    });
    const response = await POST(request({ draftId: null, expectedContentHash: null, offer: offerInput }));
    expect(response.status).toBe(403);
    expect(saveAndPublish).not.toHaveBeenCalled();
  });

  it("composes save and publish into one call for the actor's tenant and returns published state", async () => {
    const saveAndPublish = vi.fn(async () => ({
      offer: persisted,
      receipt: {
        auditId: "audit-1",
        actionKey: "offer.published" as const,
        offerId: persisted.id,
        offerVersion: 1,
        contentHash: persisted.contentHash,
      },
    }));
    const POST = createCoachOfferSaveAndPublishHandler({
      enabled: () => true,
      session: async () => actor,
      saveAndPublish,
    });
    const response = await POST(request({ draftId: null, expectedContentHash: null, offer: offerInput }));

    expect(response.status).toBe(200);
    expect(saveAndPublish).toHaveBeenCalledWith(actor.tenantId, {
      actorId: actor.userId,
      draftId: null,
      expectedContentHash: null,
      offer: offerInput,
    });
    await expect(response.json()).resolves.toMatchObject({
      state: "published",
      offer: { status: "published", version: 1 },
      receipt: { actionKey: "offer.published" },
    });
  });

  it("refuses tenant and platform-owned fields before the composed write", async () => {
    const saveAndPublish = vi.fn();
    const POST = createCoachOfferSaveAndPublishHandler({
      enabled: () => true,
      session: async () => actor,
      saveAndPublish,
    });
    const response = await POST(request({
      draftId: null,
      expectedContentHash: null,
      offer: { ...offerInput, qualificationMatrix: { outcome: "caller-owned" } },
    }));
    expect(response.status).toBe(409);
    expect(saveAndPublish).not.toHaveBeenCalled();
  });

  it("refuses when the composed write fails", async () => {
    const saveAndPublish = vi.fn(async () => {
      throw new Error("OFFER_DRAFT_READBACK_MISMATCH");
    });
    const POST = createCoachOfferSaveAndPublishHandler({
      enabled: () => true,
      session: async () => actor,
      saveAndPublish,
    });
    const response = await POST(request({ draftId: null, expectedContentHash: null, offer: offerInput }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      state: "awaiting_review",
      code: "OFFER_SAVE_AND_PUBLISH_REFUSED",
    });
  });
});
