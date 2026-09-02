import { describe, expect, it, vi } from "vitest";

import type { SupportSession } from "@/lib/support/service";

import { createSuccessOwnerHandler } from "./handler";

const admin: SupportSession = {
  userId: "admin-user",
  role: "admin",
  tenantId: null,
  impersonatingTenant: null,
};
const context = { params: Promise.resolve({ id: "tenant-1" }) };
const request = (body: unknown) => new Request(
  "https://setterfi.test/api/platform/clients/tenant-1/success-owner",
  { method: "POST", body: JSON.stringify(body) },
);
const receipt = {
  tenantId: "tenant-1",
  successOwner: "success-user",
  auditId: 41,
  state: "Reassigned" as const,
};

describe("POST /api/platform/clients/[id]/success-owner", () => {
  it("checks the support flag before session or reassignment work", async () => {
    const session = vi.fn(async () => admin);
    const reassign = vi.fn(async () => receipt);
    const response = await createSuccessOwnerHandler({
      enabled: () => false,
      session,
      reassign,
    })(request({ assigneeId: "success-user", reason: "Synthetic reason" }), context);

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(session).not.toHaveBeenCalled();
    expect(reassign).not.toHaveBeenCalled();
  });

  it("refuses missing, non-platform and impersonated sessions before parsing the mutation", async () => {
    const reassign = vi.fn(async () => receipt);
    const sessions: Array<SupportSession | null> = [
      null,
      { ...admin, role: "coach", tenantId: "tenant-1" },
      { ...admin, role: "build" },
      { ...admin, impersonatingTenant: "tenant-1" },
    ];
    const statuses = [];
    for (const session of sessions) {
      const response = await createSuccessOwnerHandler({
        enabled: () => true,
        session: async () => session,
        reassign,
      })(request({ assigneeId: "success-user", reason: "Synthetic reason" }), context);
      statuses.push(response.status);
    }

    expect(statuses).toEqual([401, 403, 403, 403]);
    expect(reassign).not.toHaveBeenCalled();
  });

  it.each(["tenant_id", "actor_id", "role", "internal"])(
    "rejects body-supplied %s instead of forwarding authority",
    async (forged) => {
      const reassign = vi.fn(async () => receipt);
      const response = await createSuccessOwnerHandler({
        enabled: () => true,
        session: async () => admin,
        reassign,
      })(request({
        assigneeId: "success-user",
        reason: "Synthetic reason",
        [forged]: "forged",
      }), context);

      expect(response.status).toBe(400);
      expect(reassign).not.toHaveBeenCalled();
    },
  );

  it("lets success self-take only and lets admin assign an eligible success user", async () => {
    const reassign = vi.fn(async () => receipt);
    const success = { ...admin, userId: "success-user", role: "success" as const };
    const handler = (session: SupportSession) => createSuccessOwnerHandler({
      enabled: () => true,
      session: async () => session,
      reassign,
    });

    const denied = await handler(success)(request({
      assigneeId: "different-success-user",
      reason: "Synthetic reason",
    }), context);
    const selfTake = await handler(success)(request({
      assigneeId: "success-user",
      reason: "Synthetic reason",
    }), context);
    const assigned = await handler(admin)(request({
      assigneeId: "success-user",
      reason: "Synthetic reason",
    }), context);

    expect([denied.status, selfTake.status, assigned.status]).toEqual([403, 200, 200]);
    expect(reassign.mock.calls).toEqual([
      [success, {
        expectedTenant: "tenant-1",
        assigneeId: "success-user",
        reason: "Synthetic reason",
      }],
      [admin, {
        expectedTenant: "tenant-1",
        assigneeId: "success-user",
        reason: "Synthetic reason",
      }],
    ]);
  });

  it("renders Reassigned only with exact tenant, assignee and persisted audit receipt", async () => {
    const accepted = await createSuccessOwnerHandler({
      enabled: () => true,
      session: async () => admin,
      reassign: async () => receipt,
    })(request({ assigneeId: "success-user", reason: "Synthetic reason" }), context);
    const mismatched = await createSuccessOwnerHandler({
      enabled: () => true,
      session: async () => admin,
      reassign: async () => ({ ...receipt, auditId: 0 }),
    })(request({ assigneeId: "success-user", reason: "Synthetic reason" }), context);

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({
      state: "Reassigned",
      tenantId: "tenant-1",
      successOwner: "success-user",
      audit: { id: 41, actionKey: "tenant.success_owner.reassigned" },
    });
    expect(mismatched.status).toBe(409);
    await expect(mismatched.json()).resolves.toEqual({ error: "Reassignment was refused." });
  });
});
