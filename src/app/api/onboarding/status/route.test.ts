import { describe, expect, it, vi } from "vitest";

import { createSignupStatusHandler } from "./handler";

function dependencies() {
  return {
    enabled: () => true,
    authenticated: vi.fn().mockResolvedValue(true),
    load: vi.fn().mockResolvedValue({
      intentId: "intent-1",
      state: "started" as const,
      tenantId: null,
      errorCode: null,
    }),
  };
}

describe("GET /api/onboarding/status", () => {
  it("returns only the caller-derived intent projection", async () => {
    const response = await createSignupStatusHandler(dependencies())();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      intent: {
        intentId: "intent-1",
        state: "started",
        tenantId: null,
        errorCode: null,
      },
    });
  });

  it("refuses an unauthenticated caller before the projection query", async () => {
    const deps = dependencies();
    deps.authenticated.mockResolvedValue(false);
    const response = await createSignupStatusHandler(deps)();
    expect(response.status).toBe(401);
    expect(deps.load).not.toHaveBeenCalled();
  });

  it("returns null for an authenticated account outside onboarding", async () => {
    const deps = dependencies();
    deps.load.mockResolvedValue(null);
    const response = await createSignupStatusHandler(deps)();
    await expect(response.json()).resolves.toEqual({ intent: null });
  });
});
