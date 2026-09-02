import { describe, expect, it, vi } from "vitest";

import type { PlatformActor } from "@/lib/auth/actors";
import type { SignupRepairResult } from "@/lib/onboarding/signup";

import { createSignupRepairHandler, type SignupRepairRouteDependencies } from "./handler";

const AUTH_USER = "00000000-0000-4000-8000-000000000001";
const TENANT = "00000000-0000-4000-8000-000000000002";
const TIER = "00000000-0000-4000-8000-000000000003";
const context = { params: Promise.resolve({ id: AUTH_USER }) };
const admin: PlatformActor = { userId: "00000000-0000-4000-8000-000000000004", role: "admin" };

function request(body: unknown) {
  return new Request(`https://setterfi.test/api/platform/signups/${AUTH_USER}/repair`, {
    method: "POST", body: JSON.stringify(body),
  });
}

function input(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    expectedTenantId: null,
    email: "coach@signup.test",
    fullName: "Synthetic Coach",
    businessName: "Synthetic Business",
    slug: "synthetic-business",
    tierId: TIER,
    timezone: "Asia/Kolkata",
    reason: "Verified the original signup details with the coach.",
    ...overrides,
  };
}

function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn<SignupRepairRouteDependencies["session"]>(async () => admin),
    repair: vi.fn<SignupRepairRouteDependencies["repair"]>(async () => ({
      state: "resumed",
      intentId: "00000000-0000-4000-8000-000000000005",
      tenantId: TENANT,
      auditId: 41,
    })),
  } satisfies SignupRepairRouteDependencies;
}

describe("POST /api/platform/signups/[id]/repair", () => {
  it("keeps the new operator command dark until its rollout gate is enabled", async () => {
    const deps = { ...dependencies(), enabled: () => false };
    expect((await createSignupRepairHandler(deps)(request(input()), context)).status).toBe(404);
    expect(deps.repair).not.toHaveBeenCalled();
  });

  it.each<PlatformActor | null>([null, { ...admin, role: "coach" }, { ...admin, role: "success" }])(
    "allows only owner/admin sessions to repair signup state",
    async (actor) => {
      const deps = dependencies(); deps.session.mockResolvedValue(actor);
      expect((await createSignupRepairHandler(deps)(request(input()), context)).status).toBe(actor ? 403 : 401);
      expect(deps.repair).not.toHaveBeenCalled();
    },
  );

  it("requires exact, reasoned input and refuses an untrusted tenant value", async () => {
    const deps = dependencies();
    for (const body of [input({ reason: "" }), input({ expectedTenantId: "tenant-a" }), { ...input(), referralCode: "INVENTED" }]) {
      expect((await createSignupRepairHandler(deps)(request(body), context)).status).toBe(400);
    }
    expect(deps.repair).not.toHaveBeenCalled();
  });

  it("forwards the path identity and optional expected tenant without consent or provider fields", async () => {
    const deps = dependencies();
    const response = await createSignupRepairHandler(deps)(request(input({ expectedTenantId: TENANT })), context);
    expect(response.status).toBe(200);
    expect(deps.repair).toHaveBeenCalledWith({
      ...input({ expectedTenantId: TENANT }), expectedAuthUserId: AUTH_USER, actorId: admin.userId,
    });
    await expect(response.json()).resolves.toEqual({
      repair: { state: "resumed", intentId: "00000000-0000-4000-8000-000000000005", tenantId: TENANT },
      audit: { id: 41 },
    });
  });

  it("returns a plainly unhealthy repair receipt without masking the recorded reason", async () => {
    const deps = dependencies();
    deps.repair.mockResolvedValue({ state: "cannot_resume", intentId: null, tenantId: null, code: "AUTH_IDENTITY_NOT_FOUND", auditId: 42 });
    const response = await createSignupRepairHandler(deps)(request(input()), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      repair: { state: "cannot_resume", intentId: null, tenantId: null, code: "AUTH_IDENTITY_NOT_FOUND" },
      audit: { id: 42 },
    });
  });

  it("returns an idempotent already-healthy receipt without requesting another tenant", async () => {
    const deps = dependencies();
    deps.repair.mockResolvedValue({
      state: "already_healthy", intentId: "00000000-0000-4000-8000-000000000005", tenantId: TENANT, auditId: 43,
    });
    const response = await createSignupRepairHandler(deps)(request(input({ expectedTenantId: TENANT })), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ repair: { state: "already_healthy", tenantId: TENANT } });
    expect(deps.repair).toHaveBeenCalledTimes(1);
  });
});
