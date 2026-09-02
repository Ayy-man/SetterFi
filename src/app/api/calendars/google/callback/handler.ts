/**
 * Google's redirect back. The path is registered with Google and is therefore fixed and publicly
 * reachable, so nothing here trusts its query string: the only thing that makes a callback ours is
 * a `state` matching an unconsumed row we wrote, and consuming that row is the same statement that
 * proves it was still unconsumed.
 *
 * Every outcome except the flag being off is a 303 to `${returnPath}?calendar=<outcome>`, built
 * against a throwaway origin so only the path and the search string are ever emitted. When there is
 * no usable state there is no return path we are willing to send a browser to, so those land on the
 * default onboarding path instead.
 *
 * `error_description` is provider prose that can carry request context. It reaches neither the
 * browser nor a log line; the coach gets the outcome, not Google's text.
 *
 * The single-calendar case is not a second code path. It calls the same verification function
 * `POST /select` calls, so there is one definition of what `ready` means in the product.
 */

import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { googleCalendarOAuthLive } from "@/lib/env-contract";
import {
  GOOGLE_CALENDAR_DEFAULT_RETURN_PATH,
  consumeGoogleOAuthState,
  exchangeGoogleAuthorizationCode,
  googleRedirectUri,
  listGoogleCalendars,
  missingGoogleScopes,
  type GoogleCalendarChoice,
  type GoogleOAuthStateRecord,
  type GoogleTokenGrant,
} from "@/lib/integrations/google-calendar-oauth";
import {
  createGoogleOAuthStateStore,
  googleCalendarOAuthConfiguration,
  persistGoogleCalendarGrant,
  type GoogleCalendarGrantRow,
  type GooglePendingCalendar,
} from "@/lib/integrations/google-calendar-oauth-store";

import { NO_STORE, notFound, refuseActor } from "../guards";
import {
  liveVerifyCalendarDependencies,
  verifyGoogleCalendar,
  type VerifyCalendarResult,
} from "../verify-calendar";

export type GoogleCallbackOutcome =
  | "ready"
  | "choose"
  | "unverified"
  | "declined"
  | "reauthorize"
  | "scopes"
  | "nocalendars"
  | "error";

export type GoogleCallbackDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  consumeState(state: string | null): Promise<GoogleOAuthStateRecord | null>;
  exchange(code: string): Promise<GoogleTokenGrant>;
  listCalendars(accessToken: string): Promise<readonly GoogleCalendarChoice[]>;
  persistGrant(input: {
    tenantId: string;
    googleAccountEmail: string | null;
    grant: GoogleTokenGrant;
    pendingCalendars: readonly GooglePendingCalendar[];
  }): Promise<GoogleCalendarGrantRow>;
  verify(input: {
    tenantId: string;
    actorId: string;
    accessToken: string;
    grant: GoogleCalendarGrantRow;
    calendar: GooglePendingCalendar;
  }): Promise<VerifyCalendarResult>;
};

export function googleCallbackRedirect(returnPath: string, outcome: GoogleCallbackOutcome) {
  const target = new URL(returnPath, "https://setterfi.invalid");
  target.searchParams.set("calendar", outcome);
  const headers = new Headers(NO_STORE);
  headers.set("Location", `${target.pathname}${target.search}`);
  return new Response(null, { status: 303, headers });
}

/**
 * An entry Google returned with no `timeZone` is ineligible, not repairable.
 *
 * The reference documents the field as optional, and the authorization RPC validates whatever
 * arrives against `pg_timezone_names`. Substituting the primary calendar's zone, the browser's zone
 * or UTC would write bookings into the wrong hour, which is worse than a calendar the coach cannot
 * pick. So the absence is filtered out here and no zone is ever invented.
 */
export function eligibleGoogleCalendars(
  choices: readonly GoogleCalendarChoice[],
): readonly GooglePendingCalendar[] {
  return choices
    .filter((choice): choice is GoogleCalendarChoice & { timeZone: string } => choice.timeZone !== null)
    .map((choice) => ({ id: choice.id, name: choice.name, timeZone: choice.timeZone }));
}

/**
 * The primary entry's id, which for a Google account is the account's email address. We requested
 * no identity scope, so there is no id_token and no userinfo call to read it from, and none is
 * added. Null when nothing claimed to be primary; the verification function supplies the fallback.
 */
export function googleAccountEmail(choices: readonly GoogleCalendarChoice[]) {
  return choices.find((choice) => choice.primary)?.id ?? null;
}

export function createGoogleCallbackHandler(dependencies: GoogleCallbackDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) return notFound();
    const actor = await dependencies.session();
    const rejected = refuseActor(actor);
    if (rejected || !actor) return rejected!;

    const query = new URL(request.url).searchParams;
    const state = query.get("state");
    const code = query.get("code")?.trim();
    const providerError = query.get("error")?.trim();

    // Consumed before anything else is read, so a replayed callback never reaches Google's token
    // endpoint at all and the single-use authorization code is never spent twice.
    const record = await dependencies.consumeState(state);
    if (!record || record.actorId !== actor.userId || record.tenantId !== actor.tenantId) {
      return googleCallbackRedirect(GOOGLE_CALENDAR_DEFAULT_RETURN_PATH, "error");
    }

    if (providerError) {
      // Pressing Cancel is a decision, not a fault, and the page says so.
      return googleCallbackRedirect(
        record.returnPath,
        providerError === "access_denied" ? "declined" : "error",
      );
    }
    if (!code) return googleCallbackRedirect(record.returnPath, "error");

    let grant: GoogleTokenGrant;
    try {
      grant = await dependencies.exchange(code);
    } catch (cause) {
      // An access-token-only grant dies in an hour with nothing to renew it from, so the library
      // refuses it rather than storing it. The coach is sent back to reconnect now instead of
      // discovering it as a failed booking later.
      const missingRefreshToken = cause instanceof Error
        && "code" in cause
        && cause.code === "GOOGLE_REFRESH_TOKEN_MISSING";
      return googleCallbackRedirect(record.returnPath, missingRefreshToken ? "reauthorize" : "error");
    }

    // Granular consent is permanently on for a client created in 2026, so a coach can grant one or
    // two of the three scopes and still arrive here with a code. A grant missing freebusy could
    // never honestly reach ready, and one missing events would fail at the first booking.
    if (missingGoogleScopes(grant.grantedScopes).length > 0) {
      return googleCallbackRedirect(record.returnPath, "scopes");
    }

    let choices: readonly GoogleCalendarChoice[];
    try {
      choices = await dependencies.listCalendars(grant.accessToken);
    } catch {
      return googleCallbackRedirect(record.returnPath, "error");
    }
    const pendingCalendars = eligibleGoogleCalendars(choices);

    // Stored even when nothing is eligible. We are holding a live Google authorization either way,
    // and a grant we did not record is a grant we could never revoke.
    const stored = await dependencies.persistGrant({
      tenantId: record.tenantId,
      googleAccountEmail: googleAccountEmail(choices),
      grant,
      pendingCalendars,
    });

    if (pendingCalendars.length === 0) {
      return googleCallbackRedirect(record.returnPath, "nocalendars");
    }
    if (pendingCalendars.length > 1) {
      return googleCallbackRedirect(record.returnPath, "choose");
    }

    const result = await dependencies.verify({
      tenantId: record.tenantId,
      actorId: actor.userId,
      accessToken: grant.accessToken,
      grant: stored,
      calendar: pendingCalendars[0],
    });
    return googleCallbackRedirect(record.returnPath, result.verified ? "ready" : "unverified");
  };
}

export const GET = createGoogleCallbackHandler({
  enabled: googleCalendarOAuthLive,
  session: loadRouteActor,
  consumeState: (state) =>
    consumeGoogleOAuthState({ state }, { states: createGoogleOAuthStateStore() }),
  exchange: (code) => {
    const configuration = googleCalendarOAuthConfiguration();
    return exchangeGoogleAuthorizationCode({
      code,
      client: configuration.client,
      // The same string the authorization URL carried, recomputed from the same source rather than
      // read back off this request, because Google compares the two byte for byte.
      redirectUri: googleRedirectUri(configuration.appBaseUrl),
    });
  },
  listCalendars: (accessToken) => listGoogleCalendars({ accessToken }),
  persistGrant: ({ tenantId, googleAccountEmail: email, grant, pendingCalendars }) =>
    persistGoogleCalendarGrant({
      tenantId,
      googleAccountEmail: email,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      tokenExpiresAt: grant.expiresAt,
      refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
      grantedScopes: grant.grantedScopes,
      pendingCalendars,
    }),
  verify: (input) => verifyGoogleCalendar(input, liveVerifyCalendarDependencies()),
});
