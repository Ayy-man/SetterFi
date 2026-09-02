/**
 * Live Supabase custody for the Google Calendar grant and its single-use authorization state.
 *
 * The split with `google-calendar-oauth.ts` is deliberate and holds in both directions: that module
 * knows the shape of every request to Google and nothing about a database, and this one knows every
 * column and nothing about HTTP beyond calling that module. Everything here runs under the service
 * role against forced-RLS, service-only tables.
 *
 * ---------------------------------------------------------------------------------------------
 * No lease, and why that is not an omission
 * ---------------------------------------------------------------------------------------------
 * `ghl-oauth-store.ts` carries a compare-and-set lease, a heartbeat and a wait-for-the-winner loop
 * because a GoHighLevel refresh token is single-use: the refresh call returns a replacement and
 * invalidates what was sent, so exactly one instance may ever spend it. Google does not rotate. Its
 * documented refresh response carries access_token, expires_in, scope and token_type, refresh_token
 * is not among them, and the same page says to keep using the stored token as long as it remains
 * valid.
 *   https://developers.google.com/identity/protocols/oauth2/web-server (read 2026-09-02)
 * Two concurrent refreshes here cost one wasted HTTP call and nothing else, so `resolveGoogleAccess
 * Token` is a plain read-decrypt-POST-write-back. Do not "restore symmetry" with the GHL custody:
 * the symmetry would be a claim about Google that this page contradicts, and the migration header
 * for `google_calendar_grants` records the same reasoning against the missing lease column.
 *
 * A failed Supabase call returns `{ error }` rather than throwing, so every call here reads the
 * error object. A catch-only guard around one of these is blind.
 *
 * Nothing here logs. A plaintext token exists only inside a local variable and only for as long as
 * the call that needs it; every column holds a V1 AES-256-GCM envelope.
 */

import {
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import { decryptCredential, encryptCredential } from "./credential-envelope";
import {
  GoogleCalendarOAuthError,
  googleAccessTokenIsFresh,
  isGoogleInvalidGrant,
  refreshGoogleAccessToken,
  type GoogleOAuthClient,
  type GoogleOAuthStateRecord,
  type GoogleOAuthStateStore,
} from "./google-calendar-oauth";

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

export const GOOGLE_CALENDAR_OAUTH_CONFIGURATION_NAMES = [
  "APP_BASE_URL",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
] as const;

export type GoogleCalendarOAuthConfiguration = {
  appBaseUrl: string;
  client: GoogleOAuthClient;
};

/** Names only on a failure — the values never leave this function's return value. */
export function googleCalendarOAuthConfiguration(
  environment: EnvironmentSource = process.env,
): GoogleCalendarOAuthConfiguration {
  const values = requireEnvironment(
    "calendar",
    GOOGLE_CALENDAR_OAUTH_CONFIGURATION_NAMES,
    environment,
  );
  return {
    appBaseUrl: values.APP_BASE_URL,
    client: {
      clientId: values.GOOGLE_CALENDAR_CLIENT_ID,
      clientSecret: values.GOOGLE_CALENDAR_CLIENT_SECRET,
    },
  };
}

// ---------------------------------------------------------------------------
// Authorization state
// ---------------------------------------------------------------------------

const STATE_COLUMNS = "state_hash, tenant_id, actor_id, return_path, expires_at";

type StateRow = {
  state_hash: string;
  tenant_id: string;
  actor_id: string;
  return_path: string;
  expires_at: string;
};

function stateRecord(row: StateRow): GoogleOAuthStateRecord {
  return {
    stateHash: row.state_hash,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    returnPath: row.return_path,
    expiresAt: row.expires_at,
  };
}

export function createGoogleOAuthStateStore(
  client: ServiceClient = createSupabaseServiceClient(),
): GoogleOAuthStateStore {
  return {
    save: async (record) => {
      const { error } = await client.from("google_oauth_states").insert({
        state_hash: record.stateHash,
        tenant_id: record.tenantId,
        actor_id: record.actorId,
        return_path: record.returnPath,
        expires_at: record.expiresAt,
      });
      if (error) throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_STATE_WRITE_FAILED");
    },
    consume: async (stateHash, consumedAt) => {
      // Single-use is the predicate on the write, not a read followed by a write. The `is null`
      // sits inside the same statement that stamps the column, so two callbacks racing the same
      // state produce one winner in Postgres. A select-then-update version would pass every test
      // written for it and still be racy in production, which is the whole reason this is here.
      const { data, error } = await client
        .from("google_oauth_states")
        .update({ consumed_at: consumedAt })
        .eq("state_hash", stateHash)
        .is("consumed_at", null)
        .select(STATE_COLUMNS)
        .maybeSingle();
      if (error) throw new GoogleCalendarOAuthError("GOOGLE_OAUTH_STATE_CONSUME_FAILED");
      return data ? stateRecord(data as unknown as StateRow) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Grant custody
// ---------------------------------------------------------------------------

const GRANT_COLUMNS =
  "id, tenant_id, google_account_email, access_credential_envelope,"
  + " refresh_credential_envelope, granted_scopes, token_expires_at, refresh_token_expires_at,"
  + " pending_calendars, reauthorization_required_at, revoked_at";

/**
 * An eligible calendar between the grant and the coach's pick. `timeZone` is a string here and not
 * a nullable one on purpose: `calendarList` may omit it, and an entry that omits it is filtered out
 * before storage rather than given a substituted zone.
 */
export type GooglePendingCalendar = {
  id: string;
  name: string;
  timeZone: string;
};

export type GoogleCalendarGrantRow = {
  id: string;
  tenantId: string;
  googleAccountEmail: string | null;
  /** Encrypted envelopes, exactly as stored. Nothing outside this module decrypts either one. */
  accessCredentialEnvelope: unknown;
  refreshCredentialEnvelope: unknown;
  grantedScopes: readonly string[];
  tokenExpiresAt: string;
  refreshTokenExpiresAt: string | null;
  pendingCalendars: readonly GooglePendingCalendar[];
  reauthorizationRequiredAt: string | null;
  revokedAt: string | null;
};

type GrantRow = {
  id: string;
  tenant_id: string;
  google_account_email: string | null;
  access_credential_envelope: unknown;
  refresh_credential_envelope: unknown;
  granted_scopes: string[] | null;
  token_expires_at: string;
  refresh_token_expires_at: string | null;
  pending_calendars: unknown;
  reauthorization_required_at: string | null;
  revoked_at: string | null;
};

export function googlePendingCalendars(value: unknown): readonly GooglePendingCalendar[] {
  if (!Array.isArray(value)) return [];
  const calendars: GooglePendingCalendar[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const timeZone = typeof row.timeZone === "string" ? row.timeZone.trim() : "";
    if (!id || !name || !timeZone) continue;
    calendars.push({ id, name, timeZone });
  }
  return calendars;
}

function grantRow(row: GrantRow): GoogleCalendarGrantRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    googleAccountEmail: row.google_account_email,
    accessCredentialEnvelope: row.access_credential_envelope,
    refreshCredentialEnvelope: row.refresh_credential_envelope,
    grantedScopes: row.granted_scopes ?? [],
    tokenExpiresAt: row.token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    pendingCalendars: googlePendingCalendars(row.pending_calendars),
    reauthorizationRequiredAt: row.reauthorization_required_at,
    revokedAt: row.revoked_at,
  };
}

export type PersistGoogleCalendarGrantInput = {
  tenantId: string;
  googleAccountEmail: string | null;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
  refreshTokenExpiresAt: string | null;
  grantedScopes: readonly string[];
  pendingCalendars: readonly GooglePendingCalendar[];
};

/**
 * One row per tenant, replaced rather than accumulated. Google caps refresh tokens at 100 per
 * account per client, so a reconnect that minted a second row would spend that budget on rows
 * nothing reads.
 */
export async function persistGoogleCalendarGrant(
  input: PersistGoogleCalendarGrantInput,
  client: ServiceClient = createSupabaseServiceClient(),
  environment: EnvironmentSource = process.env,
): Promise<GoogleCalendarGrantRow> {
  const { data, error } = await client
    .from("google_calendar_grants")
    .upsert(
      {
        tenant_id: input.tenantId,
        google_account_email: input.googleAccountEmail,
        access_credential_envelope: encryptCredential(input.accessToken, environment),
        refresh_credential_envelope: encryptCredential(input.refreshToken, environment),
        granted_scopes: [...input.grantedScopes],
        token_expires_at: input.tokenExpiresAt,
        refresh_token_expires_at: input.refreshTokenExpiresAt,
        pending_calendars: input.pendingCalendars,
        // A fresh consent clears whatever the previous grant died of, so a reconnect does not
        // inherit an expiry marker that no longer describes anything.
        reauthorization_required_at: null,
        revoked_at: null,
        last_error: null,
      },
      { onConflict: "tenant_id" },
    )
    .select(GRANT_COLUMNS)
    .single();
  if (error || !data) throw new GoogleCalendarOAuthError("GOOGLE_CALENDAR_GRANT_WRITE_FAILED");
  return grantRow(data as unknown as GrantRow);
}

export async function loadGoogleCalendarGrant(
  tenantId: string,
  client: ServiceClient = createSupabaseServiceClient(),
): Promise<GoogleCalendarGrantRow | null> {
  const { data, error } = await client
    .from("google_calendar_grants")
    .select(GRANT_COLUMNS)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new GoogleCalendarOAuthError("GOOGLE_CALENDAR_GRANT_LOOKUP_FAILED");
  return data ? grantRow(data as unknown as GrantRow) : null;
}

/** Idempotent: a tenant with no grant is the state the caller wanted, not a failure. */
export async function deleteGoogleCalendarGrant(
  tenantId: string,
  client: ServiceClient = createSupabaseServiceClient(),
): Promise<void> {
  const { error } = await client
    .from("google_calendar_grants")
    .delete()
    .eq("tenant_id", tenantId);
  if (error) throw new GoogleCalendarOAuthError("GOOGLE_CALENDAR_GRANT_DELETE_FAILED");
}

/**
 * The refresh token in plaintext, for the one caller that must post it to Google's revoke endpoint.
 * It is returned rather than stored anywhere, and no caller may put it in a response body, a
 * receipt, a log line or a column.
 */
export function decryptGoogleRefreshToken(
  grant: GoogleCalendarGrantRow,
  environment: EnvironmentSource = process.env,
) {
  return decryptCredential(grant.refreshCredentialEnvelope, environment);
}

export type ResolveGoogleAccessTokenDependencies = {
  client?: ServiceClient;
  environment?: EnvironmentSource;
  now?: () => number;
  refresh?: typeof refreshGoogleAccessToken;
  fetch?: typeof fetch;
};

export type ResolvedGoogleAccessToken = {
  accessToken: string;
  grant: GoogleCalendarGrantRow;
  refreshed: boolean;
};

/**
 * A usable access token for the tenant's grant, refreshing inside the safety margin.
 *
 * `invalid_grant` is terminal and is the only condition that changes what the product claims: the
 * grant is marked as needing reauthorization and the tenant's primary Google connection moves to
 * `expired`, so a dead grant surfaces on the page instead of failing silently at the first booking.
 * That write touches none of the three health columns, so `calendar_health_shape_chk` still holds.
 */
export async function resolveGoogleAccessToken(
  input: { tenantId: string; grant?: GoogleCalendarGrantRow },
  dependencies: ResolveGoogleAccessTokenDependencies = {},
): Promise<ResolvedGoogleAccessToken> {
  const client = dependencies.client ?? createSupabaseServiceClient();
  const environment = dependencies.environment ?? process.env;
  const now = dependencies.now ?? Date.now;
  const refresh = dependencies.refresh ?? refreshGoogleAccessToken;
  const grant = input.grant ?? await loadGoogleCalendarGrant(input.tenantId, client);
  if (!grant) throw new GoogleCalendarOAuthError("GOOGLE_CALENDAR_GRANT_NOT_FOUND");

  if (googleAccessTokenIsFresh(grant.tokenExpiresAt, now())) {
    return {
      accessToken: decryptCredential(grant.accessCredentialEnvelope, environment),
      grant,
      refreshed: false,
    };
  }

  const configuration = googleCalendarOAuthConfiguration(environment);
  let renewed: Awaited<ReturnType<typeof refreshGoogleAccessToken>>;
  try {
    renewed = await refresh(
      {
        refreshToken: decryptCredential(grant.refreshCredentialEnvelope, environment),
        client: configuration.client,
      },
      { fetch: dependencies.fetch, now },
    );
  } catch (cause) {
    if (isGoogleInvalidGrant(cause)) {
      await markGoogleGrantExpired(grant.tenantId, new Date(now()).toISOString(), client);
    }
    throw cause;
  }

  // Only the access half moves. The stored refresh envelope is untouched because Google returned
  // no replacement for it and the caller is documented to keep using the one it holds.
  const { error } = await client
    .from("google_calendar_grants")
    .update({
      access_credential_envelope: encryptCredential(renewed.accessToken, environment),
      token_expires_at: renewed.expiresAt,
      last_error: null,
    })
    .eq("tenant_id", grant.tenantId);
  if (error) throw new GoogleCalendarOAuthError("GOOGLE_CALENDAR_GRANT_WRITE_FAILED");

  return {
    accessToken: renewed.accessToken,
    grant: { ...grant, tokenExpiresAt: renewed.expiresAt },
    refreshed: true,
  };
}

/**
 * Records a grant the provider has already refused, on both rows that describe it.
 *
 * `last_error` carries our own code and never provider prose. The connection update writes no
 * health column, so a connection that had a passing availability read keeps that history while its
 * state says the authorization is gone.
 */
export async function markGoogleGrantExpired(
  tenantId: string,
  atIso: string,
  client: ServiceClient = createSupabaseServiceClient(),
): Promise<void> {
  const { error } = await client
    .from("google_calendar_grants")
    .update({
      reauthorization_required_at: atIso,
      last_error: "GOOGLE_OAUTH_GRANT_INVALID",
    })
    .eq("tenant_id", tenantId);
  if (error) throw new GoogleCalendarOAuthError("GOOGLE_CALENDAR_GRANT_WRITE_FAILED");
  const { error: connectionError } = await client
    .from("calendar_connections")
    .update({ state: "expired" })
    .eq("tenant_id", tenantId)
    .eq("provider", "google")
    .eq("is_primary", true);
  if (connectionError) throw new GoogleCalendarOAuthError("CALENDAR_CONNECTION_EXPIRY_WRITE_FAILED");
}
