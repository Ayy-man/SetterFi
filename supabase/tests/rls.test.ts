// Tenant-isolation regression suite (BUILD-PLAN B2 acceptance: "cross-tenant read
// attempt test FAILS in CI"). Runs against a real Postgres with the migrations
// applied — locally the `supabase start` stack, in CI a `supabase db start`
// container — because RLS failures are silent: a loosened policy doesn't error,
// it returns rows it shouldn't. Every test seeds inside a transaction and rolls
// back, so the database is left untouched even on crash.
//
// Deliberately NOT part of `npm run test`: if the database is unreachable this
// suite must fail loudly, not skip, and the unit run stays dependency-free.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const SESSION_USER = "33333333-3333-3333-3333-333333333333";
const PLATFORM_ADMIN = "44444444-4444-4444-8444-444444444444";
const IMPERSONATION_SESSION = "55555555-5555-4555-8555-555555555555";

let db: Client;

type Claims = {
  role?: string;
  tenant_id?: string;
  impersonation_session_id?: string;
};

// Mirrors how PostgREST presents a Supabase JWT: role + tenant live in
// app_metadata (see app.claim() in the init migration).
async function actAs(pgRole: "authenticated" | "anon" | "service_role", claims?: Claims) {
  await db.query(`set local role ${pgRole}`);
  const jwt = claims ? { sub: SESSION_USER, app_metadata: claims } : {};
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(jwt)]);
}

async function count(sql: string): Promise<number> {
  const res = await db.query(sql);
  return Number(res.rows[0].count);
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `RLS suite could not reach Postgres at ${DB_URL}. ` +
        `Start the local stack with \`supabase start\` (or \`supabase db start\` in CI). ` +
        `This suite fails rather than skips: a green run must mean isolation was actually checked.`,
      { cause },
    );
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  // Seed as superuser (bypasses RLS), then each test drops privileges via actAs().
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email) values
      ('${TENANT_A}', 'rls-test-tenant-a', 'RLS Test Tenant A', 'billing-a@rls.test'),
      ('${TENANT_B}', 'rls-test-tenant-b', 'RLS Test Tenant B', 'billing-b@rls.test');
    insert into public.users (id,email,role,tenant_id) values
      ('${PLATFORM_ADMIN}','admin@rls.test','admin',null),
      ('${SESSION_USER}','session-admin@rls.test','admin',null);
    insert into public.impersonation_sessions
      (id,actor_id,tenant_id,reason,started_at,expires_at)
      values ('${IMPERSONATION_SESSION}','${SESSION_USER}','${TENANT_A}',
        'Synthetic RLS policy test',now(),now()+interval '30 minutes');
    insert into public.tenant_settings (tenant_id) values ('${TENANT_A}'), ('${TENANT_B}');
    insert into public.contacts (tenant_id, last_channel, name) values
      ('${TENANT_A}', 'sms', 'Lead of A'),
      ('${TENANT_B}', 'sms', 'Lead of B');
    insert into public.conversations (tenant_id, contact_id, channel)
      select tenant_id, id, last_channel from public.contacts;
    insert into public.audit_log (actor_id, tenant_id, action, target_type)
      values (null, '${TENANT_B}', 'channel.went_live', 'tenant');
    insert into public.tenant_test_recipients
      (tenant_id,channel,identifier_hash,identifier_last4,verified_at,verified_by) values
      ('${TENANT_A}','sms',repeat('a',64),'0001',now(),'${PLATFORM_ADMIN}'),
      ('${TENANT_B}','sms',repeat('b',64),'0002',now(),'${PLATFORM_ADMIN}');
    insert into public.suppression_tombstones
      (tenant_id,channel,identifier_hash,identifier_last4) values
      ('${TENANT_A}','sms',repeat('c',64),'0003'),
      ('${TENANT_B}','sms',repeat('d',64),'0004');
  `);
});

afterEach(async () => {
  // rollback also recovers aborted transactions (expected-rejection tests).
  await db.query("rollback");
});

describe("structural invariants", () => {
  it("every public table has row security FORCED", async () => {
    const res = await db.query(`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity
      order by 1
    `);
    expect(res.rows.map((r) => r.relname)).toEqual([]);
  });

  it("every public table exposed to client roles has at least one policy", async () => {
    const res = await db.query(`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and not exists (
          select 1 from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname
        )
        and exists (
          select 1 from information_schema.role_table_grants table_grant
          where table_grant.table_schema = 'public' and table_grant.table_name = c.relname
            and table_grant.grantee in ('PUBLIC', 'anon', 'authenticated')
        )
      order by 1
    `);
    expect(res.rows.map((r) => r.relname)).toEqual([]);
  });
});

describe("coach sessions are tenant-scoped", () => {
  it("reads only their own tenant's contacts", async () => {
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A });
    expect(await count(`select count(*) from public.contacts`)).toBe(1);
    expect(
      await count(`select count(*) from public.contacts where tenant_id = '${TENANT_B}'`),
    ).toBe(0);
  });

  it("reads only their own tenant's conversations", async () => {
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A });
    expect(await count(`select count(*) from public.conversations`)).toBe(1);
  });

  it("resolves a coach member only through their active membership and claimed tenant", async () => {
    await db.query(`
      update public.users set role = 'coach_member' where id = '${SESSION_USER}';
      insert into public.tenant_memberships (tenant_id, user_id, role, invited_by)
      values ('${TENANT_A}', '${SESSION_USER}', 'coach_member', '${SESSION_USER}');
    `);

    await actAs("authenticated", { role: "coach_member", tenant_id: TENANT_A });
    expect((await db.query(`select app.current_tenant_id()::text as tenant_id`)).rows[0].tenant_id)
      .toBe(TENANT_A);
    expect(await count(`select count(*) from public.contacts`)).toBe(1);

    await actAs("authenticated", { role: "coach_member", tenant_id: TENANT_B });
    expect((await db.query(`select app.current_tenant_id()::text as tenant_id`)).rows[0].tenant_id)
      .toBeNull();
    expect(await count(`select count(*) from public.contacts`)).toBe(0);
  });

  it("cannot insert a contact into another tenant", async () => {
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A });
    await expect(
      db.query(
        `insert into public.contacts (tenant_id, last_channel, name) values ('${TENANT_B}', 'sms', 'smuggled')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cross-tenant update silently affects zero rows", async () => {
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A });
    const res = await db.query(
      `update public.contacts set name = 'defaced' where tenant_id = '${TENANT_B}' returning id`,
    );
    expect(res.rowCount).toBe(0);
  });

  it("cannot read the audit log", async () => {
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A });
    expect(await count(`select count(*) from public.audit_log`)).toBe(0);
  });
});

describe("sessions without a tenant see nothing", () => {
  it("authenticated with no claims resolves to NULL tenant and zero rows", async () => {
    await actAs("authenticated");
    expect(await count(`select count(*) from public.contacts`)).toBe(0);
  });

  it("affiliate role has no tenant access", async () => {
    await actAs("authenticated", { role: "affiliate" });
    expect(await count(`select count(*) from public.contacts`)).toBe(0);
    expect(await count(`select count(*) from public.conversations`)).toBe(0);
  });

  it("anon is denied at the grant layer, before RLS even runs", async () => {
    await actAs("anon");
    await expect(db.query(`select count(*) from public.contacts`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("platform roles", () => {
  it("admin reads both seeded tenants (the admin console's all-clients view)", async () => {
    await actAs("authenticated", { role: "admin" });
    expect(await count(
      `select count(*) from public.contacts where tenant_id in ('${TENANT_A}', '${TENANT_B}')`,
    )).toBe(2);
    expect(await count(
      `select count(*) from public.tenants where id in ('${TENANT_A}', '${TENANT_B}')`,
    )).toBe(2);
  });

  it("admin reads the audit log", async () => {
    await actAs("authenticated", { role: "admin" });
    expect(
      await count(
        `select count(*) from public.audit_log where action = 'channel.went_live'`,
      ),
    ).toBe(1);
  });

  it("build role cannot read or write lead data", async () => {
    await actAs("authenticated", { role: "build" });
    expect(await count(`select count(*) from public.contacts`)).toBe(0);
    await expect(
      db.query(
        `insert into public.contacts (tenant_id, last_channel, name) values ('${TENANT_A}', 'sms', 'build-write')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("authenticated sessions cannot write the audit log directly (route layer only)", async () => {
    await actAs("authenticated", { role: "admin" });
    await expect(
      db.query(`insert into public.audit_log (action) values ('forged')`),
    ).rejects.toThrow();
  });

  it("service_role bypasses RLS to record privileged actions", async () => {
    await actAs("service_role");
    const res = await db.query(
      `insert into public.audit_log (tenant_id, action, target_type)
       values ('${TENANT_A}', 'channel.went_live', 'tenant') returning id`,
    );
    expect(res.rowCount).toBe(1);
  });
});

describe("Phase 3 compliance policies", () => {
  it("lets a coach read only their tenant's test recipients but never register one", async () => {
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A });
    expect(await count(`select count(*) from public.tenant_test_recipients`)).toBe(1);
    await expect(
      db.query(`insert into public.tenant_test_recipients
        (tenant_id,channel,identifier_hash,verified_at,verified_by)
        values ('${TENANT_A}','sms',repeat('e',64),now(),'${PLATFORM_ADMIN}')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("lets a platform operator register a recipient but keeps tombstones platform-only", async () => {
    await actAs("authenticated", { role: "admin" });
    const inserted = await db.query(`insert into public.tenant_test_recipients
      (tenant_id,channel,identifier_hash,verified_at,verified_by)
      values ('${TENANT_A}','sms',repeat('f',64),now(),'${PLATFORM_ADMIN}') returning id`);
    expect(inserted.rowCount).toBe(1);
    expect(await count(`select count(*) from public.suppression_tombstones
      where tenant_id in ('${TENANT_A}','${TENANT_B}')`)).toBe(2);

    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A });
    expect(await count(`select count(*) from public.suppression_tombstones`)).toBe(0);
  });

  it("permits coach narrowing inside the platform floor and rejects widening", async () => {
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A });
    const narrowed = await db.query(`update public.tenant_settings
      set quiet_hours_start='09:00',quiet_hours_end='18:00'
      where tenant_id='${TENANT_A}' returning quiet_hours_start::text,quiet_hours_end::text`);
    expect(narrowed.rows[0]).toEqual({
      quiet_hours_start: "09:00:00",
      quiet_hours_end: "18:00:00",
    });
    await expect(
      db.query(`update public.tenant_settings set quiet_hours_end='21:00'
        where tenant_id='${TENANT_A}'`),
    ).rejects.toThrow(/tenant_settings_quiet_hours_floor_chk/);
  });

  it("refuses settings and test-recipient writes from an impersonating session", async () => {
    await actAs("authenticated", {
      role: "admin",
      tenant_id: TENANT_B,
      impersonation_session_id: IMPERSONATION_SESSION,
    });
    const update = await db.query(`update public.tenant_settings set quiet_hours_start='09:00'
      where tenant_id='${TENANT_A}' returning tenant_id`);
    expect(update.rowCount).toBe(0);
    await expect(
      db.query(`insert into public.tenant_test_recipients
        (tenant_id,channel,identifier_hash,verified_at,verified_by)
        values ('${TENANT_A}','sms',repeat('9',64),now(),'${PLATFORM_ADMIN}')`),
    ).rejects.toThrow(/row-level security/);
  });
});
