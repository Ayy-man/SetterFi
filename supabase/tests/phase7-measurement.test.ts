// Phase 7 measurement contract. All fixtures are synthetic and each test rolls back.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "71000000-0000-4000-8000-000000000001";
const TENANT_B = "71000000-0000-4000-8000-000000000002";
const TENANT_DEMO = "71000000-0000-4000-8000-000000000003";
const OWNER = "72000000-0000-4000-8000-000000000001";
const ADMIN = "72000000-0000-4000-8000-000000000002";
const SUCCESS = "72000000-0000-4000-8000-000000000003";
const COACH_A = "72000000-0000-4000-8000-000000000004";
const COACH_B = "72000000-0000-4000-8000-000000000005";
const MODERATOR = "10000000-0000-4000-8000-000000000002";
const ACTIVE_GENERATOR = "10000000-0000-4000-8000-000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CASE_HASH = "c".repeat(64);

const ANALYTICS_VIEWS = [
  "analytics_appointment_reschedules",
  "analytics_appointments",
  "analytics_audit_log",
  "analytics_billable_events",
  "analytics_billing_subscriptions",
  "analytics_brain_knowledge_usage_events",
  "analytics_brain_objection_usage_events",
  "analytics_channel_connections",
  "analytics_commission_ledger",
  "analytics_contact_identities",
  "analytics_contacts",
  "analytics_conversation_step_events",
  "analytics_conversations",
  "analytics_cross_channel_continuation_attribution",
  "analytics_eval_cases",
  "analytics_followup_reply_attribution",
  "analytics_followups",
  "analytics_message_traces",
  "analytics_messages",
  "analytics_onboarding_runs",
  "analytics_provisioning_steps",
  "analytics_tenant_cost_rollups",
  "analytics_tenant_price_overrides",
  "analytics_tenants",
  "analytics_tier_price_versions",
] as const;

const PLATFORM_METRICS = [
  "platform.a2p_approval_rate",
  "platform.a2p_median_days_to_clear",
  "platform.active_subscriptions",
  "platform.affiliate_commission",
  "platform.average_retention",
  "platform.booked_appointments",
  "platform.cadence_completion_rate",
  "platform.churn_rate",
  "platform.cross_channel_continuation_rate",
  "platform.escalation_rate",
  "platform.eval_case_count",
  "platform.followup_reply_rate",
  "platform.gross_mrr",
  "platform.growth_rate",
  "platform.guardrail_block_rate",
  "platform.guardrail_rule_fire_rate",
  "platform.holding_reply_rate",
  "platform.knowledge_usage_count",
  "platform.ltv",
  "platform.margin",
  "platform.meta_live_sms_registering_share",
  "platform.new_signups",
  "platform.no_show_rate",
  "platform.provisioning_step_failure_rate",
  "platform.reschedule_rate",
  "platform.scope_block_rate",
  "platform.time_to_live",
] as const;

let db: Client;

async function actAs(
  pgRole: "authenticated" | "anon" | "service_role",
  sub: string,
  role: string,
  tenantId?: string,
) {
  await db.query(`set local role ${pgRole}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
    sub,
    app_metadata: { role, ...(tenantId ? { tenant_id: tenantId } : {}) },
  })]);
}

async function createConversation(tenantId: string, suffix: string, isTest = false) {
  const contact = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id,last_channel,name,is_test)
     values ($1,'webchat',$2,$3) returning id`,
    [tenantId, `Synthetic ${suffix}`, isTest],
  );
  const conversation = await db.query<{ id: string }>(
    `insert into public.conversations (tenant_id,contact_id,channel,is_test)
     values ($1,$2,'webchat',$3) returning id`,
    [tenantId, contact.rows[0].id, isTest],
  );
  const lead = await db.query<{ id: string }>(
    `insert into public.messages (tenant_id,conversation_id,direction,author,body,is_test)
     values ($1,$2,'in','lead',$3,$4) returning id`,
    [tenantId, conversation.rows[0].id, `Synthetic lead ${suffix}`, isTest],
  );
  const agent = await db.query<{ id: string }>(
    `insert into public.messages (tenant_id,conversation_id,direction,author,body,is_test)
     values ($1,$2,'out','agent',$3,$4) returning id`,
    [tenantId, conversation.rows[0].id, `Synthetic agent ${suffix}`, isTest],
  );
  return {
    contactId: contact.rows[0].id,
    conversationId: conversation.rows[0].id,
    leadId: lead.rows[0].id,
    agentId: agent.rows[0].id,
  };
}

async function createBareConversation(
  tenantId: string,
  suffix: string,
  channel: "sms" | "webchat" = "webchat",
) {
  const contact = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id,last_channel,name)
     values ($1,$2,$3) returning id`,
    [tenantId, channel, `Synthetic ${suffix}`],
  );
  const conversation = await db.query<{ id: string }>(
    `insert into public.conversations (tenant_id,contact_id,channel)
     values ($1,$2,$3) returning id`,
    [tenantId, contact.rows[0].id, channel],
  );
  return { contactId: contact.rows[0].id, conversationId: conversation.rows[0].id };
}

async function createTimedMessage(
  tenantId: string,
  conversationId: string,
  direction: "in" | "out",
  occurredAt: string,
  suffix: string,
) {
  const message = await db.query<{ id: string }>(
    `insert into public.messages
       (tenant_id,conversation_id,direction,author,body,created_at)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [
      tenantId,
      conversationId,
      direction,
      direction === "in" ? "lead" : "agent",
      `Synthetic ${suffix}`,
      occurredAt,
    ],
  );
  return message.rows[0].id;
}

async function createChannelConversation(
  tenantId: string,
  contactId: string,
  channel: "sms" | "webchat" | "whatsapp",
) {
  const conversation = await db.query<{ id: string }>(
    `insert into public.conversations (tenant_id,contact_id,channel)
     values ($1,$2,$3) returning id`,
    [tenantId, contactId, channel],
  );
  return conversation.rows[0].id;
}

async function createPersistedIdentity(
  tenantId: string,
  contactId: string,
  channel: "sms" | "webchat" | "whatsapp",
  createdAt: string,
  suffix: string,
) {
  const locationId = `synthetic-phase7-location-${tenantId}`;
  const install = await db.query<{ id: string; location_id: string }>(
    `insert into public.ghl_installs (tenant_id, location_id, company_id, token_expires_at)
     values ($1, $2, $3, now() + interval '1 day')
     on conflict (location_id) do update
       set tenant_id = excluded.tenant_id,
           company_id = excluded.company_id,
           token_expires_at = excluded.token_expires_at
     returning id, location_id`,
    [tenantId, locationId, `synthetic-phase7-company-${tenantId}`],
  );
  const identity = await db.query<{ id: string }>(
    `insert into public.contact_identities
       (tenant_id,contact_id,provider,channel,provider_identity_id,provider_account_id,ghl_install_id,created_at)
     values ($1,$2,'ghl',$3,$4,$5,$6,$7) returning id`,
    [tenantId, contactId, channel, `synthetic-${suffix}`, install.rows[0].location_id, install.rows[0].id, createdAt],
  );
  return identity.rows[0].id;
}

async function createSentFollowup(
  conversationId: string,
  touchNo: number,
  sentAt: string,
  resolvedIdentityId: string | null,
) {
  await db.query(
    `insert into public.followups
      (tenant_id,conversation_id,touch_no,purpose,scheduled_at,status,sent_at,
       resolved_identity_id,channel_class,cadence_anchor_at,created_at)
     values ($1,$2,$3,'value_nudge',$4,'sent',$4,$5,'durable',
       $4::timestamptz - interval '10 days',$4)`,
    [TENANT_A, conversationId, touchNo, sentAt, resolvedIdentityId],
  );
}

type ContinuationSnapshot = {
  metrics: Array<{
    metricKey: string;
    numerator: number;
    denominator: number;
    value: number | null;
    state: string;
  }>;
  followupPerformance: Array<{ touchNo: number; crossChannel: number }>;
};

async function readContinuationSnapshot(asOf: string) {
  await actAs("service_role", OWNER, "owner");
  const result = await db.query<{ snapshot: ContinuationSnapshot }>(
    `select public.read_platform_measurement($1) snapshot`,
    [asOf],
  );
  const metric = result.rows[0].snapshot.metrics.find(
    (row) => row.metricKey === "platform.cross_channel_continuation_rate",
  );
  if (!metric) throw new Error("CROSS_CHANNEL_CONTINUATION_METRIC_MISSING");
  return { metric, followupPerformance: result.rows[0].snapshot.followupPerformance };
}

async function actAsServiceOnly() {
  await db.query(`set local role service_role`);
  await db.query(`select set_config('request.jwt.claims', '', true)`);
}

// An exception poisons the surrounding transaction, so each refusal is probed inside its own
// savepoint and the fixtures survive for the next assertion in the same test.
async function expectRaises(sql: string, params: unknown[], pattern: RegExp) {
  await db.query("savepoint seam_probe");
  await expect(db.query(sql, params)).rejects.toThrow(pattern);
  await db.query("rollback to savepoint seam_probe");
  await db.query("release savepoint seam_probe");
}

function suiteResults(caseKey = "synthetic-case") {
  return [
    "compliance_guardrails", "pricing_discipline", "jailbreak_injection",
    "output_integrity", "qualification_accuracy", "voice_tone",
  ].map((suite) => ({ suite, cases: [{ caseKey: `${suite}:${caseKey}`, passed: true }] }));
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id,slug,name,billing_contact_email,is_demo,status) values
      ('${TENANT_A}','p7-a','Phase 7 A','billing-a@synthetic.test',false,'active'),
      ('${TENANT_B}','p7-b','Phase 7 B','billing-b@synthetic.test',false,'active'),
      ('${TENANT_DEMO}','p7-demo','Phase 7 Demo','billing-demo@synthetic.test',true,'active');
    insert into public.users (id,email,role,tenant_id) values
      ('${OWNER}','owner@synthetic.test','owner',null),
      ('${ADMIN}','admin@synthetic.test','admin',null),
      ('${SUCCESS}','success@synthetic.test','success',null),
      ('${COACH_A}','coach-a@synthetic.test','coach','${TENANT_A}'),
      ('${COACH_B}','coach-b@synthetic.test','coach','${TENANT_B}');
    insert into public.tenant_settings (tenant_id,timezone)
      values ('${TENANT_A}','America/New_York'),('${TENANT_B}','America/Chicago'),
        ('${TENANT_DEMO}','America/Los_Angeles');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("Phase 7 catalog and isolation boundary", () => {
  it("installs the exact security-invoker analytics view and reader boundary", async () => {
    const result = await db.query<{ viewname: string; definition: string }>(`
      select viewname, definition from pg_views
      where schemaname='public' and viewname like 'analytics_%' order by viewname
    `);
    expect(result.rows.map((row) => row.viewname)).toEqual(ANALYTICS_VIEWS);
    const options = await db.query<{ relname: string; reloptions: string[] }>(`
      select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=any($1::text[]) order by c.relname
    `, [ANALYTICS_VIEWS]);
    expect(options.rows.every((row) => row.reloptions?.includes("security_invoker=true"))).toBe(true);
    const anonViews = await db.query<{ count: string }>(`
      select count(*)::text from information_schema.role_table_grants
      where grantee='anon' and table_schema='public' and table_name=any($1::text[])
    `, [ANALYTICS_VIEWS]);
    expect(anonViews.rows[0].count).toBe("0");

    const functions = await db.query<{
      schema_name: string;
      function_name: string;
      volatility: string;
      security_definer: boolean;
      settings: string[];
    }>(`
      select namespace.nspname schema_name, procedure.proname function_name,
        procedure.provolatile::text volatility, procedure.prosecdef security_definer,
        procedure.proconfig settings
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid=procedure.pronamespace
      where procedure.oid in (
        'app.phase7_platform_measurement_base(timestamptz)'::regprocedure,
        'public.read_platform_measurement(timestamptz)'::regprocedure
      )
      order by namespace.nspname, procedure.proname
    `);
    expect(functions.rows).toEqual([
      {
        schema_name: "app",
        function_name: "phase7_platform_measurement_base",
        volatility: "s",
        security_definer: true,
        settings: ['search_path=""'],
      },
      {
        schema_name: "public",
        function_name: "read_platform_measurement",
        volatility: "s",
        security_definer: true,
        settings: ['search_path=""'],
      },
    ]);
    const grants = await db.query<{
      public_anon: boolean;
      public_authenticated: boolean;
      public_service: boolean;
      base_anon: boolean;
      base_authenticated: boolean;
      base_service: boolean;
    }>(`
      select
        has_function_privilege('anon','public.read_platform_measurement(timestamptz)','execute') public_anon,
        has_function_privilege('authenticated','public.read_platform_measurement(timestamptz)','execute') public_authenticated,
        has_function_privilege('service_role','public.read_platform_measurement(timestamptz)','execute') public_service,
        has_function_privilege('anon','app.phase7_platform_measurement_base(timestamptz)','execute') base_anon,
        has_function_privilege('authenticated','app.phase7_platform_measurement_base(timestamptz)','execute') base_authenticated,
        has_function_privilege('service_role','app.phase7_platform_measurement_base(timestamptz)','execute') base_service
    `);
    expect(grants.rows[0]).toEqual({
      public_anon: false,
      public_authenticated: false,
      public_service: true,
      base_anon: false,
      base_authenticated: false,
      base_service: false,
    });
  });

  it("forces RLS and revokes anon access on every new relation", async () => {
    const names = ["conversation_step_events", "eval_comparisons", "test_agent_sessions"];
    const result = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
      select relname,relrowsecurity,relforcerowsecurity from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and relname=any($1::text[]) order by relname
    `, [names]);
    expect(result.rows.map((row) => row.relname)).toEqual(names.sort());
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const anon = await db.query<{ count: string }>(`
      select count(*)::text from information_schema.role_table_grants
      where grantee='anon' and table_schema='public' and table_name=any($1::text[])
    `, [names]);
    expect(anon.rows[0].count).toBe("0");
  });

  it("keeps coach reads tenant-local and hides platform aggregates", async () => {
    const a = await createConversation(TENANT_A, "a");
    const b = await createConversation(TENANT_B, "b");
    await db.query(`select * from public.record_conversation_step_events($1,$2,$3,$4,'q1','q2')`,
      [TENANT_A, a.conversationId, a.leadId, a.agentId]);
    await db.query(`select * from public.record_conversation_step_events($1,$2,$3,$4,'q1','q2')`,
      [TENANT_B, b.conversationId, b.leadId, b.agentId]);
    await actAs("authenticated", COACH_A, "coach", TENANT_A);
    const rows = await db.query<{ tenant_id: string }>(
      `select tenant_id from public.conversation_step_events order by tenant_id`,
    );
    expect(rows.rows.map((row) => row.tenant_id)).toEqual([TENANT_A, TENANT_A]);
    await expect(db.query(`select public.read_platform_measurement(now())`))
      .rejects.toThrow(/permission denied/);
  });

  it("rejects mutation of append-only measurement and test evidence", async () => {
    const source = await createConversation(TENANT_A, "immutable");
    const event = await db.query<{ answered_event_id: string }>(
      `select * from public.record_conversation_step_events($1,$2,$3,$4,'q1',null)`,
      [TENANT_A, source.conversationId, source.leadId, source.agentId],
    );
    await expect(db.query(`update public.conversation_step_events set step_key='changed' where id=$1`,
      [event.rows[0].answered_event_id])).rejects.toThrow(/CONVERSATION_STEP_EVENTS_APPEND_ONLY/);
    await db.query("rollback");
    await db.query("begin");
    await db.query(`
      insert into public.tenants (id,slug,name,billing_contact_email,is_demo,status)
      values ('${TENANT_A}','p7-a','Phase 7 A','billing-a@synthetic.test',false,'active');
      insert into public.users (id,email,role,tenant_id)
      values ('${COACH_A}','coach-a@synthetic.test','coach','${TENANT_A}');
    `);
    const session = await db.query<{ create_test_agent_session: string }>(
      `select public.create_test_agent_session($1,$2)`, [TENANT_A, COACH_A],
    );
    await expect(db.query(`delete from public.test_agent_sessions where id=$1`,
      [session.rows[0].create_test_agent_session])).rejects.toThrow(/TEST_AGENT_SESSIONS_APPEND_ONLY/);
  });

  it("repairs the Phase 2 legacy suite check without widening promotion", async () => {
    await expect(db.query(`insert into public.eval_cases
      (category,active,turns,expectation,suite,kind)
      values ('pricing',true,'["synthetic"]','{}','pricing_discipline','engine')`))
      .resolves.toBeTruthy();
    const source = await createConversation(TENANT_A, "suite");
    await expect(db.query(`select * from public.promote_eval_case(
      $1,$2,$3,$4,$5,'["redacted"]','{}','pricing_discipline','{}',$6,$7,null)`,
      [ADMIN,TENANT_A,source.conversationId,source.leadId,source.contactId,HASH_A,HASH_B]))
      .rejects.toThrow(/EVAL_PROMOTION_SUITE_INVALID/);
  });

  it("replays identical billing status evidence without ambiguous actor custody", async () => {
    const first = await db.query<{ audit_id: string }>(
      `select * from public.set_tenant_billing_status($1,$2,'suspended','Synthetic replay')`,
      [TENANT_A, ADMIN],
    );
    const replay = await db.query<{ audit_id: string }>(
      `select * from public.set_tenant_billing_status($1,$2,'suspended','Synthetic replay')`,
      [TENANT_A, ADMIN],
    );
    expect(replay.rows[0].audit_id).toBe(first.rows[0].audit_id);
  });
});

describe("measurement readers", () => {
  it("returns the exact coach snapshot keys and excludes demo/test evidence", async () => {
    const real = await createConversation(TENANT_A, "real");
    await createConversation(TENANT_A, "test", true);
    await createConversation(TENANT_DEMO, "demo");
    await db.query(`select * from public.record_conversation_step_events($1,$2,$3,$4,'q1','q2')`,
      [TENANT_A,real.conversationId,real.leadId,real.agentId]);
    await actAs("service_role", COACH_A, "coach", TENANT_A);
    const result = await db.query<{ snapshot: Record<string, unknown> }>(
      `select public.read_coach_measurement($1,'1m',null,null,now()) snapshot`, [TENANT_A],
    );
    expect(Object.keys(result.rows[0].snapshot).sort()).toEqual([
      "allowance","funnel","keywordConversationTotal","keywords","metrics","pipeline","responses",
      "tenantId","timezone","window","windowEnd","windowStart",
    ].sort());
    const metrics = result.rows[0].snapshot.metrics as Array<{ metricKey: string }>;
    expect(metrics).toHaveLength(20);
    expect((result.rows[0].snapshot.responses as Array<{ stepKey: string }>))
      .toEqual([expect.objectContaining({ stepKey: "q2" })]);
    await expect(db.query(`select public.read_coach_measurement($1,'1m',null,null,now())`,[TENANT_B]))
      .rejects.toThrow(/PHASE7_COACH_READER_TENANT_MISMATCH/);
  });

  /**
   * The funnel's steps have to nest, because a funnel that does not nest cannot be divided.
   *
   * Qualified counted contacts at stage booked or qualified_no_buy, or with outcome BOOK, while
   * Booked counted contacts holding any live appointment. Neither was a subset of the other, so a
   * contact with a booking still sitting in `qualifying` with a null outcome landed at Booked and
   * not at Qualified, and the panel printed more leads at Booked than at Ready to book. This is
   * that exact contact.
   */
  it("counts a booked contact at every step above Booked, whatever its pipeline stage says", async () => {
    const booked = await createConversation(TENANT_A, "funnel-booked");
    await createConversation(TENANT_A, "funnel-open");
    await db.query(
      `update public.contacts set pipeline_stage = 'qualifying', outcome = null where id = $1`,
      [booked.contactId],
    );
    await db.query(
      `insert into public.appointments
        (tenant_id, contact_id, conversation_id, provider, external_id, start_at, end_at, timezone)
       values ($1,$2,$3,'ghl','funnel-nesting-booking', now() + interval '2 days',
         now() + interval '2 days 30 minutes', 'America/New_York')`,
      [TENANT_A, booked.contactId, booked.conversationId],
    );

    await actAs("service_role", COACH_A, "coach", TENANT_A);
    const result = await db.query<{
      snapshot: {
        funnel: Array<{ stepKey: string; enteredContacts: number; completedContacts: number }>;
      };
    }>(`select public.read_coach_measurement($1,'1m',null,null,now()) snapshot`, [TENANT_A]);

    const funnel = result.rows[0].snapshot.funnel;
    expect(funnel.map((step) => step.stepKey)).toEqual(["entered", "qualified", "booked"]);
    const completed = funnel.map((step) => Number(step.completedContacts));
    // The contact with the booking is at Booked, so it must also be at Qualified.
    expect(completed).toEqual([2, 1, 1]);
    // Monotone by construction, not by coincidence: every step completes at most what the step
    // above it completed, which is the only shape a conversion rate can be read from.
    for (let index = 1; index < completed.length; index += 1) {
      expect(completed[index]).toBeLessThanOrEqual(completed[index - 1]!);
    }
    expect(funnel.every((step) =>
      Number(step.completedContacts) <= Number(step.enteredContacts))).toBe(true);
  });

  it("authorizes platform role before querying and returns the exact platform contract", async () => {
    await actAs("service_role", COACH_A, "coach", TENANT_A);
    await expect(db.query(`select public.read_platform_measurement(now())`))
      .rejects.toThrow(/PHASE7_PLATFORM_READER_REQUIRED/);
    await db.query("rollback");
    await db.query("begin");
    await db.query(`
      insert into public.tenants (id,slug,name,billing_contact_email,is_demo,status) values
        ('${TENANT_A}','p7-a','Phase 7 A','billing-a@synthetic.test',false,'active');
      insert into public.users (id,email,role,tenant_id) values
        ('${OWNER}','owner@synthetic.test','owner',null);
    `);
    await actAs("service_role", OWNER, "owner");
    const result = await db.query<{ snapshot: Record<string, unknown> }>(
      `select public.read_platform_measurement(now()) snapshot`,
    );
    expect(Object.keys(result.rows[0].snapshot).sort()).toEqual([
      "activeSubscriptionsByPeriod","asOf","followupPerformance","guardrailRules","history",
      "metrics","provisioningPerformance","revenueByPeriod","subscriptions","tenantPerformance",
    ].sort());
    const metrics = result.rows[0].snapshot.metrics as Array<{ metricKey: string; state: string }>;
    expect(metrics.map((metric) => metric.metricKey).sort()).toEqual(PLATFORM_METRICS);
    expect(metrics.find((metric) => metric.metricKey === "platform.margin")?.state)
      .toBe("unavailable");
  });

  it("attributes a step reply to the latest eligible asked touch instead of a prior step", async () => {
    const asOf = new Date(Date.now() + 60_000);
    const source = await createBareConversation(TENANT_A, "step-attribution");
    const moments = [-5, -4, -3].map((minutes) =>
      new Date(asOf.getTime() + minutes * 60_000).toISOString());

    const leadOne = await createTimedMessage(
      TENANT_A, source.conversationId, "in", moments[0], "step lead one",
    );
    const askOne = await createTimedMessage(
      TENANT_A, source.conversationId, "out", moments[0], "ask one",
    );
    await db.query(
      `select * from public.record_conversation_step_events($1,$2,$3,$4,null,'q1')`,
      [TENANT_A, source.conversationId, leadOne, askOne],
    );

    const leadTwo = await createTimedMessage(
      TENANT_A, source.conversationId, "in", moments[1], "step lead two",
    );
    const askTwo = await createTimedMessage(
      TENANT_A, source.conversationId, "out", moments[1], "ask two",
    );
    await db.query(
      `select * from public.record_conversation_step_events($1,$2,$3,$4,null,'q2')`,
      [TENANT_A, source.conversationId, leadTwo, askTwo],
    );

    const reply = await createTimedMessage(
      TENANT_A, source.conversationId, "in", moments[2], "late reply",
    );
    const agent = await createTimedMessage(
      TENANT_A, source.conversationId, "out", moments[2], "reply receipt",
    );
    await db.query(
      `select * from public.record_conversation_step_events($1,$2,$3,$4,'q1',null)`,
      [TENANT_A, source.conversationId, reply, agent],
    );

    await actAs("service_role", COACH_A, "coach", TENANT_A);
    const result = await db.query<{
      snapshot: { responses: Array<{ stepKey: string; answeredContacts: number }> };
    }>(
      `select public.read_coach_measurement($1,'1m',null,null,$2) snapshot`,
      [TENANT_A, asOf.toISOString()],
    );
    const answered = new Map(
      result.rows[0].snapshot.responses.map((row) => [row.stepKey, Number(row.answeredContacts)]),
    );
    expect(answered.get("q1")).toBe(0);
    expect(answered.get("q2")).toBe(1);
    expect([...answered.values()].reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it("bounds follow-up replies before the next same-channel touch and at seven days", async () => {
    const asOf = new Date(Date.now() + 60_000);
    const isoDaysBefore = (days: number) =>
      new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const insertSentTouch = async (
      conversationId: string,
      touchNo: number,
      sentAt: string,
    ) => {
      await db.query(
        `insert into public.followups
          (tenant_id,conversation_id,touch_no,purpose,scheduled_at,status,sent_at,
           channel_class,cadence_anchor_at,created_at)
         values ($1,$2,$3,'value_nudge',$4,'sent',$4,'durable',$5,$4)`,
        [TENANT_A, conversationId, touchNo, sentAt, isoDaysBefore(20)],
      );
    };

    const bounded = await createBareConversation(TENANT_A, "bounded", "sms");
    await insertSentTouch(bounded.conversationId, 1, isoDaysBefore(4));
    await insertSentTouch(bounded.conversationId, 2, isoDaysBefore(2));
    await createTimedMessage(
      TENANT_A, bounded.conversationId, "in", isoDaysBefore(1), "bounded reply",
    );

    const open = await createBareConversation(TENANT_A, "open", "sms");
    await insertSentTouch(open.conversationId, 3, isoDaysBefore(3));
    await createTimedMessage(
      TENANT_A, open.conversationId, "in", isoDaysBefore(2), "open reply",
    );

    const expired = await createBareConversation(TENANT_A, "expired", "sms");
    await insertSentTouch(expired.conversationId, 4, isoDaysBefore(10));
    await createTimedMessage(
      TENANT_A, expired.conversationId, "in", isoDaysBefore(2), "expired reply",
    );

    await actAs("service_role", OWNER, "owner");
    const result = await db.query<{
      snapshot: {
        metrics: Array<{ metricKey: string; numerator: number; denominator: number }>;
        followupPerformance: Array<{ touchNo: number; sent: number; replied: number }>;
      };
    }>(`select public.read_platform_measurement($1) snapshot`, [asOf.toISOString()]);
    const replies = new Map(result.rows[0].snapshot.followupPerformance.map((row) => [
      Number(row.touchNo), Number(row.replied),
    ]));
    const metric = result.rows[0].snapshot.metrics.find(
      (row) => row.metricKey === "platform.followup_reply_rate",
    );

    expect(replies.get(1)).toBe(0);
    expect(replies.get(2)).toBe(1);
    expect(replies.get(3)).toBe(1);
    expect(replies.get(4)).toBe(0);
    expect(metric).toMatchObject({ numerator: 2, denominator: 4 });
    expect([...replies.values()].reduce((sum, count) => sum + count, 0)).toBe(2);
  });

  it("cross-channel continuation ignores identity discovery without an inbound reply", async () => {
    const asOf = new Date(Date.now() + 60_000);
    const isoDaysBefore = (days: number) =>
      new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const source = await createBareConversation(TENANT_A, "identity-only", "sms");
    const smsIdentity = await createPersistedIdentity(
      TENANT_A, source.contactId, "sms", isoDaysBefore(6), "identity-only-sms",
    );
    await createSentFollowup(source.conversationId, 1, isoDaysBefore(4), smsIdentity);
    await createPersistedIdentity(
      TENANT_A, source.contactId, "whatsapp", isoDaysBefore(3), "identity-only-whatsapp",
    );

    const { metric } = await readContinuationSnapshot(asOf.toISOString());
    expect(metric).toMatchObject({ numerator: 0, denominator: 1, value: 0, state: "available" });
  });

  it("cross-channel continuation counts an inbound reply on a different persisted channel", async () => {
    const asOf = new Date(Date.now() + 60_000);
    const isoDaysBefore = (days: number) =>
      new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const source = await createBareConversation(TENANT_A, "different-channel", "sms");
    const replyConversation = await createChannelConversation(
      TENANT_A, source.contactId, "whatsapp",
    );
    const smsIdentity = await createPersistedIdentity(
      TENANT_A, source.contactId, "sms", isoDaysBefore(6), "different-channel-sms",
    );
    await createPersistedIdentity(
      TENANT_A, source.contactId, "whatsapp", isoDaysBefore(6), "different-channel-whatsapp",
    );
    await createSentFollowup(source.conversationId, 1, isoDaysBefore(4), smsIdentity);
    await createTimedMessage(
      TENANT_A, replyConversation, "in", isoDaysBefore(3), "different-channel reply",
    );

    const { metric } = await readContinuationSnapshot(asOf.toISOString());
    expect(metric).toMatchObject({ numerator: 1, denominator: 1, value: 100, state: "available" });
  });

  it("cross-channel continuation assigns a reply after the next touch only to that later touch", async () => {
    const asOf = new Date(Date.now() + 60_000);
    const isoDaysBefore = (days: number) =>
      new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const source = await createBareConversation(TENANT_A, "next-touch-cross", "sms");
    const replyConversation = await createChannelConversation(
      TENANT_A, source.contactId, "whatsapp",
    );
    const smsIdentity = await createPersistedIdentity(
      TENANT_A, source.contactId, "sms", isoDaysBefore(8), "next-touch-sms",
    );
    await createSentFollowup(source.conversationId, 1, isoDaysBefore(6), smsIdentity);
    await createPersistedIdentity(
      TENANT_A, source.contactId, "whatsapp", isoDaysBefore(5), "next-touch-whatsapp",
    );
    await createSentFollowup(source.conversationId, 2, isoDaysBefore(4), smsIdentity);
    await createTimedMessage(
      TENANT_A, replyConversation, "in", isoDaysBefore(3), "reply after next touch",
    );

    const { followupPerformance } = await readContinuationSnapshot(asOf.toISOString());
    const crossed = new Map(followupPerformance.map((row) => [
      Number(row.touchNo), Number(row.crossChannel),
    ]));
    expect(crossed.get(1)).toBe(0);
    expect(crossed.get(2)).toBe(1);
  });

  it("cross-channel continuation ignores an inbound reply on the sent channel", async () => {
    const asOf = new Date(Date.now() + 60_000);
    const isoDaysBefore = (days: number) =>
      new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const source = await createBareConversation(TENANT_A, "same-channel", "sms");
    const smsIdentity = await createPersistedIdentity(
      TENANT_A, source.contactId, "sms", isoDaysBefore(6), "same-channel-sms",
    );
    await createSentFollowup(source.conversationId, 1, isoDaysBefore(4), smsIdentity);
    await createPersistedIdentity(
      TENANT_A, source.contactId, "whatsapp", isoDaysBefore(3), "same-channel-whatsapp",
    );
    await createTimedMessage(
      TENANT_A, source.conversationId, "in", isoDaysBefore(2), "same-channel reply",
    );

    const { metric } = await readContinuationSnapshot(asOf.toISOString());
    expect(metric).toMatchObject({ numerator: 0, denominator: 1, value: 0, state: "available" });
  });

  it("cross-channel continuation leaves unresolved sent touches outside its denominator", async () => {
    const asOf = new Date(Date.now() + 60_000);
    const sentAt = new Date(asOf.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const source = await createBareConversation(TENANT_A, "unresolved", "sms");
    await createSentFollowup(source.conversationId, 1, sentAt, null);

    const { metric } = await readContinuationSnapshot(asOf.toISOString());
    expect(metric).toMatchObject({
      numerator: 0,
      denominator: 0,
      value: null,
      state: "unavailable",
    });
  });
});

describe("challenger comparisons", () => {
  it("creates an inactive generator and its audit atomically for owner/admin only", async () => {
    const created = await db.query<{ model_config_id: string; audit_id: string }>(
      `select * from public.create_challenger_model_config($1,'synthetic/model','{"temperature":0}')`,
      [ADMIN],
    );
    const row = await db.query<{ role: string; active: boolean; action: string }>(`
      select config.role::text,config.active,audit.action from public.model_configs config
      join public.audit_log audit on audit.id=$2 where config.id=$1
    `, [created.rows[0].model_config_id, created.rows[0].audit_id]);
    expect(row.rows[0]).toEqual({ role: "generator", active: false, action: "eval.model_config.created" });
    await expect(db.query(
      `select * from public.create_challenger_model_config($1,'synthetic/model','{}')`, [COACH_A],
    )).rejects.toThrow(/PHASE6_OWNER_ADMIN_REQUIRED/);
  });

  it("refuses moderator arms and atomically attaches equivalent A/B runs", async () => {
    const draft = await db.query<{ id: string }>(
      `insert into public.brain_draft_versions(id,content_hash,payload,created_by)
       values (gen_random_uuid(),$1,'{}',$2) returning id`, [HASH_A, ADMIN],
    );
    const challenger = await db.query<{ model_config_id: string }>(
      `select * from public.create_challenger_model_config($1,'synthetic/challenger','{}')`, [ADMIN],
    );
    await db.query("savepoint moderator_refusal");
    let moderatorError = "";
    try {
      await db.query(`select public.start_eval_comparison($1,$2,$3,$4,$5,$6)`,
        [ADMIN,draft.rows[0].id,HASH_A,ACTIVE_GENERATOR,MODERATOR,CASE_HASH]);
    } catch (error) {
      moderatorError = (error as Error).message;
    }
    await db.query("rollback to savepoint moderator_refusal");
    expect(moderatorError).toMatch(/EVAL_COMPARISON_GENERATOR_CONFIG_REQUIRED/);
    const comparison = await db.query<{ id: string }>(
      `select public.start_eval_comparison($1,$2,$3,$4,$5,$6) id`,
      [ADMIN,draft.rows[0].id,HASH_A,ACTIVE_GENERATOR,challenger.rows[0].model_config_id,CASE_HASH],
    );
    const runA = await db.query<{ id: string }>(
      `select public.record_eval_run($1,$2,'engine',$3,'synthetic-corpus',$4) id`,
      [draft.rows[0].id,HASH_A,ACTIVE_GENERATOR,JSON.stringify(suiteResults())],
    );
    const runB = await db.query<{ id: string }>(
      `select public.record_eval_run($1,$2,'engine',$3,'synthetic-corpus',$4) id`,
      [draft.rows[0].id,HASH_A,challenger.rows[0].model_config_id,JSON.stringify(suiteResults())],
    );
    await expect(db.query(`select public.finish_eval_comparison($1,$2,$3,$4)`,
      [comparison.rows[0].id,runA.rows[0].id,runB.rows[0].id,HASH_B]))
      .rejects.toThrow(/EVAL_COMPARISON_CASE_SET_HASH_MISMATCH/);
    await db.query("rollback");
    await db.query("begin");
    // Rebuild after the expected statement error aborted the transaction.
    await db.query(`
      insert into public.tenants (id,slug,name,billing_contact_email,is_demo,status)
      values ('${TENANT_A}','p7-a','Phase 7 A','billing-a@synthetic.test',false,'active');
      insert into public.users (id,email,role,tenant_id) values ('${ADMIN}','admin@synthetic.test','admin',null);
    `);
    const d = await db.query<{ id: string }>(`insert into public.brain_draft_versions(content_hash,payload,created_by)
      values ($1,'{}',$2) returning id`,[HASH_A,ADMIN]);
    const c = await db.query<{ model_config_id: string }>(`select * from public.create_challenger_model_config($1,'synthetic/challenger','{}')`,[ADMIN]);
    const cmp = await db.query<{ id: string }>(`select public.start_eval_comparison($1,$2,$3,$4,$5,$6) id`,[ADMIN,d.rows[0].id,HASH_A,ACTIVE_GENERATOR,c.rows[0].model_config_id,CASE_HASH]);
    const a = await db.query<{ id: string }>(`select public.record_eval_run($1,$2,'engine',$3,'synthetic-corpus',$4) id`,[d.rows[0].id,HASH_A,ACTIVE_GENERATOR,JSON.stringify(suiteResults())]);
    const b = await db.query<{ id: string }>(`select public.record_eval_run($1,$2,'engine',$3,'synthetic-corpus',$4) id`,[d.rows[0].id,HASH_A,c.rows[0].model_config_id,JSON.stringify(suiteResults())]);
    await db.query(`select public.finish_eval_comparison($1,$2,$3,$4)`,[cmp.rows[0].id,a.rows[0].id,b.rows[0].id,CASE_HASH]);
    const arms = await db.query<{ comparison_arm: string }>(`select comparison_arm from public.eval_runs where comparison_id=$1 order by comparison_arm`,[cmp.rows[0].id]);
    expect(arms.rows.map((row) => row.comparison_arm)).toEqual(["a","b"]);
  });
});

describe("test-agent persistence and eval promotion", () => {
  it("rejects tenant spoofing and persists only inherited test evidence", async () => {
    await expect(db.query(`select public.create_test_agent_session($1,$2)`,[TENANT_B,COACH_A]))
      .rejects.toThrow(/PHASE7_TEST_ACTOR_TENANT_MISMATCH/);
    await db.query("rollback");
    await db.query("begin");
    await db.query(`
      insert into public.tenants (id,slug,name,billing_contact_email,is_demo,status)
      values ('${TENANT_A}','p7-a','Phase 7 A','billing-a@synthetic.test',false,'active');
      insert into public.users (id,email,role,tenant_id)
      values ('${COACH_A}','coach-a@synthetic.test','coach','${TENANT_A}');
    `);
    const session = await db.query<{ id: string }>(`select public.create_test_agent_session($1,$2) id`,[TENANT_A,COACH_A]);
    const moderatorConfig = await db.query<{ id: string }>(
      `select id from public.model_configs where role='moderator' order by created_at limit 1`,
    );
    expect(moderatorConfig.rows).toHaveLength(1);
    const trace = JSON.stringify({
      outcome: "successful",
      moderator: "blocked",
      moderatorClass: "CLAIM",
      moderatorRuleId: "CLAIM-001",
      moderatorModelConfigId: moderatorConfig.rows[0].id,
    });
    const turn = await db.query<Record<string, unknown>>(`select * from public.persist_test_agent_turn(
      $1,$2,$3,'Synthetic question','Synthetic answer',$4,'mock',null,'q1')`,
      [TENANT_A,COACH_A,session.rows[0].id,trace]);
    expect(turn.rows[0]).toMatchObject({
      resolved_driver_arm:"mock",contact_is_test:true,conversation_is_test:true,
      lead_is_test:true,agent_is_test:true,trace_is_test:true,step_rows_is_test:true,
      appointment_rows:"0",billable_rows:"0",followup_rows:"0",
    });
    const stored = await db.query<{
      moderator_state: string | null;
      moderator_class: string | null;
      moderator_rule_id: string | null;
      moderator_model_config_id: string | null;
    }>(`select moderator_state, moderator_class, moderator_rule_id, moderator_model_config_id
       from public.message_traces where message_id=$1`, [turn.rows[0].agent_message_id]);
    expect(stored.rows).toEqual([{
      moderator_state: "blocked",
      moderator_class: "CLAIM",
      moderator_rule_id: "CLAIM-001",
      moderator_model_config_id: moderatorConfig.rows[0].id,
    }]);
  });

  it("locks promotion provenance and rejects bad suite, tenant, hash, and residual PII", async () => {
    const source = await createConversation(TENANT_A,"promotion");
    const hashes = await db.query<{ source_hash: string; redacted_hash: string }>(
      `select app.phase2_json_hash(to_jsonb($1::text)) source_hash,
        app.phase2_json_hash($2::jsonb) redacted_hash`,
      ["Synthetic lead promotion",JSON.stringify(["Synthetic redacted turn"])],
    );
    const args = [ADMIN,TENANT_A,source.conversationId,source.leadId,source.contactId,
      JSON.stringify(["Synthetic redacted turn"]),JSON.stringify({ outcome:"BOOK" }),
      "qualification_accuracy",JSON.stringify({ fields:["name"] }),hashes.rows[0].source_hash,
      hashes.rows[0].redacted_hash,"Synthetic case"];
    await expect(db.query(`select * from public.promote_eval_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [...args.slice(0,7),"pricing_discipline",...args.slice(8)]))
      .rejects.toThrow(/EVAL_PROMOTION_SUITE_INVALID/);
    await db.query("rollback");
    await db.query("begin");
    await db.query(`
      insert into public.tenants (id,slug,name,billing_contact_email,is_demo,status) values
        ('${TENANT_A}','p7-a','Phase 7 A','billing-a@synthetic.test',false,'active'),
        ('${TENANT_B}','p7-b','Phase 7 B','billing-b@synthetic.test',false,'active');
      insert into public.users (id,email,role,tenant_id) values ('${ADMIN}','admin@synthetic.test','admin',null);
    `);
    const fresh = await createConversation(TENANT_A,"promotion");
    const h = await db.query<{ source_hash:string; redacted_hash:string }>(`select app.phase2_json_hash(to_jsonb($1::text)) source_hash,app.phase2_json_hash($2::jsonb) redacted_hash`,["Synthetic lead promotion",JSON.stringify(["Synthetic redacted turn"])]);
    const base=[ADMIN,TENANT_A,fresh.conversationId,fresh.leadId,fresh.contactId,JSON.stringify(["Synthetic redacted turn"]),JSON.stringify({outcome:"BOOK"}),"qualification_accuracy",JSON.stringify({fields:["name"]}),h.rows[0].source_hash,h.rows[0].redacted_hash,"Synthetic case"];
    await expect(db.query(`select * from public.promote_eval_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[...base.slice(0,1),TENANT_B,...base.slice(2)]))
      .rejects.toThrow(/EVAL_PROMOTION_TENANT_MISMATCH/);
    await db.query("rollback");
    await db.query("begin");
    await db.query(`insert into public.tenants (id,slug,name,billing_contact_email,is_demo,status) values ('${TENANT_A}','p7-a','Phase 7 A','billing-a@synthetic.test',false,'active');insert into public.users (id,email,role,tenant_id) values ('${ADMIN}','admin@synthetic.test','admin',null);`);
    const finalSource=await createConversation(TENANT_A,"promotion");
    const finalHash=await db.query<{source_hash:string;redacted_hash:string}>(`select app.phase2_json_hash(to_jsonb($1::text)) source_hash,app.phase2_json_hash($2::jsonb) redacted_hash`,["Synthetic lead promotion",JSON.stringify(["Synthetic redacted turn"])]);
    const good=[ADMIN,TENANT_A,finalSource.conversationId,finalSource.leadId,finalSource.contactId,JSON.stringify(["Synthetic redacted turn"]),JSON.stringify({outcome:"BOOK"}),"qualification_accuracy",JSON.stringify({fields:["name"]}),finalHash.rows[0].source_hash,finalHash.rows[0].redacted_hash,"Synthetic case"];
    await expect(db.query(`select * from public.promote_eval_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[...good.slice(0,9),HASH_B,...good.slice(10)]))
      .rejects.toThrow(/EVAL_PROMOTION_SOURCE_HASH_MISMATCH/);
    await db.query("rollback");
    await db.query("begin");
    await db.query(`insert into public.tenants (id,slug,name,billing_contact_email,is_demo,status) values ('${TENANT_A}','p7-a','Phase 7 A','billing-a@synthetic.test',false,'active');insert into public.users (id,email,role,tenant_id) values ('${ADMIN}','admin@synthetic.test','admin',null);`);
    const piiSource=await createConversation(TENANT_A,"promotion");
    const pii=JSON.stringify(["synthetic@example.test"]);
    const piiHashes=await db.query<{source_hash:string;redacted_hash:string}>(`select app.phase2_json_hash(to_jsonb($1::text)) source_hash,app.phase2_json_hash($2::jsonb) redacted_hash`,["Synthetic lead promotion",pii]);
    await expect(db.query(`select * from public.promote_eval_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[ADMIN,TENANT_A,piiSource.conversationId,piiSource.leadId,piiSource.contactId,pii,"{}","voice_tone","{}",piiHashes.rows[0].source_hash,piiHashes.rows[0].redacted_hash,null]))
      .rejects.toThrow(/EVAL_PROMOTION_RESIDUAL_PII/);
  });

  it("promotes a redacted engine case and writes its audit in the same transaction", async () => {
    const source = await createConversation(TENANT_A,"good-promotion");
    const redacted=JSON.stringify(["Synthetic redacted turn"]);
    const hashes=await db.query<{source_hash:string;redacted_hash:string}>(`select app.phase2_json_hash(to_jsonb($1::text)) source_hash,app.phase2_json_hash($2::jsonb) redacted_hash`,["Synthetic lead good-promotion",redacted]);
    const promoted=await db.query<{eval_case_id:string;audit_id:string}>(`select * from public.promote_eval_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[ADMIN,TENANT_A,source.conversationId,source.leadId,source.contactId,redacted,"{}","voice_tone","{}",hashes.rows[0].source_hash,hashes.rows[0].redacted_hash,"Synthetic"]);
    const row=await db.query<{kind:string;category:string;action:string}>(`select eval_case.kind,eval_case.category,audit.action from public.eval_cases eval_case join public.audit_log audit on audit.id=eval_case.promotion_audit_id where eval_case.id=$1`,[promoted.rows[0].eval_case_id]);
    expect(row.rows[0]).toEqual({kind:"engine",category:"voice",action:"eval.case.promoted"});
    expect(promoted.rows[0].audit_id).toBeTruthy();
  });
});

describe("coach lead composition", () => {
  const COMPOSITION_AS_OF = "2026-08-15T12:00:00.000Z";
  const COACH_DEMO = "72000000-0000-4000-8000-000000000006";

  type CompositionStage = "new_lead" | "qualifying" | "booked" | "qualified_no_buy" | "disqualified";

  type CompositionMonth = {
    month: string;
    label: string;
    total: number;
    qualified: number;
    disqualified: number;
    active: number;
    partial: boolean;
  };

  type CompositionBookedPeriod = {
    month: string;
    booked: number;
  };

  // `app.inherit_is_test` overwrites any is_test a caller supplies: on contacts it derives
  // the flag from the linked test_agent_sessions row, or from the tenant's is_demo when
  // there is none. A test contact therefore has to be born of a session, not of a boolean.
  async function createDatedContact(
    tenantId: string,
    suffix: string,
    createdAt: string,
    options: {
      stage?: CompositionStage;
      outcome?: "BOOK" | "SOFT_DQ" | "HARD_DQ" | null;
      isTest?: boolean;
    } = {},
  ) {
    let testSessionId: string | null = null;
    if (options.isTest) {
      const session = await db.query<{ id: string }>(
        `insert into public.test_agent_sessions (tenant_id,started_by)
         values ($1,$2) returning id`,
        [tenantId, COACH_A],
      );
      testSessionId = session.rows[0].id;
    }
    const row = await db.query<{ id: string; is_test: boolean }>(
      `insert into public.contacts
         (tenant_id,last_channel,name,test_session_id,created_at,pipeline_stage,outcome)
       values ($1,'webchat',$2,$3,$4,$5,$6) returning id, is_test`,
      [
        tenantId,
        `Synthetic ${suffix}`,
        testSessionId,
        createdAt,
        options.stage ?? "new_lead",
        options.outcome ?? null,
      ],
    );
    expect(row.rows[0].is_test).toBe((options.isTest ?? false) || tenantId === TENANT_DEMO);
    return row.rows[0].id;
  }

  async function createDatedAppointment(
    tenantId: string,
    suffix: string,
    contactId: string,
    createdAt: string,
    status = "scheduled",
  ) {
    return db.query<{ id: string; is_test: boolean }>(
      `insert into public.appointments
         (tenant_id,contact_id,provider,external_id,start_at,end_at,timezone,status,created_at)
       values ($1,$2,'ghl',$3,$4::timestamptz + interval '1 day',
         $4::timestamptz + interval '1 day 30 minutes','America/New_York',$5,$4)
       returning id,is_test`,
      [tenantId, contactId, `composition-${suffix}`, createdAt, status],
    );
  }

  async function seedComposition() {
    const juneQualified = await createDatedContact(TENANT_A, "june-qualified", "2026-06-10T12:00:00.000Z", { stage: "booked" });
    const juneDisqualified = await createDatedContact(TENANT_A, "june-disqualified", "2026-06-11T12:00:00.000Z", { stage: "disqualified" });
    await createDatedContact(TENANT_A, "june-active", "2026-06-12T12:00:00.000Z", { stage: "qualifying" });
    await createDatedContact(TENANT_A, "june-overlap", "2026-06-13T12:00:00.000Z", {
      stage: "disqualified",
      outcome: "BOOK",
    });
    const juneTest = await createDatedContact(TENANT_A, "june-test", "2026-06-14T12:00:00.000Z", {
      stage: "booked",
      isTest: true,
    });
    const augustOutcome = await createDatedContact(TENANT_A, "august-outcome", "2026-08-05T12:00:00.000Z", {
      stage: "qualifying",
      outcome: "BOOK",
    });
    const demoQualified = await createDatedContact(TENANT_DEMO, "demo-qualified", "2026-06-10T12:00:00.000Z", { stage: "booked" });
    await createDatedAppointment(TENANT_A, "june-scheduled", juneQualified, "2026-06-10T12:00:00.000Z");
    await createDatedAppointment(TENANT_A, "june-canceled", juneDisqualified, "2026-06-11T12:00:00.000Z", "canceled");
    const testAppointment = await createDatedAppointment(TENANT_A, "june-test", juneTest, "2026-06-14T12:00:00.000Z");
    expect(testAppointment.rows[0].is_test).toBe(true);
    await createDatedAppointment(TENANT_A, "august-scheduled", augustOutcome, "2026-08-05T12:00:00.000Z");
    const demoAppointment = await createDatedAppointment(TENANT_DEMO, "demo-scheduled", demoQualified, "2026-06-10T12:00:00.000Z");
    expect(demoAppointment.rows[0].is_test).toBe(true);
  }

  async function readComposition(tenantId = TENANT_A) {
    const result = await db.query<{ snapshot: Record<string, unknown> }>(
      `select public.read_coach_lead_composition($1,$2) snapshot`,
      [tenantId, COMPOSITION_AS_OF],
    );
    return result.rows[0].snapshot;
  }

  it("returns exactly six ascending months with only the current one still filling", async () => {
    await seedComposition();
    await actAs("service_role", COACH_A, "coach", TENANT_A);
    const snapshot = await readComposition();
    expect(Object.keys(snapshot).sort()).toEqual(["asOf", "bookedByPeriod", "months", "tenantId", "timezone"]);
    expect(snapshot.tenantId).toBe(TENANT_A);
    expect(snapshot.timezone).toBe("America/New_York");
    const months = snapshot.months as CompositionMonth[];
    expect(months).toHaveLength(6);
    expect(months.map((row) => row.month.slice(0, 10))).toEqual([
      "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01",
    ]);
    expect(months.map((row) => row.partial)).toEqual([false, false, false, false, false, true]);
    expect(months.at(-1)?.label).toBe("Aug 2026");
    const bookedByPeriod = snapshot.bookedByPeriod as CompositionBookedPeriod[];
    expect(bookedByPeriod).toEqual([
      { month: "2026-03-01", booked: 0 },
      { month: "2026-04-01", booked: 0 },
      { month: "2026-05-01", booked: 0 },
      { month: "2026-06-01", booked: 1 },
      { month: "2026-07-01", booked: 0 },
      { month: "2026-08-01", booked: 1 },
    ]);
  });

  it("emits a zero row for a month with no contacts instead of dropping the bar", async () => {
    await seedComposition();
    await actAs("service_role", COACH_A, "coach", TENANT_A);
    const months = (await readComposition()).months as CompositionMonth[];
    expect(months[4]).toMatchObject({
      total: 0,
      qualified: 0,
      disqualified: 0,
      active: 0,
      partial: false,
    });
    expect(months[4].month.slice(0, 10)).toBe("2026-07-01");
  });

  it("refuses a cross-tenant composition read through the shared session actor", async () => {
    await actAs("service_role", COACH_A, "coach", TENANT_A);
    await expect(readComposition(TENANT_B)).rejects.toThrow(/PHASE7_COACH_READER_TENANT_MISMATCH/);
  });

  it("excludes test and demo appointments from booked periods, and offers no demo tenant to read at all", async () => {
    await seedComposition();
    await actAs("service_role", COACH_A, "coach", TENANT_A);
    const months = (await readComposition()).months as CompositionMonth[];
    expect(months[3]).toMatchObject({ total: 4, qualified: 1, disqualified: 2, active: 1 });
    const bookedByPeriod = (await readComposition()).bookedByPeriod as CompositionBookedPeriod[];
    expect(bookedByPeriod[3]).toEqual({ month: "2026-06-01", booked: 1 });
    await db.query("rollback");
    await db.query("begin");
    await db.query(`
      insert into public.tenants (id,slug,name,billing_contact_email,is_demo,status) values
        ('${TENANT_DEMO}','p7-demo','Phase 7 Demo','billing-demo@synthetic.test',true,'active');
      insert into public.tenant_settings (tenant_id,timezone)
        values ('${TENANT_DEMO}','America/Los_Angeles');
      insert into public.users (id,email,role,tenant_id) values
        ('${COACH_DEMO}','coach-demo@synthetic.test','coach','${TENANT_DEMO}');
    `);
    await actAs("service_role", COACH_DEMO, "coach", TENANT_DEMO);
    await expect(readComposition(TENANT_DEMO)).rejects.toThrow(/PHASE7_COACH_TENANT_UNAVAILABLE/);
  });

  it("conserves every month into its own labelled total and files an overlap once", async () => {
    await seedComposition();
    await actAs("service_role", COACH_A, "coach", TENANT_A);
    const months = (await readComposition()).months as CompositionMonth[];
    for (const row of months) {
      expect(row.qualified + row.disqualified + row.active).toBe(row.total);
    }
    expect(months[3]).toMatchObject({ disqualified: 2, qualified: 1 });
    expect(months[5]).toMatchObject({ total: 1, qualified: 1, disqualified: 0, active: 0 });
  });

  it("keeps the composition reader on the service-only execution boundary", async () => {
    const boundary = await db.query<{
      composition_anon: boolean;
      composition_authenticated: boolean;
      composition_service: boolean;
      security_definer: boolean;
      settings: string[];
      volatility: string;
    }>(`
      select
        has_function_privilege('anon','public.read_coach_lead_composition(uuid,timestamptz)','execute') composition_anon,
        has_function_privilege('authenticated','public.read_coach_lead_composition(uuid,timestamptz)','execute') composition_authenticated,
        has_function_privilege('service_role','public.read_coach_lead_composition(uuid,timestamptz)','execute') composition_service,
        procedure.prosecdef security_definer,
        procedure.proconfig settings,
        procedure.provolatile::text volatility
      from pg_proc procedure
      where procedure.oid = 'public.read_coach_lead_composition(uuid,timestamptz)'::regprocedure
    `);
    expect(boundary.rows[0]).toEqual({
      composition_anon: false,
      composition_authenticated: false,
      composition_service: true,
      security_definer: true,
      settings: ['search_path=""'],
      volatility: "s",
    });
  });
});

// The seam the app actually calls. Every case here runs with `set local role service_role` and
// no `request.jwt.claims` at all, which is exactly what `createSupabaseServiceClient()` produces:
// the pre-existing cases above hand the database a user JWT the app has no way to supply, and
// that harness delta is what let the four measurement screens ship unreachable.
describe("measurement reader actor seam", () => {
  const IMPERSONATION = "73000000-0000-4000-8000-000000000001";

  async function startImpersonation(tenantId: string) {
    await db.query(
      `insert into public.impersonation_sessions
         (id,actor_id,tenant_id,reason,started_at,ended_at,expires_at)
       values ($1,$2,$3,'synthetic seam probe',now() - interval '1 minute',null,
         now() + interval '20 minutes')`,
      [IMPERSONATION, OWNER, tenantId],
    );
  }

  it("records that the plain readers refuse the caller the app actually is", async () => {
    await actAsServiceOnly();
    await expectRaises(
      `select public.read_coach_measurement($1,'1m',null,null,now())`,
      [TENANT_A],
      /PHASE7_SESSION_ACTOR_REQUIRED/,
    );
    await expectRaises(
      `select public.read_coach_lead_composition($1,now())`,
      [TENANT_A],
      /PHASE7_SESSION_ACTOR_REQUIRED/,
    );
    await expectRaises(
      `select public.read_platform_measurement(now())`,
      [],
      /PHASE7_SESSION_ACTOR_REQUIRED/,
    );
  });

  it("returns the coach snapshot for an explicit actor with no JWT at all", async () => {
    const real = await createConversation(TENANT_A, "seam-real");
    await createConversation(TENANT_DEMO, "seam-demo");
    await db.query(`select * from public.record_conversation_step_events($1,$2,$3,$4,'q1','q2')`,
      [TENANT_A, real.conversationId, real.leadId, real.agentId]);
    await actAsServiceOnly();
    const result = await db.query<{ snapshot: Record<string, unknown> }>(
      `select public.read_coach_measurement_for_actor($1,$2,'1m',null,null,now()) snapshot`,
      [COACH_A, TENANT_A],
    );
    // isDemo is added by the wrapper (20260830000001), not by the measurement body, so the key
    // set this returns is deliberately one wider than read_coach_measurement's own, asserted
    // unchanged elsewhere in this suite.
    expect(Object.keys(result.rows[0].snapshot).sort()).toEqual([
      "allowance","funnel","isDemo","keywordConversationTotal","keywords","metrics","pipeline",
      "responses","tenantId","timezone","window","windowEnd","windowStart",
    ].sort());
    expect(result.rows[0].snapshot.tenantId).toBe(TENANT_A);
    expect(result.rows[0].snapshot.metrics as unknown[]).toHaveLength(20);
    expect(result.rows[0].snapshot.responses as Array<{ stepKey: string }>)
      .toEqual([expect.objectContaining({ stepKey: "q2" })]);
  });

  it("returns six composition months for an explicit actor with no JWT at all", async () => {
    await actAsServiceOnly();
    const result = await db.query<{ snapshot: Record<string, unknown> }>(
      `select public.read_coach_lead_composition_for_actor($1,$2,now()) snapshot`,
      [COACH_A, TENANT_A],
    );
    expect(Object.keys(result.rows[0].snapshot).sort())
      .toEqual(["asOf", "bookedByPeriod", "months", "tenantId", "timezone"]);
    expect(result.rows[0].snapshot.months as unknown[]).toHaveLength(6);
    expect(result.rows[0].snapshot.tenantId).toBe(TENANT_A);
  });

  it("returns the platform snapshot for an explicit platform actor with no JWT at all", async () => {
    await actAsServiceOnly();
    const result = await db.query<{ snapshot: Record<string, unknown> }>(
      `select public.read_platform_measurement_for_actor($1,now()) snapshot`,
      [OWNER],
    );
    expect(Object.keys(result.rows[0].snapshot).sort()).toEqual([
      "activeSubscriptionsByPeriod","asOf","deliveriesByDay","followupPerformance",
      "guardrailRules","history","metrics","provisioningPerformance","revenueByPeriod",
      "subscriptions","tenantPerformance","textingRegistrationByTenant",
    ].sort());
    const metrics = result.rows[0].snapshot.metrics as Array<{ metricKey: string }>;
    expect(metrics.map((metric) => metric.metricKey).sort()).toEqual(PLATFORM_METRICS);
  });

  it("returns active-only subscription and recognised-revenue periods, excluding demo data", async () => {
    await db.query(`
      insert into public.billing_subscriptions
        (tenant_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,status,
         current_period_start,current_period_end,provider_updated_at)
      values
        ('${TENANT_A}','cus_overview_active','sub_overview_active','price_overview','active',
         now() - interval '60 days',now() + interval '1 day',now()),
        ('${TENANT_B}','cus_overview_trial','sub_overview_trial','price_overview','trialing',
         now() - interval '60 days',now() + interval '1 day',now()),
        ('${TENANT_DEMO}','cus_overview_demo','sub_overview_demo','price_overview','active',
         now() - interval '60 days',now() + interval '1 day',now());
      insert into public.tenant_cost_rollups
        (tenant_id,window_start,window_end,recognized_subscription_cents,complete,missing_sources)
      values
        ('${TENANT_A}',now() - interval '2 days',now() + interval '28 days',12000,false,
         '{model,messaging,embedding}'),
        ('${TENANT_DEMO}',now() - interval '2 days',now() + interval '28 days',99000,false,
         '{model,messaging,embedding}');
    `);
    await actAsServiceOnly();
    const result = await db.query<{
      snapshot: {
        history: Array<{ periodStart: string; periodEnd: string; value: number; state: string }>;
        activeSubscriptionsByPeriod: Array<{ value: number; state: string }>;
        revenueByPeriod: Array<{ value: number; state: string }>;
      };
    }>(`select public.read_platform_measurement_for_actor($1,now()) snapshot`, [OWNER]);
    const snapshot = result.rows[0].snapshot;

    expect(snapshot.history).toHaveLength(12);
    expect(snapshot.activeSubscriptionsByPeriod).toHaveLength(12);
    expect(snapshot.revenueByPeriod).toHaveLength(12);
    expect(snapshot.activeSubscriptionsByPeriod.at(-1)).toEqual({ value: 1, state: "available" });
    expect(snapshot.revenueByPeriod.at(-1)).toEqual({ value: 12000, state: "available" });
    expect(snapshot.activeSubscriptionsByPeriod.every((row) => row.state === "available")).toBe(true);
    expect(snapshot.revenueByPeriod.at(-2)?.state).toBe("needs_more_history");
  });

  it("returns UTC delivery outcomes and texting registration while excluding test and demo rows", async () => {
    const asOf = "2026-10-18T12:00:00.000Z";
    const writeDelivery = async (
      tenantId: string,
      isTest: boolean,
      outcome: "delivered" | "failed",
      occurredAt: string,
    ) => {
      const notification = await db.query<{ id: string }>(
        `insert into public.notifications (tenant_id,kind,title,is_test,created_at)
         values ($1,'synthetic.delivery','Synthetic delivery',$2,$3) returning id`,
        [tenantId, isTest, occurredAt],
      );
      const delivered = outcome === "delivered";
      const delivery = await db.query<{ id: string }>(
        `insert into public.notification_deliveries
           (notification_id,destination,status,attempts,provider_reference,last_attempt_at,
            delivered_at,terminal_at,last_error_code,created_at)
         values ($1,'email',$2,1,$3,$4,$5,$6,$7,$4) returning id`,
        [
          notification.rows[0].id,
          delivered ? "delivered" : "unavailable",
          delivered ? "synthetic-provider-reference" : null,
          occurredAt,
          delivered ? occurredAt : null,
          occurredAt,
          delivered ? null : "SYNTHETIC_DELIVERY_FAILED",
        ],
      );
      await db.query(
        `insert into public.notification_delivery_attempts
           (delivery_id,attempt_number,worker_id,destination,recipient_email,started_at,
            finished_at,outcome,provider_reference,error_code)
         values ($1,1,gen_random_uuid(),'email','delivery@synthetic.test',$2,$2,$3,$4,$5)`,
        [
          delivery.rows[0].id,
          occurredAt,
          outcome,
          delivered ? "synthetic-provider-reference" : null,
          delivered ? null : "SYNTHETIC_DELIVERY_FAILED",
        ],
      );
    };

    await writeDelivery(TENANT_A, false, "delivered", "2026-10-17T23:30:00.000Z");
    await writeDelivery(TENANT_A, false, "failed", "2026-10-18T01:15:00.000Z");
    await writeDelivery(TENANT_A, true, "delivered", "2026-10-18T02:00:00.000Z");
    await writeDelivery(TENANT_DEMO, false, "delivered", "2026-10-18T03:00:00.000Z");
    await db.query(
      `insert into public.provisioning_steps (tenant_id,step_key,state,external_ref)
       values ($1,'sms_live','awaiting_provider','{}'),
         ($1,'a2p_campaign','awaiting_provider',$2::jsonb),
         ($3,'sms_live','done','{}'),
         ($3,'a2p_campaign','done',$2::jsonb)`,
      [TENANT_A, JSON.stringify({ submittedAt: "2026-10-16T12:00:00.000Z" }), TENANT_DEMO],
    );

    await actAsServiceOnly();
    const result = await db.query<{
      snapshot: {
        deliveriesByDay: Array<{ day: string; delivered: number; failed: number }>;
        textingRegistrationByTenant: Array<{
          tenantId: string;
          registrationState: string | null;
          submittedAt: string | null;
          daysElapsed: number | null;
        }>;
      };
    }>(`select public.read_platform_measurement_for_actor($1,$2,12) snapshot`, [OWNER, asOf]);
    const snapshot = result.rows[0].snapshot;
    const byDay = new Map(snapshot.deliveriesByDay.map((row) => [row.day, row]));

    expect(snapshot.deliveriesByDay).toHaveLength(30);
    expect(byDay.get("2026-10-17")).toMatchObject({ delivered: 1, failed: 0 });
    expect(byDay.get("2026-10-18")).toMatchObject({ delivered: 0, failed: 1 });
    expect(snapshot.textingRegistrationByTenant).toContainEqual({
      tenantId: TENANT_A,
      registrationState: "awaiting_provider",
      submittedAt: "2026-10-16T12:00:00+00:00",
      daysElapsed: 2,
    });
    expect(snapshot.textingRegistrationByTenant.map((row) => row.tenantId)).not.toContain(TENANT_DEMO);
  });

  it("refuses a null actor and an actor with no users row on all three wrappers", async () => {
    await actAsServiceOnly();
    const unknownActor = "72000000-0000-4000-8000-0000000000ff";
    for (const actor of [null, unknownActor]) {
      await expectRaises(
        `select public.read_coach_measurement_for_actor($1::uuid,$2::uuid,'1m',null,null,now())`,
        [actor, TENANT_A],
        /PHASE7_SESSION_ACTOR_REQUIRED/,
      );
      await expectRaises(
        `select public.read_coach_lead_composition_for_actor($1::uuid,$2::uuid,now())`,
        [actor, TENANT_A],
        /PHASE7_SESSION_ACTOR_REQUIRED/,
      );
      await expectRaises(
        `select public.read_platform_measurement_for_actor($1::uuid,now())`,
        [actor],
        /PHASE7_SESSION_ACTOR_REQUIRED/,
      );
    }
  });

  it("keeps the tenant and audience refusals the JWT path shipped", async () => {
    await actAsServiceOnly();
    await expectRaises(
      `select public.read_coach_measurement_for_actor($1,$2,'1m',null,null,now())`,
      [COACH_A, TENANT_B],
      /PHASE7_COACH_READER_TENANT_MISMATCH/,
    );
    await expectRaises(
      `select public.read_coach_lead_composition_for_actor($1,$2,now())`,
      [COACH_A, TENANT_B],
      /PHASE7_COACH_READER_TENANT_MISMATCH/,
    );
    await expectRaises(
      `select public.read_platform_measurement_for_actor($1,now())`,
      [COACH_A],
      /PHASE7_PLATFORM_READER_REQUIRED/,
    );
    await expectRaises(
      `select public.read_coach_measurement_for_actor($1,$2,'1m',null,null,now())`,
      [OWNER, TENANT_A],
      /PHASE7_COACH_READER_TENANT_MISMATCH/,
    );
  });

  it("accepts a platform actor on a coach read only while a live impersonation session says so", async () => {
    await startImpersonation(TENANT_A);
    await actAsServiceOnly();
    const result = await db.query<{ snapshot: Record<string, unknown> }>(
      `select public.read_coach_measurement_for_actor($1,$2,'1m',null,null,now()) snapshot`,
      [OWNER, TENANT_A],
    );
    expect(result.rows[0].snapshot.tenantId).toBe(TENANT_A);
    const composition = await db.query<{ snapshot: Record<string, unknown> }>(
      `select public.read_coach_lead_composition_for_actor($1,$2,now()) snapshot`,
      [OWNER, TENANT_A],
    );
    expect(composition.rows[0].snapshot.tenantId).toBe(TENANT_A);
  });

  it("refuses an ended, expired, or wrong-tenant impersonation session", async () => {
    await actAsServiceOnly();
    const probe = async () => expectRaises(
      `select public.read_coach_measurement_for_actor($1,$2,'1m',null,null,now())`,
      [OWNER, TENANT_A],
      /PHASE7_COACH_READER_TENANT_MISMATCH/,
    );

    await db.query("savepoint ended_session");
    await startImpersonation(TENANT_A);
    await db.query(`update public.impersonation_sessions set ended_at = now() where id = $1`,
      [IMPERSONATION]);
    await probe();
    await db.query("rollback to savepoint ended_session");

    await db.query("savepoint expired_session");
    await db.query(
      `insert into public.impersonation_sessions
         (id,actor_id,tenant_id,reason,started_at,ended_at,expires_at)
       values ($1,$2,$3,'expired seam probe',now() - interval '40 minutes',null,
         now() - interval '10 minutes')`,
      [IMPERSONATION, OWNER, TENANT_A],
    );
    await probe();
    await db.query("rollback to savepoint expired_session");

    await db.query("savepoint other_tenant_session");
    await startImpersonation(TENANT_B);
    await probe();
    await db.query("rollback to savepoint other_tenant_session");
  });

  it("keeps the wrappers off the authenticated execution boundary", async () => {
    await db.query(`set local role authenticated`);
    await expectRaises(
      `select public.read_coach_measurement_for_actor($1,$2,'1m',null,null,now())`,
      [COACH_A, TENANT_A],
      /permission denied for function read_coach_measurement_for_actor/,
    );
    await expectRaises(
      `select public.read_coach_lead_composition_for_actor($1,$2,now())`,
      [COACH_A, TENANT_A],
      /permission denied for function read_coach_lead_composition_for_actor/,
    );
    await expectRaises(
      `select public.read_platform_measurement_for_actor($1,now())`,
      [OWNER],
      /permission denied for function read_platform_measurement_for_actor/,
    );
  });

  it("does not let the supplied actor outlive its own transaction", async () => {
    await actAsServiceOnly();
    const result = await db.query<{ snapshot: Record<string, unknown> }>(
      `select public.read_coach_measurement_for_actor($1,$2,'1m',null,null,now()) snapshot`,
      [COACH_A, TENANT_A],
    );
    expect(result.rows[0].snapshot.tenantId).toBe(TENANT_A);
    await db.query("rollback");
    await db.query("begin");
    await actAsServiceOnly();
    await expect(db.query(`select public.read_coach_measurement($1,'1m',null,null,now())`,
      [TENANT_A])).rejects.toThrow(/PHASE7_SESSION_ACTOR_REQUIRED/);
  });

  it("merges platform questions with tenant order and enabled overrides, with an audit for each write", async () => {
    const first = "74000000-0000-4000-8000-000000000001";
    const second = "74000000-0000-4000-8000-000000000002";
    const vector = `[${Array<number>(1536).fill(0).join(",")}]`;
    await db.query(
      `insert into public.brain_knowledge_entries
        (id,question,answer,category,status,source,source_ref,disposition,response_template,embedding,created_at)
       values
        ($1,'What is your goal?','Synthetic answer','General Questions','published','mock',
          'coach-question-first','shared','Synthetic answer',$3::vector,'2026-01-01T00:00:00Z'),
        ($2,'What is your credit score?','Synthetic answer','Credit','published','mock',
          'coach-question-second','shared','Synthetic answer',$3::vector,'2026-01-02T00:00:00Z')`,
      [first, second, vector],
    );
    await actAsServiceOnly();

    const defaults = await db.query<{ snapshot: { questions: Array<{ id: string }> } }>(
      `select public.read_coach_questions_for_actor($1,$2) snapshot`, [COACH_A, TENANT_A],
    );
    const questionIds = [
      second,
      first,
      ...defaults.rows[0].snapshot.questions
        .map((question) => question.id)
        .filter((id) => id !== first && id !== second),
    ];

    await db.query(`select * from public.reorder_coach_questions($1,$2,$3::uuid[])`, [
      TENANT_A, COACH_A, questionIds,
    ]);
    await db.query(`select * from public.set_coach_question_enabled($1,$2,$3,false)`, [
      TENANT_A, COACH_A, first,
    ]);
    const result = await db.query<{ snapshot: { tenantId: string; questions: Array<Record<string, unknown>> } }>(
      `select public.read_coach_questions_for_actor($1,$2) snapshot`, [COACH_A, TENANT_A],
    );
    const questions = result.rows[0].snapshot.questions.filter((question) =>
      question.id === first || question.id === second,
    );
    expect(result.rows[0].snapshot.tenantId).toBe(TENANT_A);
    expect(questions).toEqual([
      { id: second, text: "What is your credit score?", tag: "Credit", enabled: true, position: 0 },
      { id: first, text: "What is your goal?", tag: "General Questions", enabled: false, position: 1 },
    ]);
    const audit = await db.query<{ action: string; count: string }>(`
      select action, count(*)::text count from public.audit_log
      where tenant_id=$1 and action in ('coach.question_order.saved','coach.question.enabled.changed')
      group by action order by action
    `, [TENANT_A]);
    expect(audit.rows).toEqual([
      { action: "coach.question.enabled.changed", count: "1" },
      { action: "coach.question_order.saved", count: "1" },
    ]);
    await expectRaises(
      `select * from public.set_coach_question_enabled($1,$2,$3,false)`,
      [TENANT_B, COACH_A, first],
      /PHASE7_COACH_READER_TENANT_MISMATCH/,
    );
  });
});

const COACH_DEMO = "72000000-0000-4000-8000-000000000006";
const DEMO_TIER = "73000000-0000-4000-8000-000000000009";

const WIDENED_VIEWS = [
  "analytics_appointments",
  "analytics_billable_events",
  "analytics_billing_subscriptions",
  "analytics_contacts",
  "analytics_conversation_step_events",
  "analytics_conversations",
  "analytics_messages",
  "analytics_tenants",
] as const;

// Everything the coach path reads, planted inside the demo tenant. `app.inherit_is_test` stamps
// every one of these rows `is_test = true` because their tenant is a demo tenant, which is why
// relaxing only the `is_demo` predicate would still hand the coach a wall of zeros.
async function seedDemoTenant() {
  await db.query(
    `insert into public.users (id,email,role,tenant_id)
     values ($1,'coach-demo@synthetic.test','coach',$2)`,
    [COACH_DEMO, TENANT_DEMO],
  );
  await db.query(
    `insert into public.tiers (id,name,price_cents,call_allowance,stripe_price_id)
     values ($1,'Synthetic demo tier',9900,25,'price_demo_synthetic')`,
    [DEMO_TIER],
  );
  await db.query(
    `insert into public.billing_subscriptions
       (tenant_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,status,
        current_period_start,current_period_end,provider_updated_at)
     values ($1,'cus_demo_synthetic','sub_demo_synthetic','price_demo_synthetic','active',
       now() - interval '2 days', now() + interval '28 days', now())`,
    [TENANT_DEMO],
  );
  const first = await createConversation(TENANT_DEMO, "demo-one");
  const second = await createConversation(TENANT_DEMO, "demo-two");
  await db.query(`select * from public.record_conversation_step_events($1,$2,$3,$4,'q1','q2')`,
    [TENANT_DEMO, first.conversationId, first.leadId, first.agentId]);
  const appointment = await db.query<{ id: string }>(
    `insert into public.appointments
       (tenant_id,contact_id,conversation_id,provider,external_id,start_at,end_at,timezone)
     values ($1,$2,$3,'ghl','demo-widening-appointment', now() + interval '1 day',
       now() + interval '1 day 30 minutes','America/Los_Angeles') returning id`,
    [TENANT_DEMO, first.contactId, first.conversationId],
  );
  await db.query(
    `insert into public.billable_events (tenant_id,quantity,appointment_id)
     values ($1,1,$2)`,
    [TENANT_DEMO, appointment.rows[0].id],
  );
  return { first, second, appointmentId: appointment.rows[0].id };
}

// Inside a non-demo tenant `is_test` cannot be set by passing the column: `app.inherit_is_test`
// overwrites it with `tenants.is_demo` unless the contact carries a test_session_id. A test-agent
// session is the only way a real tenant gets genuinely test-flagged rows, and it is the shape the
// product actually produces, so it is the shape the exclusion has to be proven against.
async function createTestSessionConversation(tenantId: string, suffix: string) {
  const session = await db.query<{ id: string }>(
    `insert into public.test_agent_sessions (tenant_id,started_by) values ($1,$2) returning id`,
    [tenantId, COACH_A],
  );
  const contact = await db.query<{ id: string; is_test: boolean }>(
    `insert into public.contacts (tenant_id,last_channel,name,test_session_id)
     values ($1,'webchat',$2,$3) returning id, is_test`,
    [tenantId, `Synthetic ${suffix}`, session.rows[0].id],
  );
  expect(contact.rows[0].is_test).toBe(true);
  const conversation = await db.query<{ id: string }>(
    `insert into public.conversations (tenant_id,contact_id,channel)
     values ($1,$2,'webchat') returning id`,
    [tenantId, contact.rows[0].id],
  );
  return { contactId: contact.rows[0].id, conversationId: conversation.rows[0].id };
}

type CoachSnapshot = {
  tenantId: string;
  isDemo: boolean;
  metrics: Array<{ metricKey: string; value: number | null; state: string }>;
  pipeline: Array<{ contactId: string }>;
  allowance: { used: number | null; limit: number | null; state: string };
};

async function readCoachSnapshot(actor: string, tenant: string) {
  const result = await db.query<{ snapshot: CoachSnapshot }>(
    `select public.read_coach_measurement_for_actor($1,$2,'1m',null,null,now()) snapshot`,
    [actor, tenant],
  );
  return result.rows[0].snapshot;
}

function metricValue(snapshot: CoachSnapshot, key: string) {
  return snapshot.metrics.find((row) => row.metricKey === key)?.value ?? null;
}

describe("own-demo-tenant visibility for the coach path", () => {
  it("shows a demo tenant's coach that tenant's own contacts, appointments and allowance", async () => {
    await seedDemoTenant();
    await actAsServiceOnly();
    const snapshot = await readCoachSnapshot(COACH_DEMO, TENANT_DEMO);

    expect(snapshot.tenantId).toBe(TENANT_DEMO);
    expect(snapshot.isDemo).toBe(true);
    expect(metricValue(snapshot, "coach.new_leads")).toBe(2);
    expect(metricValue(snapshot, "coach.booked_contacts")).toBe(1);
    expect(snapshot.pipeline).toHaveLength(2);
    expect(snapshot.allowance).toMatchObject({ state: "available", limit: 25, used: 1 });
  });

  it("returns six composition months for the demo tenant with a real total in one of them", async () => {
    await seedDemoTenant();
    await actAsServiceOnly();
    const result = await db.query<{ snapshot: { months: Array<{ total: number }> } }>(
      `select public.read_coach_lead_composition_for_actor($1,$2,now()) snapshot`,
      [COACH_DEMO, TENANT_DEMO],
    );
    const months = result.rows[0].snapshot.months;
    expect(months).toHaveLength(6);
    expect(months[months.length - 1].total).toBe(2);
  });

  it("keeps the demo tenant out of a platform read that runs right after the coach read", async () => {
    await seedDemoTenant();
    await actAsServiceOnly();
    await readCoachSnapshot(COACH_DEMO, TENANT_DEMO);

    const platform = await db.query<{
      snapshot: {
        subscriptions: Array<{ tenantId: string }>;
        tenantPerformance: Array<{ tenantId: string }>;
        metrics: Array<{ metricKey: string; value: number | null }>;
      };
      // The signup count is `created_at < as_of` over analytics_tenants, and `now()` is the
      // transaction timestamp - the same instant these fixture tenants were inserted at - so an
      // as_of of exactly now() counts none of them and the assertion would prove nothing about
      // which tenants were excluded. A second later, A and B are in and the demo tenant is out.
    }>(`select public.read_platform_measurement_for_actor($1,now() + interval '1 second') snapshot`,
      [OWNER]);
    const snapshot = platform.rows[0].snapshot;

    expect(snapshot.tenantPerformance.map((row) => row.tenantId).sort())
      .toEqual([TENANT_A, TENANT_B].sort());
    expect(snapshot.subscriptions.map((row) => row.tenantId)).not.toContain(TENANT_DEMO);
    expect(snapshot.metrics.find((row) => row.metricKey === "platform.new_signups")?.value)
      .toBe(2);
  });

  it("refuses a foreign demo tenant before any widening can happen", async () => {
    await seedDemoTenant();
    await actAsServiceOnly();
    await expectRaises(
      `select public.read_coach_measurement_for_actor($1,$2,'1m',null,null,now())`,
      [COACH_A, TENANT_DEMO],
      /PHASE7_COACH_READER_TENANT_MISMATCH/,
    );
    const leaked = await db.query<{ widened: string | null }>(
      `select nullif(current_setting('app.phase7_demo_tenant', true), '') widened`,
    );
    expect(leaked.rows[0].widened).toBeNull();
  });

  it("leaves a real tenant's own test rows excluded and its snapshot undemoted", async () => {
    const real = await createConversation(TENANT_A, "real");
    await createTestSessionConversation(TENANT_A, "flagged");
    await db.query(`select * from public.record_conversation_step_events($1,$2,$3,$4,'q1','q2')`,
      [TENANT_A, real.conversationId, real.leadId, real.agentId]);
    await actAsServiceOnly();
    const snapshot = await readCoachSnapshot(COACH_A, TENANT_A);

    expect(snapshot.isDemo).toBe(false);
    expect(metricValue(snapshot, "coach.new_leads")).toBe(1);
    expect(snapshot.pipeline).toHaveLength(1);
  });

  it("returns nothing from the eight widened views when no reader has widened them", async () => {
    await seedDemoTenant();
    for (const view of WIDENED_VIEWS) {
      await actAsServiceOnly();
      const asService = await db.query<{ count: string }>(
        `select count(*)::text from public.${view} where tenant_id = $1`,
        [TENANT_DEMO],
      );
      expect([view, asService.rows[0].count]).toEqual([view, "0"]);

      await actAs("authenticated", COACH_DEMO, "coach", TENANT_DEMO);
      const asCoach = await db.query<{ count: string }>(
        `select count(*)::text from public.${view} where tenant_id = $1`,
        [TENANT_DEMO],
      );
      expect([view, asCoach.rows[0].count]).toEqual([view, "0"]);
    }
  });
});
