import { describe, expect, it, vi } from "vitest";

import { createTierOfferTermsHandlers } from "@/app/api/platform/tier-offer-terms/handler";
import { TierOfferTermsRepositoryError } from "@/lib/repositories/tier-offer-terms";

const url = "https://app.test/api/platform/tier-offer-terms";
const post = (body: unknown) =>
  new Request(url, { method: "POST", body: JSON.stringify(body) });

function operations() {
  return { list: vi.fn().mockResolvedValue([]), record: vi.fn(), close: vi.fn() };
}

function handlers(
  overrides: Partial<{
    enabled: () => boolean;
    session: () => Promise<{ userId: string; role: string } | null>;
    operations: ReturnType<typeof operations>;
  }> = {},
) {
  const ops = overrides.operations ?? operations();
  return {
    ops,
    handlers: createTierOfferTermsHandlers({
      enabled: overrides.enabled ?? (() => true),
      session: (overrides.session ??
        (async () => ({ userId: "admin-1", role: "admin" }))) as never,
      operations: ops as never,
    }),
  };
}

const term = {
  action: "record_term",
  tierId: "tier-1",
  currency: "usd",
  amountCents: 49_900,
  interval: "month",
  stripePriceId: "price_live_1",
  effectiveFrom: "2026-09-01T00:00:00.000Z",
  effectiveTo: null,
  reason: "Launch pricing agreed with Alec.",
};

describe("platform tier offer terms route", () => {
  it("records a term against the verified actor and returns the audit receipt", async () => {
    const { handlers: routes, ops } = handlers();
    ops.record.mockResolvedValue({ termId: "term-1", auditId: 91 });

    const response = await routes.POST(post(term));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { termId: "term-1", auditId: 91 } });
    expect(ops.record).toHaveBeenCalledWith({
      actorId: "admin-1",
      tierId: "tier-1",
      // Normalized here so the database's own currency check is never the first thing that
      // notices a lowercase code the operator typed.
      currency: "USD",
      amountCents: 49_900,
      interval: "month",
      stripePriceId: "price_live_1",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      effectiveTo: null,
      reason: "Launch pricing agreed with Alec.",
    });
  });

  it("names the overlapping window instead of reporting a generic failure", async () => {
    const { handlers: routes, ops } = handlers();
    ops.record.mockRejectedValue(
      new TierOfferTermsRepositoryError("TIER_OFFER_TERM_WINDOW_OVERLAP"),
    );

    const response = await routes.POST(post(term));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("TIER_OFFER_TERM_WINDOW_OVERLAP");
    expect(body.error).toMatch(/overlaps a term already recorded/i);
  });

  it("names a duplicate Stripe price id", async () => {
    const { handlers: routes, ops } = handlers();
    ops.record.mockRejectedValue(
      new TierOfferTermsRepositoryError("TIER_OFFER_TERM_STRIPE_PRICE_DUPLICATE"),
    );

    const response = await routes.POST(post(term));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("TIER_OFFER_TERM_STRIPE_PRICE_DUPLICATE");
    expect(body.error).toMatch(/already recorded on another term/i);
  });

  it("closes an open window and returns its own receipt", async () => {
    const { handlers: routes, ops } = handlers();
    ops.close.mockResolvedValue({ termId: "term-1", auditId: 92 });

    const response = await routes.POST(post({
      action: "close_term",
      termId: "term-1",
      effectiveTo: "2026-12-01T00:00:00.000Z",
      reason: "Superseded by the 2027 price.",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { termId: "term-1", auditId: 92 } });
    expect(ops.close).toHaveBeenCalledWith({
      actorId: "admin-1",
      termId: "term-1",
      effectiveTo: "2026-12-01T00:00:00.000Z",
      reason: "Superseded by the 2027 price.",
    });
  });

  it("refuses success, who may read the money pages but not price them", async () => {
    const { handlers: routes, ops } = handlers({
      session: async () => ({ userId: "success-1", role: "success" }),
    });

    const write = await routes.POST(post(term));
    const read = await routes.GET();

    expect(write.status).toBe(403);
    expect(read.status).toBe(403);
    expect(ops.record).not.toHaveBeenCalled();
    expect(ops.list).not.toHaveBeenCalled();
  });

  it("refuses a term with no reason before it reaches the database", async () => {
    const { handlers: routes, ops } = handlers();

    const response = await routes.POST(post({ ...term, reason: "  " }));

    expect(response.status).toBe(400);
    expect(ops.record).not.toHaveBeenCalled();
  });

  it("stays open while the signup flag is off, which is the only way that flag can ever go on", async () => {
    const { handlers: routes, ops } = handlers();
    ops.record.mockResolvedValue({ termId: "term-1", auditId: 93 });

    // `tierOfferTermsLive` is never consulted by this handler; `phase6Live` is the whole gate.
    const response = await routes.POST(post(term));

    expect(response.status).toBe(200);
    const off = createTierOfferTermsHandlers({
      enabled: () => false,
      session: async () => ({ userId: "admin-1", role: "admin" }) as never,
      operations: ops as never,
    });
    expect((await off.POST(post(term))).status).toBe(404);
  });

  it("lists the recorded history for an admin", async () => {
    const { handlers: routes, ops } = handlers();
    ops.list.mockResolvedValue([{ id: "term-1", tierId: "tier-1" }]);

    const response = await routes.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ terms: [{ id: "term-1", tierId: "tier-1" }] });
    expect(ops.list).toHaveBeenCalledWith("admin-1");
  });
});
