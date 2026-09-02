import { describe, expect, it, vi } from "vitest";

import type { PlatformSupportThreadRead } from "@/lib/repositories/support";
import type { SupportSession } from "@/lib/support/service";

import { createPlatformThreadsHandler } from "./handler";

const success: SupportSession = {
  userId: "success-user",
  role: "success",
  tenantId: null,
  impersonatingTenant: null,
};
const thread: PlatformSupportThreadRead = {
  id: "thread-1",
  tenantId: "tenant-1",
  tenantName: "Synthetic Demo Tenant",
  tenantIsDemo: true,
  subject: "Synthetic subject",
  status: "open",
  assignedTo: null,
  successOwner: null,
  isTest: true,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:01:00.000Z",
  messages: [],
};
const request = (query = "") => new Request(
  `https://setterfi.test/api/platform/support/threads${query}`,
);

describe("GET /api/platform/support/threads", () => {
  it("checks the support flag before session or repository construction", async () => {
    const session = vi.fn(async () => success);
    const list = vi.fn(async () => [thread]);
    const response = await createPlatformThreadsHandler({
      enabled: () => false,
      session,
      list,
    })(request());

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(session).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("requires a platform operator and refuses impersonation", async () => {
    const list = vi.fn(async () => [thread]);
    const missing = await createPlatformThreadsHandler({
      enabled: () => true,
      session: async () => null,
      list,
    })(request());
    const coach = await createPlatformThreadsHandler({
      enabled: () => true,
      session: async () => ({ ...success, role: "coach", tenantId: "tenant-1" }),
      list,
    })(request());
    const impersonated = await createPlatformThreadsHandler({
      enabled: () => true,
      session: async () => ({ ...success, impersonatingTenant: "tenant-1" }),
      list,
    })(request());

    expect([missing.status, coach.status, impersonated.status]).toEqual([401, 403, 403]);
    expect(list).not.toHaveBeenCalled();
  });

  it("lets success read all as well as mine and preserves the same audit-free read path", async () => {
    const list = vi.fn(async () => [thread]);
    const handler = createPlatformThreadsHandler({
      enabled: () => true,
      session: async () => success,
      list,
    });

    const mine = await handler(request("?book=mine&status=open"));
    const all = await handler(request("?book=all"));

    expect([mine.status, all.status]).toEqual([200, 200]);
    expect(list.mock.calls).toEqual([
      [success, { book: "mine", status: "open" }],
      [success, { book: "all" }],
    ]);
  });

  it.each(["?book=other", "?status=unknown", "?tenantId=tenant-2", "?role=owner"])(
    "rejects unsupported selector %s before repository work",
    async (query) => {
      const list = vi.fn(async () => [thread]);
      const response = await createPlatformThreadsHandler({
        enabled: () => true,
        session: async () => success,
        list,
      })(request(query));

      expect(response.status).toBe(400);
      expect(list).not.toHaveBeenCalled();
    },
  );
});
