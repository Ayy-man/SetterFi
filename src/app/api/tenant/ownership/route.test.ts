import { describe, expect, it, vi } from "vitest";

import { createTenantOwnershipHandlers } from "./handler";

const owner = { userId: "owner-a", tenantId: "tenant-a", role: "coach" as const, impersonatingTenant: null, impersonationSessionId: null };
const teammate = { userId: "member-a", tenantId: "tenant-a", role: "coach_member" as const, impersonatingTenant: null, impersonationSessionId: null };
const membershipId = "11111111-1111-4111-8111-111111111111";
const offerId = "22222222-2222-4222-8222-222222222222";

const pendingOffer = { id: offerId, tenantId: "tenant-a", recipientUserId: "member-a", status: "pending" as const, expiresAt: "2030-01-08T00:00:00.000Z", auditId: "9" };

function dependencies() {
  return {
    enabled: vi.fn(() => true),
    session: vi.fn().mockResolvedValue(owner),
    list: vi.fn().mockResolvedValue([pendingOffer]),
    offer: vi.fn().mockResolvedValue(pendingOffer),
    accept: vi.fn().mockResolvedValue({ ...pendingOffer, status: "accepted" as const, auditId: "10" }),
    revoke: vi.fn().mockResolvedValue({ ...pendingOffer, status: "revoked" as const, auditId: "11" }),
  };
}

function post(body: unknown) {
  return new Request("https://setterfi.test/api/tenant/ownership", { method: "POST", body: JSON.stringify(body) });
}

describe("tenant ownership route", () => {
  it("offers ownership only through the owner claims scope and returns the auditable pending state", async () => {
    const deps = dependencies();
    const response = await createTenantOwnershipHandlers(deps).POST(post({ action: "offer", recipientMembershipId: membershipId }));
    expect(response.status).toBe(201);
    expect(deps.offer).toHaveBeenCalledWith({ tenantId: "tenant-a", actorId: "owner-a", recipientMembershipId: membershipId });
    await expect(response.json()).resolves.toMatchObject({ offer: { status: "pending", auditId: "9" } });
  });

  it("allows only an active teammate-shaped session to accept and routes the acceptance to its claims tenant", async () => {
    const deps = dependencies(); deps.session.mockResolvedValue(teammate);
    const response = await createTenantOwnershipHandlers(deps).POST(post({ action: "accept", offerId }));
    expect(response.status).toBe(200);
    expect(deps.accept).toHaveBeenCalledWith({ tenantId: "tenant-a", actorId: "member-a", offerId });
    await expect(response.json()).resolves.toMatchObject({ offer: { status: "accepted", auditId: "10" } });
  });

  it("does not let a client select another tenant for offer, acceptance, revocation, or reads", async () => {
    const deps = dependencies();
    const handlers = createTenantOwnershipHandlers(deps);
    expect((await handlers.POST(post({ action: "offer", recipientMembershipId: membershipId, tenantId: "tenant-b" }))).status).toBe(400);
    expect(deps.offer).not.toHaveBeenCalled();

    deps.session.mockResolvedValue(teammate);
    expect((await handlers.POST(post({ action: "accept", offerId, tenantId: "tenant-b" }))).status).toBe(400);
    expect(deps.accept).not.toHaveBeenCalled();

    deps.session.mockResolvedValue(owner);
    expect((await handlers.POST(post({ action: "revoke", offerId, tenantId: "tenant-b" }))).status).toBe(400);
    expect(deps.revoke).not.toHaveBeenCalled();
    expect((await handlers.GET()).status).toBe(200);
    expect(deps.list).toHaveBeenCalledWith({ tenantId: "tenant-a", actorId: "owner-a" });
  });

  it.each([[false, owner, 404], [true, null, 401], [true, { ...owner, role: "coach_member" as const }, 403], [true, { ...owner, impersonatingTenant: "tenant-a" }, 403]])(
    "refuses a disabled, anonymous, non-owner, or impersonated offer writer", async (enabled, actor, status) => {
      const deps = dependencies(); deps.enabled.mockReturnValue(enabled); deps.session.mockResolvedValue(actor);
      const response = await createTenantOwnershipHandlers(deps).POST(post({ action: "offer", recipientMembershipId: membershipId }));
      expect(response.status).toBe(status); expect(deps.offer).not.toHaveBeenCalled();
    },
  );
});
