import { describe, expect, it, vi } from "vitest";

import { createCoachNotificationPreferenceHandlers } from "./handler";

const actor = {
  userId: "coach-1",
  role: "coach" as const,
  tenantId: "tenant-session",
  impersonatingTenant: null,
  impersonationSessionId: null,
};

function request(body: unknown) {
  return new Request("https://setterfi.test/api/coach/notification-preference", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    session: vi.fn(async () => actor),
    read: vi.fn(async () => "email" as const),
    readEmail: vi.fn(async () => "coach@synthetic.test"),
    write: vi.fn(async () => "text" as const),
    audit: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("coach notification preference API", () => {
  it("forbids a signed-out actor", async () => {
    const deps = dependencies({ session: vi.fn(async () => null) });
    const handlers = createCoachNotificationPreferenceHandlers(deps);
    expect((await handlers.GET()).status).toBe(403);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it("forbids a non-coach role", async () => {
    const deps = dependencies({ session: vi.fn(async () => ({ ...actor, role: "admin" as const })) });
    const handlers = createCoachNotificationPreferenceHandlers(deps);
    expect((await handlers.GET()).status).toBe(403);
  });

  it("forbids an impersonated session", async () => {
    const deps = dependencies({
      session: vi.fn(async () => ({ ...actor, impersonatingTenant: "other-tenant" })),
    });
    const handlers = createCoachNotificationPreferenceHandlers(deps);
    expect((await handlers.GET()).status).toBe(403);
  });

  it("reads the coach's own preference and account email in one round trip", async () => {
    const deps = dependencies();
    const handlers = createCoachNotificationPreferenceHandlers(deps);
    const response = await handlers.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ preference: "email", email: "coach@synthetic.test" });
    expect(deps.read).toHaveBeenCalledWith("coach-1", "coach");
    expect(deps.readEmail).toHaveBeenCalledWith({ userId: "coach-1", tenantId: "tenant-session" });
  });

  it("carries a null email honestly rather than guessing one", async () => {
    const deps = dependencies({ readEmail: vi.fn(async () => null) });
    const handlers = createCoachNotificationPreferenceHandlers(deps);
    const response = await handlers.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ preference: "email", email: null });
  });

  it("writes a valid preference and returns the settled value", async () => {
    const deps = dependencies();
    const handlers = createCoachNotificationPreferenceHandlers(deps);
    const response = await handlers.PUT(request({ preference: "text" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ preference: "text" });
    expect(deps.write).toHaveBeenCalledWith("coach-1", "coach", "text", deps.audit);
  });

  it("rejects an invalid preference value", async () => {
    const deps = dependencies();
    const handlers = createCoachNotificationPreferenceHandlers(deps);
    const response = await handlers.PUT(request({ preference: "sms" }));
    expect(response.status).toBe(409);
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("rejects a body with extra keys", async () => {
    const deps = dependencies();
    const handlers = createCoachNotificationPreferenceHandlers(deps);
    const response = await handlers.PUT(request({ preference: "email", extra: true }));
    expect(response.status).toBe(409);
    expect(deps.write).not.toHaveBeenCalled();
  });
});
