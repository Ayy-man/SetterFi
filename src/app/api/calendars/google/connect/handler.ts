/**
 * The one button. Issues the single-use state that makes the callback recognisable, and sends the
 * coach to Google.
 *
 * Nothing else on this route is negotiable: the authorization URL carries `access_type=offline` so
 * a refresh token is issued at all, and `prompt=consent` on every connect and not only the first,
 * because without it a coach who already granted comes back with an access token that dies in an
 * hour and nothing to renew it from.
 *
 * The origin is computed from `APP_BASE_URL` and never from the request's Host header. Google
 * compares the redirect URI sent here against the one sent to the token endpoint byte for byte, and
 * a header-derived origin turns a spoofed host into a redirect_uri_mismatch instead of a refusal we
 * control.
 */

import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { googleCalendarOAuthLive, type EnvironmentSource } from "@/lib/env-contract";
import {
  GOOGLE_CALENDAR_DEFAULT_RETURN_PATH,
  issueGoogleOAuthState,
  validateGoogleReturnPath,
  type GoogleOAuthStateStore,
} from "@/lib/integrations/google-calendar-oauth";
import {
  createGoogleOAuthStateStore,
  googleCalendarOAuthConfiguration,
} from "@/lib/integrations/google-calendar-oauth-store";

import { NO_STORE, notFound, refuseActor } from "../guards";

export type GoogleConnectDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  begin(input: {
    actorId: string;
    tenantId: string;
    returnPath: string | null;
  }): Promise<{ authorizationUrl: string }>;
};

export function createGoogleConnectHandler(dependencies: GoogleConnectDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) return notFound();
    const actor = await dependencies.session();
    const rejected = refuseActor(actor);
    if (rejected || !actor) return rejected!;

    // Absent means the default. Present-but-unusable is a refusal rather than a quiet fallback,
    // because a caller that asked to land somewhere specific should hear that it cannot.
    const requested = new URL(request.url).searchParams.get("returnPath");
    let authorizationUrl: string;
    try {
      ({ authorizationUrl } = await dependencies.begin({
        actorId: actor.userId,
        tenantId: actor.tenantId,
        returnPath: requested,
      }));
    } catch {
      // Configuration failures and refused return paths collapse to one shape. The install URL and
      // the client credentials that produced them are never echoed.
      return Response.json(
        { error: "Calendar connect is unavailable." },
        { status: 400, headers: NO_STORE },
      );
    }
    const headers = new Headers(NO_STORE);
    headers.set("Location", authorizationUrl);
    return new Response(null, { status: 303, headers });
  };
}

export type BeginGoogleConnectDependencies = {
  states?: GoogleOAuthStateStore;
  environment?: EnvironmentSource;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
};

export async function beginGoogleConnect(
  input: { actorId: string; tenantId: string; returnPath: string | null },
  dependencies: BeginGoogleConnectDependencies = {},
) {
  const configuration = googleCalendarOAuthConfiguration(dependencies.environment);
  // Validated here as well as inside the issuer so a present-but-empty parameter is a refusal
  // rather than a silent slide onto the default path.
  const returnPath = input.returnPath === null
    ? GOOGLE_CALENDAR_DEFAULT_RETURN_PATH
    : validateGoogleReturnPath(input.returnPath, configuration.appBaseUrl);
  const issued = await issueGoogleOAuthState({
    actorId: input.actorId,
    tenantId: input.tenantId,
    returnPath,
    appBaseUrl: configuration.appBaseUrl,
    clientId: configuration.client.clientId,
  }, {
    states: dependencies.states ?? createGoogleOAuthStateStore(),
    now: dependencies.now,
    randomBytes: dependencies.randomBytes,
  });
  return { authorizationUrl: issued.authorizationUrl };
}

export const GET = createGoogleConnectHandler({
  enabled: googleCalendarOAuthLive,
  session: loadRouteActor,
  begin: (input) => beginGoogleConnect(input),
});
