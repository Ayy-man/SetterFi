/**
 * Issues the install link, and the single-use `state` that makes its callback recognisable.
 *
 * Without this the two callback routes could never accept anything: a state they never issued is a
 * state they must refuse. The provider's install link is copied out of its portal and is not
 * hand-constructable, so we take it verbatim from configuration and add only our own state.
 */

import type { PlatformActor } from "@/lib/auth/actors";
import { hasImpersonationMarker, parseAppClaims, type UserRole } from "@/lib/auth/claims";
import { phase9GhlOAuthLive } from "@/lib/env-contract";
import {
  GHL_OAUTH_APPS,
  ghlOAuthStateHash,
  issueGhlOAuthState,
  type GhlOAuthApp,
  type GhlOAuthStateStore,
} from "@/lib/integrations/ghl-oauth";
import {
  createGhlOAuthStateStore,
  ghlOAuthConfiguration,
} from "@/lib/integrations/ghl-oauth-store";
import {
  installEventContext,
  installEventStateRef,
  recordInstallStartRefusal,
  type GhlInstallStartRefusal,
} from "@/lib/integrations/install-events";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const noStoreHeaders = { "Cache-Control": "no-store" };
const INSTALLING_ROLES: readonly UserRole[] = ["owner", "admin"];

export type GhlInstallStartActor = PlatformActor & {
  tenantId: string | null;
  impersonatingTenant: string | null;
  impersonationSessionId?: string | null;
};

/**
 * The actor as this route needs to see them, impersonation included.
 *
 * `loadPlatformActor` returns null the moment `impersonatingTenant` is set, which is right for the
 * route that exports it and is exactly why the impersonation refusal below could never run: the
 * handler saw no actor at all, answered a bare 401, and recorded nothing. This reads the same
 * claims and refuses only what is genuinely unusable: no user, or no role.
 */
export async function loadInstallStartActor(): Promise<GhlInstallStartActor | null> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims) return null;
  const claims = parseAppClaims(data.claims);
  if (!claims.userId || !claims.role) return null;
  return {
    userId: claims.userId,
    role: claims.role,
    tenantId: claims.tenantId,
    impersonatingTenant: claims.impersonatingTenant,
    impersonationSessionId: claims.impersonationSessionId,
  };
}

export type GhlInstallStartDependencies = {
  enabled(): boolean;
  session(): Promise<
    (PlatformActor & {
      tenantId?: string | null;
      impersonatingTenant?: string | null;
      impersonationSessionId?: string | null;
    }) | null
  >;
  begin(input: {
    app: GhlOAuthApp;
    actorId: string;
    tenantId: string | null;
    returnPath: string | null;
  }): Promise<{ authorizationUrl: string; expiresAt: string }>;
  record(refusal: GhlInstallStartRefusal): Promise<void>;
};

function parseBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const app = GHL_OAUTH_APPS.find((candidate) => candidate === body.app);
  if (!app) return null;
  const tenantId = typeof body.tenantId === "string" && body.tenantId.trim() ? body.tenantId.trim() : null;
  const returnPath = typeof body.returnPath === "string" && body.returnPath.trim()
    ? body.returnPath.trim()
    : null;
  return { app, tenantId, returnPath };
}

export function createGhlInstallStartHandler(dependencies: GhlInstallStartDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    }
    // Read before the role check only to name the app on a refusal; the checks keep their order,
    // so an unparseable body from a coach is still a 403 rather than a 400.
    const parsed = parseBody(await request.json().catch(() => null));
    const refused = async (code: string, missingEnv?: readonly string[]) => {
      try {
        await dependencies.record({
          app: parsed?.app ?? "unknown",
          actorId: actor.userId,
          tenantId: parsed?.tenantId ?? null,
          code,
          ...(missingEnv ? { missingEnv } : {}),
        });
      } catch {
        // Swallowed here as well as inside the recorder: observing a refusal may never become the
        // reason a caller sees a different status than it would have seen.
      }
    };
    if (hasImpersonationMarker(actor) || !INSTALLING_ROLES.includes(actor.role)) {
      await refused(hasImpersonationMarker(actor)
        ? "GHL_INSTALL_START_IMPERSONATION_FORBIDDEN"
        : "GHL_INSTALL_START_ROLE_FORBIDDEN");
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    // After the role check, so an impersonated coach naming a foreign tenant still reads as an
    // impersonation refusal rather than a tenant one, the more serious of the two.
    if (actor.tenantId && parsed?.tenantId && parsed.tenantId !== actor.tenantId) {
      await refused("GHL_INSTALL_START_TENANT_FORBIDDEN");
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    if (!parsed) {
      await refused("GHL_INSTALL_START_REQUEST_INVALID");
      return Response.json({ error: "Invalid install request." }, { status: 400, headers: noStoreHeaders });
    }
    try {
      const result = await dependencies.begin({ ...parsed, actorId: actor.userId });
      return Response.json(result, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      // Configuration and provider failures collapse to one shape; the install URL and client
      // credentials that produced them are never echoed. The caught value itself is never logged
      // or serialized - only the code the normalizer allows through.
      const context = installEventContext(error);
      await refused(context.code, context.missingEnv);
      return Response.json({ error: "Messaging install could not be started." }, {
        status: 503,
        headers: noStoreHeaders,
      });
    }
  };
}

export async function beginGhlInstall(
  input: { app: GhlOAuthApp; actorId: string; tenantId: string | null; returnPath: string | null },
  states: GhlOAuthStateStore = createGhlOAuthStateStore(),
  client: ReturnType<typeof createSupabaseServiceClient> = createSupabaseServiceClient(),
) {
  const configuration = ghlOAuthConfiguration(input.app);
  const issued = await issueGhlOAuthState({
    app: input.app,
    actorId: input.actorId,
    tenantId: input.tenantId,
    returnPath: input.returnPath,
    appBaseUrl: configuration.appBaseUrl,
    installUrl: configuration.installUrl,
    clientId: configuration.client.clientId,
  }, { states });
  const { error } = await client.from("audit_log").insert({
    actor_id: input.actorId,
    tenant_id: input.tenantId,
    action: "channel.messaging_install.started",
    target_type: "ghl_oauth_state",
    target_id: input.app,
    payload: {
      before: null,
      // The ref, not the state: it is what groups this row with the callback that comes back for
      // it, and the raw state never leaves this function.
      after: {
        app: input.app,
        expires_at: issued.expiresAt,
        state_ref: installEventStateRef(issued.state),
      },
    },
  });
  if (error) {
    // The link is never returned, so the state row would otherwise sit there unconsumed for ten
    // minutes as a live credential nobody is waiting for. The raw state is in hand here and only
    // here, and it must not leave this function to be burned anywhere else.
    try {
      await states.consume(ghlOAuthStateHash(issued.state), new Date().toISOString(), input.app);
    } catch {
      // Best effort. The state is single-use and expires in ten minutes either way, and the caller
      // is already getting its 503. A second failure must not change what it sees.
    }
    throw new Error("GHL_INSTALL_START_AUDIT_FAILED");
  }
  return { authorizationUrl: issued.authorizationUrl, expiresAt: issued.expiresAt };
}

export const POST = createGhlInstallStartHandler({
  enabled: () => phase9GhlOAuthLive(),
  session: loadInstallStartActor,
  begin: beginGhlInstall,
  record: (refusal) => recordInstallStartRefusal(refusal),
});
