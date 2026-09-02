import { describe, expect, it, vi } from "vitest";

import { resolveActiveTenant } from "./active-tenant";

const claims = { userId: "user-a", tenantId: "tenant-a" };

describe("resolveActiveTenant", () => {
  it("keeps a single-workspace claim byte-for-byte when no durable choice exists", async () => {
    const loadSelection = vi.fn().mockResolvedValue(null);

    await expect(resolveActiveTenant(claims, { enabled: () => true, loadSelection })).resolves.toBe(claims.tenantId);
    expect(loadSelection).toHaveBeenCalledWith({ actorId: "user-a", claimTenantId: "tenant-a" });
  });

  it("uses an eligible durable selection when membership switching is live", async () => {
    await expect(resolveActiveTenant(claims, {
      enabled: () => true,
      loadSelection: async () => "tenant-b",
    })).resolves.toBe("tenant-b");
  });

  it("does not read a durable choice while the rollout gate is off", async () => {
    const loadSelection = vi.fn();

    await expect(resolveActiveTenant(claims, { enabled: () => false, loadSelection })).resolves.toBe("tenant-a");
    expect(loadSelection).not.toHaveBeenCalled();
  });
});
