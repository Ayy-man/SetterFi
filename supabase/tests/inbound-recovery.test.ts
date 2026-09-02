import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TENANT = "49000000-0000-4000-8000-000000000010";

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Inbound recovery suite could not reach Postgres at ${DB_URL}. Start the local stack with supabase start.`,
      { cause },
    );
  }
});

afterAll(async () => db?.end());

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email)
    values ('${TENANT}', 'inbound-recovery', 'Inbound recovery', 'recovery@example.test')
  `);
});

afterEach(async () => db.query("rollback"));

describe("ordinary webhook receipt leases", () => {
  it("uses exclusive expiring custody, counts attempts, enforces backoff, and rejects stale finishers", async () => {
    const startedAt = new Date();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * 60_000).toISOString();
    const inserted = await db.query<{ id: string }>(`
      insert into public.webhook_events (
        provider, provider_event_id, tenant_id, event_type, signature_verified, payload, next_attempt_at
      ) values (
        'ghl', 'recovery-event', '${TENANT}', 'InboundMessage', true,
        '{"normalized":{"events":[{"kind":"message"}]}}'::jsonb, '${at(0)}'
      ) returning id
    `);
    const receiptId = inserted.rows[0].id;
    const first = await db.query<{ attempt_number: number; lease_token: string }>(`
      select attempt_number, lease_token from public.claim_inbound_webhook_receipts(
        10, 300, '${at(0)}', '${receiptId}'
      )
    `);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].attempt_number).toBe(1);

    const whileLeased = await db.query(`
      select * from public.claim_inbound_webhook_receipts(
        10, 300, '${at(1)}', '${receiptId}'
      )
    `);
    expect(whileLeased.rows).toHaveLength(0);

    const second = await db.query<{ attempt_number: number; lease_token: string }>(`
      select attempt_number, lease_token from public.claim_inbound_webhook_receipts(
        10, 300, '${at(6)}', '${receiptId}'
      )
    `);
    expect(second.rows[0].attempt_number).toBe(2);
    expect(second.rows[0].lease_token).not.toBe(first.rows[0].lease_token);

    const stale = await db.query<{ finished: boolean }>(`
      select public.finish_inbound_webhook_receipt(
        '${receiptId}', '${first.rows[0].lease_token}', 1, 'processed', null, null
      ) as finished
    `);
    expect(stale.rows[0].finished).toBe(false);

    const retry = await db.query<{ finished: boolean }>(`
      select public.finish_inbound_webhook_receipt(
        '${receiptId}', '${second.rows[0].lease_token}', 2, 'failed',
        'SYNTHETIC_FAILURE', '${at(7)}'
      ) as finished
    `);
    expect(retry.rows[0].finished).toBe(true);
    expect((await db.query(`select * from public.claim_inbound_webhook_receipts(
      10, 300, '${new Date(startedAt.getTime() + 6 * 60_000 - 1000).toISOString()}', '${receiptId}'
    )`)).rows).toHaveLength(0);

    const third = await db.query<{ attempt_number: number; lease_token: string }>(`
      select attempt_number, lease_token from public.claim_inbound_webhook_receipts(
        10, 300, '${at(7)}', '${receiptId}'
      )
    `);
    expect(third.rows[0].attempt_number).toBe(3);
    expect((await db.query<{ finished: boolean }>(`
      select public.finish_inbound_webhook_receipt(
        '${receiptId}', '${third.rows[0].lease_token}', 3, 'processed', null, null
      ) as finished
    `)).rows[0].finished).toBe(true);
    expect((await db.query<{ status: string; attempts: number }>(
      "select status::text, attempts from public.webhook_events where id = $1",
      [receiptId],
    )).rows[0]).toEqual({ status: "processed", attempts: 3 });
  });

  it("never claims unsigned, lifecycle, Stripe, tenantless, or completed rows", async () => {
    await db.query(`
      insert into public.webhook_events
        (provider, provider_event_id, tenant_id, event_type, signature_verified, payload, status)
      values
        ('ghl', 'unsigned', '${TENANT}', 'InboundMessage', false, '{}', 'received'),
        ('ghl', 'install', '${TENANT}', 'INSTALL', true, '{}', 'received'),
        ('meta', 'tenantless', null, 'InboundMessage', true, '{}', 'received'),
        ('stripe', 'stripe', '${TENANT}', 'invoice.paid', true, '{}', 'received'),
        ('meta', 'done', '${TENANT}', 'InboundMessage', true, '{}', 'processed')
    `);
    expect((await db.query(`select * from public.claim_inbound_webhook_receipts(
      100, 300, '2026-08-27T12:00:00Z', null
    )`)).rows).toHaveLength(0);
  });

  it("defers a dependency-busy receipt without consuming its poison-attempt budget", async () => {
    const startedAt = new Date();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * 60_000).toISOString();
    const receiptId = (await db.query<{ id: string }>(`
      insert into public.webhook_events (
        provider, provider_event_id, tenant_id, event_type, signature_verified, payload, next_attempt_at
      ) values ('ghl', 'booking-busy', '${TENANT}', 'InboundMessage', true, '{}', '${at(0)}') returning id
    `)).rows[0].id;
    const claim = (await db.query<{ attempt_number: number; lease_token: string }>(`
      select attempt_number, lease_token from public.claim_inbound_webhook_receipts(
        1, 300, '${at(0)}', '${receiptId}'
      )
    `)).rows[0];
    expect((await db.query<{ deferred: boolean }>(`
      select public.defer_inbound_webhook_receipt(
        $1, $2, $3, 'BOOKING_SLOT_SELECTION_BUSY', $4
      ) as deferred
    `, [receiptId, claim.lease_token, claim.attempt_number, at(1)])).rows[0].deferred).toBe(true);
    expect((await db.query(`select attempts, status::text, next_attempt_at
      from public.webhook_events where id = $1`, [receiptId])).rows[0]).toMatchObject({
      attempts: 0,
      status: "failed",
    });
    expect((await db.query(`select attempt_number from public.claim_inbound_webhook_receipts(
      1, 300, '${at(1)}', '${receiptId}'
    )`)).rows[0].attempt_number).toBe(1);
  });
});

describe("bounded persisted conversation history", () => {
  it("returns only rows before the claimed inbound in chronological role order", async () => {
    const contact = await db.query<{ id: string }>(`
      insert into public.contacts (tenant_id, last_channel, name)
      values ('${TENANT}', 'sms', 'History lead') returning id
    `);
    const conversation = await db.query<{ id: string }>(`
      insert into public.conversations (tenant_id, contact_id, channel)
      values ('${TENANT}', '${contact.rows[0].id}', 'sms') returning id
    `);
    const conversationId = conversation.rows[0].id;
    await db.query(`
      insert into public.messages
        (tenant_id, conversation_id, direction, author, body, created_at)
      values
        ('${TENANT}', '${conversationId}', 'in', 'lead', 'First', '2026-08-27T11:00:00Z'),
        ('${TENANT}', '${conversationId}', 'out', 'agent', 'Reply', '2026-08-27T11:01:00Z')
    `);
    const current = await db.query<{ id: string }>(`
      insert into public.messages
        (tenant_id, conversation_id, direction, author, body, created_at)
      values ('${TENANT}', '${conversationId}', 'in', 'lead', 'Current', '2026-08-27T11:02:00Z')
      returning id
    `);
    await db.query(`
      insert into public.messages
        (tenant_id, conversation_id, direction, author, body, created_at)
      values ('${TENANT}', '${conversationId}', 'out', 'agent', 'After current', '2026-08-27T11:03:00Z')
    `);

    const history = await db.query<{ role: string; content: string }>(`
      select * from public.load_inbound_conversation_history(
        '${TENANT}', '${conversationId}', '${current.rows[0].id}', 40
      )
    `);
    expect(history.rows).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Reply" },
    ]);
  });
});

describe("durable inbound engine result", () => {
  it("keeps RPC-only custody and selects one immutable result with its original CAS inputs", async () => {
    expect((await db.query(`
      select relrowsecurity, relforcerowsecurity
      from pg_class where oid = 'public.inbound_engine_turns'::regclass
    `)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await db.query(`
      select has_table_privilege('service_role', 'public.inbound_engine_turns', 'SELECT') as select_ok,
             has_table_privilege('service_role', 'public.inbound_engine_turns', 'INSERT') as insert_ok,
             has_table_privilege('service_role', 'public.inbound_engine_turns', 'UPDATE') as update_ok
    `)).rows[0]).toEqual({ select_ok: false, insert_ok: false, update_ok: false });

    const contactId = (await db.query<{ id: string }>(`
      insert into public.contacts (tenant_id, last_channel, name)
      values ('${TENANT}', 'sms', 'Durable turn lead') returning id
    `)).rows[0].id;
    const conversationId = (await db.query<{ id: string }>(`
      insert into public.conversations (tenant_id, contact_id, channel, current_step, current_step_asks)
      values ('${TENANT}', '${contactId}', 'sms', 'qualification:credit', 1) returning id
    `)).rows[0].id;
    const inboundMessageId = (await db.query<{ id: string }>(`
      insert into public.messages (tenant_id, conversation_id, direction, author, body)
      values ('${TENANT}', '${conversationId}', 'in', 'lead', '720') returning id
    `)).rows[0].id;
    const first = (await db.query(`
      select * from public.record_inbound_engine_turn(
        $1, $2, $3, $4, 'qualification:credit', 1,
        '{"response":{"reply":"first"},"commands":[],"trace":{}}'::jsonb
      )
    `, [TENANT, conversationId, contactId, inboundMessageId])).rows[0];
    const raced = (await db.query(`
      select * from public.record_inbound_engine_turn(
        $1, $2, $3, $4, 'qualification:goal', 0,
        '{"response":{"reply":"different"},"commands":[],"trace":{}}'::jsonb
      )
    `, [TENANT, conversationId, contactId, inboundMessageId])).rows[0];
    expect(raced).toEqual(first);
    expect(first.pre_turn_current_step).toBe("qualification:credit");
    expect(first.pre_turn_current_step_asks).toBe(1);
    expect(first.result_payload.response.reply).toBe("first");
  });
});
