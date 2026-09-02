import { describe, expect, it, vi } from "vitest";

import type { PersistedOfferLayer } from "@/lib/offer/types";

import { createCoachOfferHandlers } from "./handler";
import { createCoachOfferPublishHandler } from "./publish/handler";

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
  status: "draft",
  version: 0,
  contentHash: "a".repeat(64),
  businessRevenueRequired: false,
  offerPrices: [],
  ...offerInput,
} as PersistedOfferLayer;

const put = (body: unknown) => new Request("http://localhost/api/coach/offer", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const publishRequest = (body: unknown) => new Request("http://localhost/api/coach/offer/publish", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("coach offer route contracts", () => {
  it("404s GET before auth or repository reads when Phase 2 is off", async () => {
    const session = vi.fn(async () => actor);
    const load = vi.fn();
    const save = vi.fn();
    const { GET } = createCoachOfferHandlers({ enabled: () => false, session, load, save });
    const response = await GET();
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("404s PUT before auth or service work when Phase 2 is off", async () => {
    const session = vi.fn(async () => actor);
    const load = vi.fn();
    const save = vi.fn();
    const { PUT } = createCoachOfferHandlers({ enabled: () => false, session, load, save });
    const response = await PUT(put({}));
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("404s publish before auth or service work when Phase 2 is off", async () => {
    const session = vi.fn(async () => actor);
    const publish = vi.fn();
    const response = await createCoachOfferPublishHandler({ enabled: () => false, session, publish })(
      publishRequest({}),
    );
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("derives tenant and actor from the coach session when saving", async () => {
    const save = vi.fn(async () => ({ draft: persisted as PersistedOfferLayer & { status: "draft" } }));
    const { PUT } = createCoachOfferHandlers({
      enabled: () => true,
      session: async () => actor,
      load: async () => ({ draft: null, published: null }),
      save,
    });
    const response = await PUT(put({
      draftId: null,
      expectedContentHash: null,
      offer: offerInput,
    }));

    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith(actor.tenantId, {
      actorId: actor.userId,
      draftId: null,
      expectedContentHash: null,
      offer: offerInput,
    });
    await expect(response.json()).resolves.toMatchObject({ state: "draft", draft: { id: "offer-1" } });
  });

  it.each([
    { tenantId: "tenant-request", draftId: null, expectedContentHash: null, offer: offerInput },
    {
      draftId: null,
      expectedContentHash: null,
      offer: { ...offerInput, businessRevenueRequired: true },
    },
    {
      draftId: null,
      expectedContentHash: null,
      offer: { ...offerInput, qualificationMatrix: { outcome: "caller-owned" } },
    },
  ])("refuses tenant and platform-owned fields before save", async (body) => {
    const save = vi.fn();
    const { PUT } = createCoachOfferHandlers({
      enabled: () => true,
      session: async () => actor,
      load: async () => ({ draft: null, published: null }),
      save,
    });
    const response = await PUT(put(body));
    expect(response.status).toBe(409);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses platform roles before tenant reads or writes", async () => {
    const load = vi.fn();
    const save = vi.fn();
    const handlers = createCoachOfferHandlers({
      enabled: () => true,
      session: async () => ({ ...actor, role: "admin" }),
      load,
      save,
    });
    expect((await handlers.GET()).status).toBe(403);
    expect((await handlers.PUT(put({}))).status).toBe(403);
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("returns awaiting_review when no persisted offer exists", async () => {
    const { GET } = createCoachOfferHandlers({
      enabled: () => true,
      session: async () => actor,
      load: async () => ({ draft: null, published: null }),
      save: vi.fn(),
    });
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "awaiting_review",
      draft: null,
      published: null,
    });
  });

  it("publishes only for the actor tenant and returns the persisted receipt", async () => {
    const published = { ...persisted, status: "published" as const, version: 2 };
    const publish = vi.fn(async () => ({
      offer: published,
      receipt: {
        auditId: "audit-1",
        actionKey: "offer.published" as const,
        offerId: persisted.id,
        offerVersion: 2,
        contentHash: persisted.contentHash,
      },
    }));
    const response = await createCoachOfferPublishHandler({
      enabled: () => true,
      session: async () => actor,
      publish,
    })(publishRequest({ draftId: persisted.id, expectedContentHash: persisted.contentHash }));

    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(actor.tenantId, {
      actorId: actor.userId,
      draftId: persisted.id,
      expectedContentHash: persisted.contentHash,
    });
    await expect(response.json()).resolves.toMatchObject({
      state: "published",
      offer: { status: "published", version: 2 },
      receipt: { actionKey: "offer.published", offerVersion: 2 },
    });
  });
});
