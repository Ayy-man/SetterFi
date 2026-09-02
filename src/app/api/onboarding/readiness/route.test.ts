import { afterEach, describe, expect, it, vi } from "vitest";

import type { RouteActor } from "@/app/api/conversations/[id]/claim/handler";
import { READINESS_KEYS, type ReadinessResult } from "@/lib/onboarding/contracts";

import { createOfferReadinessPort, createReadinessHandler } from "./handler";

const actor: RouteActor = { userId: "coach-1", tenantId: "tenant-1", role: "coach", impersonatingTenant: null, impersonationSessionId: null };
const codes = [
  "tenant_activation_eligible",
  "messaging_channel_required",
  "primary_calendar_unhealthy",
  "offer_review_contract_unavailable",
  "platform_brain_publish_pending",
  "test_pass_required",
  "subscription_contract_unavailable",
] as const;
const readiness: ReadinessResult = {
  ready: false,
  checks: READINESS_KEYS.map((key, index) => ({ key, ready: false, code: codes[index], evidenceAt: null, blamingParty: "platform" })),
};

describe("GET /api/onboarding/readiness", () => {
  it("preserves every named readiness refusal and tenant binding", async () => {
    const evaluate = vi.fn().mockResolvedValue(readiness);
    const response = await createReadinessHandler({ enabled: () => true, session: vi.fn().mockResolvedValue(actor), evaluate })();
    expect(evaluate).toHaveBeenCalledWith("tenant-1");
    await expect(response.json()).resolves.toEqual({ readiness });
  });

  it.each([[null, 401], [{ ...actor, impersonatingTenant: "tenant-2" }, 403]])("refuses invalid sessions", async (candidate, status) => {
    const evaluate = vi.fn();
    const response = await createReadinessHandler({ enabled: () => true, session: vi.fn().mockResolvedValue(candidate), evaluate })();
    expect(response.status).toBe(status);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("hides raw readiness errors", async () => {
    const response = await createReadinessHandler({ enabled: () => true, session: vi.fn().mockResolvedValue(actor), evaluate: vi.fn().mockRejectedValue(new Error("SQL provider detail")) })();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/sql|provider/i);
  });
});

describe("offer and billing readiness wiring", () => {
  const review = {
    offer: {
      tenantId: "tenant-1",
      offerId: "offer-1",
      version: 3,
      contentHash: "a".repeat(64),
      programName: "Synthetic offer",
      bookingMode: "direct",
      updatedAt: "2026-08-30T12:00:00.000Z",
    },
    status: "clear" as const,
    evidenceAt: "2026-08-30T12:04:00.000Z",
  };

  it("permits a real tenant only from a current clear decision and uses its timestamp as audit provenance", async () => {
    const port = createOfferReadinessPort({ loadTenantDemo: async () => false, loadReview: async () => review });
    await expect(port("tenant-1")).resolves.toEqual({
      published: true,
      programName: "Synthetic offer",
      bookingMode: "direct",
      reviewState: "clear",
      evidenceAt: "2026-08-30T12:04:00.000Z",
    });
  });

  it.each(["unreviewed", "rejected"] as const)("holds a real %s offer rather than reporting clear", async (status) => {
    const port = createOfferReadinessPort({
      loadTenantDemo: async () => false,
      loadReview: async () => ({ ...review, status, evidenceAt: null }),
    });
    await expect(port("tenant-1")).resolves.toMatchObject({ reviewState: "held", evidenceAt: null });
  });

  it("keeps the seeded demo behavior synthetic while retaining its publication timestamp", async () => {
    const port = createOfferReadinessPort({ loadTenantDemo: async () => true, loadReview: async () => review });
    await expect(port("tenant-1")).resolves.toMatchObject({
      reviewState: "clear",
      evidenceAt: "2026-08-30T12:00:00.000Z",
    });
  });
});

describe("readiness and go-live judge a tenant on the same evidence", () => {
  // These two routes drifted once: the GET installed the real Phase 6 subscription port while the
  // go-live POST installed only the demo one, so a paid coach whose subscription had genuinely
  // cleared was shown "ready" and then refused at the commit. The ports are now built by one
  // factory, and this fails if a caller starts wiring its own again.
  const stubClient = () => vi.doMock("@/lib/supabase/server", () => ({
    createSupabaseServiceClient: () => ({ from: () => ({}), rpc: async () => ({ data: null, error: null }) }),
  }));

  async function evidenceWithPhase6(phase6: boolean) {
    vi.resetModules();
    stubClient();
    vi.doMock("@/lib/env-contract", () => ({ phase5Live: () => true, phase6StripeLive: () => phase6 }));
    const route = await import("./handler");
    return route.createReadinessEvidence();
  }

  afterEach(() => {
    vi.doUnmock("@/lib/env-contract");
    vi.doUnmock("@/lib/supabase/server");
    vi.resetModules();
  });

  it("offers the real subscription port only under the Phase 6 gate", async () => {
    expect((await evidenceWithPhase6(true)).subscriptionReadiness).toBeDefined();
    expect((await evidenceWithPhase6(false)).subscriptionReadiness).toBeUndefined();
  });

  it("commits go-live on the evidence the shared factory built, not its own ports", async () => {
    vi.resetModules();
    stubClient();
    // A sentinel the go-live route cannot produce by wiring ports itself. If it ever goes back to
    // restating its own evidence, commitGoLive receives something else and this fails.
    const evidence = { sentinel: "shared-readiness-evidence" };
    const commitGoLive = vi.fn().mockResolvedValue({
      kind: "live",
      readiness: { ready: true, checks: [] },
      receipt: { tenantId: "tenant-1", auditId: "9", wentLiveAt: "2030-01-01T00:00:00.000Z" },
    });
    vi.doMock("./handler", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./handler")>()),
      createReadinessEvidence: () => evidence,
    }));
    vi.doMock("@/lib/onboarding/readiness", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/onboarding/readiness")>()),
      commitGoLive,
    }));
    vi.doMock("@/lib/auth/actors", () => ({
      loadRouteActor: async () => ({ userId: "coach-1", tenantId: "tenant-1", role: "coach" }),
    }));
    vi.doMock("@/lib/env-contract", () => ({ phase5Live: () => true, phase6StripeLive: () => true }));

    const goLive = await import("../go-live/route");
    const response = await goLive.POST();

    expect(response.status).toBe(200);
    expect(commitGoLive).toHaveBeenCalledWith({ tenantId: "tenant-1", actorId: "coach-1" }, evidence);
    vi.doUnmock("./handler");
    vi.doUnmock("@/lib/onboarding/readiness");
    vi.doUnmock("@/lib/auth/actors");
  });
});
