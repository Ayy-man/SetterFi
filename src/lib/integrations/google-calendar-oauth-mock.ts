/**
 * A scriptable stand-in for Google, so the whole connect round trip — connect, callback, picker,
 * freebusy, ready — is provable without a network and without the one Google account that can
 * complete the live flow while the app sits in Testing publishing status.
 *
 * It answers the four endpoints this integration talks to, chooses between the exchange and the
 * refresh grant by reading `grant_type` off the posted form exactly as Google does, and produces
 * every outcome the plan's contract has a branch for. Nothing here is a fixture file: the script is
 * a plain options object, so a test names the situation it is testing rather than a payload.
 *
 * Response bodies follow the documented shapes at
 * https://developers.google.com/identity/protocols/oauth2/web-server and
 * https://developers.google.com/workspace/calendar/api/v3/reference/{calendarList,freebusy}
 * (all read 2026-09-02). Where this file and Google disagree, Google is right and this file is the
 * bug.
 */

import {
  GOOGLE_CALENDAR_API_BASE,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_OAUTH_REVOKE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
} from "./google-calendar-oauth";

type FetchLike = typeof fetch;

export type GoogleMockCalendar = {
  id: string;
  summary: string;
  summaryOverride?: string;
  timeZone?: string;
  primary?: boolean;
};

export type GoogleMockScript = {
  /**
   * `success` is a full offline grant. `no-refresh-token` is the reconnect trap: the response a
   * coach who already consented gets when prompt=consent was left off. `partial-scope` is granular
   * consent, where the coach unticked one of the three.
   */
  exchange?: "success" | "no-refresh-token" | "partial-scope" | { status: number; error: string };
  refresh?: "success" | "invalid-grant" | { status: number; error: string };
  calendars?: "single" | "multiple" | "empty" | "no-timezone" | readonly GoogleMockCalendar[];
  calendarListStatus?: number;
  /**
   * `calendar-error` is the honest-state trap: HTTP 200 carrying a per-calendar errors array and
   * no busy array, which reads as success to anything that only checks response.ok.
   */
  freebusy?: "success" | "free-all-window" | "calendar-error" | "absent";
  revoke?: "success" | { status: number; error?: string };
  /** Thrown by the fetch itself, standing in for DNS or TLS failure rather than an HTTP error. */
  networkFailure?: "token" | "calendarList" | "freebusy" | "revoke";
};

const ACCESS_TOKEN = "mock-google-access-token";
const REFRESHED_ACCESS_TOKEN = "mock-google-refreshed-access-token";
const REFRESH_TOKEN = "mock-google-refresh-token";

const SINGLE: readonly GoogleMockCalendar[] = [
  { id: "coach@livelegacystrong.test", summary: "Coach", timeZone: "America/Chicago", primary: true },
];
const MULTIPLE: readonly GoogleMockCalendar[] = [
  ...SINGLE,
  { id: "consults@group.calendar.google.test", summary: "Consults", summaryOverride: "Discovery calls", timeZone: "America/New_York" },
];
const NO_TIMEZONE: readonly GoogleMockCalendar[] = [
  { id: "zoneless@group.calendar.google.test", summary: "Zoneless", primary: true },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function calendarSet(script: GoogleMockScript["calendars"]): readonly GoogleMockCalendar[] {
  if (Array.isArray(script)) return script;
  if (script === "multiple") return MULTIPLE;
  if (script === "empty") return [];
  if (script === "no-timezone") return NO_TIMEZONE;
  return SINGLE;
}

function tokenResponse(script: GoogleMockScript, grantType: string | null) {
  const scenario = grantType === "refresh_token" ? script.refresh ?? "success" : script.exchange ?? "success";
  if (typeof scenario === "object") {
    return json({ error: scenario.error, error_description: "provider prose that must not surface" }, scenario.status);
  }
  if (scenario === "invalid-grant") {
    return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
  }
  const scope = scenario === "partial-scope"
    ? GOOGLE_CALENDAR_SCOPES.slice(0, 1).join(" ")
    : GOOGLE_CALENDAR_SCOPES.join(" ");
  if (grantType === "refresh_token") {
    // Four fields, and refresh_token is deliberately not among them: Google does not rotate.
    return json({ access_token: REFRESHED_ACCESS_TOKEN, expires_in: 3599, scope, token_type: "Bearer" });
  }
  const body: Record<string, unknown> = {
    access_token: ACCESS_TOKEN,
    expires_in: 3599,
    scope,
    token_type: "Bearer",
  };
  if (scenario !== "no-refresh-token") body.refresh_token = REFRESH_TOKEN;
  return json(body);
}

function freeBusyResponse(script: GoogleMockScript, calendarId: string, timeMin: string, timeMax: string) {
  const scenario = script.freebusy ?? "success";
  if (scenario === "absent") {
    return json({ kind: "calendar#freeBusy", timeMin, timeMax, calendars: {} });
  }
  if (scenario === "calendar-error") {
    return json({
      kind: "calendar#freeBusy",
      timeMin,
      timeMax,
      calendars: { [calendarId]: { errors: [{ domain: "global", reason: "notFound" }] } },
    });
  }
  const busy = scenario === "free-all-window"
    ? []
    : [{ start: "2026-09-03T15:00:00Z", end: "2026-09-03T16:00:00Z" }];
  return json({ kind: "calendar#freeBusy", timeMin, timeMax, calendars: { [calendarId]: { busy } } });
}

export function createGoogleCalendarMockFetch(script: GoogleMockScript = {}): FetchLike {
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";

    if (url === GOOGLE_OAUTH_TOKEN_URL) {
      if (script.networkFailure === "token") throw new TypeError("fetch failed");
      return tokenResponse(script, new URLSearchParams(body).get("grant_type"));
    }

    if (url === GOOGLE_OAUTH_REVOKE_URL) {
      if (script.networkFailure === "revoke") throw new TypeError("fetch failed");
      const scenario = script.revoke ?? "success";
      if (scenario === "success") return new Response("", { status: 200 });
      return json(scenario.error ? { error: scenario.error } : {}, scenario.status);
    }

    if (url.startsWith(`${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`)) {
      if (script.networkFailure === "calendarList") throw new TypeError("fetch failed");
      if (script.calendarListStatus && script.calendarListStatus !== 200) {
        return json({ error: { code: script.calendarListStatus, status: "UNAUTHENTICATED" } }, script.calendarListStatus);
      }
      return json({ kind: "calendar#calendarList", items: calendarSet(script.calendars) });
    }

    if (url === `${GOOGLE_CALENDAR_API_BASE}/freeBusy`) {
      if (script.networkFailure === "freebusy") throw new TypeError("fetch failed");
      const parsed = JSON.parse(body || "{}") as {
        timeMin?: string;
        timeMax?: string;
        items?: { id?: string }[];
      };
      const calendarId = parsed.items?.[0]?.id ?? "";
      return freeBusyResponse(script, calendarId, parsed.timeMin ?? "", parsed.timeMax ?? "");
    }

    throw new Error(`Google mock has no route for ${url}`);
  };
  return handler as FetchLike;
}

export const GOOGLE_MOCK_TOKENS = {
  accessToken: ACCESS_TOKEN,
  refreshedAccessToken: REFRESHED_ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
} as const;

export const GOOGLE_MOCK_CALENDARS = { single: SINGLE, multiple: MULTIPLE, noTimeZone: NO_TIMEZONE } as const;
