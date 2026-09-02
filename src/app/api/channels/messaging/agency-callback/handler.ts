/**
 * Redirect URL for the agency marketplace app.
 *
 * This is the callback that ends the era of a hand-pasted agency token. What lands here is a grant
 * we store encrypted, with its expiry and its refresh token, so the resolver can keep it alive on
 * its own instead of going dark roughly a day after someone set an environment variable.
 */

import { phase9GhlOAuthLive } from "@/lib/env-contract";
import {
  GHL_OAUTH_DEFAULT_RETURN_PATHS,
  GhlOAuthError,
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
} from "@/lib/integrations/ghl-oauth-store";
import {
  installEventContext,
  installEventHashRef,
  installEventStateRef,
  recordInstallCallbackEvent,
} from "@/lib/integrations/install-events";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import {
  ghlCallbackRecorder,
  ghlCallbackRedirect,
  ghlConsumeStateRef,
  installShapePayload,
  recordInstallCompletion,
  type GhlCallbackDependencies,
} from "../callback/handler";

const noStoreHeaders = { "Cache-Control": "no-store" };

export function createGhlAgencyCallbackHandler(dependencies: GhlCallbackDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const query = new URL(request.url).searchParams;
    const state = query.get("state")?.trim();
    const code = query.get("code")?.trim();
    const providerError = query.get("error")?.trim();
    const observe = ghlCallbackRecorder(dependencies, "provisioning");
    const stateRef = state ? { stateRef: installEventStateRef(state) } : {};

    if (!state) {
      await observe({ outcome: "failed", code: "GHL_OAUTH_STATE_MISSING", tenantId: null });
      return ghlCallbackRedirect(GHL_OAUTH_DEFAULT_RETURN_PATHS.provisioning, "provisioning", "error");
    }

    let record: GhlOAuthStateRecord;
    try {
      record = await dependencies.consumeState(state);
    } catch (error) {
      const context = installEventContext(error);
      await observe({
        outcome: "failed",
        ...context,
        ...ghlConsumeStateRef(context.code, stateRef),
        tenantId: null,
      });
      return ghlCallbackRedirect(GHL_OAUTH_DEFAULT_RETURN_PATHS.provisioning, "provisioning", "error");
    }

    if (providerError) {
      await observe({
        outcome: "declined",
        code: "GHL_OAUTH_PROVIDER_DECLINED",
        providerError,
        ...stateRef,
        tenantId: record.tenantId,
      });
      return ghlCallbackRedirect(record.returnPath, "provisioning", "declined");
    }
    if (!code) {
      await observe({
        outcome: "failed",
        code: "GHL_OAUTH_CODE_MISSING",
        ...stateRef,
        tenantId: record.tenantId,
      });
      return ghlCallbackRedirect(record.returnPath, "provisioning", "error");
    }

    try {
      await dependencies.complete({ state: record, code });
    } catch (error) {
      await observe({
        outcome: "failed",
        ...installEventContext(error),
        ...stateRef,
        tenantId: record.tenantId,
      });
      return ghlCallbackRedirect(record.returnPath, "provisioning", "error");
    }
    return ghlCallbackRedirect(record.returnPath, "provisioning", "linked");
  };
}

export type GhlAgencyCompleteDependencies = {
  exchange?: (code: string) => Promise<GhlTokenGrant>;
  client?: () => ReturnType<typeof createSupabaseServiceClient>;
  persistAgency?: typeof persistGhlAgencyInstall;
};

/**
 * This app is Company-target, so a Company grant is the only thing it can legitimately return.
 *
 * A Location grant arriving here is refused by name rather than stored as if it were a Company
 * one: `persistGhlAgencyInstall` writes whatever it is handed under `app = 'provisioning'`, and a
 * location-scoped token filed as the agency credential would fail every later agency call with a
 * scope error nobody could trace back to this moment.
 */
export async function completeGhlAgencyInstall(
  { state, code }: { state: GhlOAuthStateRecord; code: string },
  dependencies: GhlAgencyCompleteDependencies = {},
) {
  const exchange = dependencies.exchange ?? (async (value: string) => {
    const configuration = ghlOAuthConfiguration("provisioning");
    return exchangeGhlAuthorizationCode({
      app: "provisioning",
      code: value,
      client: configuration.client,
      redirectUri: ghlRedirectUri("provisioning", configuration.appBaseUrl),
    });
  });
  const client = (dependencies.client ?? createSupabaseServiceClient)();
  const persistAgency = dependencies.persistAgency ?? persistGhlAgencyInstall;

  const grant = await exchange(code);
  // Before the persist, so nothing is written for a grant we are about to refuse.
  if (grant.userType !== "Company") {
    throw new GhlOAuthError("GHL_AGENCY_INSTALL_USER_TYPE_UNEXPECTED");
  }
  // Upserted on (app, company_id), so a replayed code or a reinstall refreshes this app's one
  // agency row and never touches the agent app's grant for the same company.
  const install = await persistAgency(grant, "provisioning", client);

  await recordInstallCompletion(client as never, {
    actor_id: state.actorId,
    tenant_id: null,
    action: "platform.provisioning_install.completed",
    target_type: "ghl_agency_install",
    target_id: install.id,
    payload: {
      before: null,
      after: {
        install_state: "token_ok",
        user_type: grant.userType,
        install_target: "company",
        state_ref: installEventHashRef(state.stateHash),
        ...installShapePayload(grant),
      },
    },
  });
}

export const GET = createGhlAgencyCallbackHandler({
  enabled: () => phase9GhlOAuthLive(),
  consumeState: async (state) =>
    consumeGhlOAuthState({ app: "provisioning", state }, { states: createGhlOAuthStateStore() }),
  complete: (input) => completeGhlAgencyInstall(input),
  record: (event) => recordInstallCallbackEvent(event),
});
