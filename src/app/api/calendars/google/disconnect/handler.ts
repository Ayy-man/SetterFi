/**
 * Disconnecting a Google calendar, and the one rule that shapes the whole route: the row is held
 * until Google confirms the revoke.
 *
 * The confirmation dialog already on screen tells the coach the connection changes to disconnected
 * only after the provider confirms that revoke. Writing `disconnected` on an unconfirmed revoke
 * would make the product state a rule its backend does not follow, which is the honest-states rule
 * in CLAUDE.md. Holding the row costs a coach one retry; the alternative is a false sentence on
 * screen.
 *
 * Confirmed means exactly two things and nothing else: a 200 from the revoke endpoint, which Google
 * documents as a processed revocation, or a 400 whose body `error` is `invalid_token`, meaning the
 * token was already dead and there was nothing left to revoke.
 *
 * **`invalid_token` is an assumption, not a fact.** The research records only that a 400 arrives
 * "along with an error code" and does not enumerate them, so that string came from model recall,
 * which PRE-FLIGHT.md forbids as a source. It is coded as the entire allow-list precisely so that
 * being wrong about it fails closed into PROVIDER_REVOKE_UNCONFIRMED rather than into a false
 * "disconnected". The observed status and code go into the receipt evidence, and step 9 of the
 * click-through script is the run that turns this guess into an observation.
 *
 * One documented escape hatch: a grant our own records already show as dead. It is decided on our
 * rows, never on the revoke result, which is what keeps it from widening into "any failed revoke
 * counts". A grant we have already recorded as dead has no live authorization left to revoke, and
 * under Testing publishing status every grant dies seven days after consent, so day eight is the
 * ordinary case rather than the edge.
 */

import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { googleCalendarOAuthLive } from "@/lib/env-contract";
import {
  revokeGoogleGrant,
  type GoogleRevokeResult,
} from "@/lib/integrations/google-calendar-oauth";
import {
  decryptGoogleRefreshToken,
  loadGoogleCalendarGrant,
  type GoogleCalendarGrantRow,
} from "@/lib/integrations/google-calendar-oauth-store";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import { NO_STORE, exactKeys, notFound, refuseActor, trimmed } from "../guards";
import {
  CALENDAR_CONNECTION_SELECT,
  calendarCommandReceipt,
  mapCalendarConnection,
  type CalendarCommandReceipt,
  type CalendarConnection,
} from "../verify-calendar";

/** The whole allow-list. Widening it from recall is the failure mode this shape exists to prevent. */
export const GOOGLE_REVOKE_CONFIRMED_ERROR_CODES = ["invalid_token"] as const;

export function googleRevokeConfirmed(result: GoogleRevokeResult) {
  if (result.status === 200) return true;
  return result.status === 400
    && result.errorCode !== null
    && GOOGLE_REVOKE_CONFIRMED_ERROR_CODES.includes(
      result.errorCode as (typeof GOOGLE_REVOKE_CONFIRMED_ERROR_CODES)[number],
    );
}

/**
 * Whether our own records already say the authorization is gone. Decided entirely on rows we hold,
 * so a live grant whose revoke came back unrecognised can never fall through here.
 */
export function googleGrantKnownDead(
  connection: CalendarConnection,
  grant: GoogleCalendarGrantRow | null,
  now: number,
) {
  if (connection.state === "expired") return true;
  if (!grant) return true;
  if (grant.reauthorizationRequiredAt !== null) return true;
  if (grant.revokedAt !== null) return true;
  const deadline = grant.refreshTokenExpiresAt ? Date.parse(grant.refreshTokenExpiresAt) : NaN;
  return Number.isFinite(deadline) && deadline <= now;
}

export type GoogleDisconnectDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  loadConnection(tenantId: string): Promise<CalendarConnection | null>;
  loadGrant(tenantId: string): Promise<GoogleCalendarGrantRow | null>;
  revoke(input: { grant: GoogleCalendarGrantRow }): Promise<GoogleRevokeResult>;
  recordDisconnected(input: {
    tenantId: string;
    connectionId: string;
    actorId: string;
    idempotencyKey: string;
    evidence: Record<string, unknown>;
  }): Promise<CalendarCommandReceipt>;
  now?: () => number;
};

const UNCONFIRMED = {
  error: "Google did not confirm the revocation.",
  code: "PROVIDER_REVOKE_UNCONFIRMED",
} as const;

export function createGoogleDisconnectHandler(dependencies: GoogleDisconnectDependencies) {
  const now = dependencies.now ?? Date.now;
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return notFound();
    const actor = await dependencies.session();
    const rejected = refuseActor(actor);
    if (rejected || !actor) return rejected!;

    const body = exactKeys(await request.json().catch(() => null), ["idempotencyKey"]);
    const idempotencyKey = body ? trimmed(body.idempotencyKey) : null;
    if (!idempotencyKey) {
      return Response.json({ error: "Invalid disconnect request." }, { status: 400, headers: NO_STORE });
    }

    const connection = await dependencies.loadConnection(actor.tenantId);
    if (!connection || connection.provider !== "google") {
      return Response.json(
        { error: "No Google calendar is connected.", code: "CALENDAR_CONNECTION_NOT_FOUND" },
        { status: 409, headers: NO_STORE },
      );
    }

    const grant = await dependencies.loadGrant(actor.tenantId);
    const knownDead = googleGrantKnownDead(connection, grant, now());
    // Attempted even for a grant we already know is dead, so the receipt records what Google
    // actually said rather than what we assumed it would say.
    const revoked = grant
      ? await dependencies.revoke({ grant })
      : { revoked: false, status: 0, errorCode: null };
    const confirmed = googleRevokeConfirmed(revoked);

    if (!confirmed && !knownDead) {
      return Response.json(UNCONFIRMED, { status: 409, headers: NO_STORE });
    }

    const receipt = await dependencies.recordDisconnected({
      tenantId: actor.tenantId,
      connectionId: connection.id,
      actorId: actor.userId,
      idempotencyKey,
      evidence: {
        revoke_status: revoked.status,
        revoke_error_code: revoked.errorCode,
        // Says plainly which authority produced this outcome, so a later reader is not left to
        // infer that Google confirmed something it never answered.
        confirmed_by: confirmed ? "provider" : "local_records",
        grant_known_dead: knownDead,
      },
    });
    return Response.json({ disconnected: true, receipt }, { headers: NO_STORE });
  };
}

// ---------------------------------------------------------------------------
// Live dependencies
// ---------------------------------------------------------------------------

export const POST = createGoogleDisconnectHandler({
  enabled: googleCalendarOAuthLive,
  session: loadRouteActor,
  loadConnection: async (tenantId) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client
      .from("calendar_connections")
      .select(CALENDAR_CONNECTION_SELECT)
      .eq("tenant_id", tenantId)
      .eq("is_primary", true)
      .maybeSingle();
    if (error) throw new Error("CALENDAR_CONNECTION_READ_FAILED");
    return data ? mapCalendarConnection(data as unknown as Record<string, unknown>) : null;
  },
  loadGrant: (tenantId) => loadGoogleCalendarGrant(tenantId),
  // The refresh token, because Google documents that revoking it kills the access token with it.
  // The plaintext exists only as this argument and reaches no column, no body and no log line.
  revoke: ({ grant }) => revokeGoogleGrant({ token: decryptGoogleRefreshToken(grant) }),
  recordDisconnected: async (input) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.rpc("record_calendar_connection_disconnected", {
      p_expected_tenant: input.tenantId,
      p_connection_id: input.connectionId,
      p_actor_id: input.actorId,
      p_idempotency_key: input.idempotencyKey,
      p_evidence: input.evidence,
    });
    const receipt = error ? null : calendarCommandReceipt(data, "PROVIDER_REVOKED");
    if (!receipt) throw new Error("CALENDAR_DISCONNECT_WRITE_FAILED");
    return receipt;
  },
});
