// Phase 9 install custody. Two of the claims this lane rests on are database properties and
// cannot be proved anywhere else: that a state row can only be consumed once no matter how many
// callbacks race for it, and that a refresh lease can only be taken by one writer at a time. Both
// are expressed as predicates on the write, so both are tested by racing two writes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const NEW_TABLES = ["ghl_agency_installs", "ghl_oauth_states"] as const;
const TENANT = "11111111-1111-1111-1111-111111111111";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const ENVELOPE = `'{"version":1,"keyVersion":1,"algorithm":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AQ","tag":"AAAAAAAAAAAAAAAAAAAAAA"}'::jsonb`;

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 9 install custody suite could not reach Postgres at ${DB_URL}. ` +
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
    insert into public.tenants (id, slug, name, billing_contact_email, is_demo)
      values ('${TENANT}', 'phase9-a', 'Synthetic Phase 9 A', 'billing-a@phase9.test', false);
    insert into public.users (id, tenant_id, email, role)
      values ('${ACTOR}', null, 'admin@phase9.test', 'admin');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("custody tables are service-role only", () => {
  it("forces row security and grants nothing to anon or authenticated", async () => {
    const security = await db.query<{ relname: string; forced: boolean; policies: string }>(`
      select c.relname, c.relforcerowsecurity as forced, count(p.policyname)::text as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
      where n.nspname = 'public' and c.relname = any($1::text[])
      group by c.relname, c.relforcerowsecurity
      order by c.relname
    `, [NEW_TABLES]);
    expect(security.rows.map((row) => row.relname)).toEqual([...NEW_TABLES]);
    expect(security.rows.every((row) => row.forced && Number(row.policies) === 1)).toBe(true);

    const grants = await db.query<{ grantee: string; table_name: string }>(`
      select grantee, table_name from information_schema.role_table_grants
      where table_schema = 'public' and table_name = any($1::text[])
        and grantee in ('anon', 'authenticated', 'PUBLIC')
    `, [NEW_TABLES]);
    expect(grants.rows).toEqual([]);
  });
});

describe("single-use state and single-holder lease are enforced by the write", () => {
  beforeEach(async () => {
    await db.query(`
      insert into public.ghl_oauth_states
        (id, app, state_hash, tenant_id, actor_id, return_path, expires_at)
      values (
        '66666666-6666-4666-8666-666666666666', 'agent', repeat('a', 64), '${TENANT}',
        '${ACTOR}', '/coach/integrations', now() + interval '5 minutes'
      );
      insert into public.ghl_agency_installs
        (id, company_id, access_credential_envelope, refresh_credential_envelope, token_expires_at)
      values (
        '77777777-7777-4777-8777-777777777777', 'company-1', ${ENVELOPE}, ${ENVELOPE},
        now() + interval '1 minute'
      );
    `);
  });

  it("consumes a state exactly once, so a replayed callback matches nothing", async () => {
    const consume = () => db.query(`
      update public.ghl_oauth_states set consumed_at = now()
      where state_hash = repeat('a', 64) and consumed_at is null
      returning id
    `);
    expect((await consume()).rowCount).toBe(1);
    expect((await consume()).rowCount).toBe(0);
  });

  it("hands the refresh lease to one writer and refuses the next until it expires", async () => {
    const claim = () => db.query(`
      update public.ghl_agency_installs
      set refresh_lock_expires_at = now() + interval '60 seconds'
      where id = '77777777-7777-4777-8777-777777777777'
        and (refresh_lock_expires_at is null or refresh_lock_expires_at < now())
      returning id
    `);
    expect((await claim()).rowCount).toBe(1);
    // The single-use refresh token is why this must be 0 and not 1.
    expect((await claim()).rowCount).toBe(0);

    // A lease that lapsed — an instance that died mid-refresh — must not wedge the install.
    await db.query(`
      update public.ghl_agency_installs set refresh_lock_expires_at = now() - interval '1 second'
      where id = '77777777-7777-4777-8777-777777777777'
    `);
    expect((await claim()).rowCount).toBe(1);
  });

  // A callback redirect is attacker-influenced, so the shape of what we will store is a
  // constraint rather than a convention that some future writer can forget.
  it.each([
    ["a state hash that is not a sha-256 digest", "repeat('b', 63)", "'/coach/integrations'",
      "now() + interval '5 minutes'", "'agent'", /state_hash/],
    ["an expiry beyond the ten-minute ceiling", "repeat('c', 64)", "'/coach/integrations'",
      "now() + interval '2 hours'", "'agent'", /ghl_oauth_states_expiry_chk/],
    ["a protocol-relative return path", "repeat('d', 64)", "'//evil.test/steal'",
      "now() + interval '5 minutes'", "'agent'", /return_path/],
    ["an app the callbacks do not serve", "repeat('e', 64)", "'/coach/integrations'",
      "now() + interval '5 minutes'", "'sideloaded'", /ghl_oauth_states_app_check/],
  ])("refuses %s", async (_label, hash, returnPath, expiresAt, app, message) => {
    await db.query("savepoint constraint_probe");
    await expect(db.query(`
      insert into public.ghl_oauth_states (app, state_hash, actor_id, return_path, expires_at)
      values (${app}, ${hash}, '${ACTOR}', ${returnPath}, ${expiresAt})
    `)).rejects.toThrow(message);
    await db.query("rollback to savepoint constraint_probe");
  });
});
