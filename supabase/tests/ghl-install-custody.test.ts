// Install custody schema contract, after the grant-duality change. Two claims here are database
// properties and cannot be proved anywhere else: that one agency can hold a grant for each of the
// two marketplace apps without the rows colliding, and that neither app can hold two. Both are
// expressed as a composite unique, so both are tested by racing a duplicate insert at it.
//
// The lease token is asserted as a column rather than as behavior — the fencing predicate itself is
// proved in src/lib/integrations/ghl-oauth-store.test.ts against the recorder that captures how the
// write is expressed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const CUSTODY_TABLES = ["ghl_agency_installs", "ghl_install_secrets"] as const;
const ENVELOPE = `'{"version":1,"keyVersion":1,"algorithm":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AQ","tag":"AAAAAAAAAAAAAAAAAAAAAA"}'::jsonb`;

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Install custody suite could not reach Postgres at ${DB_URL}. ` +
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
});

afterEach(async () => {
  await db.query("rollback");
});

function insertAgencyInstall(companyId: string, app?: string) {
  const columns = ["company_id", "access_credential_envelope", "refresh_credential_envelope", "token_expires_at"];
  const values = [`'${companyId}'`, ENVELOPE, ENVELOPE, "now() + interval '1 day'"];
  if (app !== undefined) {
    columns.push("app");
    values.push(`'${app}'`);
  }
  return db.query(
    `insert into public.ghl_agency_installs (${columns.join(", ")})
       values (${values.join(", ")}) returning id, app`,
  );
}

describe("the app discriminator on ghl_agency_installs", () => {
  it("is not null, defaults to provisioning, and admits only the two marketplace apps", async () => {
    const column = await db.query<{ is_nullable: string; column_default: string; data_type: string }>(`
      select is_nullable, column_default, data_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'ghl_agency_installs' and column_name = 'app'
    `);
    expect(column.rows).toHaveLength(1);
    expect(column.rows[0].is_nullable).toBe("NO");
    expect(column.rows[0].data_type).toBe("text");
    expect(column.rows[0].column_default).toContain("provisioning");

    // The default is load-bearing twice: rows written before this migration were all agency-app
    // installs, and /admin/provisioning still reads the provisioning row without naming an app.
    const defaulted = await insertAgencyInstall("company-default");
    expect(defaulted.rows[0].app).toBe("provisioning");

    await expect(insertAgencyInstall("company-third-app", "somethingelse")).rejects.toThrow(
      /violates check constraint/,
    );
  });

  it("lets both apps hold a grant for one agency and neither hold two", async () => {
    await insertAgencyInstall("company-shared", "provisioning");
    // An agency install of the sub-account-target agent app returns a Company grant of its own,
    // with a different client id and an independently rotating refresh token.
    const agent = await insertAgencyInstall("company-shared", "agent");
    expect(agent.rows[0].app).toBe("agent");

    await expect(insertAgencyInstall("company-shared", "agent")).rejects.toThrow(
      /duplicate key value violates unique constraint/,
    );
  });

  it("no longer carries the single-column unique that made those two rows collide", async () => {
    const constraints = await db.query<{ conname: string; definition: string }>(`
      select con.conname, pg_get_constraintdef(con.oid) as definition
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'public' and rel.relname = 'ghl_agency_installs' and con.contype = 'u'
    `);
    const definitions = constraints.rows.map((row) => row.definition);
    expect(definitions).toContain("UNIQUE (app, company_id)");
    expect(definitions).not.toContain("UNIQUE (company_id)");
  });
});

describe("the refresh lease carries an identity", () => {
  it("stores a nullable uuid lease token on both custody tables", async () => {
    const columns = await db.query<{ table_name: string; data_type: string; is_nullable: string }>(`
      select table_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and column_name = 'refresh_lock_token'
        and table_name = any($1::text[])
      order by table_name
    `, [CUSTODY_TABLES]);
    expect(columns.rows.map((row) => row.table_name)).toEqual([...CUSTODY_TABLES]);
    expect(columns.rows.every((row) => row.data_type === "uuid" && row.is_nullable === "YES"))
      .toBe(true);
  });

  it("keeps the lease expiry beside it on both tables, because the fence needs both halves", async () => {
    const columns = await db.query<{ table_name: string }>(`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'refresh_lock_expires_at'
        and table_name = any($1::text[])
      order by table_name
    `, [CUSTODY_TABLES]);
    expect(columns.rows.map((row) => row.table_name)).toEqual([...CUSTODY_TABLES]);
  });
});

describe("the install-shape receipt", () => {
  const RECEIPT_COLUMNS = [
    "approve_all_locations",
    "install_to_future_locations",
    "is_bulk_installation",
  ] as const;
  const RECEIPT_TABLES = ["ghl_agency_installs", "ghl_installs"] as const;

  it("keeps all three flags nullable, with no default, on both install tables", async () => {
    const columns = await db.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(`
      select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])
        and column_name = any($2::text[])
      order by table_name, column_name
    `, [RECEIPT_TABLES, RECEIPT_COLUMNS]);

    expect(columns.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual(
      RECEIPT_TABLES.flatMap((table) => RECEIPT_COLUMNS.map((column) => `${table}.${column}`)),
    );
    // Nullable and defaultless is the whole contract: a row that was written before the columns
    // existed, or a grant that did not answer, must read as "not recorded" rather than as "no".
    for (const row of columns.rows) {
      expect(row.data_type).toBe("boolean");
      expect(row.is_nullable).toBe("YES");
      expect(row.column_default).toBeNull();
    }
  });

  it("leaves an install that says nothing about them reading null, not false", async () => {
    const inserted = await insertAgencyInstall("company-no-receipt", "agent");
    const row = await db.query<{
      approve_all_locations: boolean | null;
      is_bulk_installation: boolean | null;
      install_to_future_locations: boolean | null;
    }>(
      `select approve_all_locations, is_bulk_installation, install_to_future_locations
         from public.ghl_agency_installs where id = $1`,
      [inserted.rows[0].id],
    );
    expect(row.rows[0]).toEqual({
      approve_all_locations: null,
      is_bulk_installation: null,
      install_to_future_locations: null,
    });
  });
});

describe("adding columns did not loosen the custody posture", () => {
  it("still forces row security on both tables", async () => {
    const security = await db.query<{ relname: string; enabled: boolean; forced: boolean }>(`
      select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1::text[])
      order by c.relname
    `, [CUSTODY_TABLES]);
    expect(security.rows.map((row) => row.relname)).toEqual([...CUSTODY_TABLES]);
    expect(security.rows.every((row) => row.enabled && row.forced)).toBe(true);
  });

  it("still grants these tables to service_role and to nobody else", async () => {
    const grants = await db.query<{ table_name: string; grantee: string }>(`
      select distinct table_name, grantee from information_schema.role_table_grants
      where table_schema = 'public' and table_name = any($1::text[])
      order by table_name, grantee
    `, [CUSTODY_TABLES]);
    const grantees = [...new Set(grants.rows.map((row) => row.grantee))].sort();
    expect(grantees).toEqual(["postgres", "service_role"]);
    for (const table of CUSTODY_TABLES) {
      expect(grants.rows.some((row) => row.table_name === table && row.grantee === "service_role"))
        .toBe(true);
    }
  });

  it("holds no policy that names anon or authenticated", async () => {
    const policies = await db.query<{ tablename: string; roles: string }>(`
      select tablename, roles::text from pg_policies
      where schemaname = 'public' and tablename = any($1::text[])
    `, [CUSTODY_TABLES]);
    expect(policies.rows.length).toBeGreaterThan(0);
    for (const row of policies.rows) {
      expect(row.roles).not.toContain("anon");
      expect(row.roles).not.toContain("authenticated");
    }
  });
});
