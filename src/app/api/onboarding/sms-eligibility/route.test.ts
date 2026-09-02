import { describe, expect, it, vi } from "vitest";

import { createSmsEligibilityHandlers } from "./handler";

const actor = { userId: "coach-1", tenantId: "tenant-1", role: "coach" as const, impersonatingTenant: null };
function dependencies() {
  return {
    enabled: () => true, session: vi.fn().mockResolvedValue(actor), registration: vi.fn().mockResolvedValue({ submittedAt: "2026-08-20T00:00:00Z", state: "awaiting_provider" }),
    load: vi.fn().mockResolvedValue({ screenId: "screen-1", state: "flagged" as const, matches: [], coachAcknowledgedAt: null, adminConfirmedAt: null }),
    acknowledge: vi.fn().mockResolvedValue({ auditId: "9" }),
  };
}

describe("onboarding sms-eligibility route", () => {
  it("reuses the existing screened-record acknowledgement RPC in the claims tenant", async () => {
    const deps = dependencies();
    const response = await createSmsEligibilityHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ screenId: "screen-1" }) }));
    expect(response.status).toBe(200);
    expect(deps.acknowledge).toHaveBeenCalledWith({ tenantId: "tenant-1", screenId: "screen-1", actorId: "coach-1" });
    await expect(response.json()).resolves.toMatchObject({ receipt: { auditId: "9", actionKey: "onboarding.content_acknowledged" } });
  });

  it("returns the saved carrier filing date without inventing readiness", async () => {
    const deps = dependencies();
    const response = await createSmsEligibilityHandlers(deps).GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ registration: { submittedAt: "2026-08-20T00:00:00Z", state: "awaiting_provider" } });
  });

  it("does not acknowledge from an impersonated session", async () => {
    const deps = dependencies(); deps.session.mockResolvedValue({ ...actor, impersonatingTenant: "tenant-1" });
    const response = await createSmsEligibilityHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ screenId: "screen-1" }) }));
    expect(response.status).toBe(403); expect(deps.acknowledge).not.toHaveBeenCalled();
  });
});
