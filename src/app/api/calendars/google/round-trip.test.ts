/**
 * The whole sequence — connect, callback, picker, verification, disconnect — driven end to end
 * against the Wave 1 mock driver and an in-memory Postgres stand-in.
 *
 * It is the automated half of the proof and it is deliberately not the whole proof: no request
 * leaves the process and no statement reaches a real database, so this file can show that the
 * pieces agree with each other and cannot show that they agree with Google. The live flow stays
 * unproven until a human runs the click-through script.
 *
 * The stand-in re-implements the three RPCs rather than mocking the calls to them, because the
 * behaviour under test is exactly what those functions do to the rows: which arm writes an audit
 * row, which arm may set `ready`, and what leaves together with the grant on a disconnect.
 */

import { describe, expect, it } from "vitest";

import {
  consumeGoogleOAuthState,
  exchangeGoogleAuthorizationCode,
  googleRedirectUri,
  listGoogleCalendars,
  revokeGoogleGrant,
} from "@/lib/integrations/google-calendar-oauth";
import {
  createGoogleCalendarMockFetch,
  type GoogleMockScript,
} from "@/lib/integrations/google-calendar-oauth-mock";
import {
  createGoogleOAuthStateStore,
  decryptGoogleRefreshToken,
  loadGoogleCalendarGrant,
  persistGoogleCalendarGrant,
  resolveGoogleAccessToken,
} from "@/lib/integrations/google-calendar-oauth-store";

import { beginGoogleConnect, createGoogleConnectHandler } from "./connect/handler";
import { createGoogleCallbackHandler } from "./callback/handler";
import { createGoogleDisconnectHandler } from "./disconnect/handler";
import { createGoogleSelectHandler } from "./select/handler";
import { calendarCommandReceipt, liveVerifyCalendarDependencies, verifyGoogleCalendar } from "./verify-calendar";

const ENVIRONMENT = {
  // The envelope key falls back to the mock deployment key under this selector, so the round trip
  // encrypts for real without a deployment secret in the test process.
  SETTERFI_META_DRIVER: "mock",
  APP_BASE_URL: "https://setterfi.test",
  GOOGLE_CALENDAR_CLIENT_ID: "client-id",
  GOOGLE_CALENDAR_CLIENT_SECRET: "client-secret",
};

const actor = {
  userId: "coach-1",
  tenantId: "tenant-1",
  role: "coach" as const,
  impersonatingTenant: null,
  impersonationSessionId: null,
};

type Row = Record<string, unknown>;

/**
 * Enough of the query builder and the three calendar RPCs to run the real store and the real route
 * wiring against memory. Every filter the production code expresses is applied for real, so a
 * predicate dropped from a write shows up here as a row that changed when it should not have.
 */
function memoryDatabase() {
  const tables: Record<string, Row[]> = {
    google_oauth_states: [],
    google_calendar_grants: [],
    calendar_connections: [],
    calendar_connection_command_receipts: [],
    audit_log: [],
  };
  let sequence = 1;
  const id = (prefix: string) => `${prefix}-${sequence++}`;

  function builder(table: string) {
    const filters: [string, unknown][] = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Row = {};
    // `undefined` and `null` are the same absence here: a column a row never carried is a column
    // Postgres would report as null, and a filter that missed it would silently match nothing.
    const matches = (row: Row) =>
      filters.every(([column, value]) => (row[column] ?? null) === (value ?? null));
    const run = () => {
      const rows = tables[table];
      if (op === "insert") {
        rows.push({ ...payload });
        return { data: null, error: null };
      }
      if (op === "upsert") {
        const existing = rows.find((row) => row.tenant_id === payload.tenant_id);
        if (existing) Object.assign(existing, payload);
        else rows.push({ id: id("grant"), ...payload });
        return { data: rows.find((row) => row.tenant_id === payload.tenant_id) ?? null, error: null };
      }
      if (op === "update") {
        const hit = rows.filter(matches);
        for (const row of hit) Object.assign(row, payload);
        return { data: hit[0] ?? null, error: null };
      }
      if (op === "delete") {
        tables[table] = rows.filter((row) => !matches(row));
        return { data: null, error: null };
      }
      return { data: rows.filter(matches)[0] ?? null, error: null };
    };
    const self: Record<string, unknown> = {
      insert: (value: Row) => { op = "insert"; payload = value; return self; },
      update: (value: Row) => { op = "update"; payload = value; return self; },
      upsert: (value: Row) => { op = "upsert"; payload = value; return self; },
      delete: () => { op = "delete"; return self; },
      select: () => self,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return self; },
      is: (column: string, value: unknown) => { filters.push([column, value]); return self; },
      limit: () => self,
      maybeSingle: async () => run(),
      single: async () => run(),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return self;
  }

  function writeAudit(action: string, connectionId: string) {
    const auditId = sequence++;
    tables.audit_log.push({ id: auditId, action, target_id: connectionId, tenant_id: "tenant-1" });
    return auditId;
  }

  const rpc = async (name: string, args: Row) => {
    if (name === "record_onboarding_calendar_authorization") {
      const existing = tables.calendar_connections.find(
        (row) => row.tenant_id === args.p_expected_tenant && row.is_primary === true,
      );
      if (existing) {
        // Preserves an existing `ready`: a provider receipt proves authorization, not availability.
        Object.assign(existing, {
          provider: args.p_provider,
          external_calendar_id: args.p_external_calendar_id,
          external_account_reference: args.p_external_account_reference,
          calendar_name: args.p_calendar_name,
          authorized_at: "2026-09-02T00:00:00.000Z",
          state: existing.state === "ready" ? "ready" : "connecting",
        });
        return { data: [{ calendar_connection_id: existing.id, audit_id: sequence++ }], error: null };
      }
      const connectionId = id("connection");
      tables.calendar_connections.push({
        id: connectionId,
        tenant_id: args.p_expected_tenant,
        provider: args.p_provider,
        is_primary: true,
        external_calendar_id: args.p_external_calendar_id,
        external_account_reference: args.p_external_account_reference,
        calendar_name: args.p_calendar_name,
        authorized_at: "2026-09-02T00:00:00.000Z",
        state: "connecting",
        last_slot_fetch_at: null,
        last_slot_fetch_ok: null,
        last_error: null,
      });
      return { data: [{ calendar_connection_id: connectionId, audit_id: sequence++ }], error: null };
    }

    if (name === "record_calendar_connection_availability") {
      const row = tables.calendar_connections.find((entry) => entry.id === args.p_connection_id);
      if (!row) return { data: null, error: { message: "CALENDAR_CONNECTION_NOT_FOUND" } };
      if (args.p_outcome === "verified") {
        Object.assign(row, {
          state: "ready",
          last_slot_fetch_at: "2026-09-02T00:00:00.000Z",
          last_slot_fetch_ok: true,
          last_error: null,
        });
        const auditId = writeAudit("calendar.connected", String(row.id));
        const receiptId = id("receipt");
        tables.calendar_connection_command_receipts.push({
          id: receiptId, command: "verify", audit_id: auditId, outcome: "verified",
        });
        return { data: [{ receipt_id: receiptId, audit_id: auditId, replayed: false, outcome: "verified" }], error: null };
      }
      // No audit row and no receipt: the only key available is coach-visible and reads as
      // "connected a calendar", which would contradict the amber card on the page.
      Object.assign(row, {
        last_slot_fetch_at: "2026-09-02T00:00:00.000Z",
        last_slot_fetch_ok: false,
        last_error: args.p_outcome_code,
      });
      return { data: [{ receipt_id: null, audit_id: null, replayed: false, outcome: "not_verified" }], error: null };
    }

    if (name === "record_calendar_connection_disconnected") {
      const row = tables.calendar_connections.find((entry) => entry.id === args.p_connection_id);
      if (!row) return { data: null, error: { message: "CALENDAR_CONNECTION_NOT_FOUND" } };
      Object.assign(row, {
        state: "disconnected",
        last_slot_fetch_at: null,
        last_slot_fetch_ok: null,
        last_error: null,
      });
      tables.google_calendar_grants = tables.google_calendar_grants.filter(
        (grant) => grant.tenant_id !== args.p_expected_tenant,
      );
      const auditId = writeAudit("calendar.disconnected", String(row.id));
      const receiptId = id("receipt");
      tables.calendar_connection_command_receipts.push({
        id: receiptId, command: "disconnect", audit_id: auditId, outcome: "verified",
      });
      return { data: [{ receipt_id: receiptId, audit_id: auditId, replayed: false, outcome: "verified" }], error: null };
    }
    throw new Error(`memory database has no RPC named ${name}`);
  };

  return {
    tables,
    rpc,
    client: { from: (table: string) => builder(table), rpc } as never,
    auditActions: () => tables.audit_log.map((row) => row.action),
    connection: () => tables.calendar_connections[0] ?? null,
    grant: () => tables.google_calendar_grants[0] ?? null,
  };
}

function harness(script: GoogleMockScript = {}) {
  const database = memoryDatabase();
  const fetchMock = createGoogleCalendarMockFetch(script);
  const client = database.client;
  const states = createGoogleOAuthStateStore(client);
  const verifyDependencies = {
    ...liveVerifyCalendarDependencies(client),
    freebusy: (request: { accessToken: string; calendarId: string; timeMin: string; timeMax: string }) =>
      import("@/lib/integrations/google-calendar-oauth")
        .then(({ queryGoogleFreeBusy }) => queryGoogleFreeBusy(request, { fetch: fetchMock })),
  };
  const session = async () => actor;

  const connect = createGoogleConnectHandler({
    enabled: () => true,
    session,
    begin: (input) => beginGoogleConnect(input, { states, environment: ENVIRONMENT }),
  });

  const callback = createGoogleCallbackHandler({
    enabled: () => true,
    session,
    consumeState: (state) => consumeGoogleOAuthState({ state }, { states }),
    exchange: (code) => exchangeGoogleAuthorizationCode({
      code,
      client: { clientId: ENVIRONMENT.GOOGLE_CALENDAR_CLIENT_ID, clientSecret: ENVIRONMENT.GOOGLE_CALENDAR_CLIENT_SECRET },
      redirectUri: googleRedirectUri(ENVIRONMENT.APP_BASE_URL),
    }, { fetch: fetchMock }),
    listCalendars: (accessToken) => listGoogleCalendars({ accessToken }, { fetch: fetchMock }),
    persistGrant: ({ tenantId, googleAccountEmail, grant, pendingCalendars }) =>
      persistGoogleCalendarGrant({
        tenantId,
        googleAccountEmail,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        tokenExpiresAt: grant.expiresAt,
        refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
        grantedScopes: grant.grantedScopes,
        pendingCalendars,
      }, client, ENVIRONMENT),
    verify: (input) => verifyGoogleCalendar(input, verifyDependencies),
  });

  const select = createGoogleSelectHandler({
    enabled: () => true,
    session,
    loadGrant: (tenantId) => loadGoogleCalendarGrant(tenantId, client),
    resolveAccessToken: (input) => resolveGoogleAccessToken(input, {
      client, environment: ENVIRONMENT, fetch: fetchMock,
    }),
    verify: (input) => verifyGoogleCalendar(input, verifyDependencies),
  });

  const disconnect = createGoogleDisconnectHandler({
    enabled: () => true,
    session,
    loadConnection: async (tenantId) => {
      const row = database.tables.calendar_connections.find(
        (entry) => entry.tenant_id === tenantId && entry.is_primary === true,
      );
      if (!row) return null;
      const { mapCalendarConnection } = await import("./verify-calendar");
      return mapCalendarConnection(row);
    },
    loadGrant: (tenantId) => loadGoogleCalendarGrant(tenantId, client),
    revoke: ({ grant }) => revokeGoogleGrant(
      { token: decryptGoogleRefreshToken(grant, ENVIRONMENT) },
      { fetch: fetchMock },
    ),
    recordDisconnected: async (input) => {
      const { data, error } = await database.rpc("record_calendar_connection_disconnected", {
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

  return { database, connect, callback, select, disconnect };
}

async function walkToCallback(instance: ReturnType<typeof harness>) {
  const started = await instance.connect(new Request("https://setterfi.test/api/calendars/google/connect"));
  const state = new URL(started.headers.get("Location") ?? "").searchParams.get("state");
  const landed = await instance.callback(
    new Request(`https://setterfi.test/api/calendars/google/callback?code=auth-code&state=${state}`),
  );
  return {
    state,
    outcome: new URL(landed.headers.get("Location") ?? "", "https://setterfi.invalid")
      .searchParams.get("calendar"),
  };
}

function post(body: unknown) {
  return new Request("https://setterfi.test", { method: "POST", body: JSON.stringify(body) });
}

describe("google calendar connect round trip", () => {
  it("walks connect, callback, picker and verification to a ready connection", async () => {
    const instance = harness({ calendars: "multiple" });
    const { outcome } = await walkToCallback(instance);
    expect(outcome).toBe("choose");
    expect(instance.database.grant()).not.toBeNull();
    // Nothing on the connections table yet: a stored grant with no picked calendar is a picker,
    // not a connection.
    expect(instance.database.connection()).toBeNull();

    const picked = await instance.select(post({ externalCalendarId: "consults@group.calendar.google.test" }));
    expect(picked.status).toBe(200);
    await expect(picked.json()).resolves.toMatchObject({
      verified: true,
      outcome: "AVAILABILITY_VERIFIED",
      connection: { state: "ready", calendarName: "Discovery calls" },
    });
    expect(instance.database.connection()).toMatchObject({
      provider: "google",
      state: "ready",
      last_slot_fetch_ok: true,
      last_error: null,
    });
    expect(instance.database.auditActions()).toEqual(["calendar.connected"]);
  });

  it("takes the single-calendar path to ready without a second code path", async () => {
    const instance = harness({ calendars: "single" });
    const { outcome } = await walkToCallback(instance);
    expect(outcome).toBe("ready");
    expect(instance.database.connection()).toMatchObject({
      state: "ready",
      last_slot_fetch_ok: true,
      calendar_name: "Coach",
    });
    expect(instance.database.auditActions()).toEqual(["calendar.connected"]);
  });

  it("leaves a calendar that answered with errors connecting, and logs no connection", async () => {
    const instance = harness({ calendars: "single", freebusy: "calendar-error" });
    const { outcome } = await walkToCallback(instance);
    expect(outcome).toBe("unverified");
    expect(instance.database.connection()).toMatchObject({
      state: "connecting",
      last_slot_fetch_ok: false,
      last_error: "AVAILABILITY_NOT_VERIFIED:CALENDAR_ERRORS",
    });
    expect(instance.database.auditActions()).toEqual([]);
  });

  it("moves a dead grant to expired and answers the picker with a 409 rather than throwing", async () => {
    const instance = harness({ calendars: "multiple", refresh: "invalid-grant" });
    await walkToCallback(instance);
    // One good pick first, so there is a connection row for `expired` to land on. The exchange's
    // own access token carried that one; only the second pick has to renew.
    await instance.select(post({ externalCalendarId: "coach@livelegacystrong.test" }));
    expect(instance.database.connection()).toMatchObject({ state: "ready" });

    // Age the stored access token past the refresh margin so the next pick must renew it.
    Object.assign(instance.database.grant() as Record<string, unknown>, {
      token_expires_at: "2020-01-01T00:00:00.000Z",
    });
    const picked = await instance.select(post({ externalCalendarId: "consults@group.calendar.google.test" }));
    expect(picked.status).toBe(409);
    await expect(picked.json()).resolves.toEqual({
      error: "Calendar authorization has expired.",
      code: "GOOGLE_GRANT_EXPIRED",
    });
    expect(instance.database.connection()).toMatchObject({ state: "expired" });
    expect(instance.database.grant()).toMatchObject({
      reauthorization_required_at: expect.any(String),
      last_error: "GOOGLE_OAUTH_GRANT_INVALID",
    });
    // The failed renewal wrote no second audit row; the one that exists is the good pick.
    expect(instance.database.auditActions()).toEqual(["calendar.connected"]);
  });

  it("disconnects a ready connection once Google confirms, taking the grant with it", async () => {
    const instance = harness({ calendars: "single" });
    await walkToCallback(instance);
    const response = await instance.disconnect(post({ idempotencyKey: "key-1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      disconnected: true,
      receipt: { outcome: "verified", code: "PROVIDER_REVOKED" },
    });
    expect(instance.database.grant()).toBeNull();
    expect(instance.database.connection()).toMatchObject({
      state: "disconnected",
      last_slot_fetch_at: null,
      last_slot_fetch_ok: null,
      last_error: null,
    });
    expect(instance.database.auditActions()).toEqual(["calendar.connected", "calendar.disconnected"]);
  });

  it("changes nothing when Google answers the revoke with something unrecognised", async () => {
    const instance = harness({ calendars: "single", revoke: { status: 400, error: "invalid_request" } });
    await walkToCallback(instance);
    const response = await instance.disconnect(post({ idempotencyKey: "key-1" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "PROVIDER_REVOKE_UNCONFIRMED" });
    expect(instance.database.grant()).not.toBeNull();
    expect(instance.database.connection()).toMatchObject({ state: "ready" });
    expect(instance.database.auditActions()).toEqual(["calendar.connected"]);
  });
});
