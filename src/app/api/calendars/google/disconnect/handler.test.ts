import { describe, expect, it, vi } from "vitest";

import type { GoogleCalendarGrantRow } from "@/lib/integrations/google-calendar-oauth-store";

import { createGoogleDisconnectHandler } from "./handler";

const NOW = Date.parse("2026-09-02T00:00:00.000Z");

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
  pendingCalendars: [],
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
    loadConnection: vi.fn().mockResolvedValue(connection),
    loadGrant: vi.fn().mockResolvedValue(grant),
    revoke: vi.fn().mockResolvedValue({ revoked: true, status: 200, errorCode: null }),
    recordDisconnected: vi.fn().mockResolvedValue({
      receiptId: "receipt-1",
      auditId: 77,
      outcome: "verified",
      code: "PROVIDER_REVOKED",
    }),
    now: () => NOW,
  };
}

function post(body: unknown) {
  return new Request("https://setterfi.test", { method: "POST", body: JSON.stringify(body) });
}

describe("google calendar disconnect route", () => {
  it("is absent from the product with the flag unset", async () => {
    const deps = { ...dependencies(), enabled: () => false };
    const response = await createGoogleDisconnectHandler(deps)(post({ idempotencyKey: "key-1" }));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(deps.revoke).not.toHaveBeenCalled();
  });

  it.each([
    [null, 401],
    [{ ...actor, role: "admin" as const }, 403],
    [{ ...actor, impersonatingTenant: "tenant-1" }, 403],
  ])("refuses an actor who may not disconnect a calendar", async (candidate, status) => {
    const deps = dependencies();
    deps.session.mockResolvedValue(candidate);
    const response = await createGoogleDisconnectHandler(deps)(post({ idempotencyKey: "key-1" }));
    expect(response.status).toBe(status);
    expect(deps.recordDisconnected).not.toHaveBeenCalled();
  });

  it.each([
    ["a blank key", { idempotencyKey: "   " }],
    ["a missing key", {}],
    ["an extra key", { idempotencyKey: "key-1", force: true }],
  ])("refuses %s", async (_label, body) => {
    const deps = dependencies();
    const response = await createGoogleDisconnectHandler(deps)(post(body));
    expect(response.status).toBe(400);
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(deps.recordDisconnected).not.toHaveBeenCalled();
  });

  it("disconnects on a confirmed revoke and returns the receipt the surface parses", async () => {
    const deps = dependencies();
    const response = await createGoogleDisconnectHandler(deps)(post({ idempotencyKey: "key-1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      disconnected: true,
      receipt: { receiptId: "receipt-1", auditId: 77, outcome: "verified", code: "PROVIDER_REVOKED" },
    });
    expect(deps.recordDisconnected.mock.calls[0][0]).toMatchObject({
      tenantId: "tenant-1",
      connectionId: "connection-1",
      actorId: "coach-1",
      idempotencyKey: "key-1",
      evidence: {
        revoke_status: 200,
        revoke_error_code: null,
        confirmed_by: "provider",
        grant_known_dead: false,
      },
    });
  });

  it("treats a 400 saying the token is already dead as the outcome we wanted", async () => {
    const deps = dependencies();
    deps.revoke.mockResolvedValue({ revoked: false, status: 400, errorCode: "invalid_token" });
    const response = await createGoogleDisconnectHandler(deps)(post({ idempotencyKey: "key-1" }));
    expect(response.status).toBe(200);
    expect(deps.recordDisconnected.mock.calls[0][0].evidence).toMatchObject({
      confirmed_by: "provider",
      revoke_error_code: "invalid_token",
    });
  });

  it("holds the row when a live grant's revoke comes back unrecognised", async () => {
    const deps = dependencies();
    deps.revoke.mockResolvedValue({ revoked: false, status: 400, errorCode: "invalid_request" });
    const response = await createGoogleDisconnectHandler(deps)(post({ idempotencyKey: "key-1" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Google did not confirm the revocation.",
      code: "PROVIDER_REVOKE_UNCONFIRMED",
    });
    expect(deps.recordDisconnected).not.toHaveBeenCalled();
  });

  it("holds the row when the revoke never reached Google at all", async () => {
    const deps = dependencies();
    deps.revoke.mockResolvedValue({ revoked: false, status: 0, errorCode: null });
    const response = await createGoogleDisconnectHandler(deps)(post({ idempotencyKey: "key-1" }));
    expect(response.status).toBe(409);
    expect(deps.recordDisconnected).not.toHaveBeenCalled();
  });

  it.each([
    ["the connection is already expired", { connection: { ...connection, state: "expired" as const } }],
    ["reauthorization is already required", {
      grant: { ...grant, reauthorizationRequiredAt: "2026-09-01T00:00:00.000Z" },
    }],
    ["the refresh token deadline has passed", {
      grant: { ...grant, refreshTokenExpiresAt: "2026-09-01T00:00:00.000Z" },
    }],
  ])("disconnects an already-dead grant when %s", async (_label, overrides) => {
    const deps = dependencies();
    if ("connection" in overrides) deps.loadConnection.mockResolvedValue(overrides.connection);
    if ("grant" in overrides) deps.loadGrant.mockResolvedValue(overrides.grant);
    deps.revoke.mockResolvedValue({ revoked: false, status: 400, errorCode: "invalid_request" });
    const response = await createGoogleDisconnectHandler(deps)(post({ idempotencyKey: "key-1" }));
    expect(response.status).toBe(200);
    expect(deps.recordDisconnected.mock.calls[0][0].evidence).toEqual({
      revoke_status: 400,
      revoke_error_code: "invalid_request",
      confirmed_by: "local_records",
      grant_known_dead: true,
    });
  });

  it("refuses when there is no Google connection to disconnect", async () => {
    const deps = dependencies();
    deps.loadConnection.mockResolvedValue({ ...connection, provider: "ghl" });
    const response = await createGoogleDisconnectHandler(deps)(post({ idempotencyKey: "key-1" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "CALENDAR_CONNECTION_NOT_FOUND" });
    expect(deps.revoke).not.toHaveBeenCalled();
  });

  it("names no credential in any response body", async () => {
    const deps = dependencies();
    const bodies = await Promise.all([
      createGoogleDisconnectHandler(deps)(post({ idempotencyKey: "key-1" })).then((r) => r.text()),
      createGoogleDisconnectHandler({
        ...deps,
        revoke: vi.fn().mockResolvedValue({ revoked: false, status: 400, errorCode: "invalid_request" }),
      })(post({ idempotencyKey: "key-2" })).then((r) => r.text()),
    ]);
    for (const body of bodies) {
      expect(body).not.toContain("sealed");
      expect(body).not.toContain("refreshCredentialEnvelope");
    }
  });
});
