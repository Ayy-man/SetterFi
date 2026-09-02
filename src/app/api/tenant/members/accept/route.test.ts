import { describe, expect, it, vi } from "vitest";

import { createAcceptTenantMemberHandler } from "./handler";

const actor = { userId: "user-2", role: "affiliate" as const, tenantId: null, impersonatingTenant: null, impersonationSessionId: null };
function dependencies() {
  return {
    enabled: () => true, session: vi.fn().mockResolvedValue(actor),
    accept: vi.fn().mockResolvedValue({ invitationId: "invite-1", tenantId: "tenant-1", membershipId: "member-1", auditId: "11" }),
  };
}

describe("tenant member invitation acceptance", () => {
  it("redeems only for the signed-in recipient and asks the client to refresh claims", async () => {
    const deps = dependencies();
    const response = await createAcceptTenantMemberHandler(deps)(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ token: "opaque-token" }) }));
    expect(response.status).toBe(200);
    expect(deps.accept).toHaveBeenCalledWith({ actorId: "user-2", tokenHash: "84d3f23da9b5f51b3269566eff05d3fb23607eeef89567f9cd280b90ca0dbc5c" });
    await expect(response.json()).resolves.toMatchObject({ sessionRefreshRequired: true, invitation: { membershipId: "member-1" } });
  });

  it.each([[null, 401], [{ ...actor, impersonatingTenant: "tenant-1" }, 403]])("refuses a session that cannot redeem", async (candidate, status) => {
    const deps = dependencies(); deps.session.mockResolvedValue(candidate);
    const response = await createAcceptTenantMemberHandler(deps)(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ token: "opaque-token" }) }));
    expect(response.status).toBe(status); expect(deps.accept).not.toHaveBeenCalled();
  });
});
