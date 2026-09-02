// Google Calendar grant custody and the two audited calendar writers.
//
// Three of the claims this task rests on are database properties and cannot be proved anywhere
// else: that a browser role reaches neither the grant nor the state row, that the availability
// writer moves the connection state and the three health columns in one statement so the shape
// constraint can never see a half-written row, and that a replayed command returns the first
// receipt instead of writing a second audit entry. All three are expressed as predicates on the
// write, so all three are tested by writing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const CUSTODY_TABLES = [
  "calendar_connection_command_receipts",
  "google_calendar_grants",
  "google_oauth_states",
] as const;
const GRANT_TABLES = ["google_calendar_grants", "google_oauth_states"] as const;

const TENANT_A = "9c000000-0000-4000-8000-000000000001";
const TENANT_B = "9c000000-0000-4000-8000-000000000002";
const TENANT_C = "9c000000-0000-4000-8000-000000000003";
const COACH_A = "9c000000-0000-4000-8000-000000000011";
const COACH_B = "9c000000-0000-4000-8000-000000000012";
const ENVELOPE = `'{"version":1,"keyVersion":1,"algorithm":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AQ","tag":"AAAAAAAAAAAAAAAAAAAAAA"}'::jsonb`;
const SCOPES = `array['https://www.googleapis.com/auth/calendar.freebusy']::text[]`;

let db: Client;

async function actAs(role: "anon" | "authenticated" | "service_role" | "postgres", claims: Record<string, string> = {}) {
  await db.query("reset role");
  await db.query(`set local role ${role}`);
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: claims.sub, app_metadata: claims }),
  ]);
}

async function insertGrant(tenantId: string) {
  await db.query(`
    insert into public.google_calendar_grants
      (tenant_id, google_account_email, access_credential_envelope, refresh_credential_envelope,
       granted_scopes, token_expires_at)
    values ('${tenantId}', 'coach@calendar.test', ${ENVELOPE}, ${ENVELOPE}, ${SCOPES},
            now() + interval '1 hour')
  `);
}

async function insertState(tenantId: string, actorId: string, hash: string) {
  await db.query(`
    insert into public.google_oauth_states (state_hash, tenant_id, actor_id, return_path, expires_at)
    values ('${hash}', '${tenantId}', '${actorId}', '/onboarding/calendar', now() + interval '5 minutes')
  `);
}

/** The only writer of calendar_connections, so the fixture uses it rather than a hand-built row. */
async function authorizeCalendar(tenantId: string, actorId: string, externalId: string) {
  const result = await db.query<{ calendar_connection_id: string }>(
    `select * from public.record_onboarding_calendar_authorization(
       $1, $2, 'google'::public.calendar_provider, $3, $4, $5, $6, $7)`,
    [tenantId, actorId, "coach@calendar.test", externalId, "Coaching calendar", "America/Chicago", "a".repeat(64)],
  );
  return result.rows[0].calendar_connection_id;
}

function auditCount(connectionId: string, action: string) {
  return db
    .query<{ total: string }>(
      "select count(*)::text as total from public.audit_log where action = $1 and target_id = $2",
      [action, connectionId],
    )
    .then((result) => Number(result.rows[0].total));
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Google Calendar custody suite could not reach Postgres at ${DB_URL}. ` +
        "Start the local stack with `supabase start`; this suite fails rather than skips.",
      { cause },
    );
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query("set local role postgres");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email, is_demo) values
      ('${TENANT_A}', 'google-calendar-a', 'Google Calendar A', 'a@calendar.test', false),
      ('${TENANT_B}', 'google-calendar-b', 'Google Calendar B', 'b@calendar.test', false);
    insert into public.users (id, tenant_id, email, role) values
      ('${COACH_A}', '${TENANT_A}', 'coach-a@calendar.test', 'coach'),
      ('${COACH_B}', '${TENANT_B}', 'coach-b@calendar.test', 'coach');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("grant custody is service-role only", () => {
  it("forces row security and grants nothing to anon, authenticated or PUBLIC", async () => {
    const security = await db.query<{ relname: string; forced: boolean; policies: string }>(
      `select c.relname, c.relforcerowsecurity as forced, count(p.policyname)::text as policies
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
       where n.nspname = 'public' and c.relname = any($1::text[])
       group by c.relname, c.relforcerowsecurity
       order by c.relname`,
      [CUSTODY_TABLES],
    );
    expect(security.rows.map((row) => row.relname)).toEqual([...CUSTODY_TABLES]);
    expect(security.rows.every((row) => row.forced && Number(row.policies) === 1)).toBe(true);

    const grants = await db.query<{ grantee: string; table_name: string }>(
      `select grantee, table_name from information_schema.role_table_grants
       where table_schema = 'public' and table_name = any($1::text[])
         and grantee in ('anon', 'authenticated', 'PUBLIC')`,
      [CUSTODY_TABLES],
    );
    expect(grants.rows).toEqual([]);
  });

  it.each([
    ["anon", "google_calendar_grants"],
    ["anon", "google_oauth_states"],
    ["authenticated", "google_calendar_grants"],
    ["authenticated", "google_oauth_states"],
  ] as const)("refuses %s a select or an insert on %s", async (role, table) => {
    await insertGrant(TENANT_A);
    await insertState(TENANT_A, COACH_A, "b".repeat(64));
    await actAs(role, { sub: COACH_A, tenant_id: TENANT_A, role: "coach" });
    await db.query("savepoint browser_read");
    await expect(db.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint browser_read");
    await db.query("savepoint browser_write");
    await expect(db.query(`insert into public.${table} default values`)).rejects.toThrow(
      /permission denied/,
    );
    await db.query("rollback to savepoint browser_write");
  });

  it("lets service_role insert, select, update and delete both custody rows", async () => {
    await actAs("service_role", { sub: COACH_A, tenant_id: TENANT_A, role: "coach" });
    await insertGrant(TENANT_A);
    await insertState(TENANT_A, COACH_A, "c".repeat(64));
    for (const table of GRANT_TABLES) {
      const selected = await db.query(`select id from public.${table}`);
      expect(selected.rowCount).toBe(1);
      const updated = await db.query(`update public.${table} set created_at = now() returning id`);
      expect(updated.rowCount).toBe(1);
      const deleted = await db.query(`delete from public.${table} returning id`);
      expect(deleted.rowCount).toBe(1);
    }
  });

  it("keeps the two calendar command writers off every browser role", async () => {
    const grants = await db.query<{ proname: string; anon: boolean; authenticated: boolean; service: boolean }>(
      `select proname,
         has_function_privilege('anon', p.oid, 'execute') as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
         has_function_privilege('service_role', p.oid, 'execute') as service
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and proname in ('record_calendar_connection_availability', 'record_calendar_connection_disconnected')
       order by proname`,
    );
    expect(grants.rows).toEqual([
      { proname: "record_calendar_connection_availability", anon: false, authenticated: false, service: true },
      { proname: "record_calendar_connection_disconnected", anon: false, authenticated: false, service: true },
    ]);

    await actAs("authenticated", { sub: COACH_A, tenant_id: TENANT_A, role: "coach" });
    await db.query("savepoint receipt_read");
    await expect(
      db.query("select * from public.calendar_connection_command_receipts"),
    ).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint receipt_read");
  });
});

describe("the shape of a stored grant and a stored state is a constraint", () => {
  it("holds one live Google grant per tenant", async () => {
    await insertGrant(TENANT_A);
    await db.query("savepoint second_grant");
    await expect(insertGrant(TENANT_A)).rejects.toThrow(/google_calendar_grants_tenant_id_key/);
    await db.query("rollback to savepoint second_grant");
  });

  it.each([
    ["a state hash that is not a sha-256 digest", `'${"b".repeat(63)}'`, "'/onboarding/calendar'",
      "now() + interval '5 minutes'", "null", /state_hash/],
    ["an upper-case state hash", `'${"B".repeat(64)}'`, "'/onboarding/calendar'",
      "now() + interval '5 minutes'", "null", /state_hash/],
    ["a protocol-relative return path", `'${"c".repeat(64)}'`, "'//evil.test/steal'",
      "now() + interval '5 minutes'", "null", /return_path/],
    ["an expiry beyond the ten-minute ceiling", `'${"d".repeat(64)}'`, "'/onboarding/calendar'",
      "now() + interval '2 hours'", "null", /google_oauth_states_expiry_chk/],
    ["a consumption stamped before the row existed", `'${"e".repeat(64)}'`, "'/onboarding/calendar'",
      "now() + interval '5 minutes'", "now() - interval '1 hour'", /google_oauth_states_consumed_chk/],
  ])("refuses %s", async (_label, hash, returnPath, expiresAt, consumedAt, message) => {
    await db.query("savepoint constraint_probe");
    await expect(
      db.query(`
        insert into public.google_oauth_states
          (state_hash, tenant_id, actor_id, return_path, expires_at, consumed_at)
        values (${hash}, '${TENANT_A}', '${COACH_A}', ${returnPath}, ${expiresAt}, ${consumedAt})
      `),
    ).rejects.toThrow(message);
    await db.query("rollback to savepoint constraint_probe");
  });

  // users.tenant_id restricts on delete, so this uses a tenant carrying nothing but the two
  // custody rows. What is under test is the cascade on those two tables, not the order in which
  // an account teardown would have to drop everything else a real tenant owns.
  it("takes both custody rows with the tenant they belong to", async () => {
    await db.query(`
      insert into public.tenants (id, slug, name, billing_contact_email, is_demo)
      values ('${TENANT_C}', 'google-calendar-c', 'Google Calendar C', 'c@calendar.test', false)
    `);
    await insertGrant(TENANT_C);
    await insertState(TENANT_C, COACH_A, "f".repeat(64));
    await db.query(`delete from public.tenants where id = '${TENANT_C}'`);
    const remaining = await db.query<{ grants: string; states: string }>(`
      select
        (select count(*) from public.google_calendar_grants where tenant_id = '${TENANT_C}')::text as grants,
        (select count(*) from public.google_oauth_states where tenant_id = '${TENANT_C}')::text as states
    `);
    expect(remaining.rows[0]).toEqual({ grants: "0", states: "0" });
  });
});

describe("the availability writer is the only thing that can say ready", () => {
  beforeEach(async () => {
    await actAs("service_role", { sub: COACH_A, tenant_id: TENANT_A, role: "coach" });
  });

  it("moves the connection to ready and writes the three health columns together", async () => {
    const connectionId = await authorizeCalendar(TENANT_A, COACH_A, "calendar-ready");
    const result = await db.query<{ receipt_id: string; audit_id: string; replayed: boolean; outcome: string }>(
      "select * from public.record_calendar_connection_availability($1, $2, $3, $4, $5, $6, $7)",
      [TENANT_A, connectionId, COACH_A, "verify-key-1", "verified", "AVAILABILITY_VERIFIED", { windowDays: 7 }],
    );
    expect(result.rows[0].replayed).toBe(false);
    expect(result.rows[0].outcome).toBe("verified");
    expect(result.rows[0].receipt_id).toEqual(expect.any(String));
    expect(Number(result.rows[0].audit_id)).toBeGreaterThan(0);

    const stored = await db.query<{
      state: string; ok: boolean; last_error: string | null; fetched: boolean;
    }>(
      `select state, last_slot_fetch_ok as ok, last_error, last_slot_fetch_at is not null as fetched
       from public.calendar_connections where id = $1`,
      [connectionId],
    );
    expect(stored.rows[0]).toEqual({ state: "ready", ok: true, last_error: null, fetched: true });
    expect(await auditCount(connectionId, "calendar.connected")).toBe(1);
  });

  it("leaves a failed availability read connecting, unaudited and unreceipted", async () => {
    const connectionId = await authorizeCalendar(TENANT_A, COACH_A, "calendar-unverified");
    const result = await db.query<{ receipt_id: string | null; audit_id: string | null; outcome: string }>(
      "select * from public.record_calendar_connection_availability($1, $2, $3, $4, $5, $6, $7)",
      [TENANT_A, connectionId, COACH_A, "verify-key-2", "not_verified", "AVAILABILITY_NOT_VERIFIED", {}],
    );
    expect(result.rows[0]).toMatchObject({ receipt_id: null, audit_id: null, outcome: "not_verified" });

    const stored = await db.query<{ state: string; ok: boolean; last_error: string | null; fetched: boolean }>(
      `select state, last_slot_fetch_ok as ok, last_error, last_slot_fetch_at is not null as fetched
       from public.calendar_connections where id = $1`,
      [connectionId],
    );
    expect(stored.rows[0]).toEqual({
      state: "connecting", ok: false, last_error: "AVAILABILITY_NOT_VERIFIED", fetched: true,
    });
    expect(await auditCount(connectionId, "calendar.connected")).toBe(0);
    const receipts = await db.query(
      "select id from public.calendar_connection_command_receipts where calendar_connection_id = $1",
      [connectionId],
    );
    expect(receipts.rowCount).toBe(0);
  });

  it("logs one connection even when the coach's first availability read failed", async () => {
    const connectionId = await authorizeCalendar(TENANT_A, COACH_A, "calendar-retry");
    await db.query(
      "select * from public.record_calendar_connection_availability($1, $2, $3, $4, $5, $6, $7)",
      [TENANT_A, connectionId, COACH_A, "verify-key-3", "not_verified", "AVAILABILITY_NOT_VERIFIED", {}],
    );
    await db.query(
      "select * from public.record_calendar_connection_availability($1, $2, $3, $4, $5, $6, $7)",
      [TENANT_A, connectionId, COACH_A, "verify-key-4", "verified", "AVAILABILITY_VERIFIED", {}],
    );
    expect(await auditCount(connectionId, "calendar.connected")).toBe(1);
  });

  it("returns the first receipt for a replayed verification and writes no second audit row", async () => {
    const connectionId = await authorizeCalendar(TENANT_A, COACH_A, "calendar-replay");
    const first = await db.query<{ receipt_id: string; audit_id: string }>(
      "select * from public.record_calendar_connection_availability($1, $2, $3, $4, $5, $6, $7)",
      [TENANT_A, connectionId, COACH_A, "verify-key-5", "verified", "AVAILABILITY_VERIFIED", {}],
    );
    const replay = await db.query<{ receipt_id: string; audit_id: string; replayed: boolean }>(
      "select * from public.record_calendar_connection_availability($1, $2, $3, $4, $5, $6, $7)",
      [TENANT_A, connectionId, COACH_A, "verify-key-5", "verified", "AVAILABILITY_VERIFIED", {}],
    );
    expect(replay.rows[0].replayed).toBe(true);
    expect(replay.rows[0].receipt_id).toBe(first.rows[0].receipt_id);
    expect(replay.rows[0].audit_id).toBe(first.rows[0].audit_id);
    expect(await auditCount(connectionId, "calendar.connected")).toBe(1);
  });

  it("refuses a connection that belongs to another tenant rather than writing to it", async () => {
    const foreign = await authorizeCalendar(TENANT_B, COACH_B, "calendar-foreign");
    await db.query("savepoint cross_tenant_verify");
    await expect(
      db.query("select * from public.record_calendar_connection_availability($1, $2, $3, $4, $5, $6, $7)", [
        TENANT_A, foreign, COACH_A, "verify-key-6", "verified", "AVAILABILITY_VERIFIED", {},
      ]),
    ).rejects.toThrow(/EXPECTED_TENANT_MISMATCH/);
    await db.query("rollback to savepoint cross_tenant_verify");
    const stored = await db.query<{ state: string }>(
      "select state from public.calendar_connections where id = $1",
      [foreign],
    );
    expect(stored.rows[0].state).toBe("connecting");
  });
});

describe("the disconnect writer clears the health claim and the grant together", () => {
  beforeEach(async () => {
    await actAs("service_role", { sub: COACH_A, tenant_id: TENANT_A, role: "coach" });
  });

  it("sets disconnected, nulls all three health columns, and drops the stored grant", async () => {
    const connectionId = await authorizeCalendar(TENANT_A, COACH_A, "calendar-disconnect");
    await db.query(
      "select * from public.record_calendar_connection_availability($1, $2, $3, $4, $5, $6, $7)",
      [TENANT_A, connectionId, COACH_A, "verify-key-7", "verified", "AVAILABILITY_VERIFIED", {}],
    );
    await insertGrant(TENANT_A);
    const result = await db.query<{ receipt_id: string; audit_id: string; replayed: boolean; outcome: string }>(
      "select * from public.record_calendar_connection_disconnected($1, $2, $3, $4, $5)",
      [TENANT_A, connectionId, COACH_A, "disconnect-key-1", { revokeStatus: 200 }],
    );
    expect(result.rows[0].replayed).toBe(false);
    expect(result.rows[0].outcome).toBe("verified");
    expect(Number(result.rows[0].audit_id)).toBeGreaterThan(0);

    const stored = await db.query<{ state: string; at: string | null; ok: boolean | null; last_error: string | null }>(
      `select state, last_slot_fetch_at as at, last_slot_fetch_ok as ok, last_error
       from public.calendar_connections where id = $1`,
      [connectionId],
    );
    expect(stored.rows[0]).toEqual({ state: "disconnected", at: null, ok: null, last_error: null });
    expect(await auditCount(connectionId, "calendar.disconnected")).toBe(1);
    const grants = await db.query("select id from public.google_calendar_grants where tenant_id = $1", [TENANT_A]);
    expect(grants.rowCount).toBe(0);
  });

  it("returns the first receipt for a replayed disconnect and writes no second audit row", async () => {
    const connectionId = await authorizeCalendar(TENANT_A, COACH_A, "calendar-disconnect-replay");
    const first = await db.query<{ receipt_id: string; audit_id: string }>(
      "select * from public.record_calendar_connection_disconnected($1, $2, $3, $4, $5)",
      [TENANT_A, connectionId, COACH_A, "disconnect-key-2", {}],
    );
    const replay = await db.query<{ receipt_id: string; audit_id: string; replayed: boolean }>(
      "select * from public.record_calendar_connection_disconnected($1, $2, $3, $4, $5)",
      [TENANT_A, connectionId, COACH_A, "disconnect-key-2", {}],
    );
    expect(replay.rows[0].replayed).toBe(true);
    expect(replay.rows[0].receipt_id).toBe(first.rows[0].receipt_id);
    expect(await auditCount(connectionId, "calendar.disconnected")).toBe(1);
  });

  it("refuses a connection that belongs to another tenant rather than disconnecting it", async () => {
    const foreign = await authorizeCalendar(TENANT_B, COACH_B, "calendar-foreign-disconnect");
    await db.query("savepoint cross_tenant_disconnect");
    await expect(
      db.query("select * from public.record_calendar_connection_disconnected($1, $2, $3, $4, $5)", [
        TENANT_A, foreign, COACH_A, "disconnect-key-3", {},
      ]),
    ).rejects.toThrow(/EXPECTED_TENANT_MISMATCH/);
    await db.query("rollback to savepoint cross_tenant_disconnect");
    const stored = await db.query<{ state: string }>(
      "select state from public.calendar_connections where id = $1",
      [foreign],
    );
    expect(stored.rows[0].state).toBe("connecting");
  });
});

describe("the migration records why this custody is separate", () => {
  it("states the no-lease reason and adds no audit key", () => {
    const migration = readFileSync(
      resolve("supabase/migrations/20261008000001_google_calendar_oauth.sql"),
      "utf8",
    );
    expect(migration).toContain("force row level security");
    expect(migration).toContain("https://developers.google.com/identity/protocols/oauth2/web-server");
    expect(migration).toContain("2026-09-02");
    expect(migration).not.toMatch(/refresh_lock_expires_at/);
    expect(migration).not.toMatch(/insert into public\.audit_actions/);
  });
});
