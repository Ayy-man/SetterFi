import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TENANT = "4a000000-0000-4000-8000-000000000010";

let db: Client;
let contactId: string;
let conversationId: string;
let inboundMessageId: string;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Qualification runtime suite could not reach Postgres at ${DB_URL}. Start the local stack with supabase start.`,
      { cause },
    );
  }
});

afterAll(async () => db?.end());

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email)
    values ('${TENANT}', 'qualification-runtime', 'Qualification runtime', 'qualification@example.test')
  `);
  contactId = (await db.query<{ id: string }>(`
    insert into public.contacts (tenant_id, last_channel, name)
    values ('${TENANT}', 'sms', 'Qualification lead') returning id
  `)).rows[0].id;
  conversationId = (await db.query<{ id: string }>(`
    insert into public.conversations (
      tenant_id, contact_id, channel, current_step, current_step_asks
    ) values (
      '${TENANT}', '${contactId}', 'sms', 'qualification:credit', 1
    ) returning id
  `)).rows[0].id;
  inboundMessageId = (await db.query<{ id: string }>(`
    insert into public.messages (tenant_id, conversation_id, direction, author, body)
    values ('${TENANT}', '${conversationId}', 'in', 'lead', '720') returning id
  `)).rows[0].id;
});

afterEach(async () => db.query("rollback"));

async function apply(options: {
  messageId?: string;
  expectedAsks?: number;
  value?: string;
  outcome?: "BOOK" | "SOFT_DQ" | "HARD_DQ";
  reason?: string | null;
  ruleId?: string;
}) {
  const outcome = options.outcome ?? "BOOK";
  return db.query<{
    replayed: boolean;
    current_step: string | null;
    current_step_asks: number;
    qualification_outcome: string;
    conversation_status: string;
  }>(`
    select * from public.apply_qualification_turn(
      $1, $2, $3, $4, 'qualification:credit', $5,
      'qualification:credit', null, 0, 'credit', to_jsonb($6::text),
      $7::public.outcome, $8, $9
    )
  `, [
    TENANT,
    conversationId,
    contactId,
    options.messageId ?? inboundMessageId,
    options.expectedAsks ?? 1,
    options.value ?? "700+",
    outcome,
    options.reason ?? (outcome === "HARD_DQ" ? "published_qualification_rule:low-credit" : null),
    options.ruleId ?? (outcome === "HARD_DQ" ? "low-credit" : "strong-credit"),
  ]);
}

describe("atomic qualification turns", () => {
  it("forces RLS and exposes no direct service-role table privileges", async () => {
    expect((await db.query(`
      select relrowsecurity, relforcerowsecurity
      from pg_class where oid = 'public.qualification_turn_receipts'::regclass
    `)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await db.query(`
      select has_table_privilege('service_role', 'public.qualification_turn_receipts', 'SELECT') as select_ok,
             has_table_privilege('service_role', 'public.qualification_turn_receipts', 'INSERT') as insert_ok,
             has_table_privilege('service_role', 'public.qualification_turn_receipts', 'UPDATE') as update_ok
    `)).rows[0]).toEqual({ select_ok: false, insert_ok: false, update_ok: false });
  });

  it("persists the validated fact and published outcome once, then returns an exact replay", async () => {
    const first = await apply({});
    expect(first.rows[0]).toEqual({
      replayed: false,
      current_step: null,
      current_step_asks: 0,
      qualification_outcome: "BOOK",
      conversation_status: "agent",
    });
    const replay = await apply({});
    expect(replay.rows[0].replayed).toBe(true);
    expect((await db.query(`
      select credit_range::text, outcome::text
      from public.contacts where id = $1
    `, [contactId])).rows[0]).toEqual({ credit_range: "700+", outcome: "BOOK" });
    expect((await db.query(
      "select count(*)::int as count from public.qualification_turn_receipts where inbound_message_id = $1",
      [inboundMessageId],
    )).rows[0].count).toBe(1);
  });

  it("rejects a changed replay and a second stale turn rather than double-advancing", async () => {
    await apply({});
    await db.query("savepoint changed_replay");
    await expect(apply({ value: "680–700" })).rejects.toThrow(/QUALIFICATION_TURN_REPLAY_MISMATCH/u);
    await db.query("rollback to savepoint changed_replay");
    const secondMessage = (await db.query<{ id: string }>(`
      insert into public.messages (tenant_id, conversation_id, direction, author, body)
      values ('${TENANT}', '${conversationId}', 'in', 'lead', 'another answer') returning id
    `)).rows[0].id;
    await expect(apply({ messageId: secondMessage, expectedAsks: 1 }))
      .rejects.toThrow(/QUALIFICATION_TURN_CAS_MISMATCH/u);
  });

  it("closes a HARD_DQ without overwriting a coach-owned pipeline stage", async () => {
    await db.query(`
      update public.contacts
      set pipeline_stage = 'qualified_no_buy', stage_set_by = 'user'
      where id = $1
    `, [contactId]);
    const hard = await apply({
      value: "below 600",
      outcome: "HARD_DQ",
      reason: "published_qualification_rule:low-credit",
      ruleId: "low-credit",
    });
    expect(hard.rows[0]).toMatchObject({
      qualification_outcome: "HARD_DQ",
      conversation_status: "closed",
    });
    expect((await db.query(`
      select dq_reason, pipeline_stage::text, stage_set_by
      from public.contacts where id = $1
    `, [contactId])).rows[0]).toEqual({
      dq_reason: "published_qualification_rule:low-credit",
      pipeline_stage: "qualified_no_buy",
      stage_set_by: "user",
    });
  });
});
