import { describe, expect, it, vi } from "vitest";

import type { RouteActor } from "@/app/api/conversations/[id]/claim/handler";

import { createContentScreenHandlers } from "./handler";

const actor: RouteActor = { userId: "coach-1", tenantId: "tenant-1", role: "coach", impersonatingTenant: null, impersonationSessionId: null };
function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn().mockResolvedValue(actor),
    load: vi.fn().mockResolvedValue({ screenId: "screen-1", inputHash: "a".repeat(64), state: "flagged" as const, matches: [{ phrase: "synthetic match", page: "/synthetic" }], coachAcknowledgedAt: null, adminConfirmedAt: null }),
    acknowledge: vi.fn().mockResolvedValue({ auditId: "51", actionKey: "onboarding.content_acknowledged" as const }),
  };
}

describe("onboarding content-screen routes", () => {
  it("reads and acknowledges against the claims tenant", async () => {
    const deps = dependencies();
    expect((await createContentScreenHandlers(deps).GET()).status).toBe(200);
    expect(deps.load).toHaveBeenCalledWith("tenant-1");
    const response = await createContentScreenHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ screenId: "screen-1" }) }));
    expect(response.status).toBe(200);
    expect(deps.acknowledge).toHaveBeenCalledWith({ tenantId: "tenant-1", screenId: "screen-1", actorId: "coach-1" });
  });

  it.each([
    [null, 401],
    [{ ...actor, impersonatingTenant: "tenant-2" }, 403],
    [{ ...actor, role: "coach_member" as const }, 403],
  ])("refuses unauthorized mutation", async (candidate, status) => {
    const deps = dependencies();
    deps.session.mockResolvedValue(candidate);
    const response = await createContentScreenHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: "{}" }));
    expect(response.status).toBe(status);
    expect(deps.acknowledge).not.toHaveBeenCalled();
  });

  it("does not claim a logged action without an audit receipt", async () => {
    const deps = dependencies();
    deps.acknowledge.mockResolvedValue({ auditId: "", actionKey: "onboarding.content_acknowledged" });
    const response = await createContentScreenHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ screenId: "screen-1" }) }));
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toMatch(/database|sql|audit_required/i);
  });
});
