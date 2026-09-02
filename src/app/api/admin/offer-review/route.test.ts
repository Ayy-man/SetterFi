import { describe, expect, it, vi } from "vitest";

import { createOfferReviewHandler } from "./handler";

const actor = { userId: "admin-synthetic", role: "admin" as const };
const body = {
  tenantId: "tenant-synthetic",
  offerId: "offer-synthetic",
  offerVersion: 2,
  offerContentHash: "a".repeat(64),
  decision: "clear" as const,
  reason: "Reviewed the latest published offer.",
};

function post(value: unknown) {
  return new Request("https://setterfi.test/api/admin/offer-review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

function dependencies() {
  const session = vi.fn(async () => actor);
  const review = vi.fn(async () => ({ reviewId: "review-synthetic", auditId: "72", decision: "clear" as const }));
  return { session, review, values: { enabled: () => true, session, review } };
}

describe("POST /api/admin/offer-review", () => {
  it("uses the server owner/admin identity and returns only persisted review and audit receipts", async () => {
    const deps = dependencies();
    const response = await createOfferReviewHandler(deps.values)(post(body));

    expect(response.status).toBe(200);
    expect(deps.review).toHaveBeenCalledWith({
      expectedTenant: body.tenantId,
      actorId: actor.userId,
      offerId: body.offerId,
      offerVersion: body.offerVersion,
      offerContentHash: body.offerContentHash,
      decision: body.decision,
      reason: body.reason,
    });
    await expect(response.json()).resolves.toEqual({ reviewId: "review-synthetic", auditId: "72", decision: "clear" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each(["success", "build", "coach", "coach_member", "affiliate"] as const)(
    "refuses %s even when it supplies an otherwise valid decision", async (role) => {
      const deps = dependencies();
      const response = await createOfferReviewHandler({
        ...deps.values,
        session: async () => ({ userId: "actor-synthetic", role }),
      })(post(body));
      expect(response.status).toBe(403);
      expect(deps.review).not.toHaveBeenCalled();
    },
  );

  it("rejects caller-controlled actor fields and malformed decisions before the repository", async () => {
    const deps = dependencies();
    const response = await createOfferReviewHandler(deps.values)(post({ ...body, actorId: "coach-supplied" }));
    expect(response.status).toBe(409);
    expect(deps.review).not.toHaveBeenCalled();
  });

  it("makes the feature flag off-state inert", async () => {
    const deps = dependencies();
    const response = await createOfferReviewHandler({ ...deps.values, enabled: () => false })(post(body));
    expect(response.status).toBe(404);
    expect(deps.session).not.toHaveBeenCalled();
    expect(deps.review).not.toHaveBeenCalled();
  });
});
