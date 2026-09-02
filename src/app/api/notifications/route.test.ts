import { describe, expect, it, vi } from "vitest";

import type { BellListResult } from "@/lib/notifications/bell";

import { createNotificationsHandlers } from "./handler";

const actor = { userId: "user", tenantId: "tenant", role: "coach" as const, impersonatingTenant: null, impersonationSessionId: null };
const notification = { id: "notification", kind: "appointment.booked", ruleId: "rule", sourceEventId: "appointment", title: "Booked", body: "Body", link: null, isTest: false, readAt: null, createdAt: "2026-08-18T00:00:00.000Z", deliveryLabel: "Sent" as const };

function setup(enabled = true) {
  const repository = {
    list: vi.fn(async (): Promise<BellListResult> => ({ notifications: [notification], nextCursor: null })),
    unreadCount: vi.fn(async () => 1),
    markRead: vi.fn(async () => ({ ...notification, readAt: "2026-08-18T00:00:00.000Z" })),
    markAllRead: vi.fn(async () => 1),
  };
  const session = vi.fn(async () => actor);
  return { repository, session, handlers: createNotificationsHandlers({
    enabled: () => enabled, session, repository: () => repository,
  }) };
}

describe("notification API", () => {
  it("is inert before session and repository construction while disabled", async () => {
    const values = setup(false);
    expect((await values.handlers.GET(new Request("http://local/api/notifications"))).status).toBe(404);
    expect(values.session).not.toHaveBeenCalled();
    expect(values.repository.list).not.toHaveBeenCalled();
  });

  it("lists only the session user's bell projection", async () => {
    const values = setup();
    const response = await values.handlers.GET(new Request("http://local/api/notifications"));
    expect(response.status).toBe(200);
    expect(values.repository.list).toHaveBeenCalledWith({ userId: "user", limit: 25, cursor: null });
    expect(values.repository.unreadCount).toHaveBeenCalledWith("user");
    expect(await response.json()).toEqual({
      notifications: [notification], unreadCount: 1, page: { limit: 25, nextCursor: null },
    });
  });

  it("marks only the named notification inside the session-user boundary", async () => {
    const values = setup();
    const response = await values.handlers.PUT(new Request("http://local/api/notifications", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notificationId: "notification" }),
    }));
    expect(response.status).toBe(200);
    expect(values.repository.markRead).toHaveBeenCalledWith("user", "notification");
  });

  it("reports a refused mark read as a refusal rather than a silent success", async () => {
    const values = setup();
    values.repository.markRead.mockRejectedValueOnce(new Error("NOTIFICATION_MARK_READ_REFUSED"));
    const response = await values.handlers.PUT(new Request("http://local/api/notifications", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notificationId: "notification" }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Notification update refused." });
  });

  it("pages by an opaque cursor and reports the current unread count", async () => {
    const values = setup();
    values.repository.list.mockResolvedValueOnce({
      notifications: [notification], nextCursor: { createdAt: notification.createdAt, id: notification.id },
    });
    const response = await values.handlers.GET(new Request("http://local/api/notifications?limit=1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      notifications: [notification], unreadCount: 1,
      page: { limit: 1, nextCursor: "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTE4VDAwOjAwOjAwLjAwMFoiLCJpZCI6Im5vdGlmaWNhdGlvbiJ9" },
    });
  });

  it("marks all of the session user's unread notifications", async () => {
    const values = setup();
    const response = await values.handlers.PUT(new Request("http://local/api/notifications", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ markAll: true }),
    }));
    expect(response.status).toBe(200);
    expect(values.repository.markAllRead).toHaveBeenCalledWith();
    expect(await response.json()).toEqual({ markedCount: 1 });
  });

  it("refuses anonymous or impersonated sessions and extra authority fields", async () => {
    for (const candidate of [null, { ...actor, impersonatingTenant: "other" }]) {
      const repository = { list: vi.fn(), unreadCount: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn() };
      const handlers = createNotificationsHandlers({ enabled: () => true, session: async () => candidate, repository: () => repository as never });
      expect((await handlers.GET(new Request("http://local/api/notifications"))).status).toBe(401);
      expect(repository.list).not.toHaveBeenCalled();
    }
    const values = setup();
    const response = await values.handlers.PUT(new Request("http://local", { method: "PUT", body: JSON.stringify({ notificationId: "notification", userId: "other" }) }));
    expect(response.status).toBe(400);
    expect(values.repository.markRead).not.toHaveBeenCalled();
  });

  it("refuses malformed pages before querying the notification store", async () => {
    const values = setup();
    const response = await values.handlers.GET(new Request("http://local/api/notifications?limit=101"));
    expect(response.status).toBe(400);
    expect(values.repository.list).not.toHaveBeenCalled();
  });
});
