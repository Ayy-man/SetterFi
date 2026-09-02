// Conversation read acknowledgement is a database write because the inbox's unread badge must
// survive reloads. These tests keep the acknowledgement separate from the established takeover
// RPC and prove tenant enforcement with a real Postgres transaction.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "91100000-0000-4000-8000-000000000001";
const TENANT_B = "91100000-0000-4000-8000-000000000002";
const COACH_A = "91100000-0000-4000-8000-000000000003";
const COACH_B = "91100000-0000-4000-8000-000000000004";

let db: Client;
let conversationId: string;

async function actAsServiceRole() {
  await db.query("set local role service_role");
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: COACH_A, app_metadata: { role: "coach", tenant_id: TENANT_A } }),
  ]);
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Conversation acknowledgement tests could not reach Postgres at ${DB_URL}. ` +
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
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email) values
      ('${TENANT_A}', 'read-ack-a', 'Synthetic Read Ack A', 'a@read-ack.test'),
      ('${TENANT_B}', 'read-ack-b', 'Synthetic Read Ack B', 'b@read-ack.test');
    insert into public.users (id, email, role, tenant_id) values
      ('${COACH_A}', 'coach-a@read-ack.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@read-ack.test', 'coach', '${TENANT_B}');
    insert into public.contacts (tenant_id, last_channel, name)
      values ('${TENANT_A}', 'sms', 'Synthetic read-ack lead');
  `);
  conversationId = (await db.query<{ id: string }>(`
    insert into public.conversations
      (tenant_id, contact_id, channel, status, status_reason, unread_by_coach)
    select '${TENANT_A}', id, 'sms', 'needs_human', 'lead_requested_human', true
    from public.contacts where tenant_id = '${TENANT_A}'
    returning id
  `)).rows[0].id;
  await actAsServiceRole();
});

afterEach(async () => {
  await db.query("rollback");
});

describe("conversation read acknowledgement", () => {
  it("clears the durable unread flag without claiming the thread", async () => {
    const receipt = await db.query<{
      conversation_id: string; unread_by_coach: boolean; status: string; taken_over_by: string | null;
    }>(`select * from public.acknowledge_conversation_read($1,$2,$3)`, [
      TENANT_A, conversationId, COACH_A,
    ]);

    expect(receipt.rows[0]).toEqual({
      conversation_id: conversationId,
      unread_by_coach: false,
      status: "needs_human",
      taken_over_by: null,
    });
    expect((await db.query(`
      select unread_by_coach, status::text, taken_over_by
      from public.conversations where id = $1
    `, [conversationId])).rows[0]).toEqual({
      unread_by_coach: false,
      status: "needs_human",
      taken_over_by: null,
    });
  });

  it("keeps the existing takeover behavior: it assigns the coach and clears unread", async () => {
    await db.query(`select public.claim_conversation($1,$2,$3,'needs_human',null,false)`, [
      TENANT_A, conversationId, COACH_A,
    ]);

    expect((await db.query(`
      select unread_by_coach, status::text, taken_over_by
      from public.conversations where id = $1
    `, [conversationId])).rows[0]).toEqual({
      unread_by_coach: false,
      status: "human",
      taken_over_by: COACH_A,
    });
  });

  it("refuses a cross-tenant or unauthorized actor before it can clear unread", async () => {
    await db.query("savepoint cross_tenant_ack");
    await expect(db.query(`select * from public.acknowledge_conversation_read($1,$2,$3)`, [
      TENANT_B, conversationId, COACH_B,
    ])).rejects.toThrow(/EXPECTED_TENANT_MISMATCH:conversation/);
    await db.query("rollback to savepoint cross_tenant_ack");

    await db.query("savepoint unauthorized_ack");
    await expect(db.query(`select * from public.acknowledge_conversation_read($1,$2,$3)`, [
      TENANT_A, conversationId, COACH_B,
    ])).rejects.toThrow(/CONVERSATION_ACTOR_NOT_AUTHORIZED/);
    await db.query("rollback to savepoint unauthorized_ack");

    expect((await db.query(`select unread_by_coach from public.conversations where id = $1`, [conversationId]))
      .rows[0].unread_by_coach).toBe(true);
  });
});
