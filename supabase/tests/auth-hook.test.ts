// Custom access token hook suite (BUILD-PLAN B3): the hook is the bridge between
// Supabase Auth and the RLS layer — it stamps role + tenant_id from public.users
// into JWT app_metadata, which is exactly where every policy helper reads them.
// Same harness as rls.test.ts: live migrated Postgres, transactional, rolls back.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT = "11111111-1111-1111-1111-111111111111";
const COACH = "33333333-3333-3333-3333-333333333333";
const ADMIN = "44444444-4444-4444-4444-444444444444";
const STRANGER = "55555555-5555-5555-5555-555555555555";
const BUILD = "66666666-6666-6666-6666-666666666666";
const DUAL_ROLE_COACH = "77777777-7777-4777-8777-777777777777";
const AFFILIATE = "88888888-8888-4888-8888-888888888888";

let db: Client;

type HookOutput = {
  user_id?: string;
  claims: Record<string, unknown> & { app_metadata: Record<string, unknown> };
};

async function runHook(userId: string, claims: object = {}): Promise<HookOutput> {
  const event = { user_id: userId, claims };
  const res = await db.query(`select public.custom_access_token_hook($1::jsonb) as out`, [
    JSON.stringify(event),
  ]);
  return res.rows[0].out;
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Auth-hook suite could not reach Postgres at ${DB_URL} — start the local stack with \`supabase start\`.`,
      { cause },
    );
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email)
      values ('${TENANT}', 'hook-test-tenant', 'Hook Test Tenant', 'billing@hook.test');
    insert into public.users (id, email, role, tenant_id) values
      ('${COACH}', 'coach@hook.test', 'coach', '${TENANT}'),
      ('${ADMIN}', 'admin@hook.test', 'admin', null),
      ('${BUILD}', 'build@hook.test', 'build', null),
      ('${DUAL_ROLE_COACH}', 'dual-coach@hook.test', 'coach', '${TENANT}'),
      ('${AFFILIATE}', 'affiliate@hook.test', 'affiliate', null);
    insert into public.affiliates (user_id, referral_code) values
      ('${DUAL_ROLE_COACH}', 'HOOK-DUAL'),
      ('${AFFILIATE}', 'HOOK-AFFILIATE');
    insert into public.contacts (tenant_id, last_channel, name)
      values ('${TENANT}', 'sms', 'Hook Test Lead');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("claim stamping", () => {
  it("stamps a coach's role and tenant into app_metadata", async () => {
    const out = await runHook(COACH, { sub: COACH });
    expect(out.claims.app_metadata.role).toBe("coach");
    expect(out.claims.app_metadata.tenant_id).toBe(TENANT);
    expect(out.claims.app_metadata.affiliate_access).toBe(false);
  });

  it("stamps database-derived affiliate access on a dual-role coach without changing role", async () => {
    const out = await runHook(DUAL_ROLE_COACH, {
      app_metadata: { role: "admin", affiliate_access: false },
    });
    expect(out.claims.app_metadata.role).toBe("coach");
    expect(out.claims.app_metadata.tenant_id).toBe(TENANT);
    expect(out.claims.app_metadata.affiliate_access).toBe(true);
  });

  it("refuses caller-supplied affiliate access for a coach without an affiliates row", async () => {
    const out = await runHook(COACH, { app_metadata: { affiliate_access: true } });
    expect(out.claims.app_metadata.role).toBe("coach");
    expect(out.claims.app_metadata.affiliate_access).toBe(false);
  });

  it("keeps a pure affiliate's primary role and stamps its capability", async () => {
    const out = await runHook(AFFILIATE);
    expect(out.claims.app_metadata.role).toBe("affiliate");
    expect(out.claims.app_metadata).not.toHaveProperty("tenant_id");
    expect(out.claims.app_metadata.affiliate_access).toBe(true);
  });

  it("stamps a platform admin's role with no tenant claim", async () => {
    const out = await runHook(ADMIN);
    expect(out.claims.app_metadata.role).toBe("admin");
    expect(out.claims.app_metadata).not.toHaveProperty("tenant_id");
  });

  it("returns the event untouched for an auth user with no app users row", async () => {
    const event = { user_id: STRANGER, claims: { sub: STRANGER } };
    const res = await db.query(`select public.custom_access_token_hook($1::jsonb) as out`, [
      JSON.stringify(event),
    ]);
    expect(res.rows[0].out).toEqual(event);
  });

  it("preserves existing claims and app_metadata keys", async () => {
    const out = await runHook(COACH, {
      sub: COACH,
      email: "coach@hook.test",
      app_metadata: { provider: "email" },
    });
    expect(out.claims.sub).toBe(COACH);
    expect(out.claims.email).toBe("coach@hook.test");
    expect(out.claims.app_metadata.provider).toBe("email");
    expect(out.claims.app_metadata.role).toBe("coach");
  });

  it("stamps the active session tenant and id and removes stale impersonation metadata after it ends", async () => {
    const inserted = await db.query<{ id: string }>(`
      insert into public.impersonation_sessions
        (actor_id, tenant_id, reason, started_at, expires_at)
      values ('${ADMIN}', '${TENANT}', 'Support investigation', now(), now() + interval '30 minutes')
      returning id
    `);
    const sessionId = inserted.rows[0].id;

    const active = await runHook(ADMIN);
    expect(active.claims.app_metadata.impersonating_tenant).toBe(TENANT);
    expect(active.claims.app_metadata.impersonation_session_id).toBe(sessionId);

    await db.query(`update public.impersonation_sessions set ended_at = now() where id = $1`, [
      sessionId,
    ]);
    const ended = await runHook(ADMIN, {
      app_metadata: {
        impersonating_tenant: TENANT,
        impersonation_session_id: sessionId,
      },
    });
    expect(ended.claims.app_metadata).not.toHaveProperty("impersonating_tenant");
    expect(ended.claims.app_metadata).not.toHaveProperty("impersonation_session_id");
  });

  it("omits impersonation claims for expired sessions and the build role", async () => {
    await db.query(`
      insert into public.impersonation_sessions
        (actor_id, tenant_id, reason, started_at, expires_at)
      values (
        '${ADMIN}', '${TENANT}', 'Expired investigation',
        now() - interval '31 minutes', now() - interval '1 minute'
      )
    `);

    const expired = await runHook(ADMIN);
    expect(expired.claims.app_metadata).not.toHaveProperty("impersonating_tenant");
    expect(expired.claims.app_metadata).not.toHaveProperty("impersonation_session_id");

    const build = await runHook(BUILD);
    expect(build.claims.app_metadata.role).toBe("build");
    expect(build.claims.app_metadata).not.toHaveProperty("impersonating_tenant");
    expect(build.claims.app_metadata).not.toHaveProperty("impersonation_session_id");
  });
});

describe("hook output satisfies RLS end to end", () => {
  it("a hook-stamped coach token sees exactly its tenant's rows", async () => {
    const out = await runHook(COACH, { sub: COACH });
    await db.query(`set local role authenticated`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(out.claims),
    ]);
    const res = await db.query(`select count(*) from public.contacts`);
    expect(Number(res.rows[0].count)).toBe(1);
  });

  it("an unstamped token (no users row) sees nothing", async () => {
    const out = await db.query(`select public.custom_access_token_hook($1::jsonb) as out`, [
      JSON.stringify({ user_id: STRANGER, claims: { sub: STRANGER } }),
    ]);
    await db.query(`set local role authenticated`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(out.rows[0].out.claims),
    ]);
    const res = await db.query(`select count(*) from public.contacts`);
    expect(Number(res.rows[0].count)).toBe(0);
  });

  it("an ended session id in a stale JWT grants no tenant scope", async () => {
    const inserted = await db.query<{ id: string }>(`
      insert into public.impersonation_sessions
        (actor_id, tenant_id, reason, started_at, ended_at, expires_at)
      values (
        '${ADMIN}', '${TENANT}', 'Ended investigation',
        now() - interval '10 minutes', now(), now() + interval '20 minutes'
      ) returning id
    `);
    await db.query("set local role authenticated");
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
      sub: ADMIN,
      app_metadata: { role: "coach", impersonation_session_id: inserted.rows[0].id },
    })]);
    const scope = await db.query<{ tenant_id: string | null; contacts: string }>(`
      select app.current_tenant_id()::text as tenant_id,
             (select count(*)::text from public.contacts) as contacts
    `);
    expect(scope.rows[0]).toEqual({ tenant_id: null, contacts: "0" });
  });
});

describe("service-role actor impersonation guard", () => {
  it("refuses an explicit human actor while its session is active and permits it after end", async () => {
    const inserted = await db.query<{ id: string }>(`
      insert into public.impersonation_sessions
        (actor_id, tenant_id, reason, started_at, expires_at)
      values ('${ADMIN}', '${TENANT}', 'Service write guard', now(), now() + interval '30 minutes')
      returning id
    `);

    await db.query("savepoint direct_guard");
    await expect(db.query(`select app.assert_actor_not_impersonating($1::uuid)`, [ADMIN]))
      .rejects.toThrow(/IMPERSONATION_WRITE_FORBIDDEN/);
    await db.query("rollback to savepoint direct_guard");

    await db.query("savepoint shared_guard");
    await expect(db.query(`select app.phase2_assert_platform_actor($1::uuid)`, [ADMIN]))
      .rejects.toThrow(/IMPERSONATION_WRITE_FORBIDDEN/);
    await db.query("rollback to savepoint shared_guard");

    await db.query(`update public.impersonation_sessions set ended_at = now() where id = $1`, [
      inserted.rows[0].id,
    ]);
    await expect(db.query(`select app.assert_actor_not_impersonating($1::uuid)`, [ADMIN]))
      .resolves.toBeDefined();
    await expect(db.query(`select app.phase2_assert_platform_actor($1::uuid)`, [ADMIN]))
      .resolves.toBeDefined();
  });
});

describe("hook lockdown", () => {
  it("authenticated sessions cannot execute the hook", async () => {
    await db.query(`set local role authenticated`);
    await expect(
      db.query(`select public.custom_access_token_hook('{}'::jsonb)`),
    ).rejects.toThrow(/permission denied/);
  });
});

// Everything above this line drives the hook as `postgres`, which owns these tables
// and carries `rolbypassrls`, so neither the table grants nor the row policies that
// gate the real caller are evaluated against it — and FORCE RLS, which does bind a
// table's owner, does not bind a role that bypasses RLS outright. That is how 213
// green RLS assertions and the eleven hook tests in this file all stayed green
// while sign-in was down on the hosted project: they proved
// the hook's logic, while the only principal that actually invokes it in
// production — `supabase_auth_admin` — held no select privilege on two of the three
// tables the hook reads, so every password grant came back as
// `Error running hook URI` instead of a token.
//
// The table set below is derived from `pg_get_functiondef` of the DEPLOYED
// function, not from parsing the migration files, because three migrations
// (`20260813000003`, `20260817000001:2426`, `20260824000001:711`) each
// `create or replace` this hook, so the migration text is ambiguous about which
// body actually runs while `pg_get_functiondef` returns the one Postgres will
// execute. A file parse would test the repo; this tests the database. The
// `pg_class` join is also what drops the function's own name out of the header
// line, so there is no hand-maintained exclusion list to go stale.
const HOOK_TABLE_PRIVILEGES = `
  with def as (
    select pg_get_functiondef('public.custom_access_token_hook(jsonb)'::regprocedure) as body
  ),
  referenced as (
    select distinct m[1] as name
    from def, regexp_matches(def.body, 'public\\.([a-zA-Z_][a-zA-Z0-9_$]*)', 'g') as m
  )
  select r.name,
         has_table_privilege('supabase_auth_admin', format('public.%I', r.name), 'select') as has_select,
         exists (
           select 1 from pg_policies p
           where p.schemaname = 'public' and p.tablename = r.name
             and p.cmd = 'SELECT' and p.permissive = 'PERMISSIVE'
             and 'supabase_auth_admin' = any(p.roles)
         ) as has_policy
  from referenced r
  join pg_class c on c.relname = r.name and c.relkind in ('r', 'p', 'v', 'm')
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  order by r.name
`;

type HookTablePrivilege = { name: string; has_select: boolean; has_policy: boolean };

async function hookTablePrivileges(): Promise<HookTablePrivilege[]> {
  const res = await db.query<HookTablePrivilege>(HOOK_TABLE_PRIVILEGES);
  return res.rows;
}

describe("hook principal privileges", () => {
  // The plan's arm assumed the principal with `set local role supabase_auth_admin`.
  // On the local stack `postgres` is not a member of that role — the stack answers
  // `permission denied to set role "supabase_auth_admin"` — so this connects as the
  // role instead, which the local stack does allow with the same password. Same
  // principal, real privilege evaluation, and it covers every derived table rather
  // than only the ones the hook reaches before its early return.
  let authAdmin: Client | null = null;
  let authAdminConnectError: unknown = null;

  beforeAll(async () => {
    const url = new URL(DB_URL);
    url.username = "supabase_auth_admin";
    const client = new Client({ connectionString: url.toString() });
    try {
      await client.connect();
      authAdmin = client;
    } catch (cause) {
      authAdminConnectError = cause;
    }
  });

  afterAll(async () => {
    await authAdmin?.end();
  });

  it("derives a non-empty table set from the deployed hook body", async () => {
    // Guard against a vacuous green: a regex that silently matched nothing would
    // pass every assertion below without checking a single privilege.
    const rows = await hookTablePrivileges();
    const names = rows.map((row) => row.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("users");
  });

  it("grants select on every table the deployed hook reads to supabase_auth_admin", async () => {
    const rows = await hookTablePrivileges();
    const missing = rows.filter((row) => !row.has_select).map((row) => row.name);
    expect(missing).toEqual([]);
  });

  it("carries a permissive auth-admin select policy on every table the deployed hook reads", async () => {
    // A grant on its own reads nothing here: the init sweep at
    // `20260813000001_init.sql:834` puts FORCE RLS on every public table, so the
    // grant and the policy are both load-bearing and both have to be asserted.
    const rows = await hookTablePrivileges();
    const missing = rows.filter((row) => !row.has_policy).map((row) => row.name);
    expect(missing).toEqual([]);
  });

  it("lets the real hook principal read every table the deployed hook touches", async () => {
    expect(authAdminConnectError, "could not connect as supabase_auth_admin").toBeNull();
    const rows = await hookTablePrivileges();
    const denied: string[] = [];
    for (const row of rows) {
      try {
        await authAdmin?.query(`select 1 from public."${row.name.replace(/"/g, '""')}" limit 1`);
      } catch (cause) {
        denied.push(`${row.name}: ${(cause as Error).message}`);
      }
    }
    expect(denied).toEqual([]);
  });
});
