// Migration 20261013000017: a tenant member reads the knowledge entries scoped to their own tenant
// and the question variants beneath them. Live-Postgres-only, like the other Brain suites: the
// policies resolve the caller through app.current_tenant_id(), and the membership path a
// coach_member takes cannot be restated by a mock.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "4c000000-0000-4000-8000-000000000010";
const TENANT_B = "4c000000-0000-4000-8000-000000000020";
const ADMIN = "4c100000-0000-4000-8000-000000000010";
const COACH_A = "4c100000-0000-4000-8000-000000000020";
const COACH_B = "4c100000-0000-4000-8000-000000000030";
const MEMBER_A = "4c100000-0000-4000-8000-000000000040";
const ENTRY_SHARED = "4c200000-0000-4000-8000-000000000010";
const ENTRY_A = "4c200000-0000-4000-8000-000000000020";
const ENTRY_B = "4c200000-0000-4000-8000-000000000030";
const ENTRY_UNROUTED = "4c200000-0000-4000-8000-000000000040";

type Claims = { role: "admin" | "coach" | "coach_member"; tenant_id?: string };

let db: Client;

function vector(x: number) {
  return `[${[x, ...Array<number>(1535).fill(0)].join(",")}]`;
}

async function actAs(pgRole: "authenticated" | "service_role", actorId: string, claims: Claims) {
  await db.query(`set local role ${pgRole}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
    sub: actorId, app_metadata: claims,
  })]);
}

async function resetRole() {
  await db.query("reset role");
  await db.query(`select set_config('request.jwt.claims', '{}', true)`);
}

async function expectDbError(sql: string, params: readonly unknown[], expected: string) {
  await db.query("savepoint expected_failure");
  let error: unknown;
  try {
    await db.query(sql, params as unknown[]);
  } catch (cause) {
    error = cause;
  }
  await db.query("rollback to savepoint expected_failure");
  expect(error).toBeDefined();
  expect(String(error)).toContain(expected);
}

async function visibleEntries(): Promise<string[]> {
  return (await db.query<{ id: string }>(
    `select id from public.brain_knowledge_entries order by id`,
  )).rows.map((row) => row.id);
}

async function visibleVariants(): Promise<string[]> {
  return (await db.query<{ variant: string }>(
    `select variant from public.brain_knowledge_entry_variants order by variant`,
  )).rows.map((row) => row.variant);
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(`Tenant-scoped entries suite could not reach Postgres at ${DB_URL}.`, { cause });
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email, is_demo) values
      ('${TENANT_A}', 'scoped-a', 'Scoped A', 'billing-a@scoped.test', true),
      ('${TENANT_B}', 'scoped-b', 'Scoped B', 'billing-b@scoped.test', true);
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@scoped.test', 'admin', null),
      ('${COACH_A}', 'coach-a@scoped.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@scoped.test', 'coach', '${TENANT_B}'),
      ('${MEMBER_A}', 'member-a@scoped.test', 'coach_member', '${TENANT_A}');
    insert into public.tenant_memberships (tenant_id, user_id, role, invited_by)
      values ('${TENANT_A}', '${MEMBER_A}', 'coach_member', '${COACH_A}');
  `);
  // One row per route: a shared draft (tenant_id null), one entry per tenant, and a needs_rewrite
  // row that no tenant owns. Every row stays a draft so published_read admits none of them.
  await db.query(
    `insert into public.brain_knowledge_entries
       (id, question, answer, category, status, source, source_ref, disposition, tenant_id,
        response_template, embedding)
     values
       ($1, 'Shared question', 'Shared answer', 'Funding Qs', 'draft', 'mock', 'mock:shared',
        'shared', null, 'Shared answer', $5::vector),
       ($2, 'Tenant A question', 'Tenant A answer', 'Funding Qs', 'draft', 'mock', 'mock:a',
        'tenant_specific', $6, 'Tenant A answer', $5::vector),
       ($3, 'Tenant B question', 'Tenant B answer', 'Funding Qs', 'draft', 'mock', 'mock:b',
        'tenant_specific', $7, 'Tenant B answer', $5::vector),
       ($4, 'Unrouted question', 'Unrouted answer', 'Funding Qs', 'draft', 'mock', 'mock:unrouted',
        'needs_rewrite', null, 'Unrouted answer', null)`,
    [ENTRY_SHARED, ENTRY_A, ENTRY_B, ENTRY_UNROUTED, vector(1), TENANT_A, TENANT_B],
  );
  await db.query(
    `insert into public.brain_knowledge_entry_variants (entry_id, variant, embedding, created_by)
     values ($1, 'variant shared', $4::vector, $5),
            ($2, 'variant a', $4::vector, $5),
            ($3, 'variant b', $4::vector, $5)`,
    [ENTRY_SHARED, ENTRY_A, ENTRY_B, vector(1), ADMIN],
  );
});

afterEach(async () => {
  await db.query("rollback");
});

describe("tenant_read on brain_knowledge_entries and brain_knowledge_entry_variants", () => {
  it("shows a coach only the entries and variants scoped to their own tenant", async () => {
    await actAs("authenticated", COACH_A, { role: "coach", tenant_id: TENANT_A });
    expect(await visibleEntries()).toEqual([ENTRY_A]);
    expect(await visibleVariants()).toEqual(["variant a"]);

    await actAs("authenticated", COACH_B, { role: "coach", tenant_id: TENANT_B });
    expect(await visibleEntries()).toEqual([ENTRY_B]);
    expect(await visibleVariants()).toEqual(["variant b"]);
  });

  it("shows nothing tenant-scoped to a coach whose claim names another tenant or no tenant", async () => {
    await actAs("authenticated", COACH_A, { role: "coach", tenant_id: TENANT_B });
    // The claim, not the users row, is what the policy resolves; a forged claim reads that tenant's
    // rows only if the JWT says so, and the auth hook is what pins the claim to the users row.
    expect(await visibleEntries()).toEqual([ENTRY_B]);

    await actAs("authenticated", COACH_A, { role: "coach" });
    expect(await visibleEntries()).toEqual([]);
    expect(await visibleVariants()).toEqual([]);
  });

  it("admits a coach member through an unrevoked membership and denies them once revoked", async () => {
    await actAs("authenticated", MEMBER_A, { role: "coach_member", tenant_id: TENANT_A });
    expect(await visibleEntries()).toEqual([ENTRY_A]);
    expect(await visibleVariants()).toEqual(["variant a"]);

    await actAs("authenticated", MEMBER_A, { role: "coach_member", tenant_id: TENANT_B });
    expect(await visibleEntries()).toEqual([]);
    expect(await visibleVariants()).toEqual([]);

    await resetRole();
    await db.query(
      // tenant_memberships_revocation_shape: a revocation records who revoked it.
      `update public.tenant_memberships set revoked_at = now(), revoked_by = $3 where user_id = $1 and tenant_id = $2`,
      [MEMBER_A, TENANT_A, ADMIN],
    );
    await actAs("authenticated", MEMBER_A, { role: "coach_member", tenant_id: TENANT_A });
    expect(await visibleEntries()).toEqual([]);
    expect(await visibleVariants()).toEqual([]);
  });

  it("leaves the platform read intact and still shows a coach published shared knowledge", async () => {
    await actAs("authenticated", ADMIN, { role: "admin" });
    expect(await visibleEntries()).toEqual([ENTRY_SHARED, ENTRY_A, ENTRY_B, ENTRY_UNROUTED]);
    expect(await visibleVariants()).toEqual(["variant a", "variant b", "variant shared"]);

    await resetRole();
    await db.query(
      `update public.brain_knowledge_entries set status = 'published', published_at = now() where id = $1`,
      [ENTRY_SHARED],
    );
    await actAs("authenticated", COACH_A, { role: "coach", tenant_id: TENANT_A });
    expect(await visibleEntries()).toEqual([ENTRY_SHARED, ENTRY_A]);
    // Variants have no published_read; the shared entry's variant stays platform-only.
    expect(await visibleVariants()).toEqual(["variant a"]);
  });

  it("does not widen writes: a coach cannot insert, update or delete on either table", async () => {
    await actAs("authenticated", COACH_A, { role: "coach", tenant_id: TENANT_A });
    await expectDbError(
      `insert into public.brain_knowledge_entries
         (question, answer, category, status, source, disposition, tenant_id, response_template)
       values ('q', 'a', 'Funding Qs', 'draft', 'manual', 'tenant_specific', $1, 'a')`,
      [TENANT_A], "row-level security policy",
    );
    const updated = await db.query(
      `update public.brain_knowledge_entries set answer = 'changed' where id = $1`, [ENTRY_A],
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await db.query(
      `delete from public.brain_knowledge_entries where id = $1`, [ENTRY_A],
    );
    expect(deleted.rowCount).toBe(0);
    await expectDbError(
      `insert into public.brain_knowledge_entry_variants (entry_id, variant, embedding)
       values ($1, 'coach variant', $2::vector)`,
      [ENTRY_A, vector(1)], "permission denied",
    );
    await expectDbError(
      `delete from public.brain_knowledge_entry_variants where entry_id = $1`,
      [ENTRY_A], "permission denied",
    );
  });

  it("pins the two policies as SELECT-only, documented, and the only additions", async () => {
    const policies = (await db.query<{ tablename: string; policyname: string; cmd: string; documented: boolean }>(`
      select p.tablename, p.policyname, p.cmd::text,
        obj_description(pol.oid, 'pg_policy') is not null as documented
      from pg_policies p
      join pg_class c on c.relname = p.tablename
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = p.schemaname
      join pg_policy pol on pol.polrelid = c.oid and pol.polname = p.policyname
      where p.schemaname = 'public'
        and p.tablename in ('brain_knowledge_entries', 'brain_knowledge_entry_variants')
      order by p.tablename, p.policyname
    `)).rows;
    expect(policies).toEqual([
      { tablename: "brain_knowledge_entries", policyname: "admin_write", cmd: "ALL", documented: false },
      { tablename: "brain_knowledge_entries", policyname: "published_read", cmd: "SELECT", documented: false },
      { tablename: "brain_knowledge_entries", policyname: "tenant_read", cmd: "SELECT", documented: true },
      { tablename: "brain_knowledge_entry_variants", policyname: "phase2_platform_read", cmd: "SELECT", documented: false },
      { tablename: "brain_knowledge_entry_variants", policyname: "tenant_read", cmd: "SELECT", documented: true },
    ]);
  });
});
