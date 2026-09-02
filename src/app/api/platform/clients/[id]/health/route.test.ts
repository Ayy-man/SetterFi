import { describe, expect, it, vi } from "vitest";

import { TenantHealthDetailError, type TenantHealthDetail } from "@/lib/operations/tenant-health-detail";
import type { SupportSession } from "@/lib/support/service";

import {
  createTenantHealthDetailHandler,
  type TenantHealthDetailRouteDependencies,
} from "./handler";

const owner: SupportSession = {
  userId: "owner-a", role: "owner", tenantId: null, impersonatingTenant: null,
};
const success: SupportSession = { ...owner, userId: "success-a", role: "success" };
const context = { params: Promise.resolve({ id: "tenant-a" }) };
const request = () => new Request("https://setterfi.test/api/platform/clients/tenant-a/health");
const health: TenantHealthDetail = {
  tenantId: "tenant-a",
  state: "indeterminate",
  snapshotDay: null,
  calculatedAt: null,
  signals: [{
    key: "channel", label: "Messaging channel", state: "indeterminate", freshness: "not-measured",
    observedValue: null, threshold: { freshWithinHours: 24 }, observedAt: null,
    staleAfterAt: null, calculatedAt: null, reason: "No observation has been recorded for this signal.",
    action: { availability: "not-available", command: null, endpoint: null, reason: "No implemented client command directly addresses this signal." },
  }],
};

function dependencies(): TenantHealthDetailRouteDependencies {
  return {
    enabled: () => true,
    session: vi.fn<TenantHealthDetailRouteDependencies["session"]>(async () => owner),
    read: vi.fn<TenantHealthDetailRouteDependencies["read"]>(async () => health),
  };
}

describe("GET /api/platform/clients/[id]/health", () => {
  it("checks the support flag before authentication or the health read", async () => {
    const deps = dependencies();
    deps.enabled = () => false;
    const response = await createTenantHealthDetailHandler(deps)(request(), context);

    expect(response.status).toBe(404);
    expect(deps.session).not.toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();
  });

  it("refuses missing, non-platform, and impersonated sessions before a tenant read", async () => {
    for (const session of [
      null,
      { ...owner, role: "coach" as const, tenantId: "tenant-a" },
      { ...owner, impersonatingTenant: "tenant-a" },
    ]) {
      const deps = dependencies();
      (deps.session as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      const response = await createTenantHealthDetailHandler(deps)(request(), context);
      expect(response.status).toBe(session ? 403 : 401);
      expect(deps.read).not.toHaveBeenCalled();
    }
  });

  it("uses the path tenant and returns evidence without triggering a recompute", async () => {
    const deps = dependencies();
    const response = await createTenantHealthDetailHandler(deps)(request(), context);

    expect(response.status).toBe(200);
    expect(deps.read).toHaveBeenCalledTimes(1);
    expect(deps.read).toHaveBeenCalledWith({ expectedTenant: "tenant-a", actorId: "owner-a" });
    await expect(response.json()).resolves.toEqual({ health });
  });

  it("refuses a success owner outside their assigned book without leaking the client", async () => {
    const deps = dependencies();
    (deps.session as ReturnType<typeof vi.fn>).mockResolvedValue(success);
    (deps.read as ReturnType<typeof vi.fn>).mockRejectedValue(new TenantHealthDetailError("ACCESS_REFUSED"));
    const response = await createTenantHealthDetailHandler(deps)(request(), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Client health was not found." });
    expect(deps.read).toHaveBeenCalledWith({ expectedTenant: "tenant-a", actorId: "success-a" });
  });

  it("reports an invalid read-back as unavailable rather than emitting a false health state", async () => {
    const deps = dependencies();
    (deps.read as ReturnType<typeof vi.fn>).mockResolvedValue({ ...health, tenantId: "tenant-b" });
    const response = await createTenantHealthDetailHandler(deps)(request(), context);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Client health is temporarily unavailable." });
  });
});
