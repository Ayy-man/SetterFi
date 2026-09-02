import { describe, expect, it, vi } from "vitest";

import type { SuccessClientBookRead } from "@/lib/repositories/support";
import type { SupportSession } from "@/lib/support/service";

import { createClientBookHandler } from "./handler";

const success: SupportSession = {
  userId: "success-user",
  role: "success",
  tenantId: null,
  impersonatingTenant: null,
};
const client: SuccessClientBookRead = {
  client: { id: "tenant-1", name: "Synthetic Demo Tenant", isDemo: true },
  status: "active",
  successOwner: { id: "success-user", name: "Synthetic Success" },
  supportStatus: "open",
  planId: "tier-growth",
  planLabel: "Growth",
  updatedAt: "2026-08-18T00:01:00.000Z",
};
const request = (query = "") => new Request(
  `https://setterfi.test/api/platform/clients${query}`,
);

describe("GET /api/platform/clients", () => {
  it("checks the support flag before session or book reads", async () => {
    const session = vi.fn(async () => success);
    const list = vi.fn(async () => [client]);
    const response = await createClientBookHandler({ enabled: () => false, session, list })(request());

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(session).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("lets every platform operator read mine or all but refuses build, coach and impersonation", async () => {
    const list = vi.fn(async () => [client]);
    const roles = ["owner", "admin", "success"] as const;
    for (const role of roles) {
      const response = await createClientBookHandler({
        enabled: () => true,
        session: async () => ({ ...success, role }),
        list,
      })(request("?book=all"));
      expect(response.status).toBe(200);
    }
    for (const session of [
      { ...success, role: "build" as const },
      { ...success, role: "coach" as const, tenantId: "tenant-1" },
      { ...success, impersonatingTenant: "tenant-1" },
    ]) {
      const response = await createClientBookHandler({
        enabled: () => true,
        session: async () => session,
        list,
      })(request("?book=mine"));
      expect(response.status).toBe(403);
    }
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("defaults to mine, permits all, and rejects scope-like selectors", async () => {
    const list = vi.fn(async () => [client]);
    const handler = createClientBookHandler({
      enabled: () => true,
      session: async () => success,
      list,
    });

    expect((await handler(request())).status).toBe(200);
    expect((await handler(request("?book=all"))).status).toBe(200);
    expect((await handler(request("?tenantId=tenant-2"))).status).toBe(400);
    expect((await handler(request("?book=other"))).status).toBe(400);
    expect(list.mock.calls).toEqual([[success, "mine"], [success, "all"]]);
  });

  it("returns the exact client/status/owner/support/plan/updated projection", async () => {
    const response = await createClientBookHandler({
      enabled: () => true,
      session: async () => success,
      list: async () => [client],
    })(request());
    const payload = await response.json() as { clients: Array<Record<string, unknown>> };

    expect(payload).toEqual({ clients: [client] });
    expect(Object.keys(payload.clients[0]).sort()).toEqual([
      "client", "planId", "planLabel", "status", "successOwner", "supportStatus", "updatedAt",
    ]);
  });
});
