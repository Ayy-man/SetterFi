/**
 * Redirect URL for the sub-account marketplace app.
 *
 * The path is registered with the provider and is therefore fixed and publicly reachable, which is
 * why nothing here trusts its query string. The only thing that makes a callback ours is a `state`
 * that matches an unconsumed row we wrote when someone started the install, and consuming that row
 * is the same statement that proves it was still unconsumed.
 */

import { phase9GhlOAuthLive } from "@/lib/env-contract";
import {
  GHL_OAUTH_DEFAULT_RETURN_PATHS,
  consumeGhlOAuthState,
  exchangeGhlAuthorizationCode,
  ghlRedirectUri,
  type GhlOAuthStateRecord,
  type GhlTokenGrant,
} from "@/lib/integrations/ghl-oauth";
import {
  createGhlOAuthStateStore,
  ghlOAuthConfiguration,
  persistGhlAgencyInstall,
  persistGhlSubAccountInstall,
} from "@/lib/integrations/ghl-oauth-store";
import {
  installEventContext,
  installEventHashRef,
  installEventStateRef,
  recordInstallCallbackEvent,
  type GhlInstallCallbackEvent,
} from "@/lib/integrations/install-events";
import { installLog, installLogElapsed } from "@/lib/integrations/install-log";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const noStoreHeaders = { "Cache-Control": "no-store" };

export type GhlCallbackOutcome = "linked" | "declined" | "error";

export type GhlCallbackDependencies = {
  enabled(): boolean;
  consumeState(state: string): Promise<GhlOAuthStateRecord>;
  complete(input: { state: GhlOAuthStateRecord; code: string }): Promise<void>;
  record(event: GhlInstallCallbackEvent): Promise<void>;
};

/**
 * Called only after the outcome is decided, and never able to change it: a slow or failing
 * recorder must not be the reason a browser lands somewhere else.
 */
export function ghlCallbackRecorder(
  dependencies: GhlCallbackDependencies,
  app: GhlInstallCallbackEvent["app"],
) {
  return async (event: Omit<GhlInstallCallbackEvent, "app">) => {
    try {
      await dependencies.record({ app, ...event });
    } catch {
      // The recorder owns its own failure. Rethrowing here would let observing an install
      // decide where the browser lands, which is the one thing this must never do.
    }
  };
}

/**
 * The two consume refusals that must not be filed under the attempt they name.
 *
 * The attempts panel reads the last event carrying a `state_ref` as that attempt's ending. A
 * replay arrives with the state of an install that already succeeded, and a cross-app callback
 * arrives with a state the other callback is still going to use — writing a failure under either
 * ref would end a live or finished attempt with something that did not happen to it.
 */
const UNREFERENCED_CONSUME_CODES = new Set([
  "GHL_OAUTH_STATE_ALREADY_COMPLETED",
  "GHL_OAUTH_STATE_APP_MISMATCH",
]);

export function ghlConsumeStateRef(code: string, stateRef: { stateRef?: string }) {
  return UNREFERENCED_CONSUME_CODES.has(code) ? {} : stateRef;
}

/**
 * The completion row, written after the credential is already on disk.
 *
 * This reverses last week's choice to throw when the insert fails. By the time it runs the grant
 * is stored and the connection genuinely works, so letting a missing audit row redirect the
 * browser to `?messaging=error` reports a failure that did not happen and sends a coach to
 * reconnect an install that was already fine. One retry, then a log line: the attempt reads as
 * pending in the attempts panel — an install we could not finish recording, which is what
 * occurred — and the connection chip on the integrations page is authoritative either way.
 */
export async function recordInstallCompletion(
  client: { from(table: string): { insert(row: Record<string, unknown>): Promise<{ error: unknown }> } },
  row: Record<string, unknown>,
) {
  const fields = {
    audit_action: String(row.action),
    install_target: String(row.target_type),
    install_id: String(row.target_id),
  };
  const first = await client.from("audit_log").insert(row);
  if (!first.error) {
    installLog("complete.audit_written", { ...fields, attempt: 1 });
    return;
  }
  installLog("complete.audit_retry", { ...fields, attempt: 1 }, "error");
  const retry = await client.from("audit_log").insert(row);
  if (!retry.error) {
    installLog("complete.audit_written", { ...fields, attempt: 2 });
    return;
  }
  installLog("complete.audit_failed", { ...fields, attempt: 2 }, "error");
  // The identifiers only. No state, no code, no envelope.
  console.error("[install-complete] completion audit write failed", {
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
  });
}

/**
 * The same three flags the install row now stores, repeated into the completion audit row.
 *
 * Not redundant: the install row holds the *current* install and an operator reads the attempts
 * panel, which is audit rows. A reinstall overwrites the row and the earlier consent with it, while
 * the audit keeps each install's own answers where the panel can show them.
 *
 * Nulls are written, never omitted, so a key missing from one row and present in another cannot be
 * mistaken for a difference in what the installer chose.
 */
export function installShapePayload(grant: GhlTokenGrant) {
  return {
    approve_all_locations: grant.approveAllLocations,
    is_bulk_installation: grant.isBulkInstallation,
    install_to_future_locations: grant.installToFutureLocations,
  };
}

export function ghlCallbackRedirect(returnPath: string, key: string, outcome: GhlCallbackOutcome) {
  const target = new URL(returnPath, "https://setterfi.invalid");
  target.searchParams.set(key, outcome);
  const headers = new Headers(noStoreHeaders);
  headers.set("Location", `${target.pathname}${target.search}`);
  return new Response(null, { status: 303, headers });
}

export function createGhlCallbackHandler(dependencies: GhlCallbackDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const query = new URL(request.url).searchParams;
    const state = query.get("state")?.trim();
    const code = query.get("code")?.trim();
    const providerError = query.get("error")?.trim();
    const startedAt = Date.now();
    const observe = ghlCallbackRecorder(dependencies, "agent");
    // Computed before the state is consumed, so a state we refuse still names which one it was.
    const stateRef = state ? { stateRef: installEventStateRef(state) } : {};
    installLog("callback.received", {
      app: "agent",
      ...stateRef.stateRef ? { state_ref: stateRef.stateRef } : {},
      has_state: Boolean(state),
      has_code: Boolean(code),
      has_provider_error: Boolean(providerError),
    });
    const redirect = (path: string, outcome: GhlCallbackOutcome, extra: Parameters<typeof installLog>[1] = {}) => {
      installLog("callback.redirect", {
        app: "agent",
        ...stateRef.stateRef ? { state_ref: stateRef.stateRef } : {},
        outcome,
        redirect_to: path,
        duration_ms: installLogElapsed(startedAt),
        ...extra,
      }, outcome === "linked" ? "info" : "error");
      return ghlCallbackRedirect(path, "messaging", outcome);
    };

    // Without a state there is no return path we are willing to send a browser to.
    if (!state) {
      await observe({ outcome: "failed", code: "GHL_OAUTH_STATE_MISSING", tenantId: null });
      return redirect(GHL_OAUTH_DEFAULT_RETURN_PATHS.agent, "error", { code: "GHL_OAUTH_STATE_MISSING" });
    }

    let record: GhlOAuthStateRecord;
    try {
      record = await dependencies.consumeState(state);
      installLog("callback.state_consumed", {
        app: "agent",
        state_ref: stateRef.stateRef,
        tenant_id: record.tenantId,
        actor_id: record.actorId,
        return_path: record.returnPath,
        expires_at: record.expiresAt,
      });
    } catch (error) {
      const context = installEventContext(error);
      await observe({
        outcome: "failed",
        ...context,
        ...ghlConsumeStateRef(context.code, stateRef),
        tenantId: null,
      });
      return redirect(GHL_OAUTH_DEFAULT_RETURN_PATHS.agent, "error", { code: context.code });
    }

    // `error_description` is provider prose that can carry request context; it never reaches the
    // browser and never reaches a log line. The human gets the outcome, not the provider's text.
    if (providerError) {
      await observe({
        outcome: "declined",
        code: "GHL_OAUTH_PROVIDER_DECLINED",
        providerError,
        ...stateRef,
        tenantId: record.tenantId,
      });
      return redirect(record.returnPath, "declined", { code: "GHL_OAUTH_PROVIDER_DECLINED" });
    }
    if (!code) {
      await observe({
        outcome: "failed",
        code: "GHL_OAUTH_CODE_MISSING",
        ...stateRef,
        tenantId: record.tenantId,
      });
      return redirect(record.returnPath, "error", { code: "GHL_OAUTH_CODE_MISSING" });
    }

    try {
      await dependencies.complete({ state: record, code });
    } catch (error) {
      const context = installEventContext(error);
      await observe({
        outcome: "failed",
        ...context,
        ...stateRef,
        tenantId: record.tenantId,
      });
      return redirect(record.returnPath, "error", {
        code: context.code,
        provider_status: context.providerStatus,
        body_shape: context.bodyShape,
        missing_env: context.missingEnv,
      });
    }
    return redirect(record.returnPath, "linked");
  };
}

export type GhlAgentCompleteDependencies = {
  exchange?: (code: string) => Promise<GhlTokenGrant>;
  client?: () => ReturnType<typeof createSupabaseServiceClient>;
  persistAgency?: typeof persistGhlAgencyInstall;
  persistSubAccount?: typeof persistGhlSubAccountInstall;
};

/**
 * Both grant types this app can return, and the different things each one means.
 *
 * The provider's asymmetry is the whole reason this branches. This app is Sub-Account-target with
 * bulk install enabled, so a sub-account user approving it returns a Location grant for their one
 * location, while an *agency* user approving it returns `userType: "Company"` with
 * `isBulkInstallation: true` — a platform-level grant covering the agency, and the only shape that
 * carries the `oauth.*` scopes `POST /oauth/locationToken` needs. Refusing it, which is what this
 * did before, failed the exact install path the client is about to walk.
 */
export async function completeGhlAgentInstall(
  { state, code }: { state: GhlOAuthStateRecord; code: string },
  dependencies: GhlAgentCompleteDependencies = {},
) {
  const exchange = dependencies.exchange ?? (async (value: string) => {
    const configuration = ghlOAuthConfiguration("agent");
    return exchangeGhlAuthorizationCode({
      app: "agent",
      code: value,
      client: configuration.client,
      redirectUri: ghlRedirectUri("agent", configuration.appBaseUrl),
    });
  });
  const client = (dependencies.client ?? createSupabaseServiceClient)();
  const persistAgency = dependencies.persistAgency ?? persistGhlAgencyInstall;
  const persistSubAccount = dependencies.persistSubAccount ?? persistGhlSubAccountInstall;

  const exchangeStartedAt = Date.now();
  const grant = await exchange(code);
  const company = grant.userType === "Company";
  installLog("complete.exchanged", {
    app: "agent",
    state_ref: installEventHashRef(state.stateHash),
    user_type: grant.userType,
    company_id: grant.companyId,
    location_id: grant.locationId,
    install_target: company ? "company" : "location",
    token_expires_at: grant.tokenExpiresAt,
    ...installShapePayload(grant),
    duration_ms: installLogElapsed(exchangeStartedAt),
  });
  // Company: this app's own agency-level credential, upserted on (app, company_id) so it never
  // lands on the provisioning app's row. Location: upserted on the location, so replaying a code
  // or reinstalling an existing location overwrites one row instead of creating a second,
  // contradictory install — and the store, not this route, decides which tenant it belongs to.
  const install = company
    ? await persistAgency(grant, "agent", client)
    : await persistSubAccount(grant, state.tenantId, client);
  installLog("complete.persisted", {
    app: "agent",
    state_ref: installEventHashRef(state.stateHash),
    install_id: install.id,
    install_target: company ? "company" : "location",
    company_id: install.companyId,
    location_id: install.locationId,
    tenant_id: install.tenantId,
  });

  await recordInstallCompletion(client as never, {
    actor_id: state.actorId,
    // A Company grant belongs to the platform, not to a coach. The registered key is scoped
    // `tenant` and the insert trigger does not cross-check scope against tenant_id, so this is
    // insertable with a null tenant — and it is the honest value.
    tenant_id: company ? null : install.tenantId,
    action: "channel.messaging_install.completed",
    target_type: company ? "ghl_agency_install" : "ghl_install",
    target_id: install.id,
    payload: {
      before: null,
      // The same ref the started row carries, taken from the hash rather than the raw state, so
      // an issue and its completion read as one attempt.
      after: {
        install_state: "token_ok",
        user_type: grant.userType,
        install_target: company ? "company" : "location",
        state_ref: installEventHashRef(state.stateHash),
        ...installShapePayload(grant),
      },
    },
  });
}

export const GET = createGhlCallbackHandler({
  enabled: () => phase9GhlOAuthLive(),
  consumeState: async (state) =>
    consumeGhlOAuthState({ app: "agent", state }, { states: createGhlOAuthStateStore() }),
  complete: (input) => completeGhlAgentInstall(input),
  record: (event) => recordInstallCallbackEvent(event),
});
