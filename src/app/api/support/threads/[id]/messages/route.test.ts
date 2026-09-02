import { describe, expect, it, vi } from "vitest";

import type { CoachSupportThreadRead } from "@/lib/repositories/support";
import type { SupportSession } from "@/lib/support/service";

import { createCoachMessageHandler } from "./handler";

const coach: SupportSession = {
  userId: "coach-user",
  role: "coach",
  tenantId: "tenant-1",
  impersonatingTenant: null,
};
const thread: CoachSupportThreadRead = {
  id: "thread-1",
  tenantId: "tenant-1",
  subject: "Synthetic subject",
  status: "open",
  assignedTo: null,
  isTest: true,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:01:00.000Z",
  messages: [],
};
const context = { params: Promise.resolve({ id: "thread-1" }) };
const request = (body: unknown) => new Request(
  "https://setterfi.test/api/support/threads/thread-1/messages",
  { method: "POST", body: JSON.stringify(body) },
);

describe("POST /api/support/threads/[id]/messages", () => {
  it("checks the flag before session or append work", async () => {
    const session = vi.fn(async () => coach);
    const append = vi.fn(async () => thread);
    const response = await createCoachMessageHandler({
      enabled: () => false,
      session,
      append,
    })(request({ body: "Synthetic reply" }), context);

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(session).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("requires a coach session and refuses impersonation before append", async () => {
    const append = vi.fn(async () => thread);
    const missing = await createCoachMessageHandler({
      enabled: () => true,
      session: async () => null,
      append,
    })(request({ body: "Synthetic reply" }), context);
    const impersonated = await createCoachMessageHandler({
      enabled: () => true,
      session: async () => ({ ...coach, impersonatingTenant: "tenant-1" }),
      append,
    })(request({ body: "Synthetic reply" }), context);

    expect([missing.status, impersonated.status]).toEqual([401, 403]);
    expect(append).not.toHaveBeenCalled();
  });

  it.each([
    { body: "Synthetic reply", internal: true },
    { body: "Synthetic reply", tenant_id: "tenant-2" },
    { body: "Synthetic reply", author_id: "forged-user" },
    { body: "Synthetic reply", role: "admin" },
  ])("rejects forged coach append fields %#", async (body) => {
    const append = vi.fn(async () => thread);
    const response = await createCoachMessageHandler({
      enabled: () => true,
      session: async () => coach,
      append,
    })(request(body), context);

    expect(response.status).toBe(400);
    expect(append).not.toHaveBeenCalled();
  });

  it("derives the thread from the path and returns its persisted read-back", async () => {
    const persisted = { ...thread, updatedAt: "2026-08-18T00:02:00.000Z" };
    const append = vi.fn(async () => persisted);
    const response = await createCoachMessageHandler({
      enabled: () => true,
      session: async () => coach,
      append,
    })(request({ body: "Request body" }), context);

    expect(response.status).toBe(200);
    expect(append).toHaveBeenCalledWith(coach, { threadId: "thread-1", body: "Request body" });
    await expect(response.json()).resolves.toEqual({ thread: persisted });
  });
});
