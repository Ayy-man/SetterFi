// These are database contracts, not mocked route tests: concurrent stage changes and the
// takeover/reply/handback fence depend on PostgreSQL row locks and audited transactions.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const COACH_A = randomUUID();
const COACH_B = randomUUID();
const GHL_INSTALL = randomUUID();
const GHL_LOCATION = `coach-write-${randomUUID().slice(0, 8)}`;
const EMAIL_A = `coach-a-${COACH_A}@write.test`;
const EMAIL_B = `coach-b-${COACH_B}@write.test`;

let db: Client;

async function contact(tenantId = TENANT_A) {
  const id = randomUUID();
  await db.query(
    "insert into public.contacts (id,tenant_id,last_channel,name) values ($1,$2,'sms','Write contract lead')",
    [id, tenantId],
  );
  return id;
}

async function appointment(contactId: string, status: "scheduled" | "confirmed" | "no_show") {
  const result = await db.query<{ id: string }>(`
    insert into public.appointments (tenant_id,contact_id,provider,external_id,start_at,end_at,timezone,status)
    values ($1,$2,'ghl',$3,now() + interval '1 hour',now() + interval '90 minutes','UTC',$4) returning id
  `, [TENANT_A, contactId, `coach-write-appointment-${randomUUID()}`, status]);
  return result.rows[0].id;
}

async function expectDbError(query: string, params: unknown[], pattern: RegExp) {
  await db.query("savepoint coach_write_error");
  await expect(db.query(query, params)).rejects.toThrow(pattern);
  await db.query("rollback to savepoint coach_write_error");
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(`Coach-write suite could not reach Postgres at ${DB_URL}. Start the local Supabase stack.`, { cause });
  }
  await db.query(`
    insert into public.tenants (id,slug,name,billing_contact_email) values
      ($1,$2,'Coach Write A',$3),
      ($4,$5,'Coach Write B',$6)
  `, [
    TENANT_A, `coach-write-a-${TENANT_A.slice(0, 8)}`, EMAIL_A,
    TENANT_B, `coach-write-b-${TENANT_B.slice(0, 8)}`, EMAIL_B,
  ]);
  await db.query(`
    insert into public.users (id,email,role,tenant_id) values
      ($1,$2,'coach',$3),
      ($4,$5,'coach',$6)
  `, [COACH_A, EMAIL_A, TENANT_A, COACH_B, EMAIL_B, TENANT_B]);
  await db.query(`
    insert into public.ghl_installs (id,tenant_id,location_id,company_id,token_expires_at)
      values ($1,$2,$3,'coach-write-company',now()+interval '1 hour')
  `, [GHL_INSTALL, TENANT_A, GHL_LOCATION]);
});

beforeEach(async () => db.query("begin"));
afterEach(async () => db.query("rollback"));
afterAll(async () => {
  await db.query("delete from public.ghl_installs where id=$1", [GHL_INSTALL]);
  await db.query("delete from public.users where id = any($1::uuid[])", [[COACH_A, COACH_B]]);
  await db.query("delete from public.tenants where id = any($1::uuid[])", [[TENANT_A, TENANT_B]]);
  await db.end();
});

describe("enabled coach writes", () => {
  it("enforces the booked and no-show invariants on successful pipeline transitions", async () => {
    const contactId = await contact();
    await db.query(`select public.set_contact_pipeline_stage(
      $1,$2,'new_lead','qualifying','user',$3,'Qualified',null,'stage-qualifying'
    )`, [TENANT_A, contactId, COACH_A]);
    const bookedAppointment = await appointment(contactId, "scheduled");
    await db.query(`select public.set_contact_pipeline_stage(
      $1,$2,'qualifying','booked','user',$3,'Appointment booked',$4,'stage-booked'
    )`, [TENANT_A, contactId, COACH_A, bookedAppointment]);
    await db.query("update public.appointments set status='no_show' where id=$1", [bookedAppointment]);
    await db.query(`select public.set_contact_pipeline_stage(
      $1,$2,'booked','no_show','user',$3,'Missed appointment',null,'stage-no-show'
    )`, [TENANT_A, contactId, COACH_A]);

    const result = await db.query<{ stage: string; audit_count: string }>(`
      select pipeline_stage::text stage,
        (select count(*)::text from public.audit_log
         where tenant_id=$1 and target_id::text=$2::text and action='contact.pipeline_stage.set') audit_count
      from public.contacts where id=$2::uuid
    `, [TENANT_A, contactId]);
    expect(result.rows).toEqual([{ stage: "no_show", audit_count: "3" }]);
  });

  it("refuses a cross-tenant pipeline write without changing the contact", async () => {
    const contactId = await contact();
    await expectDbError(
      "select public.set_contact_pipeline_stage($1,$2,'new_lead','qualifying','user',$3,null,null,'tenant-refusal')",
      [TENANT_B, contactId, COACH_B],
      /EXPECTED_TENANT_MISMATCH:contact/,
    );
    await expect(db.query("select pipeline_stage::text stage from public.contacts where id=$1", [contactId]))
      .resolves.toMatchObject({ rows: [{ stage: "new_lead" }] });
  });

  it("allows one concurrent stage writer and refuses the stale writer under the contact row lock", async () => {
    await db.query("rollback");
    const contactId = await contact();
    const left = new Client({ connectionString: DB_URL });
    const right = new Client({ connectionString: DB_URL });
    await Promise.all([left.connect(), right.connect()]);
    try {
      const statements = [
        [left, "qualifying", "concurrent-left"],
        [right, "disqualified", "concurrent-right"],
      ] as const;
      const outcomes = await Promise.allSettled(statements.map(([client, stage, key]) => client.query(
        "select public.set_contact_pipeline_stage($1,$2,'new_lead',$3,'system',null,null,null,$4)",
        [TENANT_A, contactId, stage, key],
      )));
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")[0]).toMatchObject({
        reason: expect.objectContaining({ message: expect.stringMatching(/PIPELINE_EXPECTED_STAGE_STALE/) }),
      });
    } finally {
      await Promise.all([left.end(), right.end()]);
      await db.query("delete from public.contacts where id=$1", [contactId]);
      await db.query("begin");
    }
  });

  it("runs takeover, human reply, and handback as one tenant-scoped audited cycle", async () => {
    const contactId = await contact();
    const conversation = await db.query<{ id: string }>(`
      insert into public.conversations (tenant_id,contact_id,channel)
      values ($1,$2,'sms') returning id
    `, [TENANT_A, contactId]);
    const conversationId = conversation.rows[0].id;
    const identityId = randomUUID();
    await db.query(`
      insert into public.contact_identities
        (id,tenant_id,contact_id,provider,channel,provider_identity_id,provider_account_id,
         ghl_install_id,consent_state,consent_source,consent_captured_at)
      values ($1,$2,$3,'ghl','sms','coach-write-lead',$4,$5,'opted_in','web_form',now())
    `, [identityId, TENANT_A, contactId, GHL_LOCATION, GHL_INSTALL]);

    await db.query("select public.claim_conversation($1,$2,$3,'agent',null,false)", [
      TENANT_A, conversationId, COACH_A,
    ]);
    const claimed = await db.query<{ claim_token: string }>(`select * from public.claim_outbound_send(
      $1,$2,$3,$4,'human_reply','sms','ghl','I can help with that.',$5,$6,false,
      null,null,null,$7
    )`, [TENANT_A, conversationId, contactId, identityId, "human-reply-1", "a".repeat(64), COACH_A]);
    await db.query("select public.record_outbound_provider_acceptance($1,$2,$3,'provider-human-1',now())", [
      TENANT_A, "human-reply-1", claimed.rows[0].claim_token,
    ]);
    await expectDbError(
      "select public.release_conversation($1,$2,$3,$3)",
      [TENANT_A, conversationId, COACH_A],
      /CONVERSATION_RELEASE_REPLY_PENDING/,
    );
    await db.query("select * from public.persist_claimed_outbound_send($1,$2,$3,$4,'provider-human-1',false)", [
      TENANT_A, "human-reply-1", claimed.rows[0].claim_token, COACH_A,
    ]);
    await db.query("select public.release_conversation($1,$2,$3,$3)", [TENANT_A, conversationId, COACH_A]);

    const state = await db.query<{ status: string; holder: string | null; disclosure: boolean; actions: string[] }>(`
      select conversation.status::text status, conversation.taken_over_by::text holder,
        conversation.disclosure_pending disclosure,
        array_agg(audit.action order by audit.id) actions
      from public.conversations conversation
      join public.audit_log audit on audit.tenant_id=conversation.tenant_id
        and audit.target_id::text=conversation.id::text
      where conversation.id=$1::uuid
      group by conversation.id
    `, [conversationId]);
    expect(state.rows).toEqual([{
      status: "agent",
      holder: null,
      disclosure: true,
      actions: [
        "conversation.takeover.claimed",
        "conversation.message.sent.human",
        "conversation.takeover.released",
      ],
    }]);
  });

  it("refuses cross-tenant takeover without exposing or changing the thread", async () => {
    const contactId = await contact();
    const conversation = await db.query<{ id: string }>(`
      insert into public.conversations (tenant_id,contact_id,channel) values ($1,$2,'sms') returning id
    `, [TENANT_A, contactId]);
    await expectDbError(
      "select public.claim_conversation($1,$2,$3,'agent',null,false)",
      [TENANT_B, conversation.rows[0].id, COACH_B],
      /EXPECTED_TENANT_MISMATCH:conversation/,
    );
  });
});
