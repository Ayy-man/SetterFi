/**
 * The one place a Google calendar becomes a calendar connection, used by both routes that can
 * produce one: the callback's single-calendar auto-pick and the picker's `POST /select`.
 *
 * There is one function rather than two code paths because the two entries differ only in how the
 * calendar was chosen. Everything after that — the freebusy read, the authorization write, the
 * availability write and the read-back — is the same, and a second implementation of it would be a
 * second definition of what `ready` means.
 *
 * The order is load-bearing. `record_onboarding_calendar_authorization` records that the coach
 * authorized us and inserts the row as `connecting`; its comment states the invariant this file
 * must not break, that a provider receipt proves authorization and not availability. Only
 * `record_calendar_connection_availability` may write `ready`, and only after a freebusy read that
 * returned an entry for the chosen calendar with no per-calendar errors. So a failed availability
 * read still records the authorization: the coach really did authorize us, and saying otherwise
 * would be as dishonest as claiming the calendar is bookable.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  queryGoogleFreeBusy,
  type GoogleFreeBusyResult,
} from "@/lib/integrations/google-calendar-oauth";
import type {
  GoogleCalendarGrantRow,
  GooglePendingCalendar,
} from "@/lib/integrations/google-calendar-oauth-store";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/** Seven days ahead: long enough that a sparse calendar still answers, short enough to stay cheap. */
export const FREEBUSY_VERIFICATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export const CALENDAR_CONNECTION_SELECT = [
  "id",
  "provider",
  "calendar_name",
  "external_calendar_id",
  "external_account_reference",
  "authorized_at",
  "state",
].join(",");

export type CalendarConnection = {
  id: string;
  provider: "ghl" | "google";
  calendarName: string | null;
  externalCalendarId: string;
  externalAccountReference: string | null;
  authorizationRecordedAt: string | null;
  state: "disconnected" | "connecting" | "ready" | "error" | "expired";
};

export type CalendarCommandReceipt = {
  receiptId: string;
  auditId: number;
  outcome: "verified" | "not_verified" | "started" | "replayed";
  code: string;
};

export type VerifyCalendarResult = {
  connection: CalendarConnection;
  verified: boolean;
  outcome: "AVAILABILITY_VERIFIED" | "AVAILABILITY_NOT_VERIFIED";
  receipt: CalendarCommandReceipt | null;
};

export type VerifyCalendarDependencies = {
  freebusy(input: {
    accessToken: string;
    calendarId: string;
    timeMin: string;
    timeMax: string;
  }): Promise<GoogleFreeBusyResult>;
  recordAuthorization(input: {
    tenantId: string;
    actorId: string;
    externalAccountReference: string;
    externalCalendarId: string;
    calendarName: string;
    timezone: string;
    authorizationReceiptHash: string;
  }): Promise<{ connectionId: string }>;
  recordAvailability(input: {
    tenantId: string;
    actorId: string;
    connectionId: string;
    idempotencyKey: string;
    outcome: "verified" | "not_verified";
    outcomeCode: string;
    evidence: Record<string, unknown>;
  }): Promise<CalendarCommandReceipt | null>;
  loadConnection(input: { tenantId: string; connectionId: string }): Promise<CalendarConnection>;
  now?: () => number;
  idempotencyKey?: () => string;
};

export function mapCalendarConnection(row: Record<string, unknown>): CalendarConnection {
  return {
    id: String(row.id),
    provider: row.provider as CalendarConnection["provider"],
    calendarName: typeof row.calendar_name === "string" ? row.calendar_name : null,
    externalCalendarId: String(row.external_calendar_id),
    externalAccountReference:
      typeof row.external_account_reference === "string" ? row.external_account_reference : null,
    authorizationRecordedAt: typeof row.authorized_at === "string" ? row.authorized_at : null,
    state: row.state as CalendarConnection["state"],
  };
}

/**
 * The authorization receipt is the grant row's id and never a credential.
 *
 * The RPC stores a SHA-256 of whatever it is given, so anything fed in here is recoverable only by
 * guessing it — which is exactly why an access token, a refresh token or an authorization code must
 * never be the input. The grant id is stable, is already the thing the connection is authorized by,
 * and is derived from nothing secret.
 */
export function googleAuthorizationReceiptHash(grantId: string) {
  return createHash("sha256").update(grantId).digest("hex");
}

/**
 * `external_account_reference` must be non-blank, and we requested no identity scope, so there is
 * no id_token and no userinfo call to read an email from. The primary calendarList entry's id is
 * the account's email address for a Google account, which is why the callback stores it. When no
 * entry claimed to be primary, the grant row's own id stands in: stable, plaintext-safe, and
 * derived from nothing secret, which matters because the column is plaintext.
 */
export function googleExternalAccountReference(grant: GoogleCalendarGrantRow) {
  return grant.googleAccountEmail ?? `google:${grant.id}`;
}

export async function verifyGoogleCalendar(
  input: {
    tenantId: string;
    actorId: string;
    accessToken: string;
    grant: GoogleCalendarGrantRow;
    calendar: GooglePendingCalendar;
  },
  dependencies: VerifyCalendarDependencies,
): Promise<VerifyCalendarResult> {
  const now = dependencies.now ?? Date.now;
  const idempotencyKey = (dependencies.idempotencyKey ?? randomUUID)();
  const startedAt = now();
  const timeMin = new Date(startedAt).toISOString();
  const timeMax = new Date(startedAt + FREEBUSY_VERIFICATION_WINDOW_MS).toISOString();

  // An HTTP failure and a 200 carrying a per-calendar errors array are the same answer to the only
  // question being asked: can we read this calendar's availability? Both leave the connection
  // `connecting`, and both are described by one of our own codes, never by provider prose.
  let reason: string | null = null;
  try {
    const result = await dependencies.freebusy({
      accessToken: input.accessToken,
      calendarId: input.calendar.id,
      timeMin,
      timeMax,
    });
    reason = result.ok ? null : result.reason ?? "FREEBUSY_NOT_VERIFIED";
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : null;
    reason = code && /^[A-Z0-9_]+$/.test(code) ? code : "FREEBUSY_REQUEST_FAILED";
  }

  const { connectionId } = await dependencies.recordAuthorization({
    tenantId: input.tenantId,
    actorId: input.actorId,
    externalAccountReference: googleExternalAccountReference(input.grant),
    externalCalendarId: input.calendar.id,
    calendarName: input.calendar.name,
    timezone: input.calendar.timeZone,
    authorizationReceiptHash: googleAuthorizationReceiptHash(input.grant.id),
  });

  const verified = reason === null;
  const receipt = await dependencies.recordAvailability({
    tenantId: input.tenantId,
    actorId: input.actorId,
    connectionId,
    idempotencyKey,
    outcome: verified ? "verified" : "not_verified",
    // The not_verified arm stores this string verbatim in `calendar_connections.last_error`, so it
    // carries our reason code and nothing a provider wrote.
    outcomeCode: verified ? "AVAILABILITY_VERIFIED" : `AVAILABILITY_NOT_VERIFIED:${reason}`,
    evidence: { window_hours: FREEBUSY_VERIFICATION_WINDOW_MS / 3_600_000, reason },
  });

  return {
    connection: await dependencies.loadConnection({ tenantId: input.tenantId, connectionId }),
    verified,
    outcome: verified ? "AVAILABILITY_VERIFIED" : "AVAILABILITY_NOT_VERIFIED",
    receipt,
  };
}

// ---------------------------------------------------------------------------
// Live dependencies
// ---------------------------------------------------------------------------

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

/**
 * Both RPCs return (receipt_id, audit_id, replayed, outcome) and no code, so the code is supplied
 * by the caller that chose it. Null is the honest answer for the not_verified arm, which writes no
 * audit row and therefore has no receipt to point at.
 *
 * The shape is checked here rather than trusted because the consumer on /coach/integrations rejects
 * anything where auditId is not a positive safe integer, and a receipt that fails there reads to a
 * coach as a disconnect that did not happen.
 */
function commandReceipt(value: unknown, code: string): CalendarCommandReceipt | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const receiptId = typeof record.receipt_id === "string" ? record.receipt_id : null;
  const auditId = Number(record.audit_id);
  if (!receiptId || !Number.isSafeInteger(auditId) || auditId <= 0) return null;
  return { receiptId, auditId, outcome: record.outcome as CalendarCommandReceipt["outcome"], code };
}

export function liveVerifyCalendarDependencies(
  client: ServiceClient = createSupabaseServiceClient(),
): VerifyCalendarDependencies {
  return {
    freebusy: (request) => queryGoogleFreeBusy(request),
    recordAuthorization: async (input) => {
      const { data, error } = await client.rpc("record_onboarding_calendar_authorization", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_provider: "google",
        p_external_account_reference: input.externalAccountReference,
        p_external_calendar_id: input.externalCalendarId,
        p_calendar_name: input.calendarName,
        p_timezone: input.timezone,
        p_authorization_receipt_hash: input.authorizationReceiptHash,
      });
      const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
      if (error || !row || typeof row.calendar_connection_id !== "string") {
        throw new Error("CALENDAR_AUTHORIZATION_WRITE_FAILED");
      }
      return { connectionId: row.calendar_connection_id };
    },
    recordAvailability: async (input) => {
      const { data, error } = await client.rpc("record_calendar_connection_availability", {
        p_expected_tenant: input.tenantId,
        p_connection_id: input.connectionId,
        p_actor_id: input.actorId,
        p_idempotency_key: input.idempotencyKey,
        p_outcome: input.outcome,
        p_outcome_code: input.outcomeCode,
        p_evidence: input.evidence,
      });
      if (error) throw new Error("CALENDAR_AVAILABILITY_WRITE_FAILED");
      return commandReceipt(data, input.outcomeCode);
    },
    loadConnection: async ({ tenantId, connectionId }) => {
      const { data, error } = await client
        .from("calendar_connections")
        .select(CALENDAR_CONNECTION_SELECT)
        .eq("tenant_id", tenantId)
        .eq("id", connectionId)
        .single();
      if (error || !data) throw new Error("CALENDAR_CONNECTION_READBACK_FAILED");
      return mapCalendarConnection(data as unknown as Record<string, unknown>);
    },
  };
}

export { commandReceipt as calendarCommandReceipt };
