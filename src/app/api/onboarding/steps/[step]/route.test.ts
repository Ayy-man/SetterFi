import { describe, expect, it, vi } from "vitest";

import type { RouteActor } from "@/app/api/conversations/[id]/claim/handler";

import { createStepActionHandler } from "./handler";

const actor: RouteActor = { userId: "coach-1", tenantId: "tenant-1", role: "coach", impersonatingTenant: null, impersonationSessionId: null };
function request(input: Record<string, unknown> = {}) {
  return new Request("https://setterfi.test/api/onboarding/steps/meta_connect", { method: "POST", headers: { origin: "https://setterfi.test", cookie: "synthetic=session" }, body: JSON.stringify({ action: "start", input }) });
}
function context(step: string) { return { params: Promise.resolve({ step }) }; }
function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn().mockResolvedValue(actor),
    meta: vi.fn().mockResolvedValue(Response.json({ state: "connecting" }, { status: 201 })),
    whatsapp: vi.fn().mockResolvedValue(Response.json({ state: "ready" }, { status: 202 })),
  };
}

describe("POST /api/onboarding/steps/[step]", () => {
  it.each(["ghl_location", "a2p_brand", "test_pass"])("forbids coach action on %s", async (step) => {
    const deps = dependencies();
    const response = await createStepActionHandler(deps)(request(), context(step));
    expect(response.status).toBe(403);
    expect(deps.meta).not.toHaveBeenCalled();
  });

  it("delegates Meta input to the Phase 4 route without accepting a tenant id", async () => {
    const deps = dependencies();
    const response = await createStepActionHandler(deps)(request({ channel: "instagram", returnPath: "/onboarding" }), context("meta_connect"));
    expect(response.status).toBe(201);
    const delegated = deps.meta.mock.calls[0][0] as Request;
    expect(delegated.url).toBe("https://setterfi.test/api/channels/meta/connect");
    await expect(delegated.json()).resolves.toEqual({ channel: "instagram", returnPath: "/onboarding" });
  });

  it("delegates WhatsApp to its Phase 4 owner route", async () => {
    const deps = dependencies();
    const response = await createStepActionHandler(deps)(request({ code: "synthetic", wabaId: "waba", phoneNumberId: "phone" }), context("whatsapp_connect"));
    expect(response.status).toBe(202);
    expect(deps.whatsapp).toHaveBeenCalledOnce();
  });

  it("sends offer setup to the existing coach agent editor", async () => {
    const deps = dependencies();
    const response = await createStepActionHandler(deps)(request(), context("offer_layer"));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      step: "offer_layer",
      state: "action_required",
      actionTarget: "/coach/agent",
    });
  });

  it.each([
    ["meta_connect", "meta", "PHASE4_META_CONNECT_SEAM_MISSING"],
    ["whatsapp_connect", "whatsapp", "PHASE4_WHATSAPP_CONNECT_SEAM_MISSING"],
  ] as const)("fails loudly when %s seam is absent", async (step, dependency, code) => {
    const deps = { ...dependencies(), [dependency]: null };
    const response = await createStepActionHandler(deps)(request(), context(step));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code });
  });

  it.each([[null, 401], [{ ...actor, impersonatingTenant: "tenant-2" }, 403], [{ ...actor, role: "coach_member" as const }, 403]])("refuses unauthorized sessions", async (candidate, status) => {
    const deps = dependencies();
    deps.session.mockResolvedValue(candidate);
    const response = await createStepActionHandler(deps)(request(), context("meta_connect"));
    expect(response.status).toBe(status);
    expect(deps.meta).not.toHaveBeenCalled();
  });
});
