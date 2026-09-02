import { describe, expect, it, vi } from "vitest";

import { createActiveTenantHandlers } from "./handler";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const actor = { userId: "member-a", tenantId: tenantA, role: "coach_member" as const, impersonatingTenant: null, impersonationSessionId: null };

function dependencies() {
  return {
    enabled: vi.fn(() => true),
    session: vi.fn().mockResolvedValue(actor),
    list: vi.fn().mockResolvedValue([
      { id: tenantA, name: "Workspace A", active: false },
      { id: tenantB, name: "Workspace B", active: true },
    ]),
    select: vi.fn().mockResolvedValue({ tenantId: tenantB, auditId: "19" }),
  };
}

function post(body: unknown) {
  return new Request("https://setterfi.test/api/tenant/active", { method: "POST", body: JSON.stringify(body) });
}

describe("active tenant route", () => {
  it("returns only the server-authorized workspace list and its durable active choice", async () => {
    const deps = dependencies();
    const response = await createActiveTenantHandlers(deps).GET();

    expect(response.status).toBe(200);
    expect(deps.list).toHaveBeenCalledWith({ actorId: "member-a", claimTenantId: tenantA });
    await expect(response.json()).resolves.toEqual({
      workspaces: [
        { id: tenantA, name: "Workspace A", active: false },
        { id: tenantB, name: "Workspace B", active: true },
      ],
      activeTenantId: tenantB,
    });
  });

  it("switches only to an exact workspace id and returns the auditable receipt", async () => {
    const deps = dependencies();
    const response = await createActiveTenantHandlers(deps).POST(post({ tenantId: tenantB }));

    expect(response.status).toBe(200);
    expect(deps.select).toHaveBeenCalledWith({ actorId: "member-a", claimTenantId: tenantA, tenantId: tenantB });
    await expect(response.json()).resolves.toEqual({
      activeTenantId: tenantB,
      audit: { id: "19", actionKey: "tenant.membership.switched" },
    });
  });

  it.each([
    [false, actor, 404],
    [true, null, 401],
    [true, { ...actor, role: "affiliate" as const }, 403],
    [true, { ...actor, impersonatingTenant: tenantA }, 403],
  ])("refuses a disabled, anonymous, non-member, or impersonated switcher", async (enabled, candidate, status) => {
    const deps = dependencies(); deps.enabled.mockReturnValue(enabled); deps.session.mockResolvedValue(candidate);
    const response = await createActiveTenantHandlers(deps).POST(post({ tenantId: tenantB }));
    expect(response.status).toBe(status); expect(deps.select).not.toHaveBeenCalled();
  });

  it("does not accept a client-supplied actor or any extra tenant data", async () => {
    const deps = dependencies();
    const response = await createActiveTenantHandlers(deps).POST(post({ tenantId: tenantB, actorId: "another-user" }));
    expect(response.status).toBe(400); expect(deps.select).not.toHaveBeenCalled();
  });
});
