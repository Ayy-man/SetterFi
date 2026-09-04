import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "13000000-0000-4000-8000-000000000010";
const TENANT_B = "13000000-0000-4000-8000-000000000020";
const COACH_A = "23000000-0000-4000-8000-000000000010";
const COACH_B = "23000000-0000-4000-8000-000000000020";

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email, is_demo) values
      ('${TENANT_A}', 'phase13-a', 'Phase 13 A', 'a@phase13.test', false),
      ('${TENANT_B}', 'phase13-b', 'Phase 13 B', 'b@phase13.test', false);
    insert into public.users (id, email, role, tenant_id) values
      ('${COACH_A}', 'coach-a@phase13.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@phase13.test', 'coach', '${TENANT_B}');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("Phase 13 schema custody", () => {
  it("forces RLS on every new tenant table", async () => {
    const result = await db.query<{ relname: string; forced: boolean }>(`
      select c.relname, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = any($1::text[])
      order by c.relname
    `, [["keyword_goals", "capi_datasets", "capi_events"]]);
    expect(result.rows).toEqual([
      { relname: "capi_datasets", forced: true },
      { relname: "capi_events", forced: true },
      { relname: "keyword_goals", forced: true },
    ]);
  });

  it("keeps all writes RPC-only and the outbox service-only", async () => {
    const grants = await db.query<{ grantee: string; table_name: string; privileges: string[] }>(`
      select grantee, table_name, array_agg(privilege_type::text order by privilege_type::text) privileges
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = any($1::text[])
        and grantee in ('authenticated', 'service_role')
      group by grantee, table_name order by grantee, table_name
    `, [["keyword_goals", "capi_datasets", "capi_events"]]);
    expect(grants.rows).toEqual([
      { grantee: "authenticated", table_name: "capi_datasets", privileges: ["SELECT"] },
      { grantee: "authenticated", table_name: "keyword_goals", privileges: ["SELECT"] },
      { grantee: "service_role", table_name: "capi_datasets", privileges: ["SELECT"] },
      { grantee: "service_role", table_name: "keyword_goals", privileges: ["SELECT"] },
    ]);
  });

  it("enforces normalized uniqueness, goal shape, HTTPS links, and bounded copy", async () => {
    await db.query(`
      insert into public.keyword_goals
        (tenant_id, keyword, goal, resource_url, created_by, updated_by)
      values ('${TENANT_A}', ' Funding ', 'resource', 'https://example.com/guide', '${COACH_A}', '${COACH_A}')
    `);
    await db.query("savepoint duplicate_keyword");
    await expect(db.query(`
      insert into public.keyword_goals
        (tenant_id, keyword, goal, resource_url, created_by, updated_by)
      values ('${TENANT_A}', 'funding', 'resource', 'https://example.com/other', '${COACH_A}', '${COACH_A}')
    `)).rejects.toThrow(/keyword_goals_tenant_normalized_keyword_key/);
    await db.query("rollback to savepoint duplicate_keyword");
    await db.query("savepoint missing_resource_link");
    await expect(db.query(`
      insert into public.keyword_goals
        (tenant_id, keyword, goal, created_by, updated_by)
      values ('${TENANT_A}', 'missing-link', 'resource', '${COACH_A}', '${COACH_A}')
    `)).rejects.toThrow(/keyword_goals_goal_shape_chk/);
    await db.query("rollback to savepoint missing_resource_link");
    await db.query("savepoint unsafe_post_booking_link");
    await expect(db.query(`
      insert into public.keyword_goals
        (tenant_id, keyword, goal, post_booking_url, created_by, updated_by)
      values ('${TENANT_A}', 'unsafe-link', 'book', 'http://example.com', '${COACH_A}', '${COACH_A}')
    `)).rejects.toThrow(/keyword_goals_post_booking_url_chk/);
    await db.query("rollback to savepoint unsafe_post_booking_link");
  });

  it("accepts only fixed events and coherent retry, value, and test/demo shapes", async () => {
    const contact = await db.query<{ id: string }>(`
      insert into public.contacts (tenant_id, last_channel, is_test)
      values ('${TENANT_A}', 'messenger', false) returning id
    `);
    const conversation = await db.query<{ id: string }>(`
      insert into public.conversations (tenant_id, contact_id, channel)
      values ('${TENANT_A}', '${contact.rows[0].id}', 'messenger') returning id
    `);
    await db.query("savepoint unknown_event_name");
    await expect(db.query(`
      insert into public.capi_events
        (tenant_id, conversation_id, channel, event_name, dedup_key, event_time)
      values ('${TENANT_A}', '${conversation.rows[0].id}', 'messenger', 'Schedule',
        '${conversation.rows[0].id}:Schedule', now())
    `)).rejects.toThrow(/capi_events_event_name_chk/);
    await db.query("rollback to savepoint unknown_event_name");
    await db.query("savepoint currency_without_value");
    await expect(db.query(`
      insert into public.capi_events
        (tenant_id, conversation_id, channel, event_name, dedup_key, event_time, currency)
      values ('${TENANT_A}', '${conversation.rows[0].id}', 'messenger', 'QualifiedLead',
        '${conversation.rows[0].id}:QualifiedLead', now(), 'USD')
    `)).rejects.toThrow(/capi_events_value_shape_chk/);
    await db.query("rollback to savepoint currency_without_value");
    await db.query("savepoint test_event_left_sendable");
    await expect(db.query(`
      insert into public.capi_events
        (tenant_id, conversation_id, channel, event_name, dedup_key, event_time, is_test, status)
      values ('${TENANT_A}', '${conversation.rows[0].id}', 'messenger', 'QualifiedLead',
        '${conversation.rows[0].id}:QualifiedLead', now(), true, 'pending')
    `)).rejects.toThrow(/capi_events_test_demo_status_chk/);
    await db.query("rollback to savepoint test_event_left_sendable");
  });

  it("counts exact attributed conversations and reports the whole-population keyword table", async () => {
    const funding = await db.query<{ keyword_goal_id: string }>(`
      select keyword_goal_id::text from public.save_keyword_goal(
        $1, $2, null, 'FUNDING', 'book', null, null, null, null
      )
    `, [TENANT_A, COACH_A]);
    const referral = await db.query<{ keyword_goal_id: string }>(`
      select keyword_goal_id::text from public.save_keyword_goal(
        $1, $2, null, 'REFERRAL', 'book', null, null, null, null
      )
    `, [TENANT_A, COACH_A]);

    async function conversation(input: { goalId?: string; keyword?: string }) {
      const contact = await db.query<{ id: string }>(`
        insert into public.contacts (tenant_id, last_channel)
        values ($1, 'messenger') returning id::text
      `, [TENANT_A]);
      const result = await db.query<{ id: string }>(`
        insert into public.conversations
          (tenant_id, contact_id, channel, keyword_goal_id, first_touch_keyword)
        values ($1, $2, 'messenger', $3, $4) returning id::text
      `, [TENANT_A, contact.rows[0].id, input.goalId ?? null, input.keyword ?? null]);
      return { contactId: contact.rows[0].id, conversationId: result.rows[0].id };
    }

    const qualifiedAndBooked = await conversation({
      goalId: funding.rows[0].keyword_goal_id, keyword: "FUNDING",
    });
    const optInOnly = await conversation({
      goalId: referral.rows[0].keyword_goal_id, keyword: "REFERRAL",
    });
    const unattributed = await conversation({});
    const stray = await conversation({ keyword: "STRAY" });
    const appointment = await db.query<{ id: string }>(`
      insert into public.appointments
        (tenant_id, contact_id, conversation_id, provider, external_id, start_at, end_at, timezone)
      values ($1, $2, $3, 'ghl', 'phase13-kpi-booking', now() + interval '1 day',
        now() + interval '1 day 30 minutes', 'America/New_York') returning id::text
    `, [TENANT_A, qualifiedAndBooked.contactId, qualifiedAndBooked.conversationId]);

    await db.query(`
      insert into public.capi_events
        (tenant_id, conversation_id, channel, event_name, dedup_key, event_time)
      values
        ($1, $2::uuid, 'messenger', 'QualifiedLead', $2::uuid::text || ':QualifiedLead', now()),
        ($1, $3::uuid, 'messenger', 'QualifiedLead', $3::uuid::text || ':QualifiedLead', now())
    `, [TENANT_A, qualifiedAndBooked.conversationId, unattributed.conversationId]);
    await db.query(`
      insert into public.capi_events
        (tenant_id, conversation_id, channel, appointment_id, event_name, dedup_key, event_time)
      values ($1, $2::uuid, 'messenger', $3, 'Purchase', $2::uuid::text || ':Purchase', now())
    `, [TENANT_A, qualifiedAndBooked.conversationId, appointment.rows[0].id]);

    // Editing configuration must not rewrite the immutable first-touch label on old conversations.
    await db.query(`select * from public.save_keyword_goal(
      $1, $2, $3, 'CAPITAL', 'book', null, null, null, null
    )`, [TENANT_A, COACH_A, funding.rows[0].keyword_goal_id]);

    const measurement = await db.query<{ snapshot: {
      keywords: Array<Record<string, unknown>>;
      keywordConversationTotal: number;
      metrics: Array<{ metricKey: string; value: number }>;
    } }>(`
      select public.read_coach_measurement_for_actor(
        $1, $2, 'all', null, null, now()
      ) snapshot
    `, [COACH_A, TENANT_A]);
    // Round 3 (docs/plans/2026-09-04-coach-backend-gaps.md, "Round 3 intake"): the `keywords`
    // table is the whole population grouped by first-touch keyword, "No keyword" row last, with
    // the phase 13 CAPI-attributed figures kept for keywords that carry an active goal. FUNDING
    // and REFERRAL keep their goal-attributed figures (CAPI events, not pipeline stage); STRAY and
    // "No keyword" are population-only rows with no CAPI attribution behind them.
    expect(measurement.rows[0].snapshot.keywords).toEqual([
      expect.objectContaining({
        keyword: "FUNDING", conversations: 1, senderCount: 1,
        qualifiedContacts: 1, bookedContacts: 1,
      }),
      expect.objectContaining({
        keyword: "REFERRAL", conversations: 1, senderCount: 1,
        qualifiedContacts: 0, bookedContacts: 0,
      }),
      expect.objectContaining({
        keyword: "STRAY", conversations: 1, senderCount: 1,
        qualifiedContacts: 0, bookedContacts: 0,
      }),
      expect.objectContaining({
        keyword: "No keyword", conversations: 1, senderCount: 1,
        qualifiedContacts: 0, bookedContacts: 0,
      }),
    ]);
    // The renamed keyword goal must not rewrite the immutable first-touch label on old
    // conversations: FUNDING's conversation stays keyed as FUNDING, not CAPITAL.
    expect(measurement.rows[0].snapshot.keywords).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "CAPITAL" }),
    ]));
    // Every row carries a distinct-sender count, the whole-population row set sums to the window's
    // four conversations, and the "coach.keyword.conversations" metric tile stays scoped to
    // goal-attributed conversations (FUNDING + REFERRAL only) -- a deliberately different number
    // from the table's own total, per the round 3 ruling.
    expect(measurement.rows[0].snapshot.keywords.every(
      (row) => typeof row.senderCount === "number",
    )).toBe(true);
    expect(measurement.rows[0].snapshot.keywordConversationTotal).toBe(4);
    expect(measurement.rows[0].snapshot.metrics.find(
      (metric) => metric.metricKey === "coach.keyword.conversations",
    )?.value).toBe(2);

    // Keep the variable live in the test: the second attributed conversation owns the denominator
    // even without either conversion event.
    expect(optInOnly.conversationId).toBeTruthy();
    expect(stray.conversationId).toBeTruthy();
  });

  it("provisions one tenant-bound dataset with a safe receipt and atomic human audit", async () => {
    const connection = await db.query<{ id: string }>(`
      insert into public.channel_connections
        (tenant_id, channel, provider, state, external_account_id, external_ref)
      values ('${TENANT_A}', 'messenger', 'meta_direct', 'ready', 'page-1', '{}'::jsonb)
      returning id::text
    `);
    const receipt = {
      provider: "meta",
      mode: "real",
      operation: "get_or_create",
      receiptId: "trace-1",
      accepted: true,
    };
    const provisioned = await db.query<{
      dataset_row_id: string;
      tenant_id: string;
      dataset_id: string;
      is_mock: boolean;
      audit_id: string;
    }>(`
      select dataset_row_id::text, tenant_id::text, dataset_id, is_mock, audit_id::text
      from public.provision_capi_dataset(
        $1, $2, 'messenger', $3, 'page-1', 'dataset-1', $4::jsonb, false,
        '2026-09-01T10:00:00Z'
      )
    `, [TENANT_A, COACH_A, connection.rows[0].id, JSON.stringify(receipt)]);
    expect(provisioned.rows).toEqual([expect.objectContaining({
      tenant_id: TENANT_A,
      dataset_id: "dataset-1",
      is_mock: false,
    })]);
    const audit = await db.query(`
      select action, actor_id::text, tenant_id::text, payload
      from public.audit_log where id = $1
    `, [provisioned.rows[0].audit_id]);
    expect(audit.rows).toEqual([expect.objectContaining({
      action: "capi.dataset.provisioned",
      actor_id: COACH_A,
      tenant_id: TENANT_A,
      payload: expect.objectContaining({
        channel: "messenger",
        datasetId: "dataset-1",
        providerMode: "real",
        receiptId: "trace-1",
      }),
    })]);
    expect(JSON.stringify(audit.rows)).not.toMatch(/token|credential|secret/i);

    const replay = await db.query<{ dataset_row_id: string }>(`
      select dataset_row_id::text from public.provision_capi_dataset(
        $1, $2, 'messenger', $3, 'page-1', 'dataset-1', $4::jsonb, false,
        '2026-09-01T10:01:00Z'
      )
    `, [TENANT_A, COACH_A, connection.rows[0].id, JSON.stringify(receipt)]);
    expect(replay.rows[0].dataset_row_id).toBe(provisioned.rows[0].dataset_row_id);
    await db.query("savepoint real_downgrade");
    await expect(db.query(`
      select * from public.provision_capi_dataset(
        $1, $2, 'messenger', $3, 'page-1', 'mock-dataset', $4::jsonb, true, now()
      )
    `, [TENANT_A, COACH_A, connection.rows[0].id, JSON.stringify({ ...receipt, mode: "mock" })]))
      .rejects.toThrow(/CAPI_DATASET_REAL_DOWNGRADE_REFUSED/);
    await db.query("rollback to savepoint real_downgrade");
    await db.query("savepoint cross_tenant_connection");
    await expect(db.query(`
      select * from public.provision_capi_dataset(
        $1, $2, 'messenger', $3, 'page-1', 'dataset-2', $4::jsonb, false, now()
      )
    `, [TENANT_B, COACH_B, connection.rows[0].id, JSON.stringify(receipt)]))
      .rejects.toThrow(/CAPI_DATASET_CONNECTION_MISMATCH/);
    await db.query("rollback to savepoint cross_tenant_connection");
  });
});

describe("Phase 13 first-touch persistence", () => {
  async function saveGoal(tenantId: string, actorId: string, keyword: string) {
    return db.query<{ keyword_goal_id: string }>(`
      select keyword_goal_id::text from public.save_keyword_goal(
        $1, $2, null, $3, 'book', null, null, null, null
      )
    `, [tenantId, actorId, keyword]);
  }

  async function persistMeta(input: {
    tenantId?: string;
    channel?: "messenger" | "instagram" | "whatsapp";
    identity?: string;
    messageId?: string;
    body?: string;
    adId?: string | null;
    adRef?: string | null;
    ctwaClid?: string | null;
  } = {}) {
    const channel = input.channel ?? "messenger";
    return db.query<{ conversation_id: string; message_inserted: boolean }>(`
      select conversation_id::text, message_inserted
      from public.persist_inbound_message(
        $1, 'meta_direct', $2, $3, null, null, null, $4, $5, null,
        '2026-09-01T10:00:00Z', '2026-09-02T10:00:00Z', 'provider',
        $6, $7, $8, $9::jsonb, $10
      )
    `, [
      input.tenantId ?? TENANT_A,
      channel,
      input.identity ?? `${channel}-lead-1`,
      input.messageId ?? `${channel}-message-1`,
      input.body ?? "funding",
      input.adId ?? null,
      input.adId ? "ADS" : null,
      input.adRef ?? null,
      input.adId ? JSON.stringify({ adTitle: "Funding guide", postId: "post-1" }) : "{}",
      input.ctwaClid ?? null,
    ]);
  }

  it("pins one exact normalized body goal and the first accepted Messenger attribution", async () => {
    const goal = await saveGoal(TENANT_A, COACH_A, "Funding");
    const first = await persistMeta({
      body: "  FUNDING  ", adId: "ad-1", adRef: "diagnostic-only",
    });
    const row = await db.query(`
      select keyword_goal_id::text, first_touch_keyword, ad_id, ad_source, ad_ref,
        ads_context_data, ad_attribution_captured_at is not null as captured
      from public.conversations where id = $1
    `, [first.rows[0].conversation_id]);
    expect(row.rows).toEqual([{
      keyword_goal_id: goal.rows[0].keyword_goal_id,
      first_touch_keyword: "Funding",
      ad_id: "ad-1",
      ad_source: "ADS",
      ad_ref: "diagnostic-only",
      ads_context_data: { adTitle: "Funding guide", postId: "post-1" },
      captured: true,
    }]);

    await persistMeta({
      messageId: "messenger-message-2", body: "another", adId: "ad-2", adRef: "changed",
    });
    const unchanged = await db.query(`
      select keyword_goal_id::text, ad_id, ad_ref
      from public.conversations where id = $1
    `, [first.rows[0].conversation_id]);
    expect(unchanged.rows).toEqual([{
      keyword_goal_id: goal.rows[0].keyword_goal_id,
      ad_id: "ad-1",
      ad_ref: "diagnostic-only",
    }]);
  });

  it("never treats ad_ref as a keyword and keeps no-referral ingest valid", async () => {
    await saveGoal(TENANT_A, COACH_A, "ref-only");
    const persisted = await persistMeta({ body: "hello", adRef: "ref-only" });
    const row = await db.query(`
      select keyword_goal_id, first_touch_keyword, ad_ref
      from public.conversations where id = $1
    `, [persisted.rows[0].conversation_id]);
    expect(row.rows).toEqual([{
      keyword_goal_id: null,
      first_touch_keyword: null,
      ad_ref: "ref-only",
    }]);

    await expect(persistMeta({
      identity: "no-ref-lead", messageId: "no-ref-message", body: "hello",
    })).resolves.toMatchObject({ rows: [expect.objectContaining({ message_inserted: true })] });
  });

  it("captures WhatsApp ctwa_clid once and refuses cross-tenant goal binding", async () => {
    await saveGoal(TENANT_B, COACH_B, "tenant-b-only");
    const whatsApp = await persistMeta({
      channel: "whatsapp", body: "tenant-b-only", ctwaClid: "ctwa-click-1",
    });
    const row = await db.query(`
      select keyword_goal_id, first_touch_keyword, ctwa_clid
      from public.conversations where id = $1
    `, [whatsApp.rows[0].conversation_id]);
    expect(row.rows).toEqual([{
      keyword_goal_id: null,
      first_touch_keyword: null,
      ctwa_clid: "ctwa-click-1",
    }]);

    await persistMeta({
      channel: "whatsapp", messageId: "whatsapp-message-2", body: "later", ctwaClid: "changed",
    });
    await expect(db.query(`
      select ctwa_clid from public.conversations where id = $1
    `, [whatsApp.rows[0].conversation_id])).resolves.toMatchObject({
      rows: [{ ctwa_clid: "ctwa-click-1" }],
    });
  });
});
