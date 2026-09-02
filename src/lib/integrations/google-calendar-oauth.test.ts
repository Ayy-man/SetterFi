// The provider contract for Google Calendar connect, proved against the scripted driver rather
// than the network. Two claims carry most of the weight and both are easy to get wrong in a way
// no HTTP status reveals: a freebusy 200 can carry a per-calendar errors array and mean the exact
// opposite of success, and an exchange response with no refresh token is a grant that dies in an
// hour. The rest of the file is the secret-handling perimeter.
import { describe, expect, it, vi } from "vitest";

import {
  GOOGLE_CALENDAR_CALLBACK_PATH,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_STATE_TTL_MS,
  GOOGLE_TESTING_REFRESH_TOKEN_TTL_MS,
  GoogleCalendarOAuthError,
  consumeGoogleOAuthState,
  exchangeGoogleAuthorizationCode,
  googleAccessTokenIsFresh,
  googleAppBaseUrl,
  googleOAuthStateHash,
  googleRedirectUri,
  isGoogleInvalidGrant,
  issueGoogleOAuthState,
  listGoogleCalendars,
  missingGoogleScopes,
  queryGoogleFreeBusy,
  refreshGoogleAccessToken,
  revokeGoogleGrant,
  validateGoogleReturnPath,
  type GoogleOAuthStateRecord,
  type GoogleOAuthStateStore,
} from "./google-calendar-oauth";
import { GOOGLE_MOCK_TOKENS, createGoogleCalendarMockFetch } from "./google-calendar-oauth-mock";

const APP_BASE_URL = "https://app.setterfi.test";
const CLIENT = { clientId: "mock-client-id", clientSecret: "mock-client-secret-value" };
const AUTHORIZATION_CODE = "mock-authorization-code";
const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-09-02T12:00:00.000Z");

/** Every value that must never appear in a returned object, a message, or a serialized error. */
const SECRETS = [
  CLIENT.clientSecret,
  AUTHORIZATION_CODE,
  GOOGLE_MOCK_TOKENS.accessToken,
  GOOGLE_MOCK_TOKENS.refreshedAccessToken,
  GOOGLE_MOCK_TOKENS.refreshToken,
];

function serialize(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.name, error.message, error.stack ?? ""];
  for (const key of Object.getOwnPropertyNames(error)) {
    parts.push(key, String((error as unknown as Record<string, unknown>)[key]));
  }
  return parts.join("|");
}

function stateStore(seed: GoogleOAuthStateRecord[] = []) {
  const rows = new Map<string, { record: GoogleOAuthStateRecord; consumedAt: string | null }>();
  for (const record of seed) rows.set(record.stateHash, { record, consumedAt: null });
  const store: GoogleOAuthStateStore = {
    async save(record) {
      rows.set(record.stateHash, { record, consumedAt: null });
    },
    // Mirrors the single-statement predicate the real store uses: stamp where still null, return
    // the row, and match nothing on a replay.
    async consume(stateHash, consumedAt) {
      const row = rows.get(stateHash);
      if (!row || row.consumedAt) return null;
      row.consumedAt = consumedAt;
      return row.record;
    },
  };
  return { store, rows };
}

function issue(overrides: Partial<Parameters<typeof issueGoogleOAuthState>[0]> = {}) {
  const { store, rows } = stateStore();
  return issueGoogleOAuthState(
    { actorId: ACTOR, tenantId: TENANT, appBaseUrl: APP_BASE_URL, clientId: CLIENT.clientId, ...overrides },
    { states: store, now: () => NOW, randomBytes: () => Buffer.alloc(32, 7) },
  ).then((issued) => ({ issued, rows }));
}

describe("the authorization URL", () => {
  it("carries exactly the seven documented parameters and the three scopes in order", async () => {
    const { issued } = await issue();
    const url = new URL(issued.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_OAUTH_AUTH_URL);
    expect([...url.searchParams.keys()].sort()).toEqual([
      "access_type", "client_id", "prompt", "redirect_uri", "response_type", "scope", "state",
    ]);
    expect(url.searchParams.get("client_id")).toBe(CLIENT.clientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_CALENDAR_SCOPES.join(" "));
    expect(url.searchParams.get("redirect_uri")).toBe(`${APP_BASE_URL}${GOOGLE_CALENDAR_CALLBACK_PATH}`);
  });

  // Asserted on its own because its absence is silent: the flow still succeeds, and the exchange
  // simply comes back with no refresh token for any coach who has consented before.
  it("asks for consent on every connect, not only the first", async () => {
    const { issued } = await issue();
    expect(new URL(issued.authorizationUrl).searchParams.get("prompt")).toBe("consent");
  });

  it("stores only the hash of the state and a ten-minute expiry", async () => {
    const { issued, rows } = await issue();
    const state = new URL(issued.authorizationUrl).searchParams.get("state") ?? "";
    expect(state).not.toBe("");
    expect([...rows.keys()]).toEqual([googleOAuthStateHash(state)]);
    expect([...rows.keys()][0]).not.toBe(state);
    expect(issued.expiresAt).toBe(new Date(NOW + GOOGLE_OAUTH_STATE_TTL_MS).toISOString());
  });

  it("refuses a return path that leaves this origin", async () => {
    await expect(issue({ returnPath: "//evil.test/steal" })).rejects.toThrow(
      /GOOGLE_OAUTH_RETURN_PATH_INVALID/,
    );
    expect(() => validateGoogleReturnPath("https://evil.test/steal", APP_BASE_URL)).toThrow(
      /GOOGLE_OAUTH_RETURN_PATH_INVALID/,
    );
    expect(validateGoogleReturnPath("/onboarding/calendar?calendar=ready", APP_BASE_URL))
      .toBe("/onboarding/calendar?calendar=ready");
  });

  it("allows a localhost origin over http and nothing else insecure", () => {
    expect(googleAppBaseUrl("http://localhost:3011")).toBe("http://localhost:3011");
    expect(googleRedirectUri("http://localhost:3011"))
      .toBe(`http://localhost:3011${GOOGLE_CALENDAR_CALLBACK_PATH}`);
    expect(() => googleAppBaseUrl("http://setterfi.test")).toThrow(/APP_BASE_URL_INVALID/);
  });
});

describe("consuming a state", () => {
  it("returns the record once and nothing on a replay", async () => {
    const { issued, rows } = await issue();
    const state = new URL(issued.authorizationUrl).searchParams.get("state") ?? "";
    const store: GoogleOAuthStateStore = {
      async save() {},
      async consume(hash, consumedAt) {
        const row = rows.get(hash);
        if (!row || row.consumedAt) return null;
        row.consumedAt = consumedAt;
        return row.record;
      },
    };
    const first = await consumeGoogleOAuthState({ state }, { states: store, now: () => NOW });
    expect(first).toMatchObject({ tenantId: TENANT, actorId: ACTOR, returnPath: "/onboarding/calendar" });
    expect(await consumeGoogleOAuthState({ state }, { states: store, now: () => NOW })).toBeNull();
  });

  it("returns nothing for an expired state and nothing for a missing one", async () => {
    const record: GoogleOAuthStateRecord = {
      stateHash: googleOAuthStateHash("stale"),
      tenantId: TENANT,
      actorId: ACTOR,
      returnPath: "/onboarding/calendar",
      expiresAt: new Date(NOW - 1_000).toISOString(),
    };
    const { store } = stateStore([record]);
    expect(await consumeGoogleOAuthState({ state: "stale" }, { states: store, now: () => NOW })).toBeNull();
    expect(await consumeGoogleOAuthState({ state: "never-issued" }, { states: store, now: () => NOW })).toBeNull();
    expect(await consumeGoogleOAuthState({ state: "" }, { states: store, now: () => NOW })).toBeNull();
  });
});

describe("the token endpoint", () => {
  it("posts the documented authorization-code form and maps the grant", async () => {
    const fetcher = vi.fn(createGoogleCalendarMockFetch({ exchange: "success" }));
    const grant = await exchangeGoogleAuthorizationCode(
      { code: AUTHORIZATION_CODE, client: CLIENT, redirectUri: `${APP_BASE_URL}${GOOGLE_CALENDAR_CALLBACK_PATH}` },
      { fetch: fetcher as unknown as typeof fetch, now: () => NOW },
    );
    const posted = new URLSearchParams(String(fetcher.mock.calls[0][1]?.body));
    expect([...posted.keys()].sort()).toEqual([
      "client_id", "client_secret", "code", "grant_type", "redirect_uri",
    ]);
    expect(posted.get("grant_type")).toBe("authorization_code");
    expect(posted.get("redirect_uri")).toBe(`${APP_BASE_URL}${GOOGLE_CALENDAR_CALLBACK_PATH}`);
    expect(grant).toEqual({
      accessToken: GOOGLE_MOCK_TOKENS.accessToken,
      refreshToken: GOOGLE_MOCK_TOKENS.refreshToken,
      expiresAt: new Date(NOW + 3_599_000).toISOString(),
      refreshTokenExpiresAt: new Date(NOW + GOOGLE_TESTING_REFRESH_TOKEN_TTL_MS).toISOString(),
      grantedScopes: [...GOOGLE_CALENDAR_SCOPES],
    });
  });

  it("refuses an exchange that came back without a refresh token", async () => {
    await expect(
      exchangeGoogleAuthorizationCode(
        { code: AUTHORIZATION_CODE, client: CLIENT, redirectUri: APP_BASE_URL },
        { fetch: createGoogleCalendarMockFetch({ exchange: "no-refresh-token" }), now: () => NOW },
      ),
    ).rejects.toThrow(/GOOGLE_REFRESH_TOKEN_MISSING/);
  });

  it("returns a new access token and never a rotated refresh token", async () => {
    const fetcher = vi.fn(createGoogleCalendarMockFetch({ refresh: "success" }));
    const refreshed = await refreshGoogleAccessToken(
      { refreshToken: GOOGLE_MOCK_TOKENS.refreshToken, client: CLIENT },
      { fetch: fetcher as unknown as typeof fetch, now: () => NOW },
    );
    expect(new URLSearchParams(String(fetcher.mock.calls[0][1]?.body)).get("grant_type"))
      .toBe("refresh_token");
    expect(refreshed).toEqual({
      accessToken: GOOGLE_MOCK_TOKENS.refreshedAccessToken,
      expiresAt: new Date(NOW + 3_599_000).toISOString(),
      grantedScopes: [...GOOGLE_CALENDAR_SCOPES],
    });
    expect(Object.keys(refreshed)).not.toContain("refreshToken");
  });

  it("classifies a dead grant on the body rather than the status", async () => {
    const failure = await refreshGoogleAccessToken(
      { refreshToken: GOOGLE_MOCK_TOKENS.refreshToken, client: CLIENT },
      { fetch: createGoogleCalendarMockFetch({ refresh: "invalid-grant" }), now: () => NOW },
    ).catch((error: unknown) => error);
    expect(isGoogleInvalidGrant(failure)).toBe(true);

    const other = await refreshGoogleAccessToken(
      { refreshToken: GOOGLE_MOCK_TOKENS.refreshToken, client: CLIENT },
      {
        fetch: createGoogleCalendarMockFetch({ refresh: { status: 400, error: "invalid_client" } }),
        now: () => NOW,
      },
    ).catch((error: unknown) => error);
    expect(isGoogleInvalidGrant(other)).toBe(false);
    expect((other as GoogleCalendarOAuthError).status).toBe(400);
  });

  it("names the missing members of a partial consent and nothing when all three are held", async () => {
    const partial = await exchangeGoogleAuthorizationCode(
      { code: AUTHORIZATION_CODE, client: CLIENT, redirectUri: APP_BASE_URL },
      { fetch: createGoogleCalendarMockFetch({ exchange: "partial-scope" }), now: () => NOW },
    );
    expect(missingGoogleScopes(partial.grantedScopes)).toEqual([
      GOOGLE_CALENDAR_SCOPES[1], GOOGLE_CALENDAR_SCOPES[2],
    ]);
    expect(missingGoogleScopes(GOOGLE_CALENDAR_SCOPES.join(" "))).toEqual([]);
    expect(missingGoogleScopes("")).toEqual([...GOOGLE_CALENDAR_SCOPES]);
  });
});

describe("the calendar list", () => {
  it("asks Google to filter to calendars the grant can write to", async () => {
    const fetcher = vi.fn(createGoogleCalendarMockFetch({ calendars: "multiple" }));
    const calendars = await listGoogleCalendars(
      { accessToken: GOOGLE_MOCK_TOKENS.accessToken },
      { fetch: fetcher as unknown as typeof fetch },
    );
    const requested = new URL(String(fetcher.mock.calls[0][0]));
    expect(requested.searchParams.get("minAccessRole")).toBe("writer");
    expect(requested.searchParams.get("maxResults")).toBe("250");
    expect(requested.searchParams.get("showDeleted")).toBe("false");
    expect(requested.searchParams.get("showHidden")).toBe("false");
    expect(calendars).toEqual([
      { id: "coach@livelegacystrong.test", name: "Coach", timeZone: "America/Chicago", primary: true },
      {
        id: "consults@group.calendar.google.test",
        name: "Discovery calls",
        timeZone: "America/New_York",
        primary: false,
      },
    ]);
  });

  it("preserves a missing time zone rather than substituting one", async () => {
    const calendars = await listGoogleCalendars(
      { accessToken: GOOGLE_MOCK_TOKENS.accessToken },
      { fetch: createGoogleCalendarMockFetch({ calendars: "no-timezone" }) },
    );
    expect(calendars).toEqual([
      { id: "zoneless@group.calendar.google.test", name: "Zoneless", timeZone: null, primary: true },
    ]);
  });

  it("returns nothing when the account has no writable calendar", async () => {
    expect(
      await listGoogleCalendars(
        { accessToken: GOOGLE_MOCK_TOKENS.accessToken },
        { fetch: createGoogleCalendarMockFetch({ calendars: "empty" }) },
      ),
    ).toEqual([]);
  });
});

describe("the freebusy check", () => {
  const window = { timeMin: "2026-09-02T12:00:00.000Z", timeMax: "2026-09-09T12:00:00.000Z" };

  it("reads an empty busy array as a genuine answer", async () => {
    const result = await queryGoogleFreeBusy(
      { accessToken: GOOGLE_MOCK_TOKENS.accessToken, calendarId: "coach@livelegacystrong.test", ...window },
      { fetch: createGoogleCalendarMockFetch({ freebusy: "free-all-window" }) },
    );
    expect(result).toEqual({ ok: true, reason: null, busy: [] });
  });

  it("returns the busy windows on a strict success", async () => {
    const result = await queryGoogleFreeBusy(
      { accessToken: GOOGLE_MOCK_TOKENS.accessToken, calendarId: "coach@livelegacystrong.test", ...window },
      { fetch: createGoogleCalendarMockFetch({ freebusy: "success" }) },
    );
    expect(result.ok).toBe(true);
    expect(result.busy).toEqual([{ start: "2026-09-03T15:00:00Z", end: "2026-09-03T16:00:00Z" }]);
  });

  // The trap: the transport succeeded and the calendar did not. Anything that reads response.ok
  // alone flips the connection to ready while nothing can actually be read.
  it("refuses a 200 that carries a per-calendar errors array", async () => {
    const result = await queryGoogleFreeBusy(
      { accessToken: GOOGLE_MOCK_TOKENS.accessToken, calendarId: "coach@livelegacystrong.test", ...window },
      { fetch: createGoogleCalendarMockFetch({ freebusy: "calendar-error" }) },
    );
    expect(result).toEqual({ ok: false, reason: "CALENDAR_ERRORS", busy: [] });
  });

  it("refuses a 200 that never mentions the calendar that was asked about", async () => {
    const result = await queryGoogleFreeBusy(
      { accessToken: GOOGLE_MOCK_TOKENS.accessToken, calendarId: "coach@livelegacystrong.test", ...window },
      { fetch: createGoogleCalendarMockFetch({ freebusy: "absent" }) },
    );
    expect(result).toEqual({ ok: false, reason: "CALENDAR_NOT_RETURNED", busy: [] });
  });

  it("sends the window and the one calendar it was asked about", async () => {
    const fetcher = vi.fn(createGoogleCalendarMockFetch({ freebusy: "success" }));
    await queryGoogleFreeBusy(
      { accessToken: GOOGLE_MOCK_TOKENS.accessToken, calendarId: "coach@livelegacystrong.test", ...window },
      { fetch: fetcher as unknown as typeof fetch },
    );
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      items: [{ id: "coach@livelegacystrong.test" }],
    });
  });
});

describe("revocation", () => {
  it("reports a processed revocation as confirmed", async () => {
    expect(
      await revokeGoogleGrant(
        { token: GOOGLE_MOCK_TOKENS.refreshToken },
        { fetch: createGoogleCalendarMockFetch({ revoke: "success" }) },
      ),
    ).toEqual({ revoked: true, status: 200, errorCode: null });
  });

  // The caller's confirmation rule is a decision about this exact string, and a boolean cannot
  // carry it, which is why the code and the status both come back rather than one verdict.
  it("surfaces the body error code and the observed status on a refusal", async () => {
    expect(
      await revokeGoogleGrant(
        { token: GOOGLE_MOCK_TOKENS.refreshToken },
        { fetch: createGoogleCalendarMockFetch({ revoke: { status: 400, error: "invalid_token" } }) },
      ),
    ).toEqual({ revoked: false, status: 400, errorCode: "invalid_token" });
    expect(
      await revokeGoogleGrant(
        { token: GOOGLE_MOCK_TOKENS.refreshToken },
        { fetch: createGoogleCalendarMockFetch({ revoke: { status: 400, error: "unsupported_grant" } }) },
      ),
    ).toEqual({ revoked: false, status: 400, errorCode: "unsupported_grant" });
  });

  it("reports a network failure as unconfirmed rather than throwing", async () => {
    expect(
      await revokeGoogleGrant(
        { token: GOOGLE_MOCK_TOKENS.refreshToken },
        { fetch: createGoogleCalendarMockFetch({ networkFailure: "revoke" }) },
      ),
    ).toEqual({ revoked: false, status: 0, errorCode: null });
  });

  it("returns nothing that contains the token it posted", async () => {
    const posted = await revokeGoogleGrant(
      { token: GOOGLE_MOCK_TOKENS.refreshToken },
      { fetch: createGoogleCalendarMockFetch({ revoke: { status: 400, error: "invalid_token" } }) },
    );
    expect(JSON.stringify(posted)).not.toContain(GOOGLE_MOCK_TOKENS.refreshToken);
  });
});

describe("nothing secret leaves this module", () => {
  const failures: [string, () => Promise<unknown>][] = [
    ["exchange refused by the provider", () => exchangeGoogleAuthorizationCode(
      { code: AUTHORIZATION_CODE, client: CLIENT, redirectUri: APP_BASE_URL },
      { fetch: createGoogleCalendarMockFetch({ exchange: { status: 400, error: "invalid_request" } }), now: () => NOW },
    )],
    ["exchange with no refresh token", () => exchangeGoogleAuthorizationCode(
      { code: AUTHORIZATION_CODE, client: CLIENT, redirectUri: APP_BASE_URL },
      { fetch: createGoogleCalendarMockFetch({ exchange: "no-refresh-token" }), now: () => NOW },
    )],
    ["exchange that never reached Google", () => exchangeGoogleAuthorizationCode(
      { code: AUTHORIZATION_CODE, client: CLIENT, redirectUri: APP_BASE_URL },
      { fetch: createGoogleCalendarMockFetch({ networkFailure: "token" }), now: () => NOW },
    )],
    ["refresh of a dead grant", () => refreshGoogleAccessToken(
      { refreshToken: GOOGLE_MOCK_TOKENS.refreshToken, client: CLIENT },
      { fetch: createGoogleCalendarMockFetch({ refresh: "invalid-grant" }), now: () => NOW },
    )],
    ["refresh that never reached Google", () => refreshGoogleAccessToken(
      { refreshToken: GOOGLE_MOCK_TOKENS.refreshToken, client: CLIENT },
      { fetch: createGoogleCalendarMockFetch({ networkFailure: "token" }), now: () => NOW },
    )],
    ["a refused calendar list", () => listGoogleCalendars(
      { accessToken: GOOGLE_MOCK_TOKENS.accessToken },
      { fetch: createGoogleCalendarMockFetch({ calendarListStatus: 401 }) },
    )],
    ["a calendar list that never reached Google", () => listGoogleCalendars(
      { accessToken: GOOGLE_MOCK_TOKENS.accessToken },
      { fetch: createGoogleCalendarMockFetch({ networkFailure: "calendarList" }) },
    )],
    ["a freebusy read that never reached Google", () => queryGoogleFreeBusy(
      { accessToken: GOOGLE_MOCK_TOKENS.accessToken, calendarId: "coach@livelegacystrong.test",
        timeMin: "2026-09-02T12:00:00.000Z", timeMax: "2026-09-09T12:00:00.000Z" },
      { fetch: createGoogleCalendarMockFetch({ networkFailure: "freebusy" }) },
    )],
  ];

  it.each(failures)("keeps every credential out of the error raised by %s", async (_label, run) => {
    const error = await run().then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleCalendarOAuthError);
    const serialized = serialize(error);
    for (const secret of SECRETS) {
      expect(serialized).not.toContain(secret);
    }
  });

  // A fetch rejection can carry the requested URL and the request options, and the token request
  // body holds the client secret, so the caught cause is dropped rather than chained.
  it("attaches no cause to a network failure", async () => {
    const error = await exchangeGoogleAuthorizationCode(
      { code: AUTHORIZATION_CODE, client: CLIENT, redirectUri: APP_BASE_URL },
      { fetch: createGoogleCalendarMockFetch({ networkFailure: "token" }), now: () => NOW },
    ).then(() => null, (caught: unknown) => caught);
    expect((error as GoogleCalendarOAuthError).code).toBe("GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED_NETWORK");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it("describes a failed response by its key names and never its values", async () => {
    const error = await exchangeGoogleAuthorizationCode(
      { code: AUTHORIZATION_CODE, client: CLIENT, redirectUri: APP_BASE_URL },
      { fetch: createGoogleCalendarMockFetch({ exchange: { status: 400, error: "invalid_request" } }), now: () => NOW },
    ).then(() => null, (caught: unknown) => caught as GoogleCalendarOAuthError);
    expect(error?.bodyShape).toBe("error,error_description");
    expect(serialize(error)).not.toContain("provider prose that must not surface");
  });
});

describe("access-token freshness", () => {
  it("refreshes inside the five-minute margin and not before", () => {
    expect(googleAccessTokenIsFresh(new Date(NOW + 6 * 60_000).toISOString(), NOW)).toBe(true);
    expect(googleAccessTokenIsFresh(new Date(NOW + 4 * 60_000).toISOString(), NOW)).toBe(false);
    expect(googleAccessTokenIsFresh("not a timestamp", NOW)).toBe(false);
  });
});
