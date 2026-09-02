/**
 * The coach's calendar pick.
 *
 * Every 200 from this route carries the same `connection` shape the onboarding GET returns, with
 * the outcome in sibling fields. That is not tidiness: the page renders the calendar name straight
 * off `connection`, so a partial object on the failed arm would blank the name, the id and the
 * authorized-at timestamp at exactly the moment the coach needs to see what was picked.
 *
 * A freebusy read that did not verify is still a 200, because the authorization was recorded and
 * only the availability read failed. It returns `receipt: null`, which is the honest-states rule
 * rather than a convenience: the only audit key available here is `calendar.connected`, which is
 * coach-visible and renders as "connected a calendar", so writing it while the page's amber card
 * says availability is not verified would have the log contradict the screen.
 */

import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { googleCalendarOAuthLive } from "@/lib/env-contract";
import { isGoogleInvalidGrant } from "@/lib/integrations/google-calendar-oauth";
import {
  loadGoogleCalendarGrant,
  resolveGoogleAccessToken,
  type GoogleCalendarGrantRow,
} from "@/lib/integrations/google-calendar-oauth-store";

import { NO_STORE, exactKeys, notFound, refuseActor, trimmed } from "../guards";
import {
  liveVerifyCalendarDependencies,
  verifyGoogleCalendar,
  type VerifyCalendarResult,
} from "../verify-calendar";

export type GoogleSelectDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  loadGrant(tenantId: string): Promise<GoogleCalendarGrantRow | null>;
  resolveAccessToken(input: {
    tenantId: string;
    grant: GoogleCalendarGrantRow;
  }): Promise<{ accessToken: string }>;
  verify(input: {
    tenantId: string;
    actorId: string;
    accessToken: string;
    grant: GoogleCalendarGrantRow;
    calendar: { id: string; name: string; timeZone: string };
  }): Promise<VerifyCalendarResult>;
};

const GRANT_EXPIRED = {
  error: "Calendar authorization has expired.",
  code: "GOOGLE_GRANT_EXPIRED",
} as const;

export function createGoogleSelectHandler(dependencies: GoogleSelectDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return notFound();
    const actor = await dependencies.session();
    const rejected = refuseActor(actor);
    if (rejected || !actor) return rejected!;

    const body = exactKeys(await request.json().catch(() => null), ["externalCalendarId"]);
    const externalCalendarId = body ? trimmed(body.externalCalendarId) : null;
    if (!externalCalendarId) {
      return Response.json({ error: "Invalid calendar selection." }, { status: 400, headers: NO_STORE });
    }

    const grant = await dependencies.loadGrant(actor.tenantId);
    // The id has to be one we offered this tenant. Without this the browser could nominate any
    // calendar id it liked and we would happily write it onto the connection.
    const calendar = grant?.pendingCalendars.find((entry) => entry.id === externalCalendarId);
    if (!grant || !calendar) {
      return Response.json({ error: "Invalid calendar selection." }, { status: 400, headers: NO_STORE });
    }

    let accessToken: string;
    try {
      ({ accessToken } = await dependencies.resolveAccessToken({ tenantId: actor.tenantId, grant }));
    } catch (cause) {
      // The store has already moved the connection to `expired` and marked the grant. Anything
      // else is a transient provider or database failure and must not read as a dead grant.
      if (isGoogleInvalidGrant(cause)) {
        return Response.json(GRANT_EXPIRED, { status: 409, headers: NO_STORE });
      }
      return Response.json(
        { error: "Calendar verification is unavailable.", code: "CALENDAR_VERIFICATION_UNAVAILABLE" },
        { status: 503, headers: NO_STORE },
      );
    }

    const result = await dependencies.verify({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      accessToken,
      grant,
      calendar,
    });
    return Response.json(result, { headers: NO_STORE });
  };
}

export const POST = createGoogleSelectHandler({
  enabled: googleCalendarOAuthLive,
  session: loadRouteActor,
  loadGrant: (tenantId) => loadGoogleCalendarGrant(tenantId),
  resolveAccessToken: (input) => resolveGoogleAccessToken(input),
  verify: (input) => verifyGoogleCalendar(input, liveVerifyCalendarDependencies()),
});
