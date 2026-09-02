import { createHash } from "node:crypto";

import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { googleCalendarOAuthLive, phase5Live } from "@/lib/env-contract";
import {
  loadGoogleCalendarGrant,
  type GooglePendingCalendar,
} from "@/lib/integrations/google-calendar-oauth-store";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const PROVIDERS = ["ghl", "google"] as const;
const CALENDAR_CONNECTION_SELECT = [
  "id",
  "provider",
  "calendar_name",
  "external_calendar_id",
  "external_account_reference",
  "authorized_at",
  "state",
].join(",");

type CalendarConnection = {
  id: string;
  provider: typeof PROVIDERS[number];
  calendarName: string | null;
  externalCalendarId: string;
  externalAccountReference: string | null;
  authorizationRecordedAt: string | null;
  state: "disconnected" | "connecting" | "ready" | "error" | "expired";
};
type CalendarSaveInput = {
  provider: typeof PROVIDERS[number]; externalAccountReference: string; externalCalendarId: string;
  calendarName: string | null; timezone: string; authorizationReceipt: string;
};
type CalendarSaveReceipt = { connection: CalendarConnection; audit: { id: string; actionKey: "onboarding.calendar_authorization.recorded" } };

/**
 * What the page needs to know about a stored Google authorization, and nothing more.
 *
 * `connectedAs` is the identity line. There is no token, no envelope and no expiry the coach cannot
 * act on: `refreshTokenExpiresAt` is here because under Testing publishing status every grant dies
 * seven days after consent, so the page has to be able to say that plainly rather than let a
 * booking fail silently later.
 */
export type GoogleGrantSummary = {
  connectedAs: string | null;
  refreshTokenExpiresAt: string | null;
  reauthorizationRequired: boolean;
};

export type CalendarDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  load(tenantId: string): Promise<CalendarConnection | null>;
  save(input: CalendarSaveInput & { tenantId: string; actorId: string }): Promise<CalendarSaveReceipt>;
  /**
   * Both optional so the flag alone decides whether this route talks to the Google tables at all.
   * With the flag unset the page gets `googleConnectAvailable: false`, an absent grant and an empty
   * picker, which is exactly what it renders today.
   */
  googleEnabled?(): boolean;
  loadGoogle?(tenantId: string): Promise<{
    grant: GoogleGrantSummary;
    pendingCalendars: readonly GooglePendingCalendar[];
  } | null>;
};

function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }

function parseBody(value: unknown): CalendarSaveInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = ["provider", "externalAccountReference", "externalCalendarId", "calendarName", "timezone", "authorizationReceipt"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return null;
  const provider = text(body.provider);
  const externalAccountReference = text(body.externalAccountReference);
  const externalCalendarId = text(body.externalCalendarId);
  const timezone = text(body.timezone);
  const authorizationReceipt = text(body.authorizationReceipt);
  const calendarName = body.calendarName === null || body.calendarName === undefined ? null : text(body.calendarName);
  if (!provider || !PROVIDERS.includes(provider as typeof PROVIDERS[number]) || !externalAccountReference
    || !externalCalendarId || !timezone || !authorizationReceipt || authorizationReceipt.length > 2048
    || (body.calendarName !== null && body.calendarName !== undefined && !calendarName)) return null;
  return { provider: provider as typeof PROVIDERS[number], externalAccountReference, externalCalendarId, calendarName, timezone, authorizationReceipt };
}

function refuse(actor: RouteActor | null) {
  if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
  if (hasImpersonationMarker(actor)) {
    return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
  }
  if (actor.role !== "coach") return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
  return null;
}

export function createCalendarHandlers(dependencies: CalendarDependencies) {
  return {
    GET: async () => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const rejected = refuse(actor);
      if (rejected || !actor) return rejected!;
      try {
        const connection = await dependencies.load(actor.tenantId);
        const googleConnectAvailable = (dependencies.googleEnabled ?? googleCalendarOAuthLive)();
        const google = googleConnectAvailable
          ? await (dependencies.loadGoogle ?? loadGoogleOnboardingState)(actor.tenantId)
          : null;
        return Response.json({
          connection,
          googleConnectAvailable,
          googleGrant: google?.grant ?? null,
          // Offered only while there is a grant and no Google connection has been written from it.
          // Once one exists the coach is looking at a connection, not at a choice.
          pendingCalendars:
            google && !(connection && connection.provider === "google") ? google.pendingCalendars : [],
        }, { headers: NO_STORE });
      } catch (cause) {
        console.error(
          "/api/onboarding/calendar failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "Calendar connection is unavailable." }, { status: 503, headers: NO_STORE });
      }
    },
    POST: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const rejected = refuse(actor);
      if (rejected || !actor) return rejected!;
      const body = parseBody(await request.json().catch(() => null));
      if (!body) return Response.json({ error: "Invalid calendar authorization." }, { status: 400, headers: NO_STORE });
      try {
        return Response.json(await dependencies.save({ ...body, tenantId: actor.tenantId, actorId: actor.userId }), {
          headers: NO_STORE,
        });
      } catch {
        return Response.json({ error: "Calendar authorization was refused." }, { status: 409, headers: NO_STORE });
      }
    },
  };
}

function mapConnection(row: Record<string, unknown>): CalendarConnection {
  return {
    id: String(row.id), provider: row.provider as CalendarConnection["provider"],
    calendarName: typeof row.calendar_name === "string" ? row.calendar_name : null,
    externalCalendarId: String(row.external_calendar_id),
    externalAccountReference: typeof row.external_account_reference === "string" ? row.external_account_reference : null,
    authorizationRecordedAt: typeof row.authorized_at === "string" ? row.authorized_at : null,
    state: row.state as CalendarConnection["state"],
  };
}

export async function loadGoogleOnboardingState(tenantId: string) {
  const grant = await loadGoogleCalendarGrant(tenantId);
  if (!grant) return null;
  return {
    grant: {
      connectedAs: grant.googleAccountEmail,
      refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
      reauthorizationRequired: grant.reauthorizationRequiredAt !== null,
    },
    pendingCalendars: grant.pendingCalendars,
  };
}

const handlers = createCalendarHandlers({
  enabled: phase5Live,
  session: loadRouteActor,
  load: async (tenantId) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.from("calendar_connections").select(CALENDAR_CONNECTION_SELECT)
      .eq("tenant_id", tenantId).eq("is_primary", true).maybeSingle();
    if (error) throw new Error("CALENDAR_CONNECTION_READ_FAILED");
    return data ? mapConnection(data as unknown as Record<string, unknown>) : null;
  },
  save: async (input) => {
    const client = createSupabaseServiceClient();
    const receiptHash = createHash("sha256").update(input.authorizationReceipt).digest("hex");
    const { data, error } = await client.rpc("record_onboarding_calendar_authorization", {
      p_expected_tenant: input.tenantId, p_actor_id: input.actorId, p_provider: input.provider,
      p_external_account_reference: input.externalAccountReference, p_external_calendar_id: input.externalCalendarId,
      p_calendar_name: input.calendarName, p_timezone: input.timezone, p_authorization_receipt_hash: receiptHash,
    });
    const result = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
    if (error || !result || typeof result.calendar_connection_id !== "string" || !result.audit_id) {
      throw new Error("CALENDAR_AUTHORIZATION_WRITE_FAILED");
    }
    const { data: row, error: readError } = await client.from("calendar_connections").select(CALENDAR_CONNECTION_SELECT)
      .eq("tenant_id", input.tenantId).eq("id", result.calendar_connection_id).single();
    if (readError || !row) throw new Error("CALENDAR_AUTHORIZATION_READBACK_FAILED");
    return { connection: mapConnection(row as unknown as Record<string, unknown>), audit: {
      id: String(result.audit_id), actionKey: "onboarding.calendar_authorization.recorded",
    } };
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;
