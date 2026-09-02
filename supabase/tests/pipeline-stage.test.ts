// Pipeline stage behavior runs against local Postgres so grants, tenant checks, row locks,
// appointment evidence, and the audit receipt are exercised together.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "51000000-0000-4000-8000-000000000010";
const TENANT_B = "51000000-0000-4000-8000-000000000020";
const COACH_A = "52000000-0000-4000-8000-000000000010";

let db: Client;

async function contact(tenantId: string, suffix: string) {
  const result = await db.query<{ id: string }>(
    `insert into public.contacts
      (tenant_id, last_channel, name, stage_set_at)
     values ($1, 'sms', $2, now() - interval '1 day')
     returning id`,
    [tenantId, `Pipeline ${suffix}`],
  );
  return result.rows[0].id;
}

async function appointment(tenantId: string, contactId: string, suffix: string, status = "scheduled") {
  const result = await db.query<{ id: string }>(
    `insert into public.appointments
      (tenant_id, contact_id, provider, external_id, start_at, end_at, timezone, status,
       canceled_at, cancel_source)
     values ($1, $2, 'ghl', $3, now() + interval '1 day',
       now() + interval '1 day 30 minutes', 'America/New_York', $4::public.appointment_status,
       case when $4 = 'canceled' then now() else null end,
       case when $4 = 'canceled' then 'system' else null end)
     returning id`,
    [tenantId, contactId, `pipeline-${suffix}`, status],
  );
  return result.rows[0].id;
}

async function expectStageError(
  query: string,
  parameters: unknown[],
  pattern: RegExp,
) {
  await db.query("savepoint pipeline_stage_error");
  await expect(db.query(query, parameters)).rejects.toThrow(pattern);
  await db.query("rollback to savepoint pipeline_stage_error");
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Pipeline stage suite could not reach Postgres at ${DB_URL}. ` +
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
      ('${TENANT_A}', 'pipeline-stage-a', 'Pipeline Stage A', 'a@pipeline-stage.test', false),
      ('${TENANT_B}', 'pipeline-stage-b', 'Pipeline Stage B', 'b@pipeline-stage.test', false);
    insert into public.users (id, email, role, tenant_id) values
      ('${COACH_A}', 'coach@pipeline-stage.test', 'coach', '${TENANT_A}');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("set_contact_pipeline_stage", () => {
  it("exposes the nine-parameter bigint function only to service_role", async () => {
    const result = await db.query<{
      signature: string;
      result_type: string;
      anon_exec: boolean;
      authenticated_exec: boolean;
      service_exec: boolean;
    }>(`
      select p.oid::regprocedure::text as signature,
        pg_get_function_result(p.oid) as result_type,
        has_function_privilege('anon', p.oid, 'execute') as anon_exec,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
        has_function_privilege('service_role', p.oid, 'execute') as service_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'set_contact_pipeline_stage'
    `);
    expect(result.rows).toEqual([{
      signature: "set_contact_pipeline_stage(uuid,uuid,pipeline_stage,pipeline_stage,text,uuid,text,uuid,text)",
      result_type: "bigint",
      anon_exec: false,
      authenticated_exec: false,
      service_exec: true,
    }]);
  });

  it("rejects a tenant mismatch", async () => {
    const contactId = await contact(TENANT_A, "tenant-mismatch");
    await expectStageError(
      "select public.set_contact_pipeline_stage($1, $2, 'new_lead', 'qualifying', 'user', $3)",
      [TENANT_B, contactId, COACH_A],
      /EXPECTED_TENANT_MISMATCH:contact/,
    );
  });

  it("rejects an impersonated session", async () => {
    const contactId = await contact(TENANT_A, "impersonated");
    const session = await db.query<{ id: string }>(`
      insert into public.impersonation_sessions
        (actor_id, tenant_id, reason, started_at, expires_at)
      values ('${COACH_A}', '${TENANT_A}', 'Pipeline test', now(), now() + interval '30 minutes')
      returning id
    `);
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
      sub: COACH_A,
      app_metadata: {
        role: "coach",
        tenant_id: TENANT_A,
        impersonating_tenant: TENANT_A,
        impersonation_session_id: session.rows[0].id,
      },
    })]);
    await expectStageError(
      "select public.set_contact_pipeline_stage($1, $2, 'new_lead', 'qualifying', 'user', $3)",
      [TENANT_A, contactId, COACH_A],
      /IMPERSONATION_WRITE_FORBIDDEN/,
    );
    await db.query("select set_config('request.jwt.claims', '{}', true)");
  });

  it("protects a user-set stage from system changes except a booked move", async () => {
    const contactId = await contact(TENANT_A, "user-protected");
    await db.query(
      "update public.contacts set pipeline_stage = 'qualifying', stage_set_by = 'user' where id = $1",
      [contactId],
    );
    await expectStageError(
      "select public.set_contact_pipeline_stage($1, $2, 'qualifying', 'disqualified', 'system')",
      [TENANT_A, contactId],
      /PIPELINE_USER_STAGE_PROTECTED/,
    );

    const appointmentId = await appointment(TENANT_A, contactId, "booked-override");
    await db.query("set local role service_role");
    const changed = await db.query<{ audit_id: string | null }>(
      `select public.set_contact_pipeline_stage(
        $1, $2, 'qualifying', 'booked', 'system', null, null, $3
      )::text as audit_id`,
      [TENANT_A, contactId, appointmentId],
    );
    await db.query("reset role");

    const result = await db.query<{
      pipeline_stage: string;
      stage_set_by: string;
      audit_count: string;
    }>(`
      select contact.pipeline_stage::text, contact.stage_set_by,
        count(audit.id)::text as audit_count
      from public.contacts contact
      left join public.audit_log audit
        on audit.target_id = contact.id::text and audit.action = 'contact.pipeline_stage.set'
      where contact.id = $1
      group by contact.id
    `, [contactId]);
    expect(changed.rows).toEqual([{ audit_id: null }]);
    expect(result.rows).toEqual([{
      pipeline_stage: "booked",
      stage_set_by: "system",
      audit_count: "0",
    }]);
  });

  it("rejects a stale expected stage while holding the contact row lock", async () => {
    const contactId = await contact(TENANT_A, "stale-stage");
    await db.query(
      "update public.contacts set pipeline_stage = 'qualifying' where id = $1",
      [contactId],
    );

    await expectStageError(
      "select public.set_contact_pipeline_stage($1, $2, 'new_lead', 'disqualified', 'user', $3)",
      [TENANT_A, contactId, COACH_A],
      /PIPELINE_EXPECTED_STAGE_STALE/,
    );
  });

  it("requires appointment evidence for booked and verifies its contact", async () => {
    const contactId = await contact(TENANT_A, "booked-evidence");
    await expectStageError(
      "select public.set_contact_pipeline_stage($1, $2, 'new_lead', 'booked', 'user', $3)",
      [TENANT_A, contactId, COACH_A],
      /PIPELINE_BOOKED_REQUIRES_APPOINTMENT/,
    );

    const otherContactId = await contact(TENANT_A, "other-contact");
    const otherAppointmentId = await appointment(TENANT_A, otherContactId, "other-contact");
    await expectStageError(
      `select public.set_contact_pipeline_stage(
        $1, $2, 'new_lead', 'booked', 'user', $3, null, $4
      )`,
      [TENANT_A, contactId, COACH_A, otherAppointmentId],
      /PIPELINE_BOOKED_APPOINTMENT_MISMATCH/,
    );
  });

  it("rejects canceled appointment evidence for a booked move", async () => {
    const contactId = await contact(TENANT_A, "booked-canceled");
    const appointmentId = await appointment(TENANT_A, contactId, "booked-canceled", "canceled");

    await expectStageError(
      `select public.set_contact_pipeline_stage(
        $1, $2, 'new_lead', 'booked', 'user', $3, null, $4
      )`,
      [TENANT_A, contactId, COACH_A, appointmentId],
      /PIPELINE_BOOKED_APPOINTMENT_INVALID_STATUS/,
    );
  });

  it("keeps the latest no-show appointment requirement", async () => {
    const contactId = await contact(TENANT_A, "no-show");
    await appointment(TENANT_A, contactId, "no-show-latest");
    await expectStageError(
      "select public.set_contact_pipeline_stage($1, $2, 'new_lead', 'no_show', 'user', $3)",
      [TENANT_A, contactId, COACH_A],
      /PIPELINE_NO_SHOW_REQUIRES_LATEST_APPOINTMENT/,
    );
  });

  it("returns one audit id and updates the stage setter and timestamp", async () => {
    const contactId = await contact(TENANT_A, "successful");
    const before = await db.query<{ stage_set_at: Date }>(
      "select stage_set_at from public.contacts where id = $1",
      [contactId],
    );

    await db.query("set local role service_role");
    const changed = await db.query<{ audit_id: string }>(
      `select public.set_contact_pipeline_stage(
        $1, $2, 'new_lead', 'qualifying', 'user', $3, $4, null
      )::text as audit_id`,
      [TENANT_A, contactId, COACH_A, "Reviewed with the coach"],
    );
    await db.query("reset role");

    const result = await db.query<{
      pipeline_stage: string;
      stage_set_by: string;
      stage_set_at: Date;
      audit_count: string;
      audit_id: string;
      reason: string;
      prior_stage: string;
      new_stage: string;
      set_by: string;
    }>(`
      select contact.pipeline_stage::text, contact.stage_set_by, contact.stage_set_at,
        count(audit.id)::text as audit_count, min(audit.id)::text as audit_id,
        min(audit.reason) as reason,
        min(audit.payload ->> 'prior_stage') as prior_stage,
        min(audit.payload ->> 'new_stage') as new_stage,
        min(audit.payload ->> 'set_by') as set_by
      from public.contacts contact
      join public.audit_log audit
        on audit.target_id = contact.id::text and audit.action = 'contact.pipeline_stage.set'
      where contact.id = $1
      group by contact.id
    `, [contactId]);
    expect(result.rows[0]).toMatchObject({
      pipeline_stage: "qualifying",
      stage_set_by: "user",
      audit_count: "1",
      audit_id: changed.rows[0].audit_id,
      reason: "Reviewed with the coach",
      prior_stage: "new_lead",
      new_stage: "qualifying",
      set_by: "user",
    });
    expect(result.rows[0].stage_set_at.getTime()).toBeGreaterThan(before.rows[0].stage_set_at.getTime());
  });
});
