/**
 * Live Supabase custody for marketplace installs.
 *
 * Everything here runs under the service role against forced-RLS, service-only tables. The two
 * writes that matter are both compare-and-set: consuming an install state, and taking the refresh
 * lease. Postgres arbitrates each of them on a single row, which is what makes them correct when
 * several serverless instances race — an in-process guard would only ever protect one instance.
 */

import { randomUUID } from "node:crypto";

import {
  environmentValue,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import { encryptCredential, type CredentialEnvelopeV1 } from "./credential-envelope";
import {
  GhlOAuthError,
  GHL_OAUTH_INSTALL_URL_NAMES,
  refreshGhlGrant,
  resolveRefreshingAccessToken,
  type GhlCustodyRow,
  type GhlOAuthApp,
  type GhlOAuthClient,
  type GhlOAuthStateRecord,
  type GhlOAuthStateStore,
  type GhlRefreshableCustody,
  type GhlTokenGrant,
} from "./ghl-oauth";
import {
  GHL_AGENCY_OAUTH_CONFIGURATION_NAMES,
  GHL_AGENT_OAUTH_CONFIGURATION_NAMES,
} from "./selector";

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

const AGENCY_COLUMNS =
  "id, app, company_id, install_state, access_credential_envelope, refresh_credential_envelope,"
  + " token_expires_at, reauthorization_required_at, install_to_future_locations";

export type GhlOAuthConfiguration = {
  appBaseUrl: string;
  installUrl: string;
  client: GhlOAuthClient;
};

/** Names only — the values never leave this function's return value. */
export function ghlOAuthConfiguration(
  app: GhlOAuthApp,
  environment: EnvironmentSource = process.env,
): GhlOAuthConfiguration {
  if (app === "provisioning") {
    const values = requireEnvironment(
      "ghl_provisioning",
      GHL_AGENCY_OAUTH_CONFIGURATION_NAMES,
      environment,
    );
    return {
      appBaseUrl: values.APP_BASE_URL,
      installUrl: values.GHL_AGENCY_INSTALL_URL,
      client: {
        clientId: values.GHL_AGENCY_CLIENT_ID,
        clientSecret: values.GHL_AGENCY_CLIENT_SECRET,
      },
    };
  }
  const values = requireEnvironment("ghl", GHL_AGENT_OAUTH_CONFIGURATION_NAMES, environment);
  return {
    appBaseUrl: values.APP_BASE_URL,
    installUrl: values.GHL_INSTALL_URL,
    client: { clientId: values.GHL_CLIENT_ID, clientSecret: values.GHL_CLIENT_SECRET },
  };
}

export { GHL_OAUTH_INSTALL_URL_NAMES };

// ---------------------------------------------------------------------------
// Install state
// ---------------------------------------------------------------------------

type StateRow = {
  app: string;
  state_hash: string;
  tenant_id: string | null;
  actor_id: string;
  return_path: string;
  expires_at: string;
};

function stateRecord(row: StateRow): GhlOAuthStateRecord {
  if (row.app !== "agent" && row.app !== "provisioning") {
    throw new GhlOAuthError("GHL_OAUTH_STATE_APP_UNSUPPORTED");
  }
  return {
    app: row.app,
    stateHash: row.state_hash,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    returnPath: row.return_path,
    expiresAt: row.expires_at,
  };
}

export function createGhlOAuthStateStore(
  client: ServiceClient = createSupabaseServiceClient(),
): GhlOAuthStateStore {
  return {
    save: async (record) => {
      const { error } = await client.from("ghl_oauth_states").insert({
        app: record.app,
        state_hash: record.stateHash,
        tenant_id: record.tenantId,
        actor_id: record.actorId,
        return_path: record.returnPath,
        expires_at: record.expiresAt,
      });
      if (error) throw new GhlOAuthError("GHL_OAUTH_STATE_WRITE_FAILED");
    },
    consume: async (stateHash, consumedAt, app) => {
      // Single-use is enforced by the predicate, not by reading first and writing after. The app
      // is in the same predicate, so a cross-app callback consumes nothing rather than spending a
      // state the other callback is still owed.
      const { data, error } = await client
        .from("ghl_oauth_states")
        .update({ consumed_at: consumedAt })
        .eq("state_hash", stateHash)
        .eq("app", app)
        .is("consumed_at", null)
        .select("app, state_hash, tenant_id, actor_id, return_path, expires_at")
        .maybeSingle();
      if (error) throw new GhlOAuthError("GHL_OAUTH_STATE_CONSUME_FAILED");
      return data ? stateRecord(data as unknown as StateRow) : null;
    },
    describe: async (stateHash) => {
      const { data, error } = await client
        .from("ghl_oauth_states")
        .select("app, consumed_at")
        .eq("state_hash", stateHash)
        .maybeSingle();
      if (error) throw new GhlOAuthError("GHL_OAUTH_STATE_LOOKUP_FAILED");
      if (!data) return null;
      const row = data as unknown as { app: string; consumed_at: string | null };
      if (row.app !== "agent" && row.app !== "provisioning") {
        throw new GhlOAuthError("GHL_OAUTH_STATE_APP_UNSUPPORTED");
      }
      return { app: row.app, consumedAt: row.consumed_at };
    },
  };
}

// ---------------------------------------------------------------------------
// Agency install custody
// ---------------------------------------------------------------------------

type AgencyRow = {
  id: string;
  app: string;
  company_id: string;
  install_state: string;
  access_credential_envelope: unknown;
  refresh_credential_envelope: unknown;
  token_expires_at: string | null;
  reauthorization_required_at: string | null;
  install_to_future_locations?: boolean | null;
};

function agencyCustodyRow(row: AgencyRow): GhlCustodyRow {
  return {
    id: row.id,
    installState: row.install_state,
    accessCredentialEnvelope: row.access_credential_envelope,
    refreshCredentialEnvelope: row.refresh_credential_envelope,
    tokenExpiresAt: row.token_expires_at,
    reauthorizationRequiredAt: row.reauthorization_required_at,
    companyId: row.company_id,
    // `??` on purpose: a row read before the column existed, or a select that did not ask for it,
    // is unknown — the same value the column itself holds for an install that never told us.
    installToFutureLocations: row.install_to_future_locations ?? null,
  };
}

/**
 * Custody for one app's grant on one agency.
 *
 * `app` is the third parameter and defaults to `provisioning` on purpose: `/admin/provisioning`
 * calls this with a company of `null` and no app, and that call has to keep meaning the agency
 * app's row now that two rows can share a `company_id` — otherwise its `.maybeSingle()` starts
 * erroring the moment the agent app's Company grant lands.
 */
export function createGhlAgencyInstallCustody(
  companyId: string | null,
  client: ServiceClient = createSupabaseServiceClient(),
  app: GhlOAuthApp = "provisioning",
): GhlRefreshableCustody {
  const select = () => {
    const query = client.from("ghl_agency_installs").select(AGENCY_COLUMNS).eq("app", app);
    return companyId ? query.eq("company_id", companyId) : query.limit(1);
  };
  return {
    load: async () => {
      const { data, error } = await select().maybeSingle();
      if (error) throw new GhlOAuthError("GHL_AGENCY_INSTALL_LOOKUP_FAILED");
      return data ? agencyCustodyRow(data as unknown as AgencyRow) : null;
    },
    claim: async ({ id, nowIso, leaseUntilIso }) => {
      // The lease gets an identity here and nowhere else, so every later write can name the lease
      // it believes it holds rather than trusting that it still holds one.
      const leaseToken = randomUUID();
      const { data, error } = await client
        .from("ghl_agency_installs")
        .update({ refresh_lock_expires_at: leaseUntilIso, refresh_lock_token: leaseToken })
        .eq("id", id)
        .eq("app", app)
        .or(`refresh_lock_expires_at.is.null,refresh_lock_expires_at.lt."${nowIso}"`)
        .select(AGENCY_COLUMNS)
        .maybeSingle();
      if (error) throw new GhlOAuthError("GHL_AGENCY_INSTALL_LOCK_FAILED");
      return data ? { ...agencyCustodyRow(data as unknown as AgencyRow), leaseToken } : null;
    },
    renew: async ({ id, leaseToken, nowIso, leaseUntilIso }) => {
      const { data, error } = await client
        .from("ghl_agency_installs")
        .update({ refresh_lock_expires_at: leaseUntilIso })
        .eq("id", id)
        .eq("app", app)
        .eq("refresh_lock_token", leaseToken)
        .gt("refresh_lock_expires_at", nowIso)
        .select("id")
        .maybeSingle();
      if (error) throw new GhlOAuthError("GHL_AGENCY_INSTALL_LOCK_RENEW_FAILED");
      return data !== null;
    },
    commit: async ({ id, leaseToken, accessCredentialEnvelope, refreshCredentialEnvelope, tokenExpiresAt }) => {
      // One row, one statement: the rotated refresh token can never be persisted without the
      // access token it came with. Fenced on the lease, so a holder whose sixty seconds ran out
      // cannot land this on top of the grant that replaced it.
      const { data, error } = await client
        .from("ghl_agency_installs")
        .update({
          access_credential_envelope: accessCredentialEnvelope,
          refresh_credential_envelope: refreshCredentialEnvelope,
          token_expires_at: tokenExpiresAt,
          install_state: "token_ok",
          refresh_lock_expires_at: null,
          refresh_lock_token: null,
          last_error: null,
        })
        .eq("id", id)
        .eq("app", app)
        .eq("refresh_lock_token", leaseToken)
        .select("id")
        .maybeSingle();
      if (error) throw new GhlOAuthError("GHL_AGENCY_INSTALL_COMMIT_FAILED");
      return data !== null;
    },
    release: async (id, leaseToken) => {
      await client
        .from("ghl_agency_installs")
        .update({ refresh_lock_expires_at: null, refresh_lock_token: null })
        .eq("id", id)
        .eq("app", app)
        .eq("refresh_lock_token", leaseToken);
    },
    markReauthorizationRequired: async ({ id, at, reason, leaseToken }) => {
      const { data: fenced } = await client
        .from("ghl_agency_installs")
        .update({
          install_state: "failed",
          reauthorization_required_at: at,
          refresh_lock_expires_at: null,
          refresh_lock_token: null,
          last_error: reason,
        })
        .eq("id", id)
        .eq("app", app)
        .eq("refresh_lock_token", leaseToken)
        .select("id")
        .maybeSingle();
      // Only if the fence let the write through. A stale holder that could not fail the install
      // must not leave an audit row saying it did.
      if (!fenced) return;
      await client.from("audit_log").insert({
        actor_id: null,
        tenant_id: null,
        action: "platform.provisioning_install.reauthorization_required",
        target_type: "ghl_agency_install",
        target_id: id,
        payload: { before: { install_state: "token_ok" }, after: { install_state: "failed", reason } },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Sub-account install custody
// ---------------------------------------------------------------------------

type InstallRow = {
  id: string;
  tenant_id: string | null;
  company_id: string;
  install_state: string;
  token_expires_at: string | null;
  reauthorization_required_at: string | null;
};

async function loadInstallCustody(client: ServiceClient, locationId: string) {
  const { data: install, error } = await client
    .from("ghl_installs")
    .select("id, tenant_id, company_id, install_state, token_expires_at, reauthorization_required_at")
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) throw new GhlOAuthError("GHL_INSTALL_LOOKUP_FAILED");
  if (!install) return null;
  const { data: secret, error: secretError } = await client
    .from("ghl_install_secrets")
    .select("access_credential_envelope, refresh_credential_envelope")
    .eq("ghl_install_id", (install as unknown as InstallRow).id)
    .maybeSingle();
  if (secretError) throw new GhlOAuthError("GHL_INSTALL_SECRET_LOOKUP_FAILED");
  const row = install as unknown as InstallRow;
  return {
    id: row.id,
    installState: row.install_state,
    accessCredentialEnvelope: secret?.access_credential_envelope ?? null,
    refreshCredentialEnvelope: secret?.refresh_credential_envelope ?? null,
    tokenExpiresAt: row.token_expires_at,
    reauthorizationRequiredAt: row.reauthorization_required_at,
    companyId: row.company_id,
    tenantId: row.tenant_id,
  };
}

export function createGhlSubAccountInstallCustody(
  locationId: string,
  client: ServiceClient = createSupabaseServiceClient(),
): GhlRefreshableCustody {
  return {
    load: async () => loadInstallCustody(client, locationId),
    claim: async ({ id, nowIso, leaseUntilIso }) => {
      const leaseToken = randomUUID();
      const { data, error } = await client
        .from("ghl_install_secrets")
        .update({ refresh_lock_expires_at: leaseUntilIso, refresh_lock_token: leaseToken })
        .eq("ghl_install_id", id)
        .or(`refresh_lock_expires_at.is.null,refresh_lock_expires_at.lt."${nowIso}"`)
        .select("ghl_install_id")
        .maybeSingle();
      if (error) throw new GhlOAuthError("GHL_INSTALL_LOCK_FAILED");
      if (!data) return null;
      const row = await loadInstallCustody(client, locationId);
      return row ? { ...row, leaseToken } : null;
    },
    renew: async ({ id, leaseToken, nowIso, leaseUntilIso }) => {
      const { data, error } = await client
        .from("ghl_install_secrets")
        .update({ refresh_lock_expires_at: leaseUntilIso })
        .eq("ghl_install_id", id)
        .eq("refresh_lock_token", leaseToken)
        .gt("refresh_lock_expires_at", nowIso)
        .select("ghl_install_id")
        .maybeSingle();
      if (error) throw new GhlOAuthError("GHL_INSTALL_LOCK_RENEW_FAILED");
      return data !== null;
    },
    commit: async ({ id, leaseToken, accessCredentialEnvelope, refreshCredentialEnvelope, tokenExpiresAt }) => {
      // Secrets first, and fenced there, because the lease lives on this table. If the metadata
      // mirror then fails, the next resolve refreshes again using the token we just stored — one
      // wasted round trip. The reverse order would hand out an expired access token behind a
      // fresh-looking expiry.
      const { data: fenced, error: secretError } = await client
        .from("ghl_install_secrets")
        .update({
          access_credential_envelope: accessCredentialEnvelope,
          refresh_credential_envelope: refreshCredentialEnvelope,
          refresh_lock_expires_at: null,
          refresh_lock_token: null,
          updated_at: new Date().toISOString(),
        })
        .eq("ghl_install_id", id)
        .eq("refresh_lock_token", leaseToken)
        .select("ghl_install_id")
        .maybeSingle();
      if (secretError) throw new GhlOAuthError("GHL_INSTALL_COMMIT_FAILED");
      // Fenced out before the mirror, so a stale holder cannot move the expiry either.
      if (!fenced) return false;
      const { error } = await client
        .from("ghl_installs")
        .update({ token_expires_at: tokenExpiresAt, install_state: "token_ok", last_error: null })
        .eq("id", id);
      if (error) throw new GhlOAuthError("GHL_INSTALL_COMMIT_FAILED");
      return true;
    },
    release: async (id, leaseToken) => {
      await client
        .from("ghl_install_secrets")
        .update({ refresh_lock_expires_at: null, refresh_lock_token: null })
        .eq("ghl_install_id", id)
        .eq("refresh_lock_token", leaseToken);
    },
    markReauthorizationRequired: async ({ id, at, reason, leaseToken }) => {
      const { data: fenced } = await client
        .from("ghl_install_secrets")
        .update({ refresh_lock_expires_at: null, refresh_lock_token: null })
        .eq("ghl_install_id", id)
        .eq("refresh_lock_token", leaseToken)
        .select("ghl_install_id")
        .maybeSingle();
      if (!fenced) return;
      const { data } = await client
        .from("ghl_installs")
        .update({ install_state: "failed", reauthorization_required_at: at, last_error: reason })
        .eq("id", id)
        .select("tenant_id")
        .maybeSingle();
      await client.from("audit_log").insert({
        actor_id: null,
        tenant_id: (data as { tenant_id: string | null } | null)?.tenant_id ?? null,
        action: "channel.messaging_install.reauthorization_required",
        target_type: "ghl_install",
        target_id: id,
        payload: { before: { install_state: "token_ok" }, after: { install_state: "failed", reason } },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Persisting a completed install
// ---------------------------------------------------------------------------

/**
 * What the consent screen offered the installer, written as a receipt of the install it came from.
 *
 * Straight through from the token response, `null` included: a flag the provider did not send is
 * stored as unanswered rather than as a no, because those are different facts and only the second
 * one is a decision anybody made. Written on install and never on refresh — a refresh reports the
 * grant's current shape, while this row is a record of one consent screen at one moment.
 */
function installShapeColumns(grant: GhlTokenGrant) {
  return {
    approve_all_locations: grant.approveAllLocations,
    is_bulk_installation: grant.isBulkInstallation,
    install_to_future_locations: grant.installToFutureLocations,
  };
}

export type PersistedGhlInstall = {
  id: string;
  companyId: string;
  locationId: string | null;
  tenantId: string | null;
};

/**
 * Idempotent on `(app, company_id)`: a replayed code or a re-install overwrites that app's row and
 * never duplicates it, and never overwrites the other app's grant for the same agency. Both apps
 * can return a Company grant for one company, and they are separate credentials — the one this
 * writes is decided by the callback that received it, not by the company the grant names.
 */
export async function persistGhlAgencyInstall(
  grant: GhlTokenGrant,
  app: GhlOAuthApp,
  client: ServiceClient = createSupabaseServiceClient(),
  encrypt: (value: string) => CredentialEnvelopeV1 = encryptCredential,
): Promise<PersistedGhlInstall> {
  const companyId = grant.companyId;
  if (!companyId) throw new GhlOAuthError("GHL_AGENCY_INSTALL_COMPANY_UNKNOWN");
  const { data, error } = await client
    .from("ghl_agency_installs")
    .upsert({
      app,
      company_id: companyId,
      install_state: "token_ok",
      access_credential_envelope: encrypt(grant.accessToken),
      refresh_credential_envelope: encrypt(grant.refreshToken),
      token_expires_at: grant.tokenExpiresAt,
      refresh_lock_expires_at: null,
      reauthorization_required_at: null,
      last_error: null,
      ...installShapeColumns(grant),
    }, { onConflict: "app,company_id" })
    .select("id")
    .single();
  if (error || !data) throw new GhlOAuthError("GHL_AGENCY_INSTALL_WRITE_FAILED");
  return { id: (data as { id: string }).id, companyId, locationId: null, tenantId: null };
}

/**
 * Idempotent on `location_id`, authoritative about which tenant that location belongs to, and
 * ordered so that no reachable failure leaves a row claiming more than what actually happened.
 *
 * The tenant is the whole point of the row. `webhooks/ghl/route.ts` resolves an inbound message's
 * tenant from `ghl_installs.tenant_id` and `repositories/conversations.ts` resolves an outbound
 * one from the same column, so a row with a null tenant is a connection SetterFi cannot route in
 * either direction — and the browser was being told it was linked.
 */
export async function persistGhlSubAccountInstall(
  grant: GhlTokenGrant,
  tenantId: string | null,
  client: ServiceClient = createSupabaseServiceClient(),
  encrypt: (value: string) => CredentialEnvelopeV1 = encryptCredential,
): Promise<PersistedGhlInstall> {
  const locationId = grant.locationId;
  const companyId = grant.companyId;
  // Nothing has been written, so a grant that names no location leaves nothing behind.
  if (!locationId || !companyId) throw new GhlOAuthError("GHL_INSTALL_TARGET_UNKNOWN");

  const { data: existingRow, error: existingError } = await client
    .from("ghl_installs")
    .select("id, tenant_id")
    .eq("location_id", locationId)
    .maybeSingle();
  if (existingError) throw new GhlOAuthError("GHL_INSTALL_LOOKUP_FAILED");
  const existing = existingRow as { id: string; tenant_id: string | null } | null;

  // Still nothing written. A location that already belongs to one tenant is never handed to
  // another because a request named the other one; the request does not get to decide this.
  if (tenantId && existing?.tenant_id && existing.tenant_id !== tenantId) {
    throw new GhlOAuthError("GHL_INSTALL_LOCATION_BOUND_ELSEWHERE");
  }
  const resolvedTenant = tenantId ?? existing?.tenant_id ?? null;
  // And still nothing written. Refusing here costs an install that could never have worked; the
  // browser's "Nothing was stored" banner is then literally true.
  if (!resolvedTenant) throw new GhlOAuthError("GHL_INSTALL_TENANT_UNRESOLVED");

  const metadata = {
    company_id: companyId,
    tenant_id: resolvedTenant,
    // `installed`, not `token_ok`. Until the secret upsert returns, the only honest claim this row
    // can make is that an install exists — a failure between here and there leaves a row that says
    // exactly that, and the resolver fails closed against it rather than handing out nothing.
    install_state: "installed",
    token_expires_at: grant.tokenExpiresAt,
    reauthorization_required_at: null,
    last_error: null,
    // On the first write, beside the tenant binding, because they describe the same install and a
    // failure after this point must not leave the row unable to say what was approved.
    ...installShapeColumns(grant),
  };

  let installId: string;
  if (!existing) {
    const { data, error } = await client
      .from("ghl_installs")
      .insert({ location_id: locationId, ...metadata })
      .select("id")
      .single();
    // A concurrent first install for the same location loses on the `location_id` unique here, and
    // loses cleanly: no secret was written for it either.
    if (error || !data) throw new GhlOAuthError("GHL_INSTALL_WRITE_FAILED");
    installId = (data as { id: string }).id;
  } else {
    // The binding lives on the write, not only on the read above. Postgres arbitrates the
    // predicate against the row as it actually is, so a location bound elsewhere between the two
    // statements matches nothing, and a zero-row result is the same refusal by another route.
    const { data, error } = await client
      .from("ghl_installs")
      .update(metadata)
      .eq("location_id", locationId)
      .or(`tenant_id.is.null,tenant_id.eq.${resolvedTenant}`)
      .select("id")
      .maybeSingle();
    if (error) throw new GhlOAuthError("GHL_INSTALL_WRITE_FAILED");
    if (!data) throw new GhlOAuthError("GHL_INSTALL_LOCATION_BOUND_ELSEWHERE");
    installId = (data as { id: string }).id;
  }

  const { error: secretError } = await client.from("ghl_install_secrets").upsert({
    ghl_install_id: installId,
    access_credential_envelope: encrypt(grant.accessToken),
    refresh_credential_envelope: encrypt(grant.refreshToken),
    refresh_lock_expires_at: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "ghl_install_id" });
  // The metadata row still reads `installed`, which is what happened.
  if (secretError) throw new GhlOAuthError("GHL_INSTALL_SECRET_WRITE_FAILED");

  // Only now, because `token_ok` is a claim about the secret and the secret is only now a fact. A
  // failure here leaves a working install reading `installed`, which costs one extra refresh.
  const { error: confirmError } = await client
    .from("ghl_installs")
    .update({
      install_state: "token_ok",
      token_expires_at: grant.tokenExpiresAt,
      reauthorization_required_at: null,
      last_error: null,
    })
    .eq("id", installId);
  if (confirmError) throw new GhlOAuthError("GHL_INSTALL_WRITE_FAILED");

  return { id: installId, companyId, locationId, tenantId: resolvedTenant };
}

// ---------------------------------------------------------------------------
// Live resolvers
// ---------------------------------------------------------------------------

/**
 * The agency access token, refreshed on demand.
 *
 * The agent app's row is preferred, and its one consumer is why. This resolver is reached only
 * from `liveCompanyInstall` in `ghl.ts:245`, which is reached only from `reconcileInstall` calling
 * `POST /oauth/locationToken` — and that call is sent with `X-Client-Id: configuration.clientId`
 * at `ghl.ts:400`, which is the *agent* app's client id. The provider will not mint a location
 * token from a Bearer belonging to a different client, so the agent app's agency-level Company
 * grant is the credential that call actually needs. The agency app's row answers only while the
 * agent app has no install stored.
 *
 * `GHL_AGENCY_ACCESS_TOKEN` survives only as a bootstrap: it answers while no install row exists
 * yet, so an existing deployment does not break the moment this ships. Once a callback has stored
 * an install the stored path is authoritative and the env var is never consulted again — it holds
 * a value the provider expires about a day after it was pasted.
 */
export async function resolveGhlAgencyAccessToken(
  environment: EnvironmentSource = process.env,
  client: ServiceClient = createSupabaseServiceClient(),
): Promise<{ companyId: string; accessToken: string }> {
  const configuredCompanyId = environmentValue("GHL_AGENCY_COMPANY_ID", environment) ?? null;
  let app: GhlOAuthApp = "agent";
  let custody = createGhlAgencyInstallCustody(configuredCompanyId, client, app);
  let stored = await custody.load();
  if (!stored) {
    app = "provisioning";
    custody = createGhlAgencyInstallCustody(configuredCompanyId, client, app);
    stored = await custody.load();
  }
  if (!stored) {
    const bootstrap = environmentValue("GHL_AGENCY_ACCESS_TOKEN", environment);
    if (bootstrap && configuredCompanyId) {
      return { companyId: configuredCompanyId, accessToken: bootstrap };
    }
    throw new GhlOAuthError("GHL_AGENCY_INSTALL_UNAVAILABLE");
  }
  // The client credentials have to match the row's app or the provider rejects the refresh: a
  // refresh token belongs to the client that was issued it.
  const configuration = ghlOAuthConfiguration(app, environment);
  const accessToken = await resolveRefreshingAccessToken("agency", {
    custody,
    refresh: async (refreshToken) => refreshGhlGrant({
      app,
      refreshToken,
      client: configuration.client,
    }),
  });
  return { companyId: stored.companyId ?? configuredCompanyId ?? "", accessToken };
}

/**
 * The agency app's own access token, refreshed on demand — the one `POST /locations/` needs.
 *
 * This exists separately from `resolveGhlAgencyAccessToken`, and neither preference is a default
 * the other can inherit. That resolver serves the location-token mint, which sends app 1's
 * `X-Client-Id` (`ghl.ts:404`), so its Bearer has to be app 1's Company grant. Sub-account creation
 * is an agency-app call, so its Bearer has to be the agency app's grant. Same table, same company,
 * two different rows and two independently rotating refresh tokens — pointing either caller at the
 * other's row hands the provider a Bearer that does not belong to the client it was told about.
 *
 * There is deliberately no fall-through to the agent row: a missing provisioning grant is a missing
 * install, not a reason to authorize a create with the other client.
 *
 * `GHL_AGENCY_ACCESS_TOKEN` survives only as a bootstrap, answering while no install row exists so
 * a deployment that has never completed the agency OAuth install is not broken by this. Once a
 * callback has stored a grant, the stored path is authoritative — the env var holds a value a human
 * pasted out of the HighLevel UI and the provider expires about a day later.
 */
export async function resolveGhlProvisioningAccessToken(
  environment: EnvironmentSource = process.env,
  client: ServiceClient = createSupabaseServiceClient(),
): Promise<{ companyId: string; accessToken: string }> {
  const configuredCompanyId = environmentValue("GHL_AGENCY_COMPANY_ID", environment) ?? null;
  const custody = createGhlAgencyInstallCustody(configuredCompanyId, client, "provisioning");
  const stored = await custody.load();
  if (!stored) {
    const bootstrap = environmentValue("GHL_AGENCY_ACCESS_TOKEN", environment);
    if (bootstrap && configuredCompanyId) {
      return { companyId: configuredCompanyId, accessToken: bootstrap };
    }
    throw new GhlOAuthError("GHL_AGENCY_INSTALL_UNAVAILABLE");
  }
  // Refreshing happens inside `resolveRefreshingAccessToken` and nowhere else: the refresh token is
  // single-use and rotating, so one spent outside the row lease destroys the install until a human
  // reinstalls through the portal. The client credentials are read only on the path that actually
  // signs a refresh, because a still-live token needs none of them.
  const accessToken = await resolveRefreshingAccessToken("agency", {
    custody,
    refresh: async (refreshToken) => refreshGhlGrant({
      app: "provisioning",
      refreshToken,
      client: ghlOAuthConfiguration("provisioning", environment).client,
    }),
  });
  return { companyId: stored.companyId ?? configuredCompanyId ?? "", accessToken };
}

/** The location access token for one coach's install, refreshed on demand. */
export async function resolveGhlLocationAccessToken(
  locationId: string,
  environment: EnvironmentSource = process.env,
  client: ServiceClient = createSupabaseServiceClient(),
): Promise<string> {
  const configuration = ghlOAuthConfiguration("agent", environment);
  return resolveRefreshingAccessToken("install", {
    custody: createGhlSubAccountInstallCustody(locationId, client),
    refresh: async (refreshToken) => refreshGhlGrant({
      app: "agent",
      refreshToken,
      client: configuration.client,
    }),
  });
}
