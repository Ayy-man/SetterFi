/**
 * Marketplace OAuth: single-use install state, code exchange, and self-refreshing token custody.
 *
 * The provider hands out access tokens that live about a day and refresh tokens that are spent the
 * first time they are used — the refresh call returns a replacement and invalidates the one you
 * sent. That makes two things load-bearing. A refresh must persist both halves of the new grant or
 * the install is permanently lost, and exactly one process may be refreshing a given install at a
 * time, which on serverless means the arbitration has to happen in the database rather than in any
 * one instance's memory.
 *
 * Nothing here reads the process environment directly and nothing logs a token. Every provider call
 * goes through an injected fetch so the whole path is provable without a network.
 */

import { createHash, randomBytes } from "node:crypto";

import type { EnvironmentName } from "@/lib/env-contract";

import {
  decryptCredential,
  encryptCredential,
  type CredentialEnvelopeV1,
} from "./credential-envelope";

export const GHL_OAUTH_BASE_URL = "https://services.leadconnectorhq.com";

/** `agent` is the sub-account app that carries messaging; `provisioning` is the agency app. */
export const GHL_OAUTH_APPS = ["agent", "provisioning"] as const;
export type GhlOAuthApp = (typeof GHL_OAUTH_APPS)[number];

export const GHL_OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_SAFETY_MARGIN_MS = 5 * 60 * 1_000;
const DEFAULT_LEASE_MS = 60 * 1_000;
const DEFAULT_WAIT_ATTEMPTS = 10;
const DEFAULT_WAIT_INTERVAL_MS = 250;

export type GhlOAuthScope = "agency" | "install";

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;
type RandomBytes = (size: number) => Buffer;

export class GhlOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly bodyShape: string | null = null,
  ) {
    super(status === null ? code : `${code} (HTTP ${status})`);
    this.name = "GhlOAuthError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * A boolean the provider actually sent, or nothing. A string, a number, or a missing key all read
 * as `null` rather than being coerced, because the value is a record of a human's choice and the
 * only wrong answer is inventing one.
 */
function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function bodyShape(value: unknown) {
  const record = object(value);
  return record
    ? Object.keys(record).sort().join(",")
    : Array.isArray(value) ? "array" : typeof value;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function ghlOAuthStateHash(state: string) {
  return sha256Hex(state);
}

// ---------------------------------------------------------------------------
// Redirect targets and return paths
// ---------------------------------------------------------------------------

export const GHL_OAUTH_CALLBACK_PATHS: Readonly<Record<GhlOAuthApp, string>> = {
  agent: "/api/channels/messaging/callback",
  provisioning: "/api/channels/messaging/agency-callback",
};

export const GHL_OAUTH_DEFAULT_RETURN_PATHS: Readonly<Record<GhlOAuthApp, string>> = {
  agent: "/coach/integrations",
  provisioning: "/admin/provisioning",
};

export const GHL_OAUTH_INSTALL_URL_NAMES: Readonly<Record<GhlOAuthApp, EnvironmentName>> = {
  agent: "GHL_INSTALL_URL",
  provisioning: "GHL_AGENCY_INSTALL_URL",
};

/**
 * The authorization endpoint our install links point at, and the scope set each app was created
 * with. One list per app, and this is the authoritative copy: `docs/SETUP.md` (GoHighLevel chapter)
 * records the same nine and four scopes as the portal ticks that produced them.
 *
 * Provider documentation, checked 2026-09-02:
 * https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0/ — "you will be able to see the
 * Installation URLs which you will be using to install the APP". The current docs hand you the
 * portal's Install Link and stop there: the host `marketplace.leadconnectorhq.com`, the path
 * `/v2/oauth/chooselocation`, and the `version_id` parameter that both of our stored links carry
 * are **not documented as of 2026-09-02** on that page, on
 * https://marketplace.gohighlevel.com/docs/Authorization/Scopes, on
 * https://marketplace.gohighlevel.com/docs/oauth/CreateMarketplaceApp/ or on
 * https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token/ (the last documents only
 * the `/oauth/token` exchange). Because an app-version selector that may be load-bearing is
 * undocumented, a stored link stays authoritative wherever one is configured and this builder is
 * the fallback — it constructs the same shape minus `version_id`, which is the part we cannot
 * source. Host and path here are copied from the links the portal generated for our two apps on
 * 2026-08-19, not from a doc page.
 */
export const GHL_OAUTH_AUTHORIZATION_ENDPOINT =
  "https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation";

export const GHL_OAUTH_SCOPES: Readonly<Record<GhlOAuthApp, readonly string[]>> = {
  agent: [
    "conversations/message.write",
    "conversations/message.readonly",
    "calendars.readonly",
    "calendars/events.readonly",
    "calendars/events.write",
    "oauth.write",
    "oauth.readonly",
    "phonenumbers.read",
    "phonenumbers.write",
  ],
  provisioning: [
    "locations.write",
    "locations.readonly",
    "snapshots.readonly",
    "phonenumbers.write",
  ],
};

export function ghlAppBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GhlOAuthError("GHL_OAUTH_APP_BASE_URL_INVALID");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new GhlOAuthError("GHL_OAUTH_APP_BASE_URL_INVALID");
  }
  return parsed.origin;
}

export function ghlRedirectUri(app: GhlOAuthApp, appBaseUrl: string) {
  return `${ghlAppBaseUrl(appBaseUrl)}${GHL_OAUTH_CALLBACK_PATHS[app]}`;
}

/**
 * The authorization URL for an app, built from what we hold rather than copied from the portal.
 * Scope order is server-assigned in the portal's own links, so it carries no meaning here either;
 * what has to be right is the set.
 */
export function buildGhlAuthorizationUrl(input: {
  app: GhlOAuthApp;
  appBaseUrl: string;
  clientId: string;
}) {
  const clientId = text(input.clientId);
  if (!clientId) throw new GhlOAuthError("GHL_OAUTH_CLIENT_ID_REQUIRED");
  const url = new URL(GHL_OAUTH_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", ghlRedirectUri(input.app, input.appBaseUrl));
  url.searchParams.set("scope", GHL_OAUTH_SCOPES[input.app].join(" "));
  return url.toString();
}

/** A callback redirect is attacker-influenced input; anything not same-origin is refused. */
export function validateGhlReturnPath(value: string, appBaseUrl: string) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new GhlOAuthError("GHL_OAUTH_RETURN_PATH_INVALID");
  }
  const base = ghlAppBaseUrl(appBaseUrl);
  const parsed = new URL(value, base);
  if (parsed.origin !== base) throw new GhlOAuthError("GHL_OAUTH_RETURN_PATH_INVALID");
  return `${parsed.pathname}${parsed.search}`;
}

// ---------------------------------------------------------------------------
// Single-use install state
// ---------------------------------------------------------------------------

export type GhlOAuthStateRecord = {
  app: GhlOAuthApp;
  stateHash: string;
  tenantId: string | null;
  actorId: string;
  returnPath: string;
  expiresAt: string;
};

export type GhlOAuthStateStore = {
  save(record: GhlOAuthStateRecord): Promise<void>;
  /**
   * Must consume atomically — a second call with the same hash returns null. The app is part of
   * the predicate rather than a check afterwards, so a callback for one app cannot burn a state
   * issued for the other: it matches nothing and leaves the row for the callback it belongs to.
   */
  consume(
    stateHash: string,
    consumedAt: string,
    app: GhlOAuthApp,
  ): Promise<GhlOAuthStateRecord | null>;
  /** Read-only, and called only after a consume matched nothing, to say which of three things it was. */
  describe(stateHash: string): Promise<{ app: GhlOAuthApp; consumedAt: string | null } | null>;
};

export type GhlOAuthStateDependencies = {
  states: GhlOAuthStateStore;
  now?: () => number;
  randomBytes?: RandomBytes;
};

export async function issueGhlOAuthState(
  input: {
    app: GhlOAuthApp;
    actorId: string;
    tenantId?: string | null;
    returnPath?: string | null;
    appBaseUrl: string;
    /**
     * The portal-issued link, when one is configured. It wins over the builder because it carries
     * `version_id`, which the provider does not document and which we therefore cannot reproduce —
     * see `GHL_OAUTH_AUTHORIZATION_ENDPOINT`. Blank or absent falls back to `clientId`.
     */
    installUrl?: string | null;
    clientId?: string | null;
  },
  { states, now = Date.now, randomBytes: generateRandomBytes = randomBytes }: GhlOAuthStateDependencies,
) {
  const actorId = text(input.actorId);
  if (!actorId) throw new GhlOAuthError("GHL_OAUTH_ACTOR_REQUIRED");
  const returnPath = validateGhlReturnPath(
    text(input.returnPath) ?? GHL_OAUTH_DEFAULT_RETURN_PATHS[input.app],
    input.appBaseUrl,
  );
  const state = generateRandomBytes(32).toString("base64url");
  if (!state) throw new GhlOAuthError("GHL_OAUTH_RANDOMNESS_INVALID");
  const expiresAt = new Date(now() + GHL_OAUTH_STATE_TTL_MS).toISOString();
  await states.save({
    app: input.app,
    stateHash: sha256Hex(state),
    tenantId: text(input.tenantId) ?? null,
    actorId,
    returnPath,
    expiresAt,
  });

  // An explicitly configured link is taken verbatim and only added to; otherwise the URL is built
  // from the app's client id and scope list. Either way we set our own redirect and the state we
  // have to be able to recognise on the way back.
  const override = text(input.installUrl);
  let authorization: URL;
  if (override) {
    try {
      authorization = new URL(override);
    } catch {
      throw new GhlOAuthError("GHL_OAUTH_INSTALL_URL_INVALID");
    }
    if (authorization.protocol !== "https:") {
      throw new GhlOAuthError("GHL_OAUTH_INSTALL_URL_INVALID");
    }
  } else {
    authorization = new URL(buildGhlAuthorizationUrl({
      app: input.app,
      appBaseUrl: input.appBaseUrl,
      clientId: text(input.clientId) ?? "",
    }));
  }
  authorization.searchParams.set("redirect_uri", ghlRedirectUri(input.app, input.appBaseUrl));
  authorization.searchParams.set("state", state);
  return { authorizationUrl: authorization.toString(), expiresAt, state };
}

export async function consumeGhlOAuthState(
  input: { app: GhlOAuthApp; state: string },
  { states, now = Date.now }: GhlOAuthStateDependencies,
) {
  const candidate = text(input.state);
  if (!candidate) throw new GhlOAuthError("GHL_OAUTH_STATE_REQUIRED");
  const stateHash = sha256Hex(candidate);
  const consumedAt = new Date(now()).toISOString();
  const record = await states.consume(stateHash, consumedAt, input.app);
  if (!record) {
    // One extra read, only on the path that already failed, and only to name what happened. The
    // three cases land in different places: a replay ends an attempt that already succeeded, a
    // cross-app callback is somebody pointing app 2's redirect at app 1's state, and no row at all
    // is a forgery. Calling all three "invalid or replayed" made the first two unreadable.
    const existing = await states.describe(stateHash);
    if (existing?.app && existing.app !== input.app) {
      throw new GhlOAuthError("GHL_OAUTH_STATE_APP_MISMATCH");
    }
    if (existing?.consumedAt) throw new GhlOAuthError("GHL_OAUTH_STATE_ALREADY_COMPLETED");
    throw new GhlOAuthError("GHL_OAUTH_STATE_INVALID_OR_REPLAYED");
  }
  if (Date.parse(record.expiresAt) <= now()) throw new GhlOAuthError("GHL_OAUTH_STATE_EXPIRED");
  return record;
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export type GhlTokenGrant = {
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
  userType: "Company" | "Location";
  companyId: string | null;
  locationId: string | null;
  /**
   * What the consent screen offered the installer, and what they picked.
   *
   * https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token/ (checked 2026-08-22)
   * documents all three as optional booleans on the token response, with `approveAllLocations`
   * ("user approved all locations during bulk installation") and `installToFutureLocations`
   * ("automatically installed to future locations") returned only for company tokens.
   *
   * Each is `null` when the response did not carry it, and `null` is never collapsed into `false`:
   * a question the provider never answered is a different fact from an installer saying no, and
   * only one of those can be reconstructed later.
   */
  approveAllLocations: boolean | null;
  isBulkInstallation: boolean | null;
  installToFutureLocations: boolean | null;
};

export type GhlOAuthClient = {
  clientId: string;
  clientSecret: string;
};

export type GhlTokenDependencies = {
  fetch?: FetchLike;
  now?: () => number;
};

function normalizeGrant(payload: unknown, now: () => number, status: number): GhlTokenGrant {
  const row = object(payload);
  const accessToken = text(row?.access_token);
  const refreshToken = text(row?.refresh_token);
  const expiresIn = typeof row?.expires_in === "number" ? row.expires_in : null;
  const userType = text(row?.userType);
  if (
    !accessToken
    || !refreshToken
    || expiresIn === null
    || expiresIn <= 0
    || (userType !== "Company" && userType !== "Location")
  ) {
    throw new GhlOAuthError("GHL_OAUTH_TOKEN_ENVELOPE_INVALID", status, bodyShape(payload));
  }
  return {
    accessToken,
    refreshToken,
    tokenExpiresAt: new Date(now() + expiresIn * 1_000).toISOString(),
    userType,
    companyId: text(row?.companyId),
    locationId: text(row?.locationId),
    approveAllLocations: flag(row?.approveAllLocations),
    isBulkInstallation: flag(row?.isBulkInstallation),
    installToFutureLocations: flag(row?.installToFutureLocations),
  };
}

/**
 * The provider documents 400 and 401 on this endpoint and no distinct revocation code. A spent or
 * withdrawn grant lands in that band, so it is treated as terminal: retrying it forever would only
 * burn quota against a token that is never coming back.
 */
function revoked(status: number) {
  return status === 400 || status === 401;
}

async function postTokenEndpoint(
  body: URLSearchParams,
  code: string,
  { fetch: fetcher = fetch, now = Date.now }: GhlTokenDependencies,
) {
  let response: Response;
  try {
    response = await fetcher(`${GHL_OAUTH_BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
  } catch {
    // A fetch failure can carry the requested URL, and this request body holds the client secret.
    throw new GhlOAuthError(`${code}_NETWORK`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GhlOAuthError(`${code}_MALFORMED_JSON`, response.status, "non-json");
  }
  if (!response.ok) {
    throw new GhlOAuthError(
      revoked(response.status) ? "GHL_OAUTH_GRANT_REVOKED" : code,
      response.status,
      bodyShape(payload),
    );
  }
  return normalizeGrant(payload, now, response.status);
}

export function ghlUserType(app: GhlOAuthApp) {
  return app === "provisioning" ? "Company" : "Location";
}

export async function exchangeGhlAuthorizationCode(
  input: {
    app: GhlOAuthApp;
    code: string;
    client: GhlOAuthClient;
    redirectUri: string;
  },
  dependencies: GhlTokenDependencies = {},
) {
  const code = text(input.code);
  if (!code) throw new GhlOAuthError("GHL_OAUTH_CODE_REQUIRED");
  return postTokenEndpoint(
    new URLSearchParams({
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      grant_type: "authorization_code",
      code,
      user_type: ghlUserType(input.app),
      redirect_uri: input.redirectUri,
    }),
    "GHL_OAUTH_TOKEN_EXCHANGE_FAILED",
    dependencies,
  );
}

export async function refreshGhlGrant(
  input: { app: GhlOAuthApp; refreshToken: string; client: GhlOAuthClient },
  dependencies: GhlTokenDependencies = {},
) {
  const refreshToken = text(input.refreshToken);
  if (!refreshToken) throw new GhlOAuthError("GHL_OAUTH_REFRESH_TOKEN_REQUIRED");
  return postTokenEndpoint(
    new URLSearchParams({
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      user_type: ghlUserType(input.app),
    }),
    "GHL_OAUTH_REFRESH_FAILED",
    dependencies,
  );
}

// ---------------------------------------------------------------------------
// Refreshing token custody
// ---------------------------------------------------------------------------

export type GhlCustodyRow = {
  id: string;
  installState: string;
  accessCredentialEnvelope: unknown;
  refreshCredentialEnvelope: unknown;
  tokenExpiresAt: string | null;
  reauthorizationRequiredAt: string | null;
  companyId: string | null;
  /**
   * Only the agency custody loads this, so it is optional rather than nullable-everywhere: the two
   * custodies share this type and a sub-account row has nothing to say about future sub-accounts.
   * `undefined` is "this custody does not carry the field", `null` is "the install never told us".
   */
  installToFutureLocations?: boolean | null;
};

export type GhlRefreshableCustody = {
  load(): Promise<GhlCustodyRow | null>;
  /**
   * Compare-and-set on the stored lease. Postgres serialises the two writers on the row itself, so
   * the loser re-evaluates the predicate against the winner's committed row and matches nothing.
   * That is why this holds across serverless instances where an in-process mutex would not.
   */
  claim(input: { id: string; nowIso: string; leaseUntilIso: string }):
    Promise<(GhlCustodyRow & { leaseToken: string }) | null>;
  /** Extends only the lease this holder still owns; false means the fence rejected it. */
  renew?(input: { id: string; leaseToken: string; nowIso: string; leaseUntilIso: string }):
    Promise<boolean>;
  /**
   * Fenced on the lease this holder took. Resolves false when the predicate matched nothing, which
   * is a different thing from throwing: false means the database refused this write because
   * somebody else owns the row now, and only the caller can decide what to do about that.
   */
  commit(input: {
    id: string;
    leaseToken: string;
    accessCredentialEnvelope: CredentialEnvelopeV1;
    refreshCredentialEnvelope: CredentialEnvelopeV1;
    tokenExpiresAt: string;
  }): Promise<boolean>;
  release(id: string, leaseToken: string): Promise<void>;
  markReauthorizationRequired(
    input: { id: string; at: string; reason: string; leaseToken: string },
  ): Promise<void>;
};

export type GhlRefreshDependencies = {
  custody: GhlRefreshableCustody;
  refresh(refreshToken: string): Promise<GhlTokenGrant>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  encryptCredential?: typeof encryptCredential;
  decryptCredential?: typeof decryptCredential;
  safetyMarginMs?: number;
  leaseMs?: number;
  waitAttempts?: number;
  waitIntervalMs?: number;
};

function scopedCode(scope: GhlOAuthScope, suffix: string) {
  return `${scope === "agency" ? "GHL_AGENCY_INSTALL" : "GHL_INSTALL"}_${suffix}`;
}

function usable(row: GhlCustodyRow, now: number, safetyMarginMs: number) {
  if (!row.tokenExpiresAt) return false;
  const expiry = Date.parse(row.tokenExpiresAt);
  return Number.isFinite(expiry) && expiry - safetyMarginMs > now;
}

/**
 * Returns a live access token, refreshing first when the stored one is expired or close to it.
 *
 * Fails closed in every direction it cannot serve: no install, an uninstalled one, a grant the
 * provider has revoked, or a lease it could not take and whose holder never published a result. It
 * never falls back to a stale token, because a stale token is exactly what the caller asked us to
 * stop handing out.
 */
export async function resolveRefreshingAccessToken(
  scope: GhlOAuthScope,
  {
    custody,
    refresh,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    encryptCredential: encrypt = encryptCredential,
    decryptCredential: decrypt = decryptCredential,
    safetyMarginMs = DEFAULT_SAFETY_MARGIN_MS,
    leaseMs = DEFAULT_LEASE_MS,
    waitAttempts = DEFAULT_WAIT_ATTEMPTS,
    waitIntervalMs = DEFAULT_WAIT_INTERVAL_MS,
  }: GhlRefreshDependencies,
): Promise<string> {
  const row = await custody.load();
  if (!row || row.installState === "uninstalled") {
    throw new GhlOAuthError(scopedCode(scope, "UNAVAILABLE"));
  }
  if (row.reauthorizationRequiredAt) {
    throw new GhlOAuthError(scopedCode(scope, "REAUTHORIZATION_REQUIRED"));
  }
  if (!row.accessCredentialEnvelope || !row.refreshCredentialEnvelope) {
    throw new GhlOAuthError(scopedCode(scope, "CREDENTIAL_UNAVAILABLE"));
  }
  // No stored expiry means the row predates expiry tracking; refuse rather than guess it is live.
  if (row.tokenExpiresAt === null) throw new GhlOAuthError(scopedCode(scope, "EXPIRY_UNKNOWN"));
  if (usable(row, now(), safetyMarginMs)) return decrypt(row.accessCredentialEnvelope);

  const claimedAt = now();
  const claimed = await custody.claim({
    id: row.id,
    nowIso: new Date(claimedAt).toISOString(),
    leaseUntilIso: new Date(claimedAt + leaseMs).toISOString(),
  });

  if (!claimed) {
    // Another instance holds the single-use refresh token. Wait for its result instead of
    // spending the token a second time, then fail closed if it never published one.
    for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
      await sleep(waitIntervalMs);
      const reread = await custody.load();
      if (!reread || reread.installState === "uninstalled") {
        throw new GhlOAuthError(scopedCode(scope, "UNAVAILABLE"));
      }
      if (reread.reauthorizationRequiredAt) {
        throw new GhlOAuthError(scopedCode(scope, "REAUTHORIZATION_REQUIRED"));
      }
      if (usable(reread, now(), safetyMarginMs)) return decrypt(reread.accessCredentialEnvelope);
    }
    throw new GhlOAuthError(scopedCode(scope, "REFRESH_LOCK_UNAVAILABLE"));
  }

  // The lease may have been handed over by a writer that already rotated the grant.
  if (usable(claimed, now(), safetyMarginMs)) {
    await custody.release(claimed.id, claimed.leaseToken);
    return decrypt(claimed.accessCredentialEnvelope);
  }

  let grant: GhlTokenGrant;
  let heartbeatStopped = false;
  let pendingRenewal: Promise<void> = Promise.resolve();
  const heartbeatIntervalMs = Math.max(10, Math.floor(leaseMs / 3));
  const heartbeat = custody.renew
    ? setInterval(() => {
        pendingRenewal = pendingRenewal.then(async () => {
          if (heartbeatStopped || !custody.renew) return;
          const renewedAt = now();
          await custody.renew({
            id: claimed.id,
            leaseToken: claimed.leaseToken,
            nowIso: new Date(renewedAt).toISOString(),
            leaseUntilIso: new Date(renewedAt + leaseMs).toISOString(),
          });
        }).catch(() => undefined);
      }, heartbeatIntervalMs)
    : null;
  try {
    grant = await refresh(decrypt(claimed.refreshCredentialEnvelope));
  } catch (error) {
    heartbeatStopped = true;
    if (heartbeat) clearInterval(heartbeat);
    await pendingRenewal;
    if (error instanceof GhlOAuthError && error.code === "GHL_OAUTH_GRANT_REVOKED") {
      await custody.markReauthorizationRequired({
        id: claimed.id,
        at: new Date(now()).toISOString(),
        reason: "GHL_OAUTH_GRANT_REVOKED",
        leaseToken: claimed.leaseToken,
      });
      throw new GhlOAuthError(scopedCode(scope, "REAUTHORIZATION_REQUIRED"));
    }
    await custody.release(claimed.id, claimed.leaseToken);
    throw error;
  }
  heartbeatStopped = true;
  if (heartbeat) clearInterval(heartbeat);
  await pendingRenewal;

  // Both halves land in one write. Dropping the rotated refresh token loses the install for good.
  const committed = await custody.commit({
    id: claimed.id,
    leaseToken: claimed.leaseToken,
    accessCredentialEnvelope: encrypt(grant.accessToken),
    refreshCredentialEnvelope: encrypt(grant.refreshToken),
    tokenExpiresAt: grant.tokenExpiresAt,
  });
  if (!committed) {
    // The lease ran out while this call was at the provider and another instance took the row
    // over. The grant in hand is deliberately thrown away rather than written: the winner has
    // already persisted a grant the provider honoured, and overwriting it with this one would
    // strand a refresh token nobody holds. What is lost is this call's rotation, which is the
    // cheaper of the two — so read back what the winner left and serve that if it is usable.
    const winner = await custody.load();
    if (winner && !winner.reauthorizationRequiredAt && usable(winner, now(), safetyMarginMs)) {
      return decrypt(winner.accessCredentialEnvelope);
    }
    throw new GhlOAuthError(scopedCode(scope, "LEASE_LOST"));
  }
  return grant.accessToken;
}
