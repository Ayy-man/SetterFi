import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(`Job receipt suite could not reach Postgres at ${DB_URL}. Start the local Supabase stack; this suite fails rather than skips.`, { cause });
  }
});

afterAll(async () => db?.end());
beforeEach(async () => db.query("begin"));
afterEach(async () => db.query("rollback"));

describe("scheduled job receipts", () => {
  it("uses forced RLS, permits platform reads, and gives service role write custody", async () => {
    const custody = await db.query<{
      forced: boolean;
      authenticated_select: boolean;
      authenticated_insert: boolean;
      service_select: boolean;
      service_insert: boolean;
      service_update: boolean;
    }>(`
      select relforcerowsecurity forced,
        has_table_privilege('authenticated','public.job_receipts','select') authenticated_select,
        has_table_privilege('authenticated','public.job_receipts','insert') authenticated_insert,
        has_table_privilege('service_role','public.job_receipts','select') service_select,
        has_table_privilege('service_role','public.job_receipts','insert') service_insert,
        has_table_privilege('service_role','public.job_receipts','update') service_update
      from pg_class where oid='public.job_receipts'::regclass
    `);
    expect(custody.rows).toEqual([{
      forced: true,
      authenticated_select: true,
      authenticated_insert: false,
      service_select: true,
      service_insert: true,
      service_update: true,
    }]);
    await db.query(`
      insert into public.job_receipts (job_key,started_at,finished_at,outcome,counters)
      values ('followups','2026-09-05T00:00:00Z','2026-09-05T00:01:00Z','succeeded','{"selected":2}'::jsonb)
    `);
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', '{\"app_metadata\":{\"role\":\"coach\"}}', true)");
    await expect(db.query("select * from public.job_receipts")).resolves.toMatchObject({ rows: [] });
    await db.query("reset role");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', '{\"app_metadata\":{\"role\":\"admin\"}}', true)");
    await expect(db.query("select job_key from public.job_receipts"))
      .resolves.toMatchObject({ rows: [{ job_key: "followups" }] });
  });

  it("records a start before a valid terminal outcome and rejects fabricated terminal shapes", async () => {
    const started = await db.query<{ id: string }>(`
      insert into public.job_receipts (job_key,started_at)
      values ('inbound-recovery','2026-09-05T00:00:00Z') returning id
    `);
    await db.query(`update public.job_receipts
      set finished_at='2026-09-05T00:01:00Z', outcome='failed', error_detail='INBOUND_UNAVAILABLE',
          counters='{"claimed":3,"processed":1,"failed":2}'::jsonb
      where id=$1`, [started.rows[0].id]);
    const receipt = await db.query(`select outcome,error_detail,counters from public.job_receipts where id=$1`, [started.rows[0].id]);
    expect(receipt.rows).toEqual([{
      outcome: "failed", error_detail: "INBOUND_UNAVAILABLE", counters: { claimed: 3, processed: 1, failed: 2 },
    }]);
    await db.query("savepoint invalid_terminal_shape");
    await expect(db.query(`insert into public.job_receipts
      (job_key,started_at,finished_at,outcome,error_detail)
      values ('followups',now(),now(),'succeeded','not allowed')`)).rejects.toThrow(/job_receipts_terminal_shape_chk/);
    await db.query("rollback to savepoint invalid_terminal_shape");
  });
});
