import { describe, expect, it, vi } from "vitest";

import { createA2pRegistrationHandler } from "./handler";

const actor = {
  userId: "coach-1",
  tenantId: "tenant-1",
  role: "coach" as const,
  impersonatingTenant: null,
};

function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn().mockResolvedValue(actor),
    load: vi.fn().mockResolvedValue({
      submittedAt: "2026-08-17T12:00:00.000Z",
      registrationState: "awaiting_provider" as const,
      terminalRejection: false,
      terminalCode: null,
    }),
  };
}

describe("GET /api/onboarding/a2p-registration", () => {
  it("passes the claims-derived tenant into the expected-tenant projection", async () => {
    const deps = dependencies();
    const response = await createA2pRegistrationHandler(deps)();
    expect(response.status).toBe(200);
    expect(deps.load).toHaveBeenCalledWith("tenant-1");
    await expect(response.json()).resolves.toMatchObject({
      registration: {
        registrationState: "awaiting_provider",
        terminalRejection: false,
      },
    });
  });

  it.each([
    [null, 401],
    [{ ...actor, impersonatingTenant: "tenant-1" }, 403],
  ] as const)("refuses unauthorized context before reading", async (candidate, status) => {
    const deps = dependencies();
    deps.session.mockResolvedValue(candidate);
    const response = await createA2pRegistrationHandler(deps)();
    expect(response.status).toBe(status);
    expect(deps.load).not.toHaveBeenCalled();
  });

  it("returns normalized terminal evidence without a retry action", async () => {
    const deps = dependencies();
    deps.load.mockResolvedValue({
      submittedAt: "2026-08-17T12:00:00.000Z",
      registrationState: "blocked",
      terminalRejection: true,
      terminalCode: "CARRIER_TERMINAL",
    });
    const response = await createA2pRegistrationHandler(deps)();
    const payload = await response.json();
    expect(payload.registration).toEqual({
      submittedAt: "2026-08-17T12:00:00.000Z",
      registrationState: "blocked",
      terminalRejection: true,
      terminalCode: "CARRIER_TERMINAL",
    });
    expect(JSON.stringify(payload)).not.toMatch(/retry|provider payload/i);
  });
});
