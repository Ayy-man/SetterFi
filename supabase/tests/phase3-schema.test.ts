// Phase 3 schema contract. Populated-table constraints, service-only RPC custody, cascade
// survival, and concurrency behavior require the real migrated Postgres stack.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

// The other eleven suites resolve the stack this way. Shelling out to `npx supabase status`
// made this file's connection depend on the npm registry being reachable at test time, and a
// transient npx failure turned the security gate red while the database itself was healthy.
const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT = "60000000-0000-4000-8000-000000000010";
const OTHER_TENANT = "60000000-0000-4000-8000-000000000020";
const ADMIN = "61000000-0000-4000-8000-000000000010";
const COACH = "61000000-0000-4000-8000-000000000020";
const CONTACT = "62000000-0000-4000-8000-000000000010";
const SEEDED_SUPPRESSED_CONTACT = "62000000-0000-4000-8000-000000000020";
const CONVERSATION = "63000000-0000-4000-8000-000000000010";
const INBOUND = "63000000-0000-4000-8000-000000000020";
const IDENTITY = "64000000-0000-4000-8000-000000000010";
const GHL_INSTALL = "64000000-0000-4000-8000-000000000020";
const GHL_LOCATION = "phase3-location";
const FOLLOWUP = "65000000-0000-4000-8000-000000000010";
const APPOINTMENT = "66000000-0000-4000-8000-000000000010";
const BILLABLE = "67000000-0000-4000-8000-000000000010";
const EVAL_CASE = "68000000-0000-4000-8000-000000000010";

const SERVICE_RPCS = [
  "apply_scope_signal",
  "apply_tripwire_signal",
  "cancel_contact_followups_on_inbound",
  "claim_due_followups",
  "clear_identity_suppression",
  "complete_followup_attempt",
  "preview_contact_deletion",
  "persist_outbound_send",
  "record_keyword_suppression",
  "record_provider_suppression_result",
  "register_tenant_test_recipient",
].sort();

let db: Client;

async function expectDbError(sql: string, params: readonly unknown[], expected: RegExp) {
  await db.query("savepoint expected_phase3_failure");
  let error: unknown;
  try {
    await db.query(sql, params as unknown[]);
  } catch (cause) {
    error = cause;
  }
  await db.query("rollback to savepoint expected_phase3_failure");
  expect(String(error)).toMatch(expected);
}

async function expectServiceRoleDbError(
  sql: string,
  params: readonly unknown[],
  expected: RegExp,
) {
  await db.query("savepoint expected_phase3_service_failure");
  await db.query("set local role service_role");
  let error: unknown;
  try {
    await db.query(sql, params as unknown[]);
  } catch (cause) {
    error = cause;
  }
  await db.query("rollback to savepoint expected_phase3_service_failure");
  expect(String(error)).toMatch(expected);
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 3 schema suite could not reach Postgres at ${DB_URL}. ` +
        "Start the local Supabase stack; this suite fails rather than skips.",
      { cause },
    );
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  // Every existing table constrained or mutated by Phase 3 carries a synthetic row. This makes
  // success representative of a populated hosted-shaped database rather than an empty schema.
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email) values
      ('${TENANT}', 'phase3-a', 'Phase 3 A', 'billing-a@phase3.test'),
      ('${OTHER_TENANT}', 'phase3-b', 'Phase 3 B', 'billing-b@phase3.test');
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@phase3.test', 'admin', null),
      ('${COACH}', 'coach@phase3.test', 'coach', '${TENANT}');
    insert into public.tenant_settings (tenant_id) values ('${TENANT}');
    insert into public.ghl_installs
      (id, tenant_id, location_id, company_id, token_expires_at)
      values ('${GHL_INSTALL}', '${TENANT}', '${GHL_LOCATION}', 'phase3-company', now() + interval '1 day');
    insert into public.contacts (id, tenant_id, last_channel, name) values
      ('${CONTACT}', '${TENANT}', 'sms', 'Synthetic compliance lead'),
      ('${SEEDED_SUPPRESSED_CONTACT}', '${TENANT}', 'sms', 'Synthetic suppressed lead');
    insert into public.conversations (id, tenant_id, contact_id, channel)
      values ('${CONVERSATION}', '${TENANT}', '${CONTACT}', 'sms');
    insert into public.messages
      (id, tenant_id, conversation_id, direction, author, body, provider, provider_message_id)
      values ('${INBOUND}', '${TENANT}', '${CONVERSATION}', 'in', 'lead',
        'Synthetic inbound', 'ghl', 'phase3-inbound');
    update public.conversations
      set cadence_anchor_at=now()-interval '1 day', cadence_anchor_message_id='${INBOUND}',
          last_lead_inbound_at=now()-interval '1 day'
      where id='${CONVERSATION}';
    insert into public.contact_identities
      (id, tenant_id, contact_id, provider, channel, provider_identity_id,
       provider_account_id, ghl_install_id, consent_state, consent_source, consent_captured_at, consent_expires_at)
      values ('${IDENTITY}', '${TENANT}', '${CONTACT}', 'ghl', 'sms', 'phase3-identity',
        '${GHL_LOCATION}', '${GHL_INSTALL}', 'opted_in', 'web_form', now()-interval '1 day', now()+interval '89 days');
    insert into public.followups
      (id, tenant_id, conversation_id, touch_no, purpose, scheduled_at,
       cadence_anchor_at, channel_class)
      values ('${FOLLOWUP}', '${TENANT}', '${CONVERSATION}', 1, 'lead_magnet',
        now()-interval '1 minute', now()-interval '1 day', 'durable');
    insert into public.appointments
      (id, tenant_id, contact_id, conversation_id, provider, external_id,
       start_at, end_at, attributed_to_agent)
      values ('${APPOINTMENT}', '${TENANT}', '${CONTACT}', '${CONVERSATION}', 'ghl',
        'phase3-appointment', now()+interval '1 day', now()+interval '1 day 61 minutes', true);
    insert into public.billable_events (id, tenant_id, quantity, appointment_id)
      values ('${BILLABLE}', '${TENANT}', 1, '${APPOINTMENT}');
    insert into public.suppression_entries
      (tenant_id, channel, identifier_hash, identifier_last4, contact_id,
       source, reason, provider_sync_state)
      values ('${TENANT}', 'sms', repeat('1',64), '0001', '${SEEDED_SUPPRESSED_CONTACT}',
        'manual', 'Synthetic manual suppression', 'pending');
    insert into public.tenant_test_recipients
      (tenant_id, channel, identifier_hash, identifier_last4, verified_at, verified_by)
      values ('${TENANT}', 'sms', repeat('2',64), '0002', now(), '${ADMIN}');
    insert into public.suppression_tombstones
      (tenant_id, channel, identifier_hash, identifier_last4)
      values ('${TENANT}', 'sms', repeat('3',64), '0003');
    insert into public.eval_cases
      (id, turns, expectation, suite, kind, category, source_tenant_id,
       source_conversation_id, source_message_id, source_contact_id, promoted_by)
      values ('${EVAL_CASE}', '["Synthetic turn"]', '{}', 'qualification_accuracy',
        'engine', 'qualification', '${TENANT}', '${CONVERSATION}', '${INBOUND}',
        '${CONTACT}', '${ADMIN}');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("Phase 3 migration and catalog contract", () => {
  it("extends the Phase 1 tables and leaves followup_status untouched", () => {
    const migration = readFileSync(
      resolve("supabase/migrations/20260819000001_phase3_compliance_safety.sql"),
      "utf8",
    );
    expect(migration).not.toMatch(/create table public\.(contacts|conversations|followups|billable_events)/i);
    expect(migration).not.toMatch(/alter type public\.followup_status/i);
    expect(migration).not.toMatch(/create type public\.followup_status/i);
    expect(migration).toContain("PHASE3_FOLLOWUP_CADENCE_REMEDIATION_REQUIRED");
    expect(migration).toContain("PHASE3_AGENT_CONTENT_APPROVAL_REVIEW_REQUIRED");
  });

  it("installs the exact durable columns and keeps cadence class advisory", async () => {
    const columns = await db.query<{ signature: string }>(`
      select table_name || '.' || column_name as signature
      from information_schema.columns
      where table_schema='public' and (table_name,column_name) in (
        ('billable_events','appointment_detached_at'),
        ('contacts','deletion_preview_token'),
        ('conversations','tripwire_classes'),
        ('followups','claim_token'),
        ('followups','paused_at'),
        ('followups','remaining_offset_seconds'),
        ('suppression_entries','provider_sync_attempts')
      ) order by 1
    `);
    expect(columns.rows.map((row) => row.signature)).toEqual([
      "billable_events.appointment_detached_at",
      "contacts.deletion_preview_token",
      "conversations.tripwire_classes",
      "followups.claim_token",
      "followups.paused_at",
      "followups.remaining_offset_seconds",
      "suppression_entries.provider_sync_attempts",
    ]);
    const comment = await db.query<{ description: string }>(`
      select col_description('public.followups'::regclass,
        (select attnum from pg_attribute
         where attrelid='public.followups'::regclass and attname='channel_class')) description
    `);
    expect(comment.rows[0].description).toMatch(/Advisory record only/);
    const content = await db.query<{ approved: boolean; stop_copy: string; scope_copy: string }>(`
      select approved, agent_content->'controlCopy'->>'STOP' stop_copy,
        agent_content->>'scopeDeflection1' scope_copy
      from public.platform_settings where singleton
    `);
    expect(content.rows[0]).toEqual({
      approved: false,
      stop_copy: "SETTERFI_DEMO_PLACEHOLDER_STOP_COPY",
      scope_copy: "SETTERFI_DEMO_PLACEHOLDER_SCOPE_DEFLECTION_1",
    });
  });

  it("forces RLS on both new tables and exposes the intended policy commands", async () => {
    const tables = await db.query<{
      relname: string;
      relforcerowsecurity: boolean;
      commands: string[];
    }>(`
      select class.relname, class.relforcerowsecurity,
        array_agg(policy.cmd order by policy.cmd)::text[] commands
      from pg_class class join pg_namespace namespace on namespace.oid=class.relnamespace
      join pg_policies policy on policy.schemaname=namespace.nspname
        and policy.tablename=class.relname
      where namespace.nspname='public'
        and class.relname in ('suppression_tombstones','tenant_test_recipients')
      group by class.relname,class.relforcerowsecurity order by class.relname
    `);
    expect(tables.rows).toEqual([
      { relname: "suppression_tombstones", relforcerowsecurity: true, commands: ["ALL", "SELECT"] },
      {
        relname: "tenant_test_recipients",
        relforcerowsecurity: true,
        commands: ["ALL", "SELECT", "SELECT"],
      },
    ]);
    const forbiddenColumns = await db.query<{ signature: string }>(`
      select table_name || '.' || column_name signature
      from information_schema.columns
      where table_schema='public'
        and table_name in ('suppression_tombstones','tenant_test_recipients')
        and column_name in ('identifier','phone','email','name','message','body','freeform')
      order by 1
    `);
    expect(forbiddenColumns.rows).toEqual([]);
  });

  it("pins every Phase 3 transition to service_role with an empty search path", async () => {
    const functions = await db.query<{ proname: string; proconfig: string[]; grantees: string[] }>(`
      select procedure.proname, procedure.proconfig,
        array(
          select coalesce(role.rolname,'PUBLIC')::text
          from aclexplode(coalesce(procedure.proacl,acldefault('f',procedure.proowner))) acl
          left join pg_roles role on role.oid=acl.grantee
          where acl.privilege_type='EXECUTE' and role.rolname <> 'postgres'
          order by coalesce(role.rolname,'PUBLIC')
        )::text[] grantees
      from pg_proc procedure join pg_namespace namespace on namespace.oid=procedure.pronamespace
      where namespace.nspname='public' and procedure.proname=any($1::text[])
      order by procedure.proname
    `, [SERVICE_RPCS]);
    expect(functions.rows.map((row) => row.proname)).toEqual(SERVICE_RPCS);
    expect(functions.rows.every((row) => row.proconfig.includes('search_path=""'))).toBe(true);
    expect(functions.rows.every((row) => row.grantees.join(",") === "service_role")).toBe(true);
  });

  it("rejects malformed hashes, second deferrals, and nullable cadence anchors", async () => {
    await expectDbError(
      `insert into public.tenant_test_recipients
       (tenant_id,channel,identifier_hash,verified_at,verified_by)
       values ($1,'sms','not-a-hash',now(),$2)`,
      [TENANT, ADMIN],
      /tenant_test_recipients_identifier_hash_check/,
    );
    await expectDbError(
      `update public.followups set deferred_count=2 where id=$1`,
      [FOLLOWUP],
      /followups_one_deferral_chk/,
    );
    await expectDbError(
      `update public.followups set cadence_anchor_at=null where id=$1`,
      [FOLLOWUP],
      /cadence_anchor_at.*not-null|cadence_anchor_at.*not null|followups_consent_window_chk/,
    );
  });

  it("keeps an off-allowlist identity representable without authorizing its hash", async () => {
    const setup = await db.query<{ identities: string; recipients: string }>(`
      select
        (select count(*)::text from public.contact_identities where id=$1) identities,
        (select count(*)::text from public.tenant_test_recipients
         where tenant_id=$2 and channel='sms' and identifier_hash=repeat('7',64)) recipients
    `, [IDENTITY, TENANT]);
    expect(setup.rows[0]).toEqual({ identities: "1", recipients: "0" });
    const claimDefinition = await db.query<{ definition: string }>(`
      select pg_get_functiondef('public.claim_due_followups(uuid,text,int,int,timestamptz)'::regprocedure)
        definition
    `);
    expect(claimDefinition.rows[0].definition).not.toMatch(/channel_class/);
  });
});

describe("Phase 3 transactional invariants", () => {
  it("keeps direct message DML revoked while the outbound RPC persists message and audit atomically", async () => {
    await expectServiceRoleDbError(
      `insert into public.messages (tenant_id,conversation_id,direction,author,body,is_test)
       values ($1,$2,'out','agent','Synthetic direct insert',true)`,
      [TENANT, CONVERSATION],
      /permission denied for table messages/,
    );

    await db.query("set local role service_role");
    const persisted = await db.query<{
      message_id: string;
      audit_id: string;
      persisted_at: Date;
    }>(
      `select * from public.persist_outbound_send(
        $1,$2,'agent_reply',null,'Synthetic RPC outbound','ghl',
        'phase3-rpc-provider-1','phase3-rpc-state-1',true
      )`,
      [TENANT, CONVERSATION],
    );
    await db.query("reset role");
    const evidence = await db.query<{
      message_id: string;
      provider_message_id: string;
      state_entry_key: string;
      is_test: boolean;
      audit_id: string;
      action: string;
      audit_message_id: string;
    }>(`
      select message.id message_id, message.provider_message_id, message.state_entry_key,
        message.is_test, audit.id audit_id, audit.action,
        audit.payload->>'messageId' audit_message_id
      from public.messages message
      join public.audit_log audit
        on audit.tenant_id=message.tenant_id
       and audit.target_id=message.conversation_id::text
       and audit.payload->>'messageId'=message.id::text
      where message.id=$1
    `, [persisted.rows[0].message_id]);
    expect(evidence.rows[0]).toEqual({
      message_id: persisted.rows[0].message_id,
      provider_message_id: "phase3-rpc-provider-1",
      state_entry_key: "phase3-rpc-state-1",
      is_test: false,
      audit_id: String(persisted.rows[0].audit_id),
      action: "conversation.channel_continued",
      audit_message_id: persisted.rows[0].message_id,
    });

    // The rollback provocation used to be an agent_reply carrying an actor, which raised
    // AUDIT_SYSTEM_ACTOR_FORBIDDEN because the RPC passed p_actor_id through on every purpose.
    // 20260829000101 picks the actor from the same case that picks the key, so that call now
    // succeeds. The mirror-image failure is still reachable and still proves atomicity: a
    // human_reply is registered actor_kind = 'human' and the RPC has a nullable actor argument.
    await expectDbError(
      `select * from public.persist_outbound_send(
        $1,$2,'human_reply',null,'Synthetic rollback outbound','ghl',
        'phase3-rpc-provider-rollback','phase3-rpc-state-rollback',true
      )`,
      [TENANT, CONVERSATION],
      /AUDIT_HUMAN_ACTOR_REQUIRED/,
    );
    const rolledBack = await db.query<{ messages: string; audits: string }>(`
      select
        (select count(*)::text from public.messages
         where state_entry_key='phase3-rpc-state-rollback') messages,
        (select count(*)::text from public.audit_log
         where payload->>'providerMessageId'='phase3-rpc-provider-rollback') audits
    `);
    expect(rolledBack.rows[0]).toEqual({ messages: "0", audits: "0" });
  });

  it("rejects expected-tenant mismatch and a cross-tenant conversation", async () => {
    await expectDbError(
      `select * from public.persist_outbound_send(
        $1,$2,'agent_reply',null,'Synthetic mismatch','ghl',
        'phase3-rpc-provider-mismatch','phase3-rpc-state-mismatch',true
      )`,
      [OTHER_TENANT, CONVERSATION],
      /EXPECTED_TENANT_MISMATCH:conversation/,
    );

    const foreignContact = "62000000-0000-4000-8000-000000000099";
    const foreignConversation = "63000000-0000-4000-8000-000000000099";
    await db.query(
      `insert into public.contacts (id,tenant_id,last_channel,name)
       values ($1,$2,'sms','Synthetic foreign lead')`,
      [foreignContact, OTHER_TENANT],
    );
    await db.query(
      `insert into public.conversations (id,tenant_id,contact_id,channel)
       values ($1,$2,$3,'sms')`,
      [foreignConversation, OTHER_TENANT, foreignContact],
    );
    await expectDbError(
      `select * from public.persist_outbound_send(
        $1,$2,'agent_reply',null,'Synthetic cross-tenant','ghl',
        'phase3-rpc-provider-cross','phase3-rpc-state-cross',true
      )`,
      [TENANT, foreignConversation],
      /EXPECTED_TENANT_MISMATCH:conversation/,
    );
  });

  it("registers one verified test recipient and one audit row under replay", async () => {
    const sql = `select * from public.register_tenant_test_recipient($1,'sms',$2,'0004',$3)`;
    const first = await db.query(sql, [TENANT, "4".repeat(64), ADMIN]);
    const replay = await db.query(sql, [TENANT, "4".repeat(64), ADMIN]);
    expect(first.rows[0].inserted).toBe(true);
    expect(replay.rows[0]).toMatchObject({ inserted: false, audit_id: null });
    const counts = await db.query<{ recipients: string; audits: string }>(`
      select
        (select count(*)::text from public.tenant_test_recipients
         where identifier_hash=repeat('4',64)) recipients,
        (select count(*)::text from public.audit_log
         where action='test_recipient.registered' and target_id=$1) audits
    `, [first.rows[0].recipient_id]);
    expect(counts.rows[0]).toEqual({ recipients: "1", audits: "1" });
  });

  it("records STOP once, cancels future work, and reserves one confirmation", async () => {
    const call = `select * from public.record_keyword_suppression(
      $1,$2,array['sms']::public.messaging_channel[],array[$3]::text[],array['0005']::text[],
      'stop_keyword','phase3-stop-replay')`;
    const first = await db.query(call, [TENANT, CONTACT, "5".repeat(64)]);
    const replay = await db.query(call, [TENANT, CONTACT, "5".repeat(64)]);
    expect(first.rows[0].confirmation_reserved).toBe(true);
    expect(replay.rows[0]).toMatchObject({ confirmation_reserved: false, audit_id: null });
    const state = await db.query<{
      opted_out: boolean;
      status: string;
      followup_status: string;
      suppressions: string;
      audits: string;
    }>(`
      select contact.opted_out, conversation.status::text,
        followup.status::text followup_status,
        (select count(*)::text from public.suppression_entries
         where contact_id=contact.id and identifier_hash=repeat('5',64)) suppressions,
        (select count(*)::text from public.audit_log
         where action='suppression.insert.keyword' and target_id=contact.id::text) audits
      from public.contacts contact
      join public.conversations conversation on conversation.contact_id=contact.id
      join public.followups followup on followup.conversation_id=conversation.id
      where contact.id=$1
    `, [CONTACT]);
    expect(state.rows[0]).toEqual({
      opted_out: true,
      status: "opted_out",
      followup_status: "canceled",
      suppressions: "1",
      audits: "1",
    });
  });

  it("clears the stale STOP confirmation reservation after the final START clear", async () => {
    await db.query(
      `select * from public.record_keyword_suppression(
        $1,$2,array['sms']::public.messaging_channel[],array[$3]::text[],array['0007']::text[],
        'stop_keyword','phase3-stop-then-start')`,
      [TENANT, CONTACT, "7".repeat(64)],
    );
    await db.query(
      "select public.clear_identity_suppression($1,$2,$3,$4,true)",
      [TENANT, CONTACT, IDENTITY, "7".repeat(64)],
    );

    const contact = await db.query<{
      opted_out: boolean;
      stop_confirmation_key: string | null;
      stop_confirmation_reserved_at: Date | null;
      stop_confirmation_sent_at: Date | null;
    }>(`
      select opted_out, stop_confirmation_key, stop_confirmation_reserved_at,
        stop_confirmation_sent_at
      from public.contacts where id=$1
    `, [CONTACT]);
    expect(contact.rows[0]).toEqual({
      opted_out: false,
      stop_confirmation_key: null,
      stop_confirmation_reserved_at: null,
      stop_confirmation_sent_at: null,
    });
  });

  it("excludes paused rows from claims and restores their remaining offset on hand-back", async () => {
    const claim = await db.query(
      `select public.claim_conversation($1,$2,$3,'agent',null,false) audit_id`,
      [TENANT, CONVERSATION, COACH],
    );
    expect(claim.rows[0].audit_id).toBeTruthy();
    const paused = await db.query<{ status: string; paused: boolean; remaining: number }>(`
      select status::text, paused_at is not null paused, remaining_offset_seconds remaining
      from public.followups where id=$1
    `, [FOLLOWUP]);
    expect(paused.rows[0].status).toBe("scheduled");
    expect(paused.rows[0].paused).toBe(true);
    expect(paused.rows[0].remaining).toBeGreaterThanOrEqual(0);
    const due = await db.query(
      `select * from public.claim_due_followups($1,'phase3-worker',10,60,now())`,
      [TENANT],
    );
    expect(due.rows).toEqual([]);

    await db.query(`select public.release_conversation($1,$2,$3,$3)`, [
      TENANT,
      CONVERSATION,
      COACH,
    ]);
    const resumed = await db.query<{ paused: boolean; scheduled_future: boolean }>(`
      select paused_at is not null paused, scheduled_at >= now() scheduled_future
      from public.followups where id=$1
    `, [FOLLOWUP]);
    expect(resumed.rows[0]).toEqual({ paused: false, scheduled_future: true });
  });

  it("claims one due attempt once and cancels it when a lead-authored inbound arrives", async () => {
    const first = await db.query(
      `select * from public.claim_due_followups($1,'phase3-worker',10,60,now())`,
      [TENANT],
    );
    const second = await db.query(
      `select * from public.claim_due_followups($1,'phase3-worker',10,60,now())`,
      [TENANT],
    );
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toEqual([]);
    const canceled = await db.query(
      `select * from public.cancel_contact_followups_on_inbound($1,$2,$3)`,
      [TENANT, CONTACT, INBOUND],
    );
    expect(canceled.rows[0].canceled_count).toBe(1);
    const state = await db.query<{ status: string; reason: string; claims: string }>(`
      select status::text,canceled_reason::text reason,
        (select count(*)::text from public.audit_log
         where action='followup.claimed' and target_id=$1::text) claims
      from public.followups where id=$1::uuid
    `, [FOLLOWUP]);
    expect(state.rows[0]).toEqual({ status: "canceled", reason: "lead_reply", claims: "1" });
  });

  it("persists the scope ladder and escalates the second refuse class", async () => {
    const actions: string[] = [];
    for (const key of ["scope-1", "scope-2", "scope-3"]) {
      const result = await db.query(
        `select * from public.apply_scope_signal($1,$2,$3)`,
        [TENANT, CONVERSATION, key],
      );
      actions.push(result.rows[0].action);
    }
    expect(actions).toEqual(["deflect_1", "deflect_2", "scope_blocked"]);
    const scope = await db.query<{ count: number; status: string }>(`
      select scope_attack_count count,status::text from public.conversations where id=$1
    `, [CONVERSATION]);
    expect(scope.rows[0]).toEqual({ count: 3, status: "scope_blocked" });

    await db.query(`update public.conversations set status='agent',status_reason=null,
      scope_attack_count=0 where id=$1`, [CONVERSATION]);
    const first = await db.query(
      `select * from public.apply_tripwire_signal($1,$2,'trip-1','cpn','refuse')`,
      [TENANT, CONVERSATION],
    );
    const second = await db.query(
      `select * from public.apply_tripwire_signal($1,$2,'trip-2','guarantee','refuse')`,
      [TENANT, CONVERSATION],
    );
    expect(first.rows[0].action).toBe("refused");
    expect(second.rows[0].action).toBe("escalated");
    const tripwire = await db.query<{ count: number; status: string; classes: string[] }>(`
      select tripwire_count count,status::text,tripwire_classes classes
      from public.conversations where id=$1
    `, [CONVERSATION]);
    expect(tripwire.rows[0]).toEqual({
      count: 2,
      status: "needs_human",
      classes: ["cpn", "guarantee"],
    });
  });

  it("hard-deletes the contact while tombstone, audit, eval, and billing evidence survive", async () => {
    const preview = await db.query<{
      preview: {
        previewToken: string;
        snapshotDigest: string;
        providerTargetDigest: string;
      };
    }>(
      `select public.preview_contact_deletion($1,$2,$3) preview`,
      [TENANT, CONTACT, ADMIN],
    );
    const leaseToken = "69000000-0000-4000-8000-000000000010";
    const idempotencyDigest = "7".repeat(64);
    const providerEvidence = { kind: "confirmed_absent" };
    const intent = await db.query<{ intent_id: string; status: string }>(
      `select * from public.begin_contact_deletion_intent(
        $1,$2,$3,'Synthetic privacy request',$4,$5,$6,$7,$8
      )`,
      [
        TENANT,
        CONTACT,
        ADMIN,
        preview.rows[0].preview.previewToken,
        leaseToken,
        idempotencyDigest,
        preview.rows[0].preview.snapshotDigest,
        preview.rows[0].preview.providerTargetDigest,
      ],
    );
    expect(intent.rows[0].status).toBe("claimed");
    await db.query(
      "select * from public.checkpoint_contact_deletion_provider($1,$2,$3,$4,$5::jsonb)",
      [TENANT, ADMIN, intent.rows[0].intent_id, leaseToken, JSON.stringify(providerEvidence)],
    );
    const deletion = await db.query(
      `select * from public.finalize_contact_deletion_intent(
        $1,$2,$3,$4,array['sms']::public.messaging_channel[],array[$5]::text[],array['0006']::text[],
        jsonb_build_object(
          'intentId', ($3::uuid)::text,
          'providerEvidence', $6::jsonb,
          'idempotencyDigest', $7::text
        ))`,
      [
        TENANT,
        ADMIN,
        intent.rows[0].intent_id,
        leaseToken,
        "6".repeat(64),
        JSON.stringify(providerEvidence),
        idempotencyDigest,
      ],
    );
    expect(deletion.rows[0].deleted).toBe(true);
    const evidence = await db.query<{
      contacts: string;
      appointments: string;
      appointment_id: string | null;
      detached: boolean;
      quantity: number;
      tombstones: string;
      severed: boolean;
      quarantined: boolean;
      audit: string;
    }>(`
      select
        (select count(*)::text from public.contacts where id=$1) contacts,
        (select count(*)::text from public.appointments where id=$2) appointments,
        billable.appointment_id,
        billable.appointment_detached_at is not null detached,
        billable.quantity,
        (select count(*)::text from public.suppression_tombstones
         where identifier_hash=repeat('6',64)) tombstones,
        eval.provenance_severed severed,
        eval.quarantined,
        (select count(*)::text from public.audit_log
         where action='contact.delete' and target_id=$1::text) audit
      from public.billable_events billable cross join public.eval_cases eval
      where billable.id=$3 and eval.id=$4
    `, [CONTACT, APPOINTMENT, BILLABLE, EVAL_CASE]);
    expect(evidence.rows[0]).toEqual({
      contacts: "0",
      appointments: "0",
      appointment_id: null,
      detached: true,
      quantity: 1,
      tombstones: "1",
      severed: true,
      quarantined: true,
      audit: "1",
    });
    const completed = await db.query<{ status: string; audit_id: string }>(
      "select status::text, audit_id::text from public.contact_deletion_intents where id=$1",
      [intent.rows[0].intent_id],
    );
    expect(completed.rows[0]).toEqual({ status: "completed", audit_id: String(deletion.rows[0].audit_id) });
  });
});
