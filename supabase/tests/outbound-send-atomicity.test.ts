// The outbound claim, provider receipt, message, and audit contract requires real Postgres locks
// and transactions. Unit mocks cannot prove that two workers see one dispatch owner.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TENANT = "71000000-0000-4000-8000-000000000010";
const CONTACT = "72000000-0000-4000-8000-000000000010";
const CONVERSATION = "73000000-0000-4000-8000-000000000010";
const IDENTITY = "74000000-0000-4000-8000-000000000010";
const OPERATOR = "75000000-0000-4000-8000-000000000010";
const WEBHOOK = "76000000-0000-4000-8000-000000000010";
const ORIGIN_LEASE = "77000000-0000-4000-8000-000000000010";
const GHL_INSTALL = "78000000-0000-4000-8000-000000000010";
const GHL_LOCATION = "outbound-atomicity-location";

let db: Client;

type OriginLease = { receiptId: string; leaseToken: string; attemptNumber: number };

async function claim(
  key: string,
  hash = "a".repeat(64),
  origin: OriginLease | null = null,
  campaignInitiated = false,
) {
  return db.query<{
    disposition: string;
    claim_token: string;
    provider_message_id: string | null;
    message_id: string | null;
    audit_id: string | null;
    effective_body: string;
    first_campaign_disclosure_appended: boolean;
  }>(`select * from public.claim_outbound_send(
    $1,$2,$3,$4,$5,'sms','ghl','Synthetic outbound',$6,$7,false,$8,$9,$10,null,$11,'freeform'
  )`, [
    TENANT, CONVERSATION, CONTACT, IDENTITY,
    origin ? "agent_reply" : "follow_up", key, hash,
    origin?.receiptId ?? null, origin?.leaseToken ?? null, origin?.attemptNumber ?? null,
    campaignInitiated,
  ]);
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Outbound atomicity suite could not reach Postgres at ${DB_URL}. ` +
        "Start the local Supabase stack; this suite fails rather than skips.",
      { cause },
    );
  }
});

afterAll(async () => db?.end());

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id,slug,name,billing_contact_email)
      values ('${TENANT}','outbound-atomicity','Outbound Atomicity','billing@outbound.test');
    insert into public.ghl_installs (id,tenant_id,location_id,company_id,token_expires_at)
      values ('${GHL_INSTALL}','${TENANT}','${GHL_LOCATION}','outbound-atomicity-company',
        now()+interval '1 hour');
    insert into public.contacts (id,tenant_id,last_channel,name)
      values ('${CONTACT}','${TENANT}','sms','Outbound Lead');
    insert into public.users (id,email,role,tenant_id)
      values ('${OPERATOR}','operator@outbound.test','coach','${TENANT}');
    insert into public.conversations (id,tenant_id,contact_id,channel)
      values ('${CONVERSATION}','${TENANT}','${CONTACT}','sms');
    insert into public.contact_identities
      (id,tenant_id,contact_id,provider,channel,provider_identity_id,
       provider_account_id,ghl_install_id,consent_state,consent_source,consent_captured_at)
      values ('${IDENTITY}','${TENANT}','${CONTACT}','ghl','sms','outbound-contact',
        '${GHL_LOCATION}','${GHL_INSTALL}','opted_in','web_form',now());
    insert into public.webhook_events
      (id,provider,provider_event_id,tenant_id,event_type,signature_verified,payload,status,
       attempts,error,next_attempt_at,lease_token,lease_expires_at)
      values ('${WEBHOOK}','ghl','outbound-origin-receipt','${TENANT}','InboundMessage',true,
        '{"normalized":{"events":[{"kind":"message","providerMessageId":"lead-message-1"}]}}',
        'failed',8,'INBOUND_ATTEMPT_BUDGET_EXHAUSTED',now(),'${ORIGIN_LEASE}',now()+interval '5 minutes');
  `);
});

afterEach(async () => db.query("rollback"));

describe("durable outbound send custody", () => {
  it("gives one active worker the dispatch claim", async () => {
    const first = await claim("outbound:concurrent");
    const second = await claim("outbound:concurrent");

    expect(first.rows[0]).toMatchObject({ disposition: "claimed" });
    expect(second.rows[0]).toMatchObject({
      disposition: "in_progress",
      claim_token: first.rows[0].claim_token,
    });
  });

  it("appends and preserves exactly one first-campaign SMS disclosure per identity", async () => {
    const first = await claim("outbound:first-campaign", "a".repeat(64), null, true);
    expect(first.rows[0]).toMatchObject({
      disposition: "claimed",
      effective_body: "Synthetic outbound\n\nMsg & data rates may apply. Reply STOP to opt out.",
      first_campaign_disclosure_appended: true,
    });

    const retry = await claim("outbound:first-campaign", "a".repeat(64), null, true);
    expect(retry.rows[0]).toMatchObject({
      disposition: "in_progress",
      effective_body: first.rows[0].effective_body,
      first_campaign_disclosure_appended: true,
    });

    const second = await claim("outbound:second-campaign", "b".repeat(64), null, true);
    expect(second.rows[0]).toMatchObject({
      disposition: "claimed",
      effective_body: "Synthetic outbound",
      first_campaign_disclosure_appended: false,
    });

    const evidence = await db.query<{
      disclosure_text: string;
      body_matches: boolean;
      count: string;
    }>(`
      select min(disclosure.disclosure_text) disclosure_text,
        bool_and(disclosure.effective_body_hash = encode(
          extensions.digest(attempt.body, 'sha256'), 'hex'
        )) body_matches,
        count(*)::text count
      from public.sms_first_campaign_disclosures disclosure
      join public.outbound_send_attempts attempt
        on attempt.id = disclosure.outbound_send_attempt_id
      where disclosure.tenant_id=$1 and disclosure.identity_id=$2
    `, [TENANT, IDENTITY]);
    expect(evidence.rows).toEqual([{
      disclosure_text: "Msg & data rates may apply. Reply STOP to opt out.",
      body_matches: true,
      count: "1",
    }]);
  });

  it("releases undispatched disclosure evidence so the next send remains first", async () => {
    const first = await claim("outbound:released-first", "a".repeat(64), null, true);
    await db.query("select public.release_outbound_send_claim($1,$2,$3)", [
      TENANT, "outbound:released-first", first.rows[0].claim_token,
    ]);

    const next = await claim("outbound:replacement-first", "b".repeat(64), null, true);
    expect(next.rows[0]).toMatchObject({
      effective_body: "Synthetic outbound\n\nMsg & data rates may apply. Reply STOP to opt out.",
      first_campaign_disclosure_appended: true,
    });
  });

  it("rolls back the send claim when its origin receipt cannot bind", async () => {
    await db.query("savepoint invalid_origin_claim");
    await expect(claim("inbound:ghl:different-lead-message", "a".repeat(64), {
      receiptId: WEBHOOK, leaseToken: ORIGIN_LEASE, attemptNumber: 8,
    }))
      .rejects.toThrow(/OUTBOUND_SEND_ORIGIN_PAYLOAD_MISMATCH/);
    await db.query("rollback to savepoint invalid_origin_claim");
    const attempts = await db.query<{ count: string }>(`
      select count(*)::text count from public.outbound_send_attempts
      where tenant_id=$1 and idempotency_key=$2
    `, [TENANT, "inbound:ghl:different-lead-message"]);
    expect(attempts.rows).toEqual([{ count: "0" }]);
  });

  it("resumes accepted persistence and replays one evidence-complete send", async () => {
    const first = await claim("outbound:accepted");
    const token = first.rows[0].claim_token;
    const acceptance = await db.query<{ recorded: boolean }>(
      `select public.record_outbound_provider_acceptance(
        $1,$2,$3,'provider-outbound-1',now()
      ) recorded`,
      [TENANT, "outbound:accepted", token],
    );
    expect(acceptance.rows).toEqual([{ recorded: true }]);

    // Expiry hands local persistence to a new worker without a second provider call.
    await db.query(`update public.outbound_send_attempts
      set lease_expires_at=now()-interval '1 second'
      where tenant_id=$1 and idempotency_key=$2`, [TENANT, "outbound:accepted"]);
    const resumed = await claim("outbound:accepted");
    expect(resumed.rows[0]).toMatchObject({
      disposition: "accepted",
      provider_message_id: "provider-outbound-1",
    });

    const persisted = await db.query<{
      message_id: string;
      audit_id: string;
      persisted_at: string;
    }>(`select * from public.persist_claimed_outbound_send(
      $1,$2,$3,null,'provider-outbound-1',false
    )`, [TENANT, "outbound:accepted", resumed.rows[0].claim_token]);
    expect(persisted.rows[0].message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(persisted.rows[0].audit_id)).toBeGreaterThan(0);

    const replay = await claim("outbound:accepted");
    expect(replay.rows[0]).toMatchObject({
      disposition: "persisted",
      provider_message_id: "provider-outbound-1",
      message_id: persisted.rows[0].message_id,
      audit_id: persisted.rows[0].audit_id,
    });
    const counts = await db.query<{ messages: string; audits: string }>(`
      select
        (select count(*)::text from public.messages where state_entry_key='outbound:accepted') messages,
        (select count(*)::text from public.audit_log
          where payload->>'outboundAttemptId' is not null) audits
    `);
    expect(counts.rows).toEqual([{ messages: "1", audits: "1" }]);
  });

  it("holds an expired non-idempotent claim for reconciliation instead of resending", async () => {
    const key = "inbound:ghl:lead-message-1";
    const originalOrigin = { receiptId: WEBHOOK, leaseToken: ORIGIN_LEASE, attemptNumber: 8 };
    await claim(key, "a".repeat(64), originalOrigin);
    await db.query(`update public.outbound_send_attempts
      set lease_expires_at=now()-interval '1 second'
      where tenant_id=$1 and idempotency_key=$2`, [TENANT, key]);

    const retry = await claim(key, "a".repeat(64), originalOrigin);
    expect(retry.rows[0].disposition).toBe("indeterminate");
    const evidence = await db.query<{ status: string; error: string; messages: string }>(`
      select attempt.status, attempt.last_error_code error,
        count(message.id)::text messages
      from public.outbound_send_attempts attempt
      left join public.messages message on message.id=attempt.message_id
      where attempt.tenant_id=$1 and attempt.idempotency_key=$2
      group by attempt.id
    `, [TENANT, key]);
    expect(evidence.rows).toEqual([{
      status: "indeterminate",
      error: "CLAIM_EXPIRED_PROVIDER_ACCEPTANCE_UNKNOWN",
      messages: "0",
    }]);

    await db.query("savepoint arbitrary_reconciliation_evidence");
    await expect(db.query(`select public.reconcile_indeterminate_outbound_send(
      $1,$2,'not_accepted',null,null,'{"source":"operator_note"}'::jsonb,$3,'No message found'
    )`, [TENANT, key, OPERATOR])).rejects.toThrow(/OUTBOUND_RECONCILIATION_EVIDENCE_INVALID/);
    await db.query("rollback to savepoint arbitrary_reconciliation_evidence");

    const reconciled = await db.query<{ audit_id: string }>(`
      select public.reconcile_indeterminate_outbound_send(
        $1,$2,'not_accepted',null,null,$3::jsonb,$4,'Provider delivery lookup found no message'
      )::text audit_id
    `, [
      TENANT,
      key,
      JSON.stringify({
        provider: "ghl", channel: "sms", kind: "provider_readback",
        evidenceId: "readback-no-message-1", result: "not_found",
        providerMessageId: null, observedAt: "2026-08-27T12:00:00Z",
      }),
      OPERATOR,
    ]);
    expect(Number(reconciled.rows[0].audit_id)).toBeGreaterThan(0);
    const origin = await db.query<{ status: string; attempts: number; error: string; due: boolean }>(`
      select status, attempts, error, next_attempt_at <= clock_timestamp() + interval '1 second' due
      from public.webhook_events where id=$1
    `, [WEBHOOK]);
    expect(origin.rows).toEqual([{
      status: "failed",
      attempts: 0,
      error: "OUTBOUND_RECONCILED_NOT_ACCEPTED_RETRY_AUTHORIZED",
      due: true,
    }]);
    await db.query("savepoint stale_origin_after_resolution");
    await expect(claim(key, "a".repeat(64), originalOrigin))
      .rejects.toThrow(/OUTBOUND_SEND_ORIGIN_LEASE_LOST/);
    await db.query("rollback to savepoint stale_origin_after_resolution");
    const absent = await db.query<{ count: string }>(`
      select count(*)::text count from public.outbound_send_attempts
      where tenant_id=$1 and idempotency_key=$2
    `, [TENANT, key]);
    expect(absent.rows).toEqual([{ count: "0" }]);

    const inboundClaim = await db.query<{ lease_token: string; attempt_number: number }>(`
      select lease_token,attempt_number
      from public.claim_inbound_webhook_receipts(1,300,clock_timestamp(),$1)
    `, [WEBHOOK]);
    expect(inboundClaim.rows).toHaveLength(1);
    await db.query("savepoint stale_origin_after_reclaim");
    await expect(claim(key, "a".repeat(64), originalOrigin))
      .rejects.toThrow(/OUTBOUND_SEND_ORIGIN_LEASE_LOST/);
    await db.query("rollback to savepoint stale_origin_after_reclaim");
    const reclaimed = await claim(key, "a".repeat(64), {
      receiptId: WEBHOOK,
      leaseToken: inboundClaim.rows[0].lease_token,
      attemptNumber: inboundClaim.rows[0].attempt_number,
    });
    expect(reclaimed.rows[0].disposition).toBe("claimed");
  });

  it("rotates reconciliation fencing so a stale worker cannot finish after reclaim", async () => {
    const first = await claim("outbound:reconciliation-fence");
    const staleToken = first.rows[0].claim_token;
    await db.query(`select public.record_outbound_provider_acceptance(
      $1,$2,$3,'provider-reconciliation-fence',now()
    )`, [TENANT, "outbound:reconciliation-fence", staleToken]);
    await db.query(`update public.outbound_send_attempts
      set lease_expires_at=now()-interval '1 second'
      where tenant_id=$1 and idempotency_key=$2`, [TENANT, "outbound:reconciliation-fence"]);

    const claimed = await db.query<{
      claim_token: string;
      disposition: string;
    }>(`select * from public.claim_outbound_reconciliation_batch(1,300,now())`);
    expect(claimed.rows[0].disposition).toBe("accepted");
    expect(claimed.rows[0].claim_token).not.toBe(staleToken);

    await db.query("savepoint stale_reconciliation_worker");
    await expect(db.query(`select public.finish_outbound_reconciliation_attempt(
      (select id from public.outbound_send_attempts where idempotency_key=$1),
      $2,'retry','stale worker',now()+interval '1 minute',now()
    )`, ["outbound:reconciliation-fence", staleToken]))
      .rejects.toThrow(/OUTBOUND_RECONCILIATION_CLAIM_LOST/);
    await db.query("rollback to savepoint stale_reconciliation_worker");

    const persisted = await db.query<{ message_id: string }>(`
      select * from public.persist_claimed_outbound_send(
        $1,$2,$3,null,'provider-reconciliation-fence',false
      )
    `, [TENANT, "outbound:reconciliation-fence", claimed.rows[0].claim_token]);
    expect(persisted.rows[0].message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("requires provider- and channel-matched acceptance evidence", async () => {
    const key = "outbound:manual-accepted";
    const first = await claim(key);
    await db.query("select public.mark_outbound_dispatch_indeterminate($1,$2,$3,$4)", [
      TENANT, key, first.rows[0].claim_token, "PROVIDER_TIMEOUT",
    ]);
    const acceptedEvidence = {
      provider: "ghl", channel: "sms", kind: "provider_receipt",
      evidenceId: "provider-receipt-accepted-1", result: "accepted",
      providerMessageId: "provider-manual-accepted", observedAt: "2026-08-27T12:00:00Z",
    };
    await db.query("savepoint mismatched_provider_evidence");
    await expect(db.query(`select public.reconcile_indeterminate_outbound_send(
      $1,$2,'accepted',$3,now(),$4::jsonb,$5,'Provider receipt confirms acceptance'
    )`, [
      TENANT, key, "provider-manual-accepted",
      JSON.stringify({ ...acceptedEvidence, provider: "meta_direct" }), OPERATOR,
    ])).rejects.toThrow(/OUTBOUND_RECONCILIATION_EVIDENCE_INVALID/);
    await db.query("rollback to savepoint mismatched_provider_evidence");

    const result = await db.query<{ audit_id: string }>(`select
      public.reconcile_indeterminate_outbound_send(
        $1,$2,'accepted',$3,now(),$4::jsonb,$5,'Provider receipt confirms acceptance'
      )::text audit_id
    `, [TENANT, key, "provider-manual-accepted", JSON.stringify(acceptedEvidence), OPERATOR]);
    expect(Number(result.rows[0].audit_id)).toBeGreaterThan(0);
    const attempt = await db.query<{ status: string; provider_message_id: string }>(`
      select status,provider_message_id from public.outbound_send_attempts
      where tenant_id=$1 and idempotency_key=$2
    `, [TENANT, key]);
    expect(attempt.rows).toEqual([{
      status: "accepted", provider_message_id: "provider-manual-accepted",
    }]);
  });

  it("rejects reuse of a key for a different payload", async () => {
    await claim("outbound:conflict");
    await db.query("savepoint outbound_conflict");
    await expect(claim("outbound:conflict", "b".repeat(64)))
      .rejects.toThrow(/OUTBOUND_SEND_IDEMPOTENCY_CONFLICT/);
    await db.query("rollback to savepoint outbound_conflict");
  });

  it("forces RLS and exposes transition functions only to service_role", async () => {
    const table = await db.query<{
      forced: boolean;
      anon_select: boolean;
      authenticated_select: boolean;
      service_select: boolean;
      service_insert: boolean;
    }>(`
      select relforcerowsecurity forced,
        has_table_privilege('anon','public.outbound_send_attempts','select') anon_select,
        has_table_privilege('authenticated','public.outbound_send_attempts','select') authenticated_select,
        has_table_privilege('service_role','public.outbound_send_attempts','select') service_select,
        has_table_privilege('service_role','public.outbound_send_attempts','insert') service_insert
      from pg_class
      where oid='public.outbound_send_attempts'::regclass
    `);
    expect(table.rows).toEqual([{
      forced: true,
      anon_select: false,
      authenticated_select: false,
      service_select: true,
      service_insert: false,
    }]);

    const functions = await db.query<{ name: string; anon: boolean; authenticated: boolean; service: boolean }>(`
      select p.proname name,
        has_function_privilege('anon',p.oid,'execute') anon,
        has_function_privilege('authenticated',p.oid,'execute') authenticated,
        has_function_privilege('service_role',p.oid,'execute') service
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in (
        'claim_outbound_send','record_outbound_provider_acceptance',
        'mark_outbound_dispatch_indeterminate','persist_claimed_outbound_send',
        'reconcile_indeterminate_outbound_send','release_outbound_send_claim',
        'claim_outbound_reconciliation_batch','finish_outbound_reconciliation_attempt'
      ) order by 1
    `);
    expect(functions.rows).toEqual([
      { name: "claim_outbound_reconciliation_batch", anon: false, authenticated: false, service: true },
      { name: "claim_outbound_send", anon: false, authenticated: false, service: true },
      { name: "finish_outbound_reconciliation_attempt", anon: false, authenticated: false, service: true },
      { name: "mark_outbound_dispatch_indeterminate", anon: false, authenticated: false, service: true },
      { name: "persist_claimed_outbound_send", anon: false, authenticated: false, service: true },
      { name: "reconcile_indeterminate_outbound_send", anon: false, authenticated: false, service: true },
      { name: "record_outbound_provider_acceptance", anon: false, authenticated: false, service: true },
      { name: "release_outbound_send_claim", anon: false, authenticated: false, service: true },
    ]);
  });
});
