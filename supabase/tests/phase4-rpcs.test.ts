// Phase 4 RPC behavior runs against real Postgres because atomic rollback, row locks, enum
// precedence, append-only audit snapshots, and service-only grants cannot be proved with mocks.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "41000000-0000-4000-8000-000000000010";
const TENANT_B = "41000000-0000-4000-8000-000000000020";
const TENANT_DEMO = "41000000-0000-4000-8000-000000000030";
const COACH_A = "42000000-0000-4000-8000-000000000010";
const COACH_B = "42000000-0000-4000-8000-000000000020";
const GHL_INSTALL_A = "43000000-0000-4000-8000-000000000010";
const GHL_LOCATION_A = "phase4-rpc-ghl-location";

let db: Client;

async function contact(
  tenantId: string,
  name: string,
  overrides: {
    isTest?: boolean;
    optedOut?: boolean;
    creditRange?: string | null;
    fundingGoal?: string | null;
    outcome?: string | null;
    updatedAt?: string;
  } = {},
) {
  const result = await db.query<{ id: string }>(
    `insert into public.contacts (
       tenant_id, last_channel, name, is_test, opted_out, credit_range, funding_goal,
       outcome, updated_at
     ) values ($1, 'instagram', $2, $3, $4, $5, $6, $7, $8::timestamptz)
     returning id`,
    [
      tenantId,
      name,
      overrides.isTest ?? false,
      overrides.optedOut ?? false,
      overrides.creditRange ?? null,
      overrides.fundingGoal ?? null,
      overrides.outcome ?? null,
      overrides.updatedAt ?? "2026-08-17T10:00:00Z",
    ],
  );
  return result.rows[0].id;
}

async function conversation(tenantId: string, contactId: string, channel = "instagram") {
  const result = await db.query<{ id: string }>(
    `insert into public.conversations (tenant_id, contact_id, channel)
     values ($1, $2, $3::public.messaging_channel) returning id`,
    [tenantId, contactId, channel],
  );
  return result.rows[0].id;
}

async function message(tenantId: string, conversationId: string, suffix: string) {
  const result = await db.query<{ id: string }>(
    `insert into public.messages (tenant_id, conversation_id, direction, author, body)
     values ($1, $2, 'in', 'lead', $3) returning id`,
    [tenantId, conversationId, `Synthetic ${suffix}`],
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 4 RPC suite could not reach Postgres at ${DB_URL}. ` +
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
    insert into public.tenants (id, slug, name, billing_contact_email, is_demo) values
      ('${TENANT_A}', 'phase4-rpc-a', 'Phase 4 RPC A', 'a@phase4-rpc.test', false),
      ('${TENANT_B}', 'phase4-rpc-b', 'Phase 4 RPC B', 'b@phase4-rpc.test', false),
      ('${TENANT_DEMO}', 'phase4-rpc-demo', 'Phase 4 RPC Demo', 'demo@phase4-rpc.test', true);
    insert into public.users (id, email, role, tenant_id) values
      ('${COACH_A}', 'coach-a@phase4-rpc.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@phase4-rpc.test', 'coach', '${TENANT_B}');
    insert into public.ghl_installs
      (id, tenant_id, location_id, company_id, token_expires_at)
      values ('${GHL_INSTALL_A}', '${TENANT_A}', '${GHL_LOCATION_A}',
        'phase4-rpc-ghl-company', now() + interval '1 hour');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("Phase 4 RPC catalog", () => {
  it("exposes the account-bound service entrypoint and disables the legacy inbound signature", async () => {
    const result = await db.query<{
      signature: string;
      security_definer: boolean;
      config: string[];
      authenticated: boolean;
      service_role: boolean;
    }>(`
      select p.oid::regprocedure::text as signature,
        p.prosecdef as security_definer, coalesce(p.proconfig, '{}') as config,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
        has_function_privilege('service_role', p.oid, 'execute') as service_role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
      order by signature
    `, [[
      "persist_inbound_message",
      "switch_channel_provider",
      "merge_contacts",
      "unmerge_contact",
      "submit_message_template",
    ]]);
    expect(result.rows.map((row) => row.signature)).toEqual([
      "merge_contacts(uuid,uuid,uuid,text,text,uuid,text,text)",
      "persist_inbound_message(uuid,channel_provider,messaging_channel,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,text,text,text,jsonb,text)",
      "persist_inbound_message(uuid,channel_provider,messaging_channel,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text)",
      "persist_inbound_message(uuid,channel_provider,messaging_channel,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text)",
      "submit_message_template(uuid,messaging_channel,channel_provider,text,text,text,text,text,jsonb,uuid,text)",
      "switch_channel_provider(uuid,messaging_channel,uuid,uuid,jsonb,uuid,text,text)",
      "unmerge_contact(uuid,bigint,uuid,text,text)",
    ]);
    expect(result.rows.every((row) => row.security_definer)).toBe(true);
    expect(result.rows.every((row) => row.config.includes("search_path=\"\""))).toBe(true);
    const legacyInbound = result.rows.find((row) =>
      row.signature === "persist_inbound_message(uuid,channel_provider,messaging_channel,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text)",
    );
    const accountBoundInbound = result.rows.find((row) =>
      row.signature === "persist_inbound_message(uuid,channel_provider,messaging_channel,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text)",
    );
    expect(legacyInbound).toMatchObject({ authenticated: false, service_role: false });
    expect(accountBoundInbound).toMatchObject({ authenticated: false, service_role: true });
    expect(result.rows.filter((row) => row !== legacyInbound)
      .every((row) => !row.authenticated && row.service_role)).toBe(true);
  });

  it("refuses a cross-tenant human actor before any privileged mutation", async () => {
    await db.query("savepoint cross_tenant_actor");
    await expect(
      db.query(
        `select * from public.submit_message_template(
          $1, 'whatsapp', 'meta_direct', 'provider-template', 'template-name', 'utility',
          'en_US', 'Synthetic body', '[]'::jsonb, $2, 'cross-tenant'
        )`,
        [TENANT_A, COACH_B],
      ),
    ).rejects.toThrow(/PHASE4_ACTOR_NOT_AUTHORIZED/);
    await db.query("rollback to savepoint cross_tenant_actor");
    const rows = await db.query<{ count: string }>(
      "select count(*)::text from public.message_templates where tenant_id = $1",
      [TENANT_A],
    );
    expect(rows.rows[0].count).toBe("0");
  });
});

describe("inbound identity and provider window", () => {
  it("persists mandatory Meta identity, message, and both window mirrors atomically", async () => {
    const args = [
      TENANT_A,
      "meta-lead-1",
      "+15550000001",
      "lead@example.test",
      "meta-message-1",
      "Synthetic inbound",
      "Synthetic Lead",
      "2026-08-17T12:00:00Z",
      "2026-08-18T12:00:00Z",
    ];
    const first = await db.query<{
      contact_id: string;
      conversation_id: string;
      message_id: string;
      message_inserted: boolean;
      provider_window_expires_at: Date;
    }>(
      `select * from public.persist_inbound_message(
        $1, 'meta_direct', 'instagram', $2, $3, $4, $5, $6, $7,
        $8::timestamptz, $9::timestamptz, 'provider'
      )`,
      args,
    );
    const replay = await db.query<{ message_inserted: boolean; message_id: string }>(
      `select * from public.persist_inbound_message(
        $1, 'meta_direct', 'instagram', $2, $3, $4, $5, $6, $7,
        $8::timestamptz, $9::timestamptz, 'provider'
      )`,
      args,
    );
    expect(first.rows[0].message_inserted).toBe(true);
    expect(replay.rows[0]).toMatchObject({
      message_inserted: false,
      message_id: first.rows[0].message_id,
    });

    const stored = await db.query<{
      identity_window: Date;
      conversation_window: Date;
      messages: string;
    }>(`
      select identity.provider_window_expires_at as identity_window,
        conversation.provider_window_expires_at as conversation_window,
        (select count(*)::text from public.messages
         where tenant_id = '${TENANT_A}' and provider_message_id = 'meta-message-1') as messages
      from public.contact_identities identity
      join public.conversations conversation on conversation.id = '${first.rows[0].conversation_id}'
      where identity.contact_id = '${first.rows[0].contact_id}'
    `);
    expect(stored.rows[0].identity_window.toISOString()).toBe("2026-08-18T12:00:00.000Z");
    expect(stored.rows[0].conversation_window.toISOString()).toBe("2026-08-18T12:00:00.000Z");
    expect(stored.rows[0].messages).toBe("1");
  });

  it("rejects an empty identity and keeps durable GHL channels independent of a window", async () => {
    await db.query("savepoint missing_identity");
    await expect(
      db.query(`select * from public.persist_inbound_message(
        '${TENANT_A}', 'meta_direct', 'instagram', ' ', null, null, 'message-empty',
        'Synthetic', null, now(), now() + interval '24 hours', 'provider'
      )`),
    ).rejects.toThrow(/INBOUND_REQUIRED_FIELD_MISSING/);
    await db.query("rollback to savepoint missing_identity");

    const durable = await db.query<{
      contact_id: string;
      provider_window_expires_at: Date | null;
    }>(`
      select * from public.persist_inbound_message(
        '${TENANT_A}', 'ghl', 'sms', 'ghl-lead', '${GHL_LOCATION_A}', '+15550000002', null,
        'ghl-message', 'Synthetic durable inbound', null, null, null, null
      )
    `);
    expect(durable.rows[0].provider_window_expires_at).toBeNull();

    await db.query("update public.contacts set last_seen_at = null where id = $1", [
      durable.rows[0].contact_id,
    ]);
    await db.query(`
      select * from public.persist_inbound_message(
        '${TENANT_A}', 'ghl', 'sms', 'ghl-lead', '${GHL_LOCATION_A}', '+15550000002', null,
        'ghl-message-2', 'Second durable inbound', null, null, null, null
      )
    `);
    const contact = await db.query<{ last_seen_at: Date | null }>(
      "select last_seen_at from public.contacts where id = $1",
      [durable.rows[0].contact_id],
    );
    expect(contact.rows[0].last_seen_at).toBeInstanceOf(Date);
  });
});

describe("provider cutover", () => {
  it("changes zero rows on partial coverage and switches atomically on complete backfill", async () => {
    const contactA = await contact(TENANT_A, "Cutover A");
    const contactB = await contact(TENANT_A, "Cutover B");
    const conversationA = await conversation(TENANT_A, contactA);
    const conversationB = await conversation(TENANT_A, contactB);
    await message(TENANT_A, conversationA, "cutover-a");
    await message(TENANT_A, conversationB, "cutover-b");
    await db.query(
      `insert into public.contact_identities
        (tenant_id, contact_id, provider, channel, provider_identity_id, provider_account_id, ghl_install_id)
       values
        ($1, $2, 'ghl', 'instagram', 'ghl-a', $4, $5),
        ($1, $3, 'ghl', 'instagram', 'ghl-b', $4, $5)`,
      [TENANT_A, contactA, contactB, GHL_LOCATION_A, GHL_INSTALL_A],
    );
    const receipt = await db.query<{ id: string }>(`
      insert into public.webhook_events
        (provider, provider_event_id, tenant_id, signature_verified, payload)
      values ('meta', 'phase4-switch-receipt', '${TENANT_A}', true, '{}') returning id
    `);
    const outbound = await db.query<{ id: string }>(
      `insert into public.messages (tenant_id, conversation_id, direction, author, body)
       values ($1, $2, 'out', 'agent', 'Synthetic round trip') returning id`,
      [TENANT_A, conversationA],
    );
    const connections = await db.query<{ id: string; provider: string }>(
      `insert into public.channel_connections (
         tenant_id, channel, provider, state, external_account_id, asset_verified_at,
         webhook_subscribed_at, signed_round_trip_at, last_signed_inbound_receipt_id,
         last_signed_outbound_message_id
       ) values
         ($1, 'instagram', 'ghl', 'live', '${GHL_LOCATION_A}', null, null, null, null, null),
         ($1, 'instagram', 'meta_direct', 'ready', 'meta-account', now(), now(), now(), $2, $3)
       returning id, provider`,
      [TENANT_A, receipt.rows[0].id, outbound.rows[0].id],
    );
    const outgoing = connections.rows.find((row) => row.provider === "ghl")!.id;
    const incoming = connections.rows.find((row) => row.provider === "meta_direct")!.id;
    const partial = [{ contactId: contactA, outgoingExternalId: "ghl-a", incomingExternalId: "meta-a" }];

    await db.query("savepoint partial_switch");
    await expect(
      db.query(
        `select * from public.switch_channel_provider(
          $1, 'instagram', $2, $3, $4::jsonb, $5, 'Synthetic cutover', 'partial'
        )`,
        [TENANT_A, outgoing, incoming, JSON.stringify(partial), COACH_A],
      ),
    ).rejects.toThrow(/IDENTITY_BACKFILL_REQUIRED/);
    await db.query("rollback to savepoint partial_switch");
    const unchanged = await db.query<{ provider: string; state: string }>(
      `select provider::text, state::text from public.channel_connections
       where id = any($1::uuid[]) order by provider`,
      [[outgoing, incoming]],
    );
    expect(unchanged.rows).toEqual([
      { provider: "ghl", state: "live" },
      { provider: "meta_direct", state: "ready" },
    ]);
    expect((await db.query(
      "select count(*)::text as count from public.channel_operation_receipts where idempotency_key = 'partial'",
    )).rows[0].count).toBe("0");

    const complete = [
      ...partial,
      { contactId: contactB, outgoingExternalId: "ghl-b", incomingExternalId: "meta-b" },
    ];
    const switched = await db.query<{ applied_identity_count: number; audit_id: string }>(
      `select * from public.switch_channel_provider(
        $1, 'instagram', $2, $3, $4::jsonb, $5, 'Synthetic cutover', 'complete'
      )`,
      [TENANT_A, outgoing, incoming, JSON.stringify(complete), COACH_A],
    );
    const replay = await db.query<{ applied_identity_count: number; audit_id: string }>(
      `select * from public.switch_channel_provider(
        $1, 'instagram', $2, $3, $4::jsonb, $5, 'Synthetic cutover', 'complete'
      )`,
      [TENANT_A, outgoing, incoming, JSON.stringify(complete), COACH_A],
    );
    expect(switched.rows[0].applied_identity_count).toBe(2);
    expect(replay.rows[0]).toEqual(switched.rows[0]);

    const proof = await db.query<{
      live: string;
      incoming_identities: string;
      conversation_contacts: string[];
      messages: string;
      audits: string;
    }>(`
      select
        (select provider::text from public.channel_connections
         where tenant_id = '${TENANT_A}' and channel = 'instagram' and state = 'live') as live,
        (select count(*)::text from public.contact_identities
         where tenant_id = '${TENANT_A}' and provider = 'meta_direct') as incoming_identities,
        (select array_agg(contact_id::text order by contact_id) from public.conversations
         where id = any(array['${conversationA}'::uuid, '${conversationB}'::uuid])) as conversation_contacts,
        (select count(*)::text from public.messages
         where conversation_id = any(array['${conversationA}'::uuid, '${conversationB}'::uuid])) as messages,
        (select count(*)::text from public.audit_log
         where action = 'channel.provider.switched' and tenant_id = '${TENANT_A}') as audits
    `);
    expect(proof.rows[0]).toEqual({
      live: "meta_direct",
      incoming_identities: "2",
      conversation_contacts: [contactA, contactB].sort(),
      messages: "3",
      audits: "1",
    });
  });
});

describe("contact merge and undo", () => {
  it("applies safe precedence, captures the full before-image, and restores exactly", async () => {
    const winner = await contact(TENANT_A, "Winner", {
      creditRange: "640–680",
      fundingGoal: "$50K–100K",
      outcome: "BOOK",
      updatedAt: "2026-08-17T10:00:00Z",
    });
    const loser = await contact(TENANT_A, "Loser", {
      optedOut: true,
      creditRange: "700+",
      fundingGoal: null,
      outcome: "SOFT_DQ",
      updatedAt: "2026-08-17T11:00:00Z",
    });
    const loserConversation = await conversation(TENANT_A, loser);
    const untouchedMessage = await message(TENANT_A, loserConversation, "merge-message");
    const loserIdentity = await db.query<{ id: string }>(
      `insert into public.contact_identities
        (tenant_id, contact_id, provider, channel, provider_identity_id)
       values ($1, $2, 'meta_direct', 'instagram', 'merge-identity') returning id`,
      [TENANT_A, loser],
    );
    const candidate = await db.query<{ id: string }>(
      `insert into public.contact_duplicate_candidates
        (tenant_id, contact_a_id, contact_b_id, source, evidence_key)
       values ($1, least($2::uuid, $3::uuid), greatest($2::uuid, $3::uuid),
         'field_match', 'synthetic-match') returning id`,
      [TENANT_A, winner, loser],
    );
    const appointment = await db.query<{ id: string }>(
      `insert into public.appointments
        (tenant_id, contact_id, conversation_id, provider, external_id, start_at, end_at)
       values ($1, $2, $3, 'ghl', 'merge-appointment', now() + interval '1 day',
         now() + interval '1 day 30 minutes') returning id`,
      [TENANT_A, loser, loserConversation],
    );
    const meter = await db.query<{ id: string }>(
      `insert into public.billable_events (tenant_id, appointment_id, quantity)
       values ($1, $2, 1) returning id`,
      [TENANT_A, appointment.rows[0].id],
    );

    const merged = await db.query<{
      merge_audit_id: string;
      moved_identity_count: number;
      moved_conversation_count: number;
    }>(
      `select * from public.merge_contacts(
        $1, $2, $3, 'human_asserted', $4, $5, 'Synthetic reviewed merge', 'merge-1'
      )`,
      [TENANT_A, winner, loser, candidate.rows[0].id, COACH_A],
    );
    expect(merged.rows[0]).toMatchObject({
      moved_identity_count: 1,
      moved_conversation_count: 1,
    });
    const afterMerge = await db.query<{
      opted_out: boolean;
      credit_range: string;
      funding_goal: string;
      outcome: string;
      merged_into_contact_id: string;
      merge_audit_id: string;
      identity_contact: string;
      conversation_contact: string;
      message_conversation: string;
      appointment_contact: string;
      meter_appointment: string;
      snapshot_complete: boolean;
      candidate_state: string;
    }>(`
      select winner.opted_out, winner.credit_range::text, winner.funding_goal::text,
        winner.outcome::text, loser.merged_into_contact_id, loser.merge_audit_id,
        identity.contact_id as identity_contact, conversation.contact_id as conversation_contact,
        message.conversation_id as message_conversation,
        appointment.contact_id as appointment_contact,
        meter.appointment_id as meter_appointment,
        (snapshot.prior_payload #> '{winner}' ? 'id'
          and snapshot.prior_payload #> '{loser}' ? 'id'
          and jsonb_array_length(snapshot.prior_payload #> '{identities}') = 1
          and jsonb_array_length(snapshot.prior_payload #> '{conversations}') = 1) as snapshot_complete,
        candidate.state as candidate_state
      from public.contacts winner
      join public.contacts loser on loser.id = '${loser}'
      join public.contact_identities identity on identity.id = '${loserIdentity.rows[0].id}'
      join public.conversations conversation on conversation.id = '${loserConversation}'
      join public.messages message on message.id = '${untouchedMessage}'
      join public.appointments appointment on appointment.id = '${appointment.rows[0].id}'
      join public.billable_events meter on meter.id = '${meter.rows[0].id}'
      join public.contact_merge_snapshots snapshot
        on snapshot.merge_audit_id = ${merged.rows[0].merge_audit_id}
      join public.contact_duplicate_candidates candidate on candidate.id = '${candidate.rows[0].id}'
      where winner.id = '${winner}'
    `);
    expect(afterMerge.rows[0]).toEqual({
      opted_out: true,
      credit_range: "700+",
      funding_goal: "$50K–100K",
      outcome: "BOOK",
      merged_into_contact_id: winner,
      merge_audit_id: merged.rows[0].merge_audit_id,
      identity_contact: winner,
      conversation_contact: winner,
      message_conversation: loserConversation,
      appointment_contact: loser,
      meter_appointment: appointment.rows[0].id,
      snapshot_complete: true,
      candidate_state: "merged",
    });

    const undone = await db.query<{
      restored_identity_count: number;
      restored_conversation_count: number;
    }>(
      `select * from public.unmerge_contact($1, $2, $3, 'Synthetic undo', 'undo-1')`,
      [TENANT_A, merged.rows[0].merge_audit_id, COACH_A],
    );
    expect(undone.rows[0]).toMatchObject({
      restored_identity_count: 1,
      restored_conversation_count: 1,
    });
    const restored = await db.query<{
      winner_opted_out: boolean;
      winner_credit: string;
      winner_outcome: string;
      loser_merged: string | null;
      identity_contact: string;
      conversation_contact: string;
      candidate_state: string;
      unmerge_audits: string;
    }>(`
      select winner.opted_out as winner_opted_out, winner.credit_range::text as winner_credit,
        winner.outcome::text as winner_outcome, loser.merged_into_contact_id as loser_merged,
        identity.contact_id as identity_contact, conversation.contact_id as conversation_contact,
        candidate.state as candidate_state,
        (select count(*)::text from public.audit_log where action = 'contact.unmerged'
          and payload ->> 'mergeAuditId' = '${merged.rows[0].merge_audit_id}') as unmerge_audits
      from public.contacts winner
      join public.contacts loser on loser.id = '${loser}'
      join public.contact_identities identity on identity.id = '${loserIdentity.rows[0].id}'
      join public.conversations conversation on conversation.id = '${loserConversation}'
      join public.contact_duplicate_candidates candidate on candidate.id = '${candidate.rows[0].id}'
      where winner.id = '${winner}'
    `);
    expect(restored.rows[0]).toEqual({
      winner_opted_out: false,
      winner_credit: "640–680",
      winner_outcome: "BOOK",
      loser_merged: null,
      identity_contact: loser,
      conversation_contact: loser,
      candidate_state: "open",
      unmerge_audits: "1",
    });
  });

  it("refuses test-to-real merges and rejects an idempotency payload mismatch", async () => {
    const real = await contact(TENANT_A, "Real");
    const test = await contact(TENANT_A, "Test", { isTest: true });
    await db.query("set local session_replication_role = replica");
    await db.query("update public.contacts set is_test = true where id = $1", [test]);
    await db.query("set local session_replication_role = origin");
    await db.query("savepoint test_boundary");
    await expect(
      db.query(
        `select * from public.merge_contacts(
          $1, $2, $3, 'human_asserted', null, $4, 'Synthetic mismatch', 'test-mismatch'
        )`,
        [TENANT_A, real, test, COACH_A],
      ),
    ).rejects.toThrow(/CONTACT_MERGE_TEST_MISMATCH/);
    await db.query("rollback to savepoint test_boundary");

    const other = await contact(TENANT_A, "Other");
    await db.query("update public.contacts set outcome = 'HARD_DQ' where id = $1", [real]);
    await db.query("update public.contacts set outcome = 'SOFT_DQ' where id = $1", [other]);
    await db.query(
      `select * from public.merge_contacts(
        $1, $2, $3, 'human_asserted', null, $4, 'Synthetic merge', 'replay-key'
      )`,
      [TENANT_A, real, other, COACH_A],
    );
    expect((await db.query(
      "select outcome::text from public.contacts where id = $1",
      [real],
    )).rows[0].outcome).toBe("SOFT_DQ");
    await db.query("savepoint replay_mismatch");
    await expect(
      db.query(
        `select * from public.merge_contacts(
          $1, $2, $3, 'human_asserted', null, $4, 'Changed reason', 'replay-key'
        )`,
        [TENANT_A, real, other, COACH_A],
      ),
    ).rejects.toThrow(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    await db.query("rollback to savepoint replay_mismatch");
  });

  it("refuses an undo when a moved identity no longer matches the merge snapshot", async () => {
    const winner = await contact(TENANT_A, "Conflict winner");
    const loser = await contact(TENANT_A, "Conflict loser");
    const third = await contact(TENANT_A, "Conflict third");
    const identity = await db.query<{ id: string }>(
      `insert into public.contact_identities
        (tenant_id, contact_id, provider, channel, provider_identity_id)
       values ($1, $2, 'meta_direct', 'instagram', 'conflict-identity') returning id`,
      [TENANT_A, loser],
    );
    const merged = await db.query<{ merge_audit_id: string }>(
      `select * from public.merge_contacts(
        $1, $2, $3, 'human_asserted', null, $4, 'Synthetic conflict merge', 'conflict-merge'
      )`,
      [TENANT_A, winner, loser, COACH_A],
    );
    await db.query(
      "update public.contact_identities set contact_id = $1 where id = $2",
      [third, identity.rows[0].id],
    );
    await db.query("savepoint conflict_undo");
    await expect(
      db.query(
        "select * from public.unmerge_contact($1, $2, $3, 'Synthetic conflict undo', 'conflict-undo')",
        [TENANT_A, merged.rows[0].merge_audit_id, COACH_A],
      ),
    ).rejects.toThrow(/CONTACT_UNMERGE_IDENTITY_CONFLICT/);
    await db.query("rollback to savepoint conflict_undo");
    expect((await db.query(
      "select merged_into_contact_id from public.contacts where id = $1",
      [loser],
    )).rows[0].merged_into_contact_id).toBe(winner);
  });
});

describe("message template submission", () => {
  it("persists submitted lifecycle only and cannot accept client-forged approval", async () => {
    const submitted = await db.query<{ template_id: string; status: string; audit_id: string }>(
      `select * from public.submit_message_template(
        $1, 'whatsapp', 'meta_direct', 'provider-template-1', 'synthetic_template',
        'utility', 'en_US', 'Synthetic template body', '[{"name":"first_name"}]'::jsonb,
        $2, 'template-1'
      )`,
      [TENANT_A, COACH_A],
    );
    const stored = await db.query<{
      status: string;
      approved_at: Date | null;
      audits: string;
      status_argument: boolean;
    }>(`
      select template.status, template.approved_at,
        (select count(*)::text from public.audit_log
         where id = ${submitted.rows[0].audit_id} and action = 'message_template.submitted') as audits,
        exists (
          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'submit_message_template'
            and pg_get_function_arguments(p.oid) ~ '(^|, )p_status '
        ) as status_argument
      from public.message_templates template where id = '${submitted.rows[0].template_id}'
    `);
    expect(submitted.rows[0].status).toBe("submitted");
    expect(stored.rows[0]).toEqual({
      status: "submitted",
      approved_at: null,
      audits: "1",
      status_argument: false,
    });
  });

  it("requires explicit synthetic placeholders for demo lifecycle rows", async () => {
    await db.query("savepoint demo_copy");
    await expect(
      db.query(
        `select * from public.submit_message_template(
          $1, 'whatsapp', 'meta_direct', 'demo-provider-1', 'ordinary_name', 'utility',
          'en_US', 'Ordinary body', '[]'::jsonb, $2, 'demo-bad'
        )`,
        [TENANT_DEMO, COACH_A],
      ),
    ).rejects.toThrow(/PHASE4_ACTOR_NOT_AUTHORIZED/);
    await db.query("rollback to savepoint demo_copy");

    await db.query("update public.users set tenant_id = $1 where id = $2", [TENANT_DEMO, COACH_A]);
    await db.query("savepoint demo_placeholder");
    await expect(
      db.query(
        `select * from public.submit_message_template(
          $1, 'whatsapp', 'meta_direct', 'demo-provider-1', 'ordinary_name', 'utility',
          'en_US', 'Ordinary body', '[]'::jsonb, $2, 'demo-bad'
        )`,
        [TENANT_DEMO, COACH_A],
      ),
    ).rejects.toThrow(/DEMO_TEMPLATE_PLACEHOLDER_REQUIRED/);
    await db.query("rollback to savepoint demo_placeholder");

    const demo = await db.query<{ template_id: string }>(
      `select * from public.submit_message_template(
        $1, 'whatsapp', 'meta_direct', 'demo-provider-2',
        'SETTERFI_DEMO_PLACEHOLDER_UTILITY', 'utility', 'en_US',
        'SETTERFI_DEMO_PLACEHOLDER_BODY', '[]'::jsonb, $2, 'demo-good'
      )`,
      [TENANT_DEMO, COACH_A],
    );
    expect((await db.query(
      "select is_demo from public.message_templates where id = $1",
      [demo.rows[0].template_id],
    )).rows[0].is_demo).toBe(true);
  });
});
