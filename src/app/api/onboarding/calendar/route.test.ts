import { describe, expect, it, vi } from "vitest";

import { createCalendarHandlers } from "./handler";

const actor = { userId: "coach-1", tenantId: "tenant-1", role: "coach" as const, impersonatingTenant: null };
const body = { provider: "google", externalAccountReference: "account-1", externalCalendarId: "calendar-1", calendarName: "Primary", timezone: "America/Chicago", authorizationReceipt: "provider-receipt" };
function dependencies() {
  return {
    enabled: () => true, session: vi.fn().mockResolvedValue(actor), load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue({ connection: { id: "calendar-1", provider: "google", calendarName: "Primary", externalCalendarId: "calendar-1", externalAccountReference: "account-1", authorizationRecordedAt: "2026-09-07T00:00:00Z", state: "connecting" }, audit: { id: "22", actionKey: "onboarding.calendar_authorization.recorded" as const } }),
  };
}

describe("onboarding calendar route", () => {
  it("records a claims-scoped provider receipt but returns a still-connecting calendar", async () => {
    const deps = dependencies();
    const response = await createCalendarHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    expect(deps.save).toHaveBeenCalledWith({ ...body, tenantId: "tenant-1", actorId: "coach-1" });
    await expect(response.json()).resolves.toMatchObject({ connection: { state: "connecting" }, audit: { id: "22" } });
  });

  it.each([[null, 401], [{ ...actor, role: "admin" as const }, 403], [{ ...actor, impersonatingTenant: "tenant-1" }, 403]])(
    "refuses an unauthorized writer", async (candidate, status) => {
      const deps = dependencies(); deps.session.mockResolvedValue(candidate);
      const response = await createCalendarHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify(body) }));
      expect(response.status).toBe(status); expect(deps.save).not.toHaveBeenCalled();
    },
  );

  it("rejects a forged empty receipt before persistence", async () => {
    const deps = dependencies();
    const response = await createCalendarHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ ...body, authorizationReceipt: "" }) }));
    expect(response.status).toBe(400); expect(deps.save).not.toHaveBeenCalled();
  });
});

describe("onboarding calendar GET payload", () => {
  const connection = {
    id: "connection-1", provider: "google" as const, calendarName: "Coach",
    externalCalendarId: "cal-1", externalAccountReference: "coach@livelegacystrong.test",
    authorizationRecordedAt: "2026-09-02T00:00:00.000Z", state: "ready" as const,
  };
  const googleGrant = {
    connectedAs: "coach@livelegacystrong.test",
    refreshTokenExpiresAt: "2026-09-09T00:00:00.000Z",
    reauthorizationRequired: false,
  };
  const pendingCalendars = [{ id: "cal-1", name: "Coach", timeZone: "America/Chicago" }];

  it("keeps the connection field and reports the connect affordance as unavailable when the flag is off", async () => {
    const deps = { ...dependencies(), googleEnabled: () => false, loadGoogle: vi.fn() };
    deps.load.mockResolvedValue(connection);
    const response = await createCalendarHandlers(deps).GET();
    await expect(response.json()).resolves.toEqual({
      connection, googleConnectAvailable: false, googleGrant: null, pendingCalendars: [],
    });
    // The Google tables are not read at all while the flag is unset.
    expect(deps.loadGoogle).not.toHaveBeenCalled();
  });

  it("offers the picker while a grant exists and no Google connection has been written from it", async () => {
    const deps = {
      ...dependencies(),
      googleEnabled: () => true,
      loadGoogle: vi.fn().mockResolvedValue({ grant: googleGrant, pendingCalendars }),
    };
    const response = await createCalendarHandlers(deps).GET();
    await expect(response.json()).resolves.toEqual({
      connection: null, googleConnectAvailable: true, googleGrant, pendingCalendars,
    });
  });

  it("stops offering the picker once the grant produced a connection", async () => {
    const deps = {
      ...dependencies(),
      googleEnabled: () => true,
      loadGoogle: vi.fn().mockResolvedValue({ grant: googleGrant, pendingCalendars }),
    };
    deps.load.mockResolvedValue(connection);
    const payload = await (await createCalendarHandlers(deps).GET()).json();
    expect(payload.pendingCalendars).toEqual([]);
    expect(payload.googleGrant).toEqual(googleGrant);
  });
});
