import { describe, expect, it, vi } from "vitest";

import type { RouteActor } from "@/lib/auth/actors";

import { createOfferChangeTrailHandler } from "./handler";

const actor: RouteActor = {
  userId: "coach-a", tenantId: "tenant-a", role: "coach",
  impersonatingTenant: null, impersonationSessionId: null,
};

function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn().mockResolvedValue(actor),
    load: vi.fn().mockResolvedValue([{
      changeId: "change-1", event: "draft_saved" as const, changedKeys: ["programName"],
      contentHash: "a".repeat(64), changedAt: "2026-09-29T12:00:00.000Z",
      actorId: "coach-a", actorName: "Synthetic Coach", auditId: "42",
    }]),
  };
}

describe("GET /api/offer/change-trail", () => {
  it("derives tenant and actor from verified claims, then returns database-authorized history", async () => {
    const deps = dependencies();
    const response = await createOfferChangeTrailHandler(deps)(new Request("https://setterfi.test/api/offer/change-trail?offerId=offer-a"));
    expect(response.status).toBe(200);
    expect(deps.load).toHaveBeenCalledWith({ tenantId: "tenant-a", actorId: "coach-a", offerId: "offer-a" });
    await expect(response.json()).resolves.toMatchObject({ state: "measured", changes: [{ changedKeys: ["programName"] }] });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    [null, 403],
    [{ ...actor, role: "affiliate" as const }, 403],
    [actor, 400],
  ])("refuses an invalid actor or request before the RPC read", async (candidate, status) => {
    const deps = dependencies();
    deps.session.mockResolvedValue(candidate);
    const url = candidate === actor ? "https://setterfi.test/api/offer/change-trail" : "https://setterfi.test/api/offer/change-trail?offerId=offer-a";
    expect((await createOfferChangeTrailHandler(deps)(new Request(url))).status).toBe(status);
    expect(deps.load).not.toHaveBeenCalled();
  });

  it("keeps a cross-tenant RPC refusal opaque instead of falling back to another tenant", async () => {
    const deps = dependencies();
    deps.load.mockRejectedValue(new Error("EXPECTED_TENANT_MISMATCH:offer_change_trail"));
    const response = await createOfferChangeTrailHandler(deps)(new Request("https://setterfi.test/api/offer/change-trail?offerId=offer-b"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Offer change history is unavailable." });
    expect(deps.load).toHaveBeenCalledWith({ tenantId: "tenant-a", actorId: "coach-a", offerId: "offer-b" });
  });
});
