import { describe, expect, it, vi } from "vitest";

import type { CoachSupportThreadRead } from "@/lib/repositories/support";
import type { SupportSession } from "@/lib/support/service";

import { createCoachThreadsHandlers } from "./handler";

const coach: SupportSession = {
  userId: "coach-user",
  role: "coach",
  tenantId: "tenant-1",
  impersonatingTenant: null,
};
const thread: CoachSupportThreadRead = {
  id: "thread-persisted",
  tenantId: "tenant-1",
  subject: "Persisted synthetic subject",
  status: "open",
  assignedTo: null,
  isTest: true,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:01:00.000Z",
  messages: [{
    id: "message-persisted",
    authorId: "coach-user",
    authorName: "Synthetic Coach",
    body: "Persisted synthetic body",
    isTest: true,
    createdAt: "2026-08-18T00:01:00.000Z",
  }],
};

function request(body: unknown) {
  return new Request("https://setterfi.test/api/support/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function expectNoStore(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

describe("/api/support/threads", () => {
  it("checks the Phase 8 support flag before constructing a session or reading data", async () => {
    const session = vi.fn(async () => coach);
    const list = vi.fn(async () => [thread]);
    const create = vi.fn(async () => thread);
    const handlers = createCoachThreadsHandlers({ enabled: () => false, session, list, create });

    const [get, post] = await Promise.all([handlers.GET(), handlers.POST(request({}))]);

    expect([get.status, post.status]).toEqual([404, 404]);
    expectNoStore(get);
    expectNoStore(post);
    expect(session).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("requires a non-impersonated coach session for list and create", async () => {
    const list = vi.fn(async () => [thread]);
    const create = vi.fn(async () => thread);
    const missing = createCoachThreadsHandlers({
      enabled: () => true,
      session: async () => null,
      list,
      create,
    });
    const platform = createCoachThreadsHandlers({
      enabled: () => true,
      session: async () => ({ ...coach, role: "admin", tenantId: null }),
      list,
      create,
    });
    const impersonated = createCoachThreadsHandlers({
      enabled: () => true,
      session: async () => ({ ...coach, impersonatingTenant: "tenant-1" }),
      list,
      create,
    });

    expect((await missing.GET()).status).toBe(401);
    expect((await platform.GET()).status).toBe(403);
    expect((await impersonated.POST(request({ subject: "S", body: "B" }))).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["tenant_id", "author_id", "internal", "role"])(
    "rejects body-supplied %s instead of forwarding scope or authority",
    async (forged) => {
      const create = vi.fn(async () => thread);
      const handlers = createCoachThreadsHandlers({
        enabled: () => true,
        session: async () => coach,
        list: async () => [thread],
        create,
      });
      const response = await handlers.POST(request({
        subject: "Synthetic subject",
        body: "Synthetic body",
        [forged]: forged === "internal" ? true : "forged",
      }));

      expect(response.status).toBe(400);
      expectNoStore(response);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("returns repository projections and the persisted created row rather than the request", async () => {
    const list = vi.fn(async () => [thread]);
    const create = vi.fn(async () => thread);
    const handlers = createCoachThreadsHandlers({
      enabled: () => true,
      session: async () => coach,
      list,
      create,
    });

    const get = await handlers.GET();
    const post = await handlers.POST(request({
      subject: "Request subject",
      body: "Request body",
    }));

    expect(get.status).toBe(200);
    expect(post.status).toBe(201);
    expectNoStore(get);
    expectNoStore(post);
    await expect(get.json()).resolves.toEqual({ threads: [thread] });
    await expect(post.json()).resolves.toEqual({ thread });
    expect(create).toHaveBeenCalledWith(coach, {
      subject: "Request subject",
      body: "Request body",
    });
  });
});
