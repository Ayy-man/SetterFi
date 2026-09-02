import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TENANT = "4b000000-0000-4000-8000-000000000010";

let db: Client;
let contactId: string;
let conversationId: string;
let outboundMessageId: string;
let inboundMessageId: string;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Booking slot selection suite could not reach Postgres at ${DB_URL}. Start the local stack with supabase start.`,
      { cause },
    );
  }
});

afterAll(async () => db?.end());

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email)
    values ('${TENANT}', 'booking-selection', 'Booking selection', 'booking@example.test')
  `);
  contactId = (await db.query<{ id: string }>(`
    insert into public.contacts (tenant_id, last_channel, name)
    values ('${TENANT}', 'sms', 'Booking lead') returning id
  `)).rows[0].id;
  conversationId = (await db.query<{ id: string }>(`
    insert into public.conversations (tenant_id, contact_id, channel)
    values ('${TENANT}', '${contactId}', 'sms') returning id
  `)).rows[0].id;
  outboundMessageId = (await db.query<{ id: string }>(`
    insert into public.messages (tenant_id, conversation_id, direction, author, body)
    values (
      '${TENANT}', '${conversationId}', 'out', 'agent',
      'Choose 2026-08-30 12:00 UTC — [slot_id:provider-slot-1]'
    ) returning id
  `)).rows[0].id;
  inboundMessageId = (await db.query<{ id: string }>(`
    insert into public.messages (tenant_id, conversation_id, direction, author, body)
    values ('${TENANT}', '${conversationId}', 'in', 'lead', 'provider-slot-1') returning id
  `)).rows[0].id;
});

afterEach(async () => db.query("rollback"));

describe("booking slot emission and selection", () => {
  it("forces RPC-only custody", async () => {
    expect((await db.query(`
      select relrowsecurity, relforcerowsecurity
      from pg_class where oid = 'public.booking_slot_emissions'::regclass
    `)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await db.query(`
      select has_table_privilege('service_role', 'public.booking_slot_emissions', 'SELECT') as select_ok,
             has_table_privilege('service_role', 'public.booking_slot_emissions', 'INSERT') as insert_ok,
             has_table_privilege('service_role', 'public.booking_slot_emissions', 'UPDATE') as update_ok
    `)).rows[0]).toEqual({ select_ok: false, insert_ok: false, update_ok: false });
  });

  it("claims only an exact lead-authored ID from an unexpired emitted token and replays it", async () => {
    const emission = (await db.query<{ emission_id: string }>(`
      select public.record_booking_slot_emission(
        $1, $2, $3, $4, array['provider-slot-1'],
        '2026-08-30T10:00:00Z', '2026-08-30T10:15:00Z'
      ) as emission_id
    `, [TENANT, conversationId, contactId, outboundMessageId])).rows[0].emission_id;
    const claimed = (await db.query(`
      select * from public.claim_booking_slot_selection(
        $1, $2, $3, $4, 'provider-slot-1', '2026-08-30T10:05:00Z'
      )
    `, [TENANT, conversationId, contactId, inboundMessageId])).rows[0];
    expect(claimed).toEqual({
      selection_state: "claimed",
      emission_id: emission,
      selected_slot_id: "provider-slot-1",
    });
    expect((await db.query(`
      select * from public.claim_booking_slot_selection(
        $1, $2, $3, $4, 'provider-slot-1', '2026-08-30T10:06:00Z'
      )
    `, [TENANT, conversationId, contactId, inboundMessageId])).rows[0].selection_state).toBe("replay");
  });

  it("atomically checkpoints a conflict reoffer even when the replacement still lists the selected slot", async () => {
    const emission = (await db.query<{ emission_id: string }>(`
      select public.record_booking_slot_emission(
        $1, $2, $3, $4, array['provider-slot-1'],
        '2026-08-30T10:00:00Z', '2026-08-30T10:15:00Z'
      ) as emission_id
    `, [TENANT, conversationId, contactId, outboundMessageId])).rows[0].emission_id;
    await db.query(`
      select * from public.claim_booking_slot_selection(
        $1, $2, $3, $4, 'provider-slot-1', '2026-08-30T10:05:00Z'
      )
    `, [TENANT, conversationId, contactId, inboundMessageId]);
    const calendarId = (await db.query<{ id: string }>(`
      insert into public.calendar_connections
        (tenant_id, provider, external_calendar_id, external_location_id, timezone, state, is_primary)
      values ($1, 'ghl', 'conflict-calendar', 'conflict-location', 'UTC', 'ready', true)
      returning id
    `, [TENANT])).rows[0].id;
    const intentId = (await db.query<{ id: string }>(`
      insert into public.booking_intents (
        tenant_id, conversation_id, contact_id, calendar_connection_id, selected_slot_id,
        start_at, end_at, timezone, idempotency_key, status, attempts, lease_token, lease_until
      ) values (
        $1, $2, $3, $4, 'provider-slot-1', '2026-08-30T12:00:00Z',
        '2026-08-30T12:30:00Z', 'UTC', 'conflict-intent', 'creating', 1,
        '4b000000-0000-4000-8000-000000000099', '2026-08-30T10:10:00Z'
      ) returning id
    `, [TENANT, conversationId, contactId, calendarId])).rows[0].id;
    const proposal = {
      calendarConnectionId: calendarId,
      rangeStartAt: "2026-08-30T00:00:00.000Z",
      rangeEndAt: "2026-08-31T00:00:00.000Z",
      proposedAt: "2026-08-30T10:06:00.000Z",
      presentationTimezone: "UTC",
      slots: [{
        id: "provider-slot-1",
        startAt: "2026-08-30T12:00:00.000Z",
        endAt: "2026-08-30T12:30:00.000Z",
        timezone: "UTC",
        display: "2026-08-30 12:00 UTC",
      }],
    };
    await db.query(`
      select public.checkpoint_booking_slot_conflict(
        $1, $2, $3, $4, $5, 'CALENDAR_SLOT_CONFLICT', '2026-08-30T10:05:30Z'
      )
    `, [TENANT, emission, inboundMessageId, intentId, "4b000000-0000-4000-8000-000000000099"]);
    expect((await db.query(`
      select * from public.claim_booking_slot_selection(
        $1, $2, $3, $4, 'provider-slot-1', '2026-08-30T10:05:45Z'
      )
    `, [TENANT, conversationId, contactId, inboundMessageId])).rows[0].selection_state)
      .toBe("conflict_pending");
    const persisted = (await db.query<{ proposal: unknown }>(`
      select public.record_booking_slot_conflict_reoffer(
        $1, $2, $3, $4::jsonb, $5, '2026-08-30T10:06:01Z'
      ) as proposal
    `, [TENANT, emission, inboundMessageId, JSON.stringify(proposal), proposal.proposedAt])).rows[0].proposal;
    expect(persisted).toEqual(proposal);
    expect((await db.query(`
      select reoffer_booking_intent_id, reoffered_at is not null as reoffered
      from public.booking_slot_emissions where id = $1
    `, [emission])).rows[0]).toEqual({ reoffer_booking_intent_id: intentId, reoffered: true });
    expect((await db.query(`
      select * from public.claim_booking_slot_selection(
        $1, $2, $3, $4, 'provider-slot-1', '2026-08-30T10:07:00Z'
      )
    `, [TENANT, conversationId, contactId, inboundMessageId])).rows[0].selection_state).toBe("reoffer");
    expect((await db.query<{ proposal: unknown }>(`
      select public.record_booking_slot_conflict_reoffer(
        $1, $2, $3, $4::jsonb, $5, '2026-08-30T10:07:01Z'
      ) as proposal
    `, [TENANT, emission, inboundMessageId, JSON.stringify(proposal), proposal.proposedAt])).rows[0].proposal)
      .toEqual(proposal);
  });

  it("rejects a substring-only outbound body and free-text selection", async () => {
    const weakOutbound = (await db.query<{ id: string }>(`
      insert into public.messages (tenant_id, conversation_id, direction, author, body)
      values ('${TENANT}', '${conversationId}', 'out', 'agent', 'provider-slot-2') returning id
    `)).rows[0].id;
    await expect(db.query(`
      select public.record_booking_slot_emission(
        $1, $2, $3, $4, array['provider-slot-2'],
        '2026-08-30T10:00:00Z', '2026-08-30T10:15:00Z'
      )
    `, [TENANT, conversationId, contactId, weakOutbound])).rejects.toThrow(/BOOKING_SLOT_NOT_EMITTED/u);
  });
});
