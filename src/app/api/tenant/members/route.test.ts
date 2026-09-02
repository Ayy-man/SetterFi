import { describe, expect, it, vi } from "vitest";

import { createTenantMemberHandlers } from "./handler";

const actor = { userId: "coach-1", tenantId: "tenant-1", role: "coach" as const, impersonatingTenant: null, impersonationSessionId: null };

function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn().mockResolvedValue(actor),
    issue: vi.fn().mockReturnValue({ email: "assistant@example.test", role: "coach_member", token: "opaque-token", tokenHash: "a".repeat(64), expiresAt: "2030-01-08T00:00:00.000Z" }),
    save: vi.fn().mockResolvedValue({ id: "invite-1", tenantId: "tenant-1", email: "assistant@example.test", role: "coach_member", expiresAt: "2030-01-08T00:00:00.000Z", audit: { id: "9", actionKey: "tenant.membership.invited" } }),
  };
}

describe("tenant member invitations route", () => {
  it("creates a coach_member-only, claims-scoped invitation and returns its one-time secret once", async () => {
    const deps = dependencies();
    const response = await createTenantMemberHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ email: "Assistant@example.test" }) }));
    expect(response.status).toBe(201);
    expect(deps.save).toHaveBeenCalledWith({ tenantId: "tenant-1", actorId: "coach-1", email: "assistant@example.test", role: "coach_member", tokenHash: "a".repeat(64), expiresAt: "2030-01-08T00:00:00.000Z" });
    await expect(response.json()).resolves.toMatchObject({ invitationToken: "opaque-token", invitation: { audit: { actionKey: "tenant.membership.invited" } } });
  });

  it.each([[null, 401], [{ ...actor, role: "coach_member" as const }, 403], [{ ...actor, impersonatingTenant: "tenant-1" }, 403]])(
    "refuses an unauthorized invitation writer", async (candidate, status) => {
      const deps = dependencies(); deps.session.mockResolvedValue(candidate);
      const response = await createTenantMemberHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ email: "assistant@example.test" }) }));
      expect(response.status).toBe(status); expect(deps.save).not.toHaveBeenCalled();
    },
  );

  it("does not let the client select a higher role or extra persistence fields", async () => {
    const deps = dependencies();
    const response = await createTenantMemberHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ email: "assistant@example.test", role: "coach" }) }));
    expect(response.status).toBe(400); expect(deps.issue).not.toHaveBeenCalled();
  });
});
