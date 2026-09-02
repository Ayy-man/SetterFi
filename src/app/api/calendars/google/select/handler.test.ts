import { describe, expect, it, vi } from "vitest";

import { GoogleCalendarOAuthError } from "@/lib/integrations/google-calendar-oauth";
import type { GoogleCalendarGrantRow } from "@/lib/integrations/google-calendar-oauth-store";

import { createGoogleSelectHandler } from "./handler";

const actor = {
  userId: "coach-1",
  tenantId: "tenant-1",
  role: "coach" as const,
  impersonatingTenant: null,
};

const grant = {
  id: "grant-1",
  tenantId: "tenant-1",
  googleAccountEmail: "coach@livelegacystrong.test",
  accessCredentialEnvelope: { sealed: true },
  refreshCredentialEnvelope: { sealed: true },
  grantedScopes: ["a", "b", "c"],
  tokenExpiresAt: "2026-09-02T01:00:00.000Z",
  refreshTokenExpiresAt: "2026-09-09T00:00:00.000Z",
  pendingCalendars: [{ id: "cal-1", name: "Coach", timeZone: "America/Chicago" }],
  reauthorizationRequiredAt: null,
  revokedAt: null,
} satisfies GoogleCalendarGrantRow;

const connection = {
  id: "connection-1",
  provider: "google" as const,
  calendarName: "Coach",
  externalCalendarId: "cal-1",
  externalAccountReference: "coach@livelegacystrong.test",
  authorizationRecordedAt: "2026-09-02T00:00:00.000Z",
  state: "ready" as const,
};

function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn().mockResolvedValue(actor),
    loadGrant: vi.fn().mockResolvedValue(grant),
    resolveAccessToken: vi.fn().mockResolvedValue({ accessToken: "access" }),
    verify: vi.fn().mockResolvedValue({
      connection,
      verified: true,
      outcome: "AVAILABILITY_VERIFIED",
      receipt: { receiptId: "receipt-1", auditId: 41, outcome: "verified", code: "AVAILABILITY_VERIFIED" },
    }),
  };
}

function post(body: unknown) {
  return new Request("https://setterfi.test", { method: "POST", body: JSON.stringify(body) });
}

describe("google calendar select route", () => {
  it("is absent from the product with the flag unset", async () => {
    const deps = { ...dependencies(), enabled: () => false };
    const response = await createGoogleSelectHandler(deps)(post({ externalCalendarId: "cal-1" }));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Not found." });
    expect(deps.loadGrant).not.toHaveBeenCalled();
  });

  it.each([
    [null, 401],
    [{ ...actor, role: "admin" as const }, 403],
    [{ ...actor, impersonatingTenant: "tenant-1" }, 403],
  ])("refuses an actor who may not write a calendar", async (candidate, status) => {
    const deps = dependencies();
    deps.session.mockResolvedValue(candidate);
    const response = await createGoogleSelectHandler(deps)(post({ externalCalendarId: "cal-1" }));
    expect(response.status).toBe(status);
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("refuses an id the tenant was never offered", async () => {
    const deps = dependencies();
    const response = await createGoogleSelectHandler(deps)(post({ externalCalendarId: "someone-else" }));
    expect(response.status).toBe(400);
    expect(deps.resolveAccessToken).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("refuses a body carrying any key beyond the calendar id", async () => {
    const deps = dependencies();
    const response = await createGoogleSelectHandler(deps)(
      post({ externalCalendarId: "cal-1", isPrimary: true }),
    );
    expect(response.status).toBe(400);
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("returns the full connection with a receipt when availability verified", async () => {
    const deps = dependencies();
    const response = await createGoogleSelectHandler(deps)(post({ externalCalendarId: "cal-1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connection,
      verified: true,
      outcome: "AVAILABILITY_VERIFIED",
      receipt: { receiptId: "receipt-1", auditId: 41, outcome: "verified", code: "AVAILABILITY_VERIFIED" },
    });
    expect(deps.verify.mock.calls[0][0]).toMatchObject({
      tenantId: "tenant-1",
      actorId: "coach-1",
      calendar: { id: "cal-1", name: "Coach", timeZone: "America/Chicago" },
    });
  });

  it("returns the same field set with a null receipt when availability did not verify", async () => {
    const deps = dependencies();
    deps.verify.mockResolvedValue({
      connection: { ...connection, state: "connecting" },
      verified: false,
      outcome: "AVAILABILITY_NOT_VERIFIED",
      receipt: null,
    });
    const response = await createGoogleSelectHandler(deps)(post({ externalCalendarId: "cal-1" }));
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["connection", "outcome", "receipt", "verified"]);
    expect(payload.receipt).toBeNull();
    // The name, the id and the authorized-at timestamp all survive the failed arm, because the page
    // renders them off this object at the moment the coach needs to see what was picked.
    expect(payload.connection).toEqual({ ...connection, state: "connecting" });
  });

  it("answers a dead grant with the expiry code rather than a generic failure", async () => {
    const deps = dependencies();
    deps.resolveAccessToken.mockRejectedValue(
      new GoogleCalendarOAuthError("GOOGLE_OAUTH_GRANT_INVALID", 400, "error"),
    );
    const response = await createGoogleSelectHandler(deps)(post({ externalCalendarId: "cal-1" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Calendar authorization has expired.",
      code: "GOOGLE_GRANT_EXPIRED",
    });
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("does not read a transient refresh failure as an expired grant", async () => {
    const deps = dependencies();
    deps.resolveAccessToken.mockRejectedValue(
      new GoogleCalendarOAuthError("GOOGLE_OAUTH_REFRESH_FAILED_NETWORK"),
    );
    const response = await createGoogleSelectHandler(deps)(post({ externalCalendarId: "cal-1" }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "CALENDAR_VERIFICATION_UNAVAILABLE" });
  });

  it("puts the resolved access token in no response body", async () => {
    const deps = dependencies();
    deps.resolveAccessToken.mockResolvedValue({ accessToken: "ya29-sentinel-token" });
    const response = await createGoogleSelectHandler(deps)(post({ externalCalendarId: "cal-1" }));
    expect(deps.verify.mock.calls[0][0].accessToken).toBe("ya29-sentinel-token");
    expect(await response.text()).not.toContain("ya29-sentinel-token");
  });
});
