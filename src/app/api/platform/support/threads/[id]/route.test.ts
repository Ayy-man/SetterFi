import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { PlatformSupportThreadRead } from "@/lib/repositories/support";
import type { SupportSession } from "@/lib/support/service";

import { createPlatformThreadHandlers } from "./handler";

const admin: SupportSession = {
  userId: "admin-user",
  role: "admin",
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
const context = { params: Promise.resolve({ id: "thread-1" }) };
const getRequest = () => new Request("https://setterfi.test/api/platform/support/threads/thread-1");
const postRequest = (body: unknown) => new Request(
  "https://setterfi.test/api/platform/support/threads/thread-1",
  { method: "POST", body: JSON.stringify(body) },
);
const patchRequest = (body: unknown) => new Request(
  "https://setterfi.test/api/platform/support/threads/thread-1",
  { method: "PATCH", body: JSON.stringify(body) },
);
const statusReceipt = {
  threadId: "thread-1", tenantId: "tenant-1", status: "open" as const, auditId: 42,
  actionKey: "support.thread.status.changed" as const,
  microcopy: "Thread status change logged" as const,
};
const assignmentReceipt = {
  threadId: "thread-1", tenantId: "tenant-1", assigneeId: "success-user", auditId: 43,
  actionKey: "support.thread.assignment.changed" as const,
  microcopy: "Thread assignment logged" as const,
};

describe("/api/platform/support/threads/[id]", () => {
  it("checks the flag before session, detail, or append work", async () => {
    const session = vi.fn(async () => admin);
    const get = vi.fn(async () => thread);
    const append = vi.fn(async () => thread);
    const handlers = createPlatformThreadHandlers({ enabled: () => false, session, get, append });

    const [detail, reply] = await Promise.all([
      handlers.GET(getRequest(), context),
      handlers.POST(postRequest({ kind: "reply", body: "Synthetic reply" }), context),
    ]);

    expect([detail.status, reply.status]).toEqual([404, 404]);
    expect(session).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("refuses missing, coach, build and impersonated sessions before a support read", async () => {
    const get = vi.fn(async () => thread);
    const append = vi.fn(async () => thread);
    const sessions: Array<SupportSession | null> = [
      null,
      { ...admin, role: "coach", tenantId: "tenant-1" },
      { ...admin, role: "build" },
      { ...admin, impersonatingTenant: "tenant-1" },
    ];
    const statuses = [];
    for (const session of sessions) {
      const handlers = createPlatformThreadHandlers({
        enabled: () => true,
        session: async () => session,
        get,
        append,
      });
      statuses.push((await handlers.GET(getRequest(), context)).status);
    }

    expect(statuses).toEqual([401, 403, 403, 403]);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "reply", body: "Synthetic reply" }, false],
    [{ kind: "internal_note", body: "Synthetic note" }, true],
  ] as const)("maps explicit %s to the persisted internal value", async (body, internal) => {
    const append = vi.fn(async () => ({
      ...thread,
      messages: [{
        id: "message-persisted",
        authorId: "admin-user",
        authorName: "Synthetic Admin",
        body: body.body,
        internal,
        isTest: true,
        createdAt: "2026-08-18T00:02:00.000Z",
      }],
    }));
    const handlers = createPlatformThreadHandlers({
      enabled: () => true,
      session: async () => admin,
      get: async () => thread,
      append,
    });
    const response = await handlers.POST(postRequest(body), context);

    expect(response.status).toBe(200);
    expect(append).toHaveBeenCalledWith(admin, { threadId: "thread-1", body: body.body, internal });
    const payload = await response.json() as { thread: PlatformSupportThreadRead };
    expect(payload.thread.messages[0].internal).toBe(internal);
  });

  it("rejects body-supplied scope and internal booleans instead of trusting them", async () => {
    const append = vi.fn(async () => thread);
    const handlers = createPlatformThreadHandlers({
      enabled: () => true,
      session: async () => admin,
      get: async () => thread,
      append,
    });
    const responses = await Promise.all([
      handlers.POST(postRequest({ kind: "reply", body: "B", internal: true }), context),
      handlers.POST(postRequest({ kind: "reply", body: "B", tenant_id: "tenant-2" }), context),
      handlers.POST(postRequest({ kind: "reply", body: "B", author_id: "forged" }), context),
      handlers.POST(postRequest({ kind: "reply", body: "B", role: "owner" }), context),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(append).not.toHaveBeenCalled();
  });

  it.each(["open", "waiting_on_coach", "resolved"] as const)(
    "sets the schema-supported %s lifecycle state with a Logged receipt",
    async (status) => {
      const setStatus = vi.fn(async () => ({ ...statusReceipt, status }));
      const handlers = createPlatformThreadHandlers({
        enabled: () => true, session: async () => admin, get: async () => thread,
        append: async () => thread, setStatus, setAssignee: async () => assignmentReceipt,
      });
      const response = await handlers.PATCH(patchRequest({
        kind: "status", status, reason: "Synthetic lifecycle update",
      }), context);

      expect(response.status).toBe(200);
      expect(setStatus).toHaveBeenCalledWith(admin, {
        threadId: "thread-1", status, reason: "Synthetic lifecycle update",
      });
      await expect(response.json()).resolves.toEqual({
        thread: { id: "thread-1", tenantId: "tenant-1", status },
        audit: {
          id: 42, actionKey: "support.thread.status.changed", microcopy: "Thread status change logged",
        },
      });
    },
  );

  it("assigns the support thread itself and rejects a tenant success-owner field", async () => {
    const setAssignee = vi.fn(async () => assignmentReceipt);
    const handlers = createPlatformThreadHandlers({
      enabled: () => true, session: async () => admin, get: async () => thread,
      append: async () => thread, setStatus: async () => statusReceipt, setAssignee,
    });
    const assigned = await handlers.PATCH(patchRequest({
      kind: "assignment", assigneeId: "success-user", reason: "Synthetic ticket routing",
    }), context);
    const forged = await handlers.PATCH(patchRequest({
      kind: "assignment", assigneeId: "success-user", reason: "Synthetic ticket routing",
      successOwner: "forged-owner",
    }), context);

    expect(assigned.status).toBe(200);
    expect(setAssignee).toHaveBeenCalledWith(admin, {
      threadId: "thread-1", assigneeId: "success-user", reason: "Synthetic ticket routing",
    });
    await expect(assigned.json()).resolves.toEqual({
      thread: { id: "thread-1", tenantId: "tenant-1", assignedTo: "success-user" },
      audit: {
        id: 43, actionKey: "support.thread.assignment.changed", microcopy: "Thread assignment logged",
      },
    });
    expect(forged.status).toBe(400);
    expect(setAssignee).toHaveBeenCalledTimes(1);
  });

  it("refuses unauthorised lifecycle mutations before parsing or service work", async () => {
    const setStatus = vi.fn(async () => statusReceipt);
    const handlers = createPlatformThreadHandlers({
      enabled: () => true,
      session: async () => ({ ...admin, role: "coach", tenantId: "tenant-1" }),
      get: async () => thread, append: async () => thread, setStatus,
      setAssignee: async () => assignmentReceipt,
    });
    const response = await handlers.PATCH(patchRequest({
      kind: "status", status: "resolved", reason: "Forged lifecycle update",
    }), context);

    expect(response.status).toBe(403);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("contains no canned or generated support-reply path", async () => {
    const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/cannedReply|generateSupportReply|suggestedReply|openrouter/i);
  });
});
