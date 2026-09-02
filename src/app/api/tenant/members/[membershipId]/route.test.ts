import { describe, expect, it, vi } from "vitest";

import { createRevokeTenantMemberHandler } from "./handler";

const actor = { userId: "coach-1", tenantId: "tenant-1", role: "coach" as const, impersonatingTenant: null, impersonationSessionId: null };
const membershipId = "ef5c5215-8cf0-43cb-8d70-8d4b072aac8d";

describe("tenant member revocation", () => {
  it("revokes the database membership before ending all recipient sessions", async () => {
    const dependencies = { enabled: () => true, session: vi.fn().mockResolvedValue(actor), revoke: vi.fn().mockResolvedValue({ membershipId, userId: "member-user", auditId: "12" }), revokeSessions: vi.fn().mockResolvedValue(undefined) };
    const response = await createRevokeTenantMemberHandler(dependencies)(new Request("https://setterfi.test", { method: "DELETE" }), { params: Promise.resolve({ membershipId }) });
    expect(response.status).toBe(200);
    expect(dependencies.revoke).toHaveBeenCalledWith({ tenantId: "tenant-1", actorId: "coach-1", membershipId });
    expect(dependencies.revokeSessions).toHaveBeenCalledWith("member-user");
  });

  it("rejects malformed membership identifiers before any write", async () => {
    const dependencies = { enabled: () => true, session: vi.fn().mockResolvedValue(actor), revoke: vi.fn(), revokeSessions: vi.fn() };
    const response = await createRevokeTenantMemberHandler(dependencies)(new Request("https://setterfi.test", { method: "DELETE" }), { params: Promise.resolve({ membershipId: "other-tenant" }) });
    expect(response.status).toBe(400); expect(dependencies.revoke).not.toHaveBeenCalled();
  });
});
