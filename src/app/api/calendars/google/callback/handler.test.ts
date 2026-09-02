import { describe, expect, it, vi } from "vitest";

import {
  GOOGLE_CALENDAR_SCOPES,
  GoogleCalendarOAuthError,
} from "@/lib/integrations/google-calendar-oauth";
import type { GoogleCalendarGrantRow } from "@/lib/integrations/google-calendar-oauth-store";

import { createGoogleCallbackHandler } from "./handler";

const actor = {
  userId: "coach-1",
  tenantId: "tenant-1",
  role: "coach" as const,
  impersonatingTenant: null,
};

const stateRecord = {
  stateHash: "a".repeat(64),
  tenantId: "tenant-1",
  actorId: "coach-1",
  returnPath: "/onboarding/calendar",
  expiresAt: "2026-09-02T00:10:00.000Z",
};

const tokenGrant = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: "2026-09-02T01:00:00.000Z",
  refreshTokenExpiresAt: "2026-09-09T00:00:00.000Z",
  grantedScopes: [...GOOGLE_CALENDAR_SCOPES],
};

const storedGrant = {
  id: "grant-1",
  tenantId: "tenant-1",
  googleAccountEmail: "coach@livelegacystrong.test",
  accessCredentialEnvelope: { sealed: true },
  refreshCredentialEnvelope: { sealed: true },
  grantedScopes: [...GOOGLE_CALENDAR_SCOPES],
  tokenExpiresAt: "2026-09-02T01:00:00.000Z",
  refreshTokenExpiresAt: "2026-09-09T00:00:00.000Z",
  pendingCalendars: [],
  reauthorizationRequiredAt: null,
  revokedAt: null,
} satisfies GoogleCalendarGrantRow;

const SINGLE = [
  { id: "coach@livelegacystrong.test", name: "Coach", timeZone: "America/Chicago", primary: true },
];
const MULTIPLE = [
  ...SINGLE,
  { id: "consults@group.test", name: "Discovery calls", timeZone: "America/New_York", primary: false },
];

function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn().mockResolvedValue(actor),
    consumeState: vi.fn().mockResolvedValue(stateRecord),
    exchange: vi.fn().mockResolvedValue(tokenGrant),
    listCalendars: vi.fn().mockResolvedValue(MULTIPLE),
    persistGrant: vi.fn().mockResolvedValue(storedGrant),
    verify: vi.fn().mockResolvedValue({
      connection: {
        id: "connection-1",
        provider: "google",
        calendarName: "Coach",
        externalCalendarId: "coach@livelegacystrong.test",
        externalAccountReference: "coach@livelegacystrong.test",
        authorizationRecordedAt: "2026-09-02T00:00:00.000Z",
        state: "ready",
      },
      verified: true,
      outcome: "AVAILABILITY_VERIFIED",
      receipt: { receiptId: "receipt-1", auditId: 41, outcome: "verified", code: "AVAILABILITY_VERIFIED" },
    }),
  };
}

function callback(search: string) {
  return new Request(`https://setterfi.test/api/calendars/google/callback${search}`);
}

function outcome(response: Response) {
  return new URL(response.headers.get("Location") ?? "", "https://setterfi.invalid")
    .searchParams.get("calendar");
}

describe("google calendar callback route", () => {
  it("is absent from the product with the flag unset, and does not redirect", async () => {
    const deps = { ...dependencies(), enabled: () => false };
    const response = await createGoogleCallbackHandler(deps)(callback("?code=c&state=s"));
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(deps.exchange).not.toHaveBeenCalled();
  });

  it.each([
    [null, 401],
    [{ ...actor, role: "admin" as const }, 403],
    [{ ...actor, impersonatingTenant: "tenant-1" }, 403],
  ])("refuses an actor who may not complete a connect", async (candidate, status) => {
    const deps = dependencies();
    deps.session.mockResolvedValue(candidate);
    const response = await createGoogleCallbackHandler(deps)(callback("?code=c&state=s"));
    expect(response.status).toBe(status);
    expect(deps.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ["there is no state at all", "?code=c", null],
    ["the state was already spent", "?code=c&state=s", null],
    ["the state belongs to another session's coach", "?code=c&state=s", { ...stateRecord, actorId: "coach-2" }],
    ["the state belongs to another tenant", "?code=c&state=s", { ...stateRecord, tenantId: "tenant-2" }],
  ])("never reaches the token endpoint when %s", async (_label, search, record) => {
    const deps = dependencies();
    deps.consumeState.mockResolvedValue(record);
    const response = await createGoogleCallbackHandler(deps)(callback(search));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/onboarding/calendar?calendar=error");
    expect(deps.exchange).not.toHaveBeenCalled();
  });

  it("treats a cancelled consent as a decision rather than a failure", async () => {
    const deps = dependencies();
    const response = await createGoogleCallbackHandler(deps)(
      callback("?state=s&error=access_denied&error_description=The+user+denied+the+request"),
    );
    expect(outcome(response)).toBe("declined");
    expect(deps.exchange).not.toHaveBeenCalled();
    expect(deps.persistGrant).not.toHaveBeenCalled();
    // Provider prose can carry request context, so none of it rides along in the redirect.
    expect(response.headers.get("Location")).toBe("/onboarding/calendar?calendar=declined");
  });

  it("asks for a fresh consent when the exchange carried no refresh token", async () => {
    const deps = dependencies();
    deps.exchange.mockRejectedValue(
      new GoogleCalendarOAuthError("GOOGLE_REFRESH_TOKEN_MISSING", 200, "access_token,expires_in"),
    );
    const response = await createGoogleCallbackHandler(deps)(callback("?code=c&state=s"));
    expect(outcome(response)).toBe("reauthorize");
    expect(deps.persistGrant).not.toHaveBeenCalled();
  });

  it("stores nothing when the coach granted only part of what was asked", async () => {
    const deps = dependencies();
    deps.exchange.mockResolvedValue({
      ...tokenGrant,
      grantedScopes: [GOOGLE_CALENDAR_SCOPES[0]],
    });
    const response = await createGoogleCallbackHandler(deps)(callback("?code=c&state=s"));
    expect(outcome(response)).toBe("scopes");
    expect(deps.persistGrant).not.toHaveBeenCalled();
    expect(deps.listCalendars).not.toHaveBeenCalled();
  });

  it("populates the picker and writes no connection when several calendars are eligible", async () => {
    const deps = dependencies();
    const response = await createGoogleCallbackHandler(deps)(callback("?code=c&state=s"));
    expect(outcome(response)).toBe("choose");
    expect(deps.persistGrant.mock.calls[0][0]).toMatchObject({
      tenantId: "tenant-1",
      googleAccountEmail: "coach@livelegacystrong.test",
      pendingCalendars: [
        { id: "coach@livelegacystrong.test", name: "Coach", timeZone: "America/Chicago" },
        { id: "consults@group.test", name: "Discovery calls", timeZone: "America/New_York" },
      ],
    });
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("verifies the only eligible calendar through the shared path", async () => {
    const deps = dependencies();
    deps.listCalendars.mockResolvedValue(SINGLE);
    const response = await createGoogleCallbackHandler(deps)(callback("?code=c&state=s"));
    expect(outcome(response)).toBe("ready");
    expect(deps.verify).toHaveBeenCalledTimes(1);
    expect(deps.verify.mock.calls[0][0]).toMatchObject({
      tenantId: "tenant-1",
      actorId: "coach-1",
      calendar: { id: "coach@livelegacystrong.test", timeZone: "America/Chicago" },
    });
  });

  it("says availability is unverified rather than ready when the freebusy read failed", async () => {
    const deps = dependencies();
    deps.listCalendars.mockResolvedValue(SINGLE);
    deps.verify.mockResolvedValue({
      connection: { id: "connection-1", provider: "google", calendarName: "Coach",
        externalCalendarId: "cal", externalAccountReference: "cal",
        authorizationRecordedAt: null, state: "connecting" },
      verified: false,
      outcome: "AVAILABILITY_NOT_VERIFIED",
      receipt: null,
    });
    const response = await createGoogleCallbackHandler(deps)(callback("?code=c&state=s"));
    expect(outcome(response)).toBe("unverified");
  });

  it.each([
    ["Google returned nothing writable", []],
    ["every writable calendar came back with no time zone", [
      { id: "zoneless@group.test", name: "Zoneless", timeZone: null, primary: true },
    ]],
  ])("offers no calendar when %s", async (_label, calendars) => {
    const deps = dependencies();
    deps.listCalendars.mockResolvedValue(calendars);
    const response = await createGoogleCallbackHandler(deps)(callback("?code=c&state=s"));
    expect(outcome(response)).toBe("nocalendars");
    expect(deps.persistGrant.mock.calls[0][0].pendingCalendars).toEqual([]);
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("keeps a zoneless entry out of the picker while offering the ones that have a zone", async () => {
    const deps = dependencies();
    deps.listCalendars.mockResolvedValue([
      ...MULTIPLE,
      { id: "zoneless@group.test", name: "Zoneless", timeZone: null, primary: false },
    ]);
    await createGoogleCallbackHandler(deps)(callback("?code=c&state=s"));
    const stored = deps.persistGrant.mock.calls[0][0].pendingCalendars as { id: string }[];
    expect(stored.map((entry) => entry.id)).toEqual([
      "coach@livelegacystrong.test",
      "consults@group.test",
    ]);
  });

  it("lands on an error when the calendar list could not be read", async () => {
    const deps = dependencies();
    deps.listCalendars.mockRejectedValue(
      new GoogleCalendarOAuthError("GOOGLE_CALENDAR_LIST_FAILED", 401, "error"),
    );
    const response = await createGoogleCallbackHandler(deps)(callback("?code=c&state=s"));
    expect(outcome(response)).toBe("error");
    expect(deps.persistGrant).not.toHaveBeenCalled();
  });

  it("emits a path and a search string only, carrying no code and no provider prose", async () => {
    const deps = dependencies();
    const response = await createGoogleCallbackHandler(deps)(
      callback("?code=4/secret-authorization-code&state=s&error_description=provider+prose"),
    );
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith("/onboarding/calendar?")).toBe(true);
    expect(location).not.toContain("secret-authorization-code");
    expect(location).not.toContain("prose");
    expect(location).not.toContain("setterfi.invalid");
  });
});
