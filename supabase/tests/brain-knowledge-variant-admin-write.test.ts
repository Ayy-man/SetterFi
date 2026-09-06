// Migration 20261013000017: the RPC that adds a question variant and its audit row together.
// Live-Postgres-only: the transaction, the registered audit key and the actor check are database
// behaviours a mock would only restate.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ADMIN = "4b000000-0000-4000-8000-000000000017";
const COACH = "4b000000-0000-4000-8000-000000000018";
const ENTRY = "44000000-0000-4000-8000-000000000017";

let db: Client;

function vector(x: number, y = 0) {
  return `[${[x, y, ...Array<number>(1534).fill(0)].join(",")}]`;
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
  expect(String(error)).toContain(expected);
}

const ADD = `select * from public.add_brain_knowledge_entry_variant($1, $2, $3, $4::vector)`;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(`Variant write suite could not reach Postgres at ${DB_URL}.`, { cause });
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@variant-write.test', 'admin', null),
      ('${COACH}', 'coach@variant-write.test', 'coach', null);
    insert into public.brain_knowledge_entries
      (id, question, answer, category, status, source, source_ref, disposition, response_template, embedding)
    values ('${ENTRY}', 'What does it cost?', 'It depends.', 'Funding Qs', 'draft', 'mock', 'mock:${ENTRY}',
      'shared', 'It depends.', '${vector(1)}'::vector);
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("add_brain_knowledge_entry_variant", () => {
  it("registers the audit action for the interface", async () => {
    const row = (await db.query<{ microcopy: string; scope: string; reason_required: boolean }>(
      `select microcopy, scope::text as scope, reason_required from public.audit_actions where key = 'brain.knowledge.variant_added'`,
    )).rows[0];
    expect(row).toEqual({ microcopy: "Phrasing logged", scope: "platform", reason_required: false });
  });

  it("inserts the trimmed variant with its embedding and one audit row naming the entry", async () => {
    const receipt = (await db.query<{ variant_id: string; audit_id: string }>(
      ADD, [ADMIN, ENTRY, "  how much is the programme  ", vector(0.6, 0.8)],
    )).rows[0];
    const stored = (await db.query<{ variant: string; created_by: string; entry_id: string }>(
      `select variant, created_by, entry_id from public.brain_knowledge_entry_variants where id = $1`,
      [receipt.variant_id],
    )).rows[0];
    expect(stored).toEqual({ variant: "how much is the programme", created_by: ADMIN, entry_id: ENTRY });
    const audit = (await db.query<{ action: string; target_type: string; target_id: string; actor_id: string; payload: Record<string, unknown> }>(
      `select action, target_type, target_id, actor_id, payload from public.audit_log where id = $1`,
      [receipt.audit_id],
    )).rows[0];
    expect(audit).toMatchObject({
      action: "brain.knowledge.variant_added",
      target_type: "brain_knowledge_entry",
      target_id: ENTRY,
      actor_id: ADMIN,
    });
    expect(audit.payload).toMatchObject({ variant_id: receipt.variant_id, variant: "how much is the programme" });
  });

  it("refuses blank, oversized, question-restating and duplicate phrasings, an unknown entry, and a non-platform actor", async () => {
    await db.query(ADD, [ADMIN, ENTRY, "how much is the programme", vector(0.6, 0.8)]);
    await expectDbError(ADD, [ADMIN, ENTRY, "   ", vector(0, 1)], "BRAIN_VARIANT_TEXT_REQUIRED");
    await expectDbError(ADD, [ADMIN, ENTRY, "x".repeat(501), vector(0, 1)], "BRAIN_VARIANT_TOO_LONG");
    await expectDbError(ADD, [ADMIN, ENTRY, " what does IT cost? ", vector(0, 1)], "BRAIN_VARIANT_MATCHES_QUESTION");
    await expectDbError(ADD, [ADMIN, ENTRY, "How much is the programme", vector(0, 1)], "BRAIN_VARIANT_DUPLICATE");
    await expectDbError(ADD, [ADMIN, "44000000-0000-4000-8000-0000000000ff", "anything", vector(0, 1)], "BRAIN_KNOWLEDGE_ENTRY_NOT_FOUND");
    await expectDbError(ADD, [COACH, ENTRY, "another phrasing", vector(0, 1)], "PHASE2_PLATFORM_ACTOR_FORBIDDEN");
    expect((await db.query(
      `select count(*)::int as count from public.brain_knowledge_entry_variants where entry_id = $1`, [ENTRY],
    )).rows[0].count).toBe(1);
  });

  it("is callable by the service role only", async () => {
    const grants = (await db.query<{ grantee: string }>(`
      select grantee from information_schema.routine_privileges
      where routine_schema = 'public' and routine_name = 'add_brain_knowledge_entry_variant'
      order by grantee
    `)).rows.map((row) => row.grantee);
    expect(grants).not.toContain("anon");
    expect(grants).not.toContain("authenticated");
    expect(grants).toContain("service_role");
  });
});
