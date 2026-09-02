import { describe, expect, it, vi } from "vitest";

import { GoogleCalendarOAuthError } from "@/lib/integrations/google-calendar-oauth";
import type { GoogleCalendarGrantRow } from "@/lib/integrations/google-calendar-oauth-store";

import {
  FREEBUSY_VERIFICATION_WINDOW_MS,
  googleAuthorizationReceiptHash,
  googleExternalAccountReference,
  verifyGoogleCalendar,
} from "./verify-calendar";

const NOW = Date.parse("2026-09-02T00:00:00.000Z");

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

const calendar = { id: "cal-1", name: "Coach", timeZone: "America/Chicago" };

function dependencies() {
  return {
    freebusy: vi.fn().mockResolvedValue({ ok: true, reason: null, busy: [] }),
    recordAuthorization: vi.fn().mockResolvedValue({ connectionId: "connection-1" }),
    recordAvailability: vi.fn().mockResolvedValue({
      receiptId: "receipt-1",
      auditId: 41,
      outcome: "verified",
      code: "AVAILABILITY_VERIFIED",
    }),
    loadConnection: vi.fn().mockResolvedValue({
      id: "connection-1",
      provider: "google",
      calendarName: "Coach",
      externalCalendarId: "cal-1",
      externalAccountReference: "coach@livelegacystrong.test",
      authorizationRecordedAt: "2026-09-02T00:00:00.000Z",
      state: "ready",
    }),
    now: () => NOW,
    idempotencyKey: () => "idempotency-1",
  };
}

function verify(deps: ReturnType<typeof dependencies>) {
  return verifyGoogleCalendar(
    { tenantId: "tenant-1", actorId: "coach-1", accessToken: "access", grant, calendar },
    deps,
  );
}

describe("verifyGoogleCalendar", () => {
  it("reads availability over a window that starts now and runs seven days", async () => {
    const deps = dependencies();
    await verify(deps);
    expect(deps.freebusy.mock.calls[0][0]).toEqual({
      accessToken: "access",
      calendarId: "cal-1",
      timeMin: "2026-09-02T00:00:00.000Z",
      timeMax: new Date(NOW + FREEBUSY_VERIFICATION_WINDOW_MS).toISOString(),
    });
  });

  it("records the authorization, then the verified availability, in that order", async () => {
    const deps = dependencies();
    const order: string[] = [];
    deps.recordAuthorization.mockImplementation(async () => {
      order.push("authorization");
      return { connectionId: "connection-1" };
    });
    deps.recordAvailability.mockImplementation(async () => {
      order.push("availability");
      return { receiptId: "receipt-1", auditId: 41, outcome: "verified", code: "AVAILABILITY_VERIFIED" };
    });
    const result = await verify(deps);
    expect(order).toEqual(["authorization", "availability"]);
    expect(deps.recordAvailability.mock.calls[0][0]).toMatchObject({
      connectionId: "connection-1",
      idempotencyKey: "idempotency-1",
      outcome: "verified",
      outcomeCode: "AVAILABILITY_VERIFIED",
    });
    expect(result.verified).toBe(true);
    expect(result.outcome).toBe("AVAILABILITY_VERIFIED");
  });

  it("feeds the grant id as the authorization receipt and never a credential", async () => {
    const deps = dependencies();
    await verify(deps);
    expect(deps.recordAuthorization.mock.calls[0][0]).toEqual({
      tenantId: "tenant-1",
      actorId: "coach-1",
      externalAccountReference: "coach@livelegacystrong.test",
      externalCalendarId: "cal-1",
      calendarName: "Coach",
      timezone: "America/Chicago",
      authorizationReceiptHash: googleAuthorizationReceiptHash("grant-1"),
    });
    expect(googleAuthorizationReceiptHash("grant-1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records not_verified when the calendar came back carrying errors", async () => {
    const deps = dependencies();
    deps.freebusy.mockResolvedValue({ ok: false, reason: "CALENDAR_ERRORS", busy: [] });
    deps.recordAvailability.mockResolvedValue(null);
    const result = await verify(deps);
    expect(deps.recordAvailability.mock.calls[0][0]).toMatchObject({
      outcome: "not_verified",
      outcomeCode: "AVAILABILITY_NOT_VERIFIED:CALENDAR_ERRORS",
    });
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("AVAILABILITY_NOT_VERIFIED");
    expect(result.receipt).toBeNull();
  });

  it("still records the authorization when availability could not be read", async () => {
    const deps = dependencies();
    deps.freebusy.mockResolvedValue({ ok: false, reason: "CALENDAR_NOT_RETURNED", busy: [] });
    deps.recordAvailability.mockResolvedValue(null);
    await verify(deps);
    expect(deps.recordAuthorization).toHaveBeenCalledTimes(1);
  });

  it("describes a thrown provider failure with our own code and no provider prose", async () => {
    const deps = dependencies();
    deps.freebusy.mockRejectedValue(
      new GoogleCalendarOAuthError("GOOGLE_FREEBUSY_FAILED", 503, "error"),
    );
    deps.recordAvailability.mockResolvedValue(null);
    const result = await verify(deps);
    expect(deps.recordAvailability.mock.calls[0][0].outcomeCode)
      .toBe("AVAILABILITY_NOT_VERIFIED:GOOGLE_FREEBUSY_FAILED");
    expect(result.verified).toBe(false);
  });

  it("falls back to the grant id when no calendar claimed to be the primary one", () => {
    expect(googleExternalAccountReference({ ...grant, googleAccountEmail: null }))
      .toBe("google:grant-1");
  });
});
