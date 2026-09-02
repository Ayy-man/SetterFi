/**
 * Google Calendar OAuth: authorization URL, single-use state, code exchange, access-token refresh,
 * calendar list, freebusy verification and revocation.
 *
 * What this module owns: the shape of every request to Google and the meaning of every response.
 * What it deliberately does not own: all database access. Grant custody, envelope encryption and
 * the state rows live in the store module beside it. The split exists because every dependency
 * here is injected — fetch, the clock, the randomness — so the whole provider path is provable
 * without a network, and a module that also opened a Supabase connection could not be.
 *
 * ---------------------------------------------------------------------------------------------
 * Why this is not a copy of ghl-oauth.ts
 * ---------------------------------------------------------------------------------------------
 * The state half is ported near-verbatim: same SHA-256 hashing, same 10-minute TTL, same 32 bytes
 * of randomness, same same-origin return-path refusal, same typed error carrying key names and no
 * values, same injected seams.
 *
 * The refreshing-custody half is not ported at all, and the reason is a provider fact rather than
 * a preference. A GoHighLevel refresh token is single-use, so that module needs a compare-and-set
 * lease, a heartbeat and a wait-for-the-winner loop to make sure exactly one instance spends it.
 * Google does not rotate: its documented refresh response carries access_token, expires_in, scope
 * and token_type, refresh_token is not among them, and the page says "You should save refresh
 * tokens in long-term storage and continue to use them as long as they remain valid".
 *   https://developers.google.com/identity/protocols/oauth2/web-server (read 2026-09-02)
 * Two concurrent refreshes here cost one wasted HTTP call. There is no lease, no heartbeat and no
 * wait loop, and adding one later would be a claim about Google that this page contradicts.
 *
 * For the same reason a dead grant is classified on the parsed body's `error` field rather than on
 * the HTTP status. The same page's error table documents `invalid_grant` as the signal that "the
 * token may have expired or has been invalidated", without fixing the status it arrives with, so
 * a status-based helper would be guessing.
 *
 * ---------------------------------------------------------------------------------------------
 * Two smaller notes for whoever reads this next
 * ---------------------------------------------------------------------------------------------
 * `docs/ENGINEERING-BRIEF.md` calls for zod at every boundary. zod is not a dependency of this
 * project and this task adds no package, so every provider payload is hand-narrowed from
 * `unknown` exactly as the surrounding integration modules do.
 *
 * Nothing here logs. No thrown error, and no value any function returns, carries an access token,
 * a refresh token, an authorization code or the client secret. A failure is described by a code, a
 * status, and the sorted key names of the response body.
 */

import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

/**
 * Exactly the three scopes the consent screen was configured with on 2026-09-02, in the order the
 * authorization URL sends them. Adding a fourth is a Google Cloud console change and a new consent
 * for every coach, so this array is the contract rather than a convenience.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export const GOOGLE_CALENDAR_CALLBACK_PATH = "/api/calendars/google/callback";
export const GOOGLE_CALENDAR_DEFAULT_RETURN_PATH = "/onboarding/calendar";
export const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;

/**
 * Seven days, because an app in Testing publishing status is issued refresh tokens that expire
 * seven days after consent: "Authorizations by a test user will expire seven days from the time of
 * consent. If your OAuth client requests an offline access type and receives a refresh token, that
 * token will also expire." — https://support.google.com/cloud/answer/15549945 (read 2026-09-02).
 *
 * Stated plainly, because it changes what "normal" means for this integration: under today's
 * configuration every grant dies after seven days, so `expired` is the ordinary operating
 * condition rather than an exception, and the coach-facing copy has to read that way.
 *
 * `refresh_token_expires_in` is documented as set "only when the user grants time-based access",
 * so it is preferred when it arrives and this constant is the deadline otherwise.
 */
export const GOOGLE_TESTING_REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const ACCESS_TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1_000;
export const GOOGLE_ACCESS_TOKEN_SAFETY_MARGIN_MS = ACCESS_TOKEN_SAFETY_MARGIN_MS;

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;
type RandomBytes = (size: number) => Buffer;

export class GoogleCalendarOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly bodyShape: string | null = null,
  ) {
    super(status === null ? code : `${code} (HTTP ${status})`);
    this.name = "GoogleCalendarOAuthError";
  }
}

/** True only for the one condition that means the grant is gone and retrying cannot help. */
export function isGoogleInvalidGrant(error: unknown) {
  return error instanceof GoogleCalendarOAuthError && error.code === "GOOGLE_OAUTH_GRANT_INVALID";
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveSeconds(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Key names only, sorted. This is how a failure is described without describing a token. */
function bodyShape(value: unknown) {
  const record = object(value);
  return record
    ? Object.keys(record).sort().join(",")
    : Array.isArray(value) ? "array" : typeof value;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function googleOAuthStateHash(state: string) {
  return sha256Hex(state);
}

// ---------------------------------------------------------------------------
// Origins and return paths
// ---------------------------------------------------------------------------

/**
 * https unless the host is localhost, which is what lets http://localhost:3011 work against a
 * registered redirect URI. The origin is never derived from a request's Host header: that value is
 * attacker-controlled, and Google refuses anything outside the registered list anyway, so a
 * header-derived origin turns a spoofed host into a redirect_uri_mismatch instead of a refusal we
 * control.
 */
export function googleAppBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_APP_BASE_URL_INVALID");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_APP_BASE_URL_INVALID");
  }
  return parsed.origin;
}

/**
 * Computed once and sent byte-identically to the authorization endpoint and then to the token
 * endpoint. Google compares the two, and a difference of one character is a redirect_uri_mismatch.
 */
export function googleRedirectUri(appBaseUrl: string) {
  return `${googleAppBaseUrl(appBaseUrl)}${GOOGLE_CALENDAR_CALLBACK_PATH}`;
}

/** A callback redirect target is attacker-influenced input; anything not same-origin is refused. */
export function validateGoogleReturnPath(value: string, appBaseUrl: string) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_RETURN_PATH_INVALID");
  }
  const base = googleAppBaseUrl(appBaseUrl);
  const parsed = new URL(value, base);
  if (parsed.origin !== base) {
    throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_RETURN_PATH_INVALID");
  }
  return `${parsed.pathname}${parsed.search}`;
}

// ---------------------------------------------------------------------------
// Single-use authorization state
// ---------------------------------------------------------------------------

export type GoogleOAuthStateRecord = {
  stateHash: string;
  tenantId: string;
  actorId: string;
  returnPath: string;
  expiresAt: string;
};

export type GoogleOAuthStateStore = {
  save(record: GoogleOAuthStateRecord): Promise<void>;
  /**
   * Must consume atomically: one statement that stamps `consumed_at` where it is still null and
   * returns the row. A second call for the same hash matches nothing and resolves null. A
   * select-then-update version is racy and would pass every test written for it, which is the
   * whole reason this is a predicate on the write rather than a check in application code.
   */
  consume(stateHash: string, consumedAt: string): Promise<GoogleOAuthStateRecord | null>;
};

export type GoogleOAuthStateDependencies = {
  states: GoogleOAuthStateStore;
  now?: () => number;
  randomBytes?: RandomBytes;
};

export async function issueGoogleOAuthState(
  input: {
    actorId: string;
    tenantId: string;
    returnPath?: string | null;
    appBaseUrl: string;
    clientId: string;
  },
  {
    states,
    now = Date.now,
    randomBytes: generateRandomBytes = randomBytes,
  }: GoogleOAuthStateDependencies,
) {
  const actorId = text(input.actorId);
  const tenantId = text(input.tenantId);
  const clientId = text(input.clientId);
  if (!actorId || !tenantId) throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_ACTOR_REQUIRED");
  if (!clientId) throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_CLIENT_ID_REQUIRED");
  const returnPath = validateGoogleReturnPath(
    text(input.returnPath) ?? GOOGLE_CALENDAR_DEFAULT_RETURN_PATH,
    input.appBaseUrl,
  );
  const state = generateRandomBytes(32).toString("base64url");
  if (!state) throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_RANDOMNESS_INVALID");
  const expiresAt = new Date(now() + GOOGLE_OAUTH_STATE_TTL_MS).toISOString();
  await states.save({ stateHash: sha256Hex(state), tenantId, actorId, returnPath, expiresAt });

  const authorization = new URL(GOOGLE_OAUTH_AUTH_URL);
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", googleRedirectUri(input.appBaseUrl));
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
  authorization.searchParams.set("access_type", "offline");
  // Without this, a coach who has already granted gets an exchange response with no refresh_token
  // and the connection dies an hour later. It is sent on every connect, not only the first.
  authorization.searchParams.set("prompt", "consent");
  authorization.searchParams.set("state", state);
  return { authorizationUrl: authorization.toString(), expiresAt, state };
}

/**
 * Null for a missing, forged, replayed or expired state. All four land on the same coach-facing
 * outcome, so unlike the GoHighLevel port there is no second read to tell them apart: there is one
 * Google callback, so there is no cross-app case to name, and a distinction nothing consumes is
 * an extra query on the path that has already failed.
 */
export async function consumeGoogleOAuthState(
  input: { state: string | null | undefined },
  { states, now = Date.now }: GoogleOAuthStateDependencies,
) {
  const candidate = text(input.state);
  if (!candidate) return null;
  const record = await states.consume(sha256Hex(candidate), new Date(now()).toISOString());
  if (!record) return null;
  if (Date.parse(record.expiresAt) <= now()) return null;
  return record;
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export type GoogleOAuthClient = {
  clientId: string;
  clientSecret: string;
};

export type GoogleTokenGrant = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshTokenExpiresAt: string;
  grantedScopes: readonly string[];
};

export type GoogleAccessTokenRefresh = {
  accessToken: string;
  expiresAt: string;
  grantedScopes: readonly string[];
};

export type GoogleTokenDependencies = {
  fetch?: FetchLike;
  now?: () => number;
};

function scopeList(value: unknown): readonly string[] {
  const granted = text(value);
  return granted ? granted.split(/\s+/).filter(Boolean) : [];
}

async function postGoogleTokenEndpoint(
  body: URLSearchParams,
  code: string,
  { fetch: fetcher = fetch }: GoogleTokenDependencies,
) {
  let response: Response;
  try {
    response = await fetcher(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
  } catch {
    // The caught cause is deliberately not attached: a fetch failure can carry the requested URL
    // and the request options, and this request body holds the client secret.
    throw new GoogleCalendarOAuthError(`${code}_NETWORK`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GoogleCalendarOAuthError(`${code}_MALFORMED_JSON`, response.status, "non-json");
  }
  if (!response.ok) {
    // Classified on the body, not the status. error_description is provider prose that can carry
    // request context, so it is read by nothing and reaches neither a caller nor a log line.
    const providerError = text(object(payload)?.error);
    throw new GoogleCalendarOAuthError(
      providerError === "invalid_grant" ? "GOOGLE_OAUTH_GRANT_INVALID" : code,
      response.status,
      bodyShape(payload),
    );
  }
  return { payload, status: response.status };
}

export async function exchangeGoogleAuthorizationCode(
  input: { code: string; client: GoogleOAuthClient; redirectUri: string },
  dependencies: GoogleTokenDependencies = {},
): Promise<GoogleTokenGrant> {
  const code = text(input.code);
  if (!code) throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_CODE_REQUIRED");
  const now = dependencies.now ?? Date.now;
  const { payload, status } = await postGoogleTokenEndpoint(
    new URLSearchParams({
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
    "GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED",
    dependencies,
  );
  const row = object(payload);
  const accessToken = text(row?.access_token);
  const expiresIn = positiveSeconds(row?.expires_in);
  if (!accessToken || expiresIn === null) {
    throw new GoogleCalendarOAuthError(
      "GOOGLE_OAUTH_TOKEN_ENVELOPE_INVALID",
      status,
      bodyShape(payload),
    );
  }
  const refreshToken = text(row?.refresh_token);
  if (!refreshToken) {
    // An access-token-only grant is dead in an hour with nothing to renew it from. Refusing here
    // is what turns a silent booking failure weeks later into a reconnect prompt now.
    throw new GoogleCalendarOAuthError(
      "GOOGLE_REFRESH_TOKEN_MISSING",
      status,
      bodyShape(payload),
    );
  }
  const refreshExpiresIn = positiveSeconds(row?.refresh_token_expires_in);
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(now() + expiresIn * 1_000).toISOString(),
    refreshTokenExpiresAt: new Date(
      now() + (refreshExpiresIn === null
        ? GOOGLE_TESTING_REFRESH_TOKEN_TTL_MS
        : refreshExpiresIn * 1_000),
    ).toISOString(),
    grantedScopes: scopeList(row?.scope),
  };
}

/**
 * Returns a new access token and nothing else. There is no rotated refresh token to return: the
 * caller keeps the one it stored, and a future reader who expects one back should read the module
 * header before adding a field for it.
 */
export async function refreshGoogleAccessToken(
  input: { refreshToken: string; client: GoogleOAuthClient },
  dependencies: GoogleTokenDependencies = {},
): Promise<GoogleAccessTokenRefresh> {
  const refreshToken = text(input.refreshToken);
  if (!refreshToken) throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_REFRESH_TOKEN_REQUIRED");
  const now = dependencies.now ?? Date.now;
  const { payload, status } = await postGoogleTokenEndpoint(
    new URLSearchParams({
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    "GOOGLE_OAUTH_REFRESH_FAILED",
    dependencies,
  );
  const row = object(payload);
  const accessToken = text(row?.access_token);
  const expiresIn = positiveSeconds(row?.expires_in);
  if (!accessToken || expiresIn === null) {
    throw new GoogleCalendarOAuthError(
      "GOOGLE_OAUTH_TOKEN_ENVELOPE_INVALID",
      status,
      bodyShape(payload),
    );
  }
  return {
    accessToken,
    expiresAt: new Date(now() + expiresIn * 1_000).toISOString(),
    grantedScopes: scopeList(row?.scope),
  };
}

/**
 * Granular consent is permanently on for an OAuth client created in 2026, so a coach can grant one
 * or two of the three scopes and the flow still returns a code. Missing freebusy means the
 * connection can never honestly reach ready; missing events means the agent can never book.
 */
export function missingGoogleScopes(granted: string | readonly string[]): readonly string[] {
  const held = new Set(typeof granted === "string" ? scopeList(granted) : granted);
  return GOOGLE_CALENDAR_SCOPES.filter((scope) => !held.has(scope));
}

// ---------------------------------------------------------------------------
// Calendar API
// ---------------------------------------------------------------------------

export type GoogleCalendarChoice = {
  id: string;
  name: string;
  /**
   * Null when Google returned no zone, which the reference documents as legal: "The time zone of
   * the calendar. Optional. Read-only." The absence is preserved rather than filled, because the
   * authorization RPC validates the zone against pg_timezone_names and a booking written into a
   * substituted zone is worse than a calendar the coach cannot pick. The caller filters; nothing
   * here invents a value.
   */
  timeZone: string | null;
  primary: boolean;
};

export type GoogleBusyInterval = { start: string; end: string };

export type GoogleFreeBusyResult = {
  ok: boolean;
  /** One of our own codes on failure, never provider prose. Null when the read succeeded. */
  reason: string | null;
  busy: readonly GoogleBusyInterval[];
};

export type GoogleRevokeResult = {
  revoked: boolean;
  status: number;
  errorCode: string | null;
};

export type GoogleCalendarApiDependencies = {
  fetch?: FetchLike;
};

async function callCalendarApi(
  url: string,
  init: RequestInit,
  code: string,
  { fetch: fetcher = fetch }: GoogleCalendarApiDependencies,
) {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    throw new GoogleCalendarOAuthError(`${code}_NETWORK`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GoogleCalendarOAuthError(`${code}_MALFORMED_JSON`, response.status, "non-json");
  }
  if (!response.ok) {
    throw new GoogleCalendarOAuthError(code, response.status, bodyShape(payload));
  }
  return payload;
}

/**
 * `minAccessRole=writer` is applied server-side rather than filtered afterwards. freeBusyReader and
 * reader cannot insert an event, so offering one would let Google accept the coach's choice and
 * fail the first booking instead.
 */
export async function listGoogleCalendars(
  input: { accessToken: string },
  dependencies: GoogleCalendarApiDependencies = {},
): Promise<readonly GoogleCalendarChoice[]> {
  const accessToken = text(input.accessToken);
  if (!accessToken) throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_ACCESS_TOKEN_REQUIRED");
  const url = new URL(`${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`);
  url.searchParams.set("minAccessRole", "writer");
  url.searchParams.set("maxResults", "250");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("showHidden", "false");
  const payload = await callCalendarApi(
    url.toString(),
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
    "GOOGLE_CALENDAR_LIST_FAILED",
    dependencies,
  );
  const items = object(payload)?.items;
  if (!Array.isArray(items)) return [];
  const choices: GoogleCalendarChoice[] = [];
  for (const entry of items) {
    const row = object(entry);
    const id = text(row?.id);
    const name = text(row?.summaryOverride) ?? text(row?.summary);
    if (!id || !name) continue;
    choices.push({
      id,
      name,
      timeZone: text(row?.timeZone),
      primary: row?.primary === true,
    });
  }
  return choices;
}

/**
 * An HTTP 200 is not the check. A calendar the grant cannot read comes back inside a 200 with a
 * per-calendar `errors` array and no `busy` array, and treating that as success would flip the
 * connection to ready while nothing can actually be read. An empty `busy` array is a legitimate
 * answer meaning free for the whole window, so emptiness is not failure — absence is.
 */
export async function queryGoogleFreeBusy(
  input: { accessToken: string; calendarId: string; timeMin: string; timeMax: string },
  dependencies: GoogleCalendarApiDependencies = {},
): Promise<GoogleFreeBusyResult> {
  const accessToken = text(input.accessToken);
  const calendarId = text(input.calendarId);
  if (!accessToken) throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_ACCESS_TOKEN_REQUIRED");
  if (!calendarId) throw new GoogleCalendarOAuthError("GOOGLE_CALENDAR_ID_REQUIRED");
  const payload = await callCalendarApi(
    `${GOOGLE_CALENDAR_API_BASE}/freeBusy`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        items: [{ id: calendarId }],
      }),
    },
    "GOOGLE_FREEBUSY_FAILED",
    dependencies,
  );
  const entry = object(object(payload)?.calendars)?.[calendarId];
  const row = object(entry);
  if (!row) return { ok: false, reason: "CALENDAR_NOT_RETURNED", busy: [] };
  const errors = row.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return { ok: false, reason: "CALENDAR_ERRORS", busy: [] };
  }
  if (!Array.isArray(row.busy)) return { ok: false, reason: "BUSY_NOT_RETURNED", busy: [] };
  const busy: GoogleBusyInterval[] = [];
  for (const interval of row.busy) {
    const window = object(interval);
    const start = text(window?.start);
    const end = text(window?.end);
    if (start && end) busy.push({ start, end });
  }
  return { ok: true, reason: null, busy };
}

/**
 * Never throws, because the caller's decision is made on the observed status and the body's error
 * code together, and an exception cannot carry either. Google documents 200 for a processed
 * revocation and "an HTTP status code 400 […] along with an error code" otherwise. A network
 * failure reports status 0 with no code, which is correctly not a confirmation.
 *
 * The posted token appears in no field of the result and in no message on any path.
 */
export async function revokeGoogleGrant(
  input: { token: string },
  { fetch: fetcher = fetch }: GoogleCalendarApiDependencies = {},
): Promise<GoogleRevokeResult> {
  const token = text(input.token);
  if (!token) return { revoked: false, status: 0, errorCode: null };
  let response: Response;
  try {
    response = await fetcher(GOOGLE_OAUTH_REVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ token }),
    });
  } catch {
    return { revoked: false, status: 0, errorCode: null };
  }
  let errorCode: string | null = null;
  try {
    errorCode = text(object(await response.json())?.error);
  } catch {
    errorCode = null;
  }
  return { revoked: response.status === 200, status: response.status, errorCode };
}

/** Whether a stored access token is still usable, with the margin the resolver refreshes inside. */
export function googleAccessTokenIsFresh(tokenExpiresAt: string, now: number) {
  const expiry = Date.parse(tokenExpiresAt);
  return Number.isFinite(expiry) && expiry - now > ACCESS_TOKEN_SAFETY_MARGIN_MS;
}
