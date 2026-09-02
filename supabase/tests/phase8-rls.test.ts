// Phase 8 operational behavior contract. Each case runs in a rolled-back transaction against
// real Postgres so queue leasing, receipt idempotency, and tenant custody cannot be mocked green.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "8f100000-0000-4000-8000-000000000001";
const TENANT_B = "8f100000-0000-4000-8000-000000000002";
const ADMIN = "8f200000-0000-4000-8000-000000000001";
const SUCCESS_A = "8f200000-0000-4000-8000-000000000002";
const SUCCESS_B = "8f200000-0000-4000-8000-000000000003";
const COACH = "8f200000-0000-4000-8000-000000000004";
const WORKER_A = "8f300000-0000-4000-8000-000000000001";
const WORKER_B = "8f300000-0000-4000-8000-000000000002";

let db: Client;

async function actAs(
  role: "authenticated" | "service_role",
  claims: Record<string, string> = {},
) {
  await db.query(`set local role ${role}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: claims.sub, app_metadata: claims }),
  ]);
}

async function resetRole() {
  await db.query("reset role");
  await db.query(`select set_config('request.jwt.claims', '{}', true)`);
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 8 RLS suite could not reach Postgres at ${DB_URL}. ` +
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
      ('${TENANT_A}', 'phase8-a', 'Synthetic Phase 8 A', 'billing-a@phase8.test', false),
      ('${TENANT_B}', 'phase8-b', 'Synthetic Phase 8 B', 'billing-b@phase8.test', false);
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@phase8.test', 'admin', null),
      ('${SUCCESS_A}', 'success-a@phase8.test', 'success', null),
      ('${SUCCESS_B}', 'success-b@phase8.test', 'success', null),
      ('${COACH}', 'coach@phase8.test', 'coach', '${TENANT_A}');
    update public.tenants set success_owner = '${SUCCESS_A}' where id = '${TENANT_A}';
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("Phase 8 guarded operations", () => {
  it("creates tenant support atomically and keeps internal notes out of the coach projection", async () => {
    await actAs("service_role", { role: "coach", tenant_id: TENANT_A, sub: COACH });
    const created = await db.query<{ thread_id: string; message_id: string }>(
      `select * from public.create_support_thread($1,$2,'Synthetic subject','Synthetic body')`,
      [TENANT_A, COACH],
    );
    await db.query(
      `select * from public.append_support_message($1,$2,$3,'Synthetic internal note',true)`,
      [TENANT_A, created.rows[0].thread_id, ADMIN],
    );
    await resetRole();
    const counts = await db.query<{ all_messages: string; coach_messages: string }>(`
      select (select count(*)::text from public.support_messages where thread_id = $1) as all_messages,
        (select count(*)::text from public.coach_support_messages where thread_id = $1) as coach_messages
    `, [created.rows[0].thread_id]);
    expect(counts.rows[0]).toEqual({ all_messages: "2", coach_messages: "1" });
    await actAs("service_role", { role: "coach", tenant_id: TENANT_A, sub: COACH });
    await expect(db.query(
      `select * from public.append_support_message($1,$2,$3,'Forged internal note',true)`,
      [TENANT_A, created.rows[0].thread_id, COACH],
    )).rejects.toThrow(/SUPPORT_INTERNAL_NOTE_FORBIDDEN/);
  });

  it("reassigns the success owner with one reason-required audit receipt", async () => {
    await actAs("service_role", { role: "admin", sub: ADMIN });
    const result = await db.query<{ tenant_id: string; success_owner: string; audit_id: string }>(
      `select * from public.reassign_success_owner($1,$2,$3,'Synthetic coverage change')`,
      [TENANT_A, ADMIN, SUCCESS_B],
    );
    expect(result.rows[0]).toMatchObject({ tenant_id: TENANT_A, success_owner: SUCCESS_B });
    await resetRole();
    const persisted = await db.query<{ success_owner: string; action: string; reason: string }>(`
      select tenant.success_owner, audit.action, audit.reason
      from public.tenants tenant join public.audit_log audit on audit.id = $2
      where tenant.id = $1
    `, [TENANT_A, result.rows[0].audit_id]);
    expect(persisted.rows[0]).toEqual({
      success_owner: SUCCESS_B,
      action: "tenant.success_owner.reassigned",
      reason: "Synthetic coverage change",
    });
  });

  it("keeps preferences read-only to authenticated callers and locks nonsuppressible rules", async () => {
    const rule = await db.query<{ id: string }>(`
      select id from public.alert_rules where event_key = 'billing.payment_failed' and scope = 'tenant'
    `);
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A, sub: COACH });
    await db.query("savepoint phase8_authenticated_preference");
    await expect(db.query(
      `insert into public.notification_preferences (user_id,rule_id,destination,enabled)
       values ($1,$2,'email',false)`,
      [COACH, rule.rows[0].id],
    )).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint phase8_authenticated_preference");
    await resetRole();
    await actAs("service_role", { role: "coach", tenant_id: TENANT_A, sub: COACH });
    await expect(db.query(
      `select * from public.set_notification_preference($1,$2,'email',false)`,
      [COACH, rule.rows[0].id],
    )).rejects.toThrow(/NOTIFICATION_PREFERENCE_LOCKED/);
  });

  it("claims an address-only billing contact once and records one immutable attempt", async () => {
    const rule = await db.query<{ id: string }>(`
      select id from public.alert_rules where event_key = 'billing.payment_failed' and scope = 'tenant'
    `);
    const notification = await db.query<{ id: string }>(`
      insert into public.notifications
        (tenant_id,user_id,recipient_email,rule_id,source_event_id,kind,title,body)
      values ($1,null,'billing-a@phase8.test',$2,'invoice-synthetic','billing.payment_failed',
        'Synthetic payment failure','SETTERFI_DEMO_PLACEHOLDER_BILLING') returning id
    `, [TENANT_A, rule.rows[0].id]);
    await db.query(`
      insert into public.notification_deliveries (notification_id,destination,next_attempt_at)
      values ($1,'email','2026-08-18T00:00:00Z')
    `, [notification.rows[0].id]);
    await actAs("service_role", {});
    const first = await db.query(
      `select * from public.claim_notification_deliveries($1,10,60,'2026-08-18T01:00:00Z')`,
      [WORKER_A],
    );
    const second = await db.query(
      `select * from public.claim_notification_deliveries($1,10,60,'2026-08-18T01:00:00Z')`,
      [WORKER_B],
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({
      recipient_email: "billing-a@phase8.test",
      user_id: null,
      attempt_number: 1,
      event_key: "billing.payment_failed",
    });
    expect(second.rows).toEqual([]);
    await resetRole();
    const attempts = await db.query<{ count: string }>(`
      select count(*)::text from public.notification_delivery_attempts where delivery_id = $1
    `, [first.rows[0].delivery_id]);
    expect(attempts.rows[0].count).toBe("1");
  });

  it("applies one signed Resend receipt idempotently after an accepted provider response", async () => {
    const rule = await db.query<{ id: string }>(`
      select id from public.alert_rules where event_key = 'appointment.booked' and scope = 'tenant'
    `);
    const notification = await db.query<{ id: string }>(`
      insert into public.notifications
        (tenant_id,user_id,rule_id,source_event_id,kind,title,body)
      values ($1,$2,$3,'appointment-synthetic','appointment.booked','Synthetic booking','Synthetic body')
      returning id
    `, [TENANT_A, COACH, rule.rows[0].id]);
    await db.query(`insert into public.notification_deliveries
      (notification_id,destination,next_attempt_at) values ($1,'email','2026-08-18T00:00:00Z')`,
    [notification.rows[0].id]);
    await actAs("service_role", {});
    const claimed = await db.query(
      `select * from public.claim_notification_deliveries($1,1,60,'2026-08-18T01:00:00Z')`,
      [WORKER_A],
    );
    await db.query(
      `select public.finish_notification_delivery_attempt($1,$2,$3,'accepted','email-synthetic',null,null,null,'2026-08-18T01:00:01Z')`,
      [WORKER_A, claimed.rows[0].delivery_id, claimed.rows[0].attempt_number],
    );
    await resetRole();
    await db.query(`
      insert into public.webhook_events
        (provider,provider_event_id,tenant_id,event_type,signature_verified,payload)
      values ('resend','resend-event-synthetic',$1,'email.delivered',true,
        '{"data":{"email_id":"email-synthetic"}}')
    `, [TENANT_A]);
    await actAs("service_role", {});
    await db.query(
      `select public.apply_resend_delivery_receipt('resend-event-synthetic','email-synthetic','email.delivered','2026-08-18T01:01:00Z')`,
    );
    await db.query(
      `select public.apply_resend_delivery_receipt('resend-event-synthetic','email-synthetic','email.delivered','2026-08-18T01:01:00Z')`,
    );
    await resetRole();
    const persisted = await db.query<{ status: string; delivered_at: string; receipt_status: string }>(`
      select delivery.status::text as status, delivery.delivered_at::text,
        receipt.status::text as receipt_status
      from public.notification_deliveries delivery
      join public.webhook_events receipt on receipt.provider_event_id = 'resend-event-synthetic'
      where delivery.id = $1
    `, [claimed.rows[0].delivery_id]);
    expect(persisted.rows[0].status).toBe("delivered");
    expect(persisted.rows[0].delivered_at).toContain("2026-08-18 01:01:00");
    expect(persisted.rows[0].receipt_status).toBe("processed");
  });

  it("binds a named-tenant platform export pair to the same tenant", async () => {
    await actAs("service_role", { role: "admin", sub: ADMIN });
    const start = await db.query<{ id: string }>(
      `select public.start_platform_export($1,'support-threads','{}',array['id'],'Synthetic export',$2) as id`,
      [ADMIN, TENANT_A],
    );
    await db.query("savepoint phase8_named_export");
    await expect(db.query(
      `select public.finish_platform_export($1,$2,1,64,'Wrong tenant',$3)`,
      [ADMIN, start.rows[0].id, TENANT_B],
    )).rejects.toThrow(/PLATFORM_EXPORT_START_NOT_FOUND/);
    await db.query("rollback to savepoint phase8_named_export");
    await db.query(
      `select public.finish_platform_export($1,$2,1,64,'Synthetic completion',$3)`,
      [ADMIN, start.rows[0].id, TENANT_A],
    );
    await resetRole();
    const audits = await db.query<{ action: string; target_id: string }>(`
      select action, target_id from public.audit_log
      where target_type = 'platform_export_tenant' and target_id = $1::text
      order by id
    `, [TENANT_A]);
    expect(audits.rows).toEqual([
      { action: "platform_export.started", target_id: TENANT_A },
      { action: "platform_export.finished", target_id: TENANT_A },
    ]);
  });

  it("refuses every service writer during an active impersonation session", async () => {
    await resetRole();
    const session = await db.query<{ id: string }>(`
      insert into public.impersonation_sessions
        (actor_id,tenant_id,reason,started_at,expires_at)
      values ('${ADMIN}','${TENANT_A}','Synthetic inspection',now(),now()+interval '30 minutes')
      returning id
    `);
    await actAs("service_role", {
      role: "admin",
      sub: ADMIN,
      impersonation_session_id: session.rows[0].id,
    });
    await expect(db.query(
      `select * from public.create_support_thread($1,$2,'Blocked','Blocked')`,
      [TENANT_A, ADMIN],
    )).rejects.toThrow(/IMPERSONATION_WRITE_FORBIDDEN/);
  });
});

describe("Phase 7 exclusion views retained by Phase 8 exports", () => {
  const expectedColumns = {
    analytics_tenants: ["tenant_id", "created_at", "status", "tier_id", "timezone"],
    analytics_contacts: ["contact_id", "tenant_id", "created_at", "updated_at", "pipeline_stage", "stage_set_at", "outcome", "merged_into_contact_id"],
    analytics_conversations: ["conversation_id", "tenant_id", "contact_id", "channel", "first_touch_keyword", "status", "status_reason", "current_step", "cadence_anchor_at", "created_at", "last_message_at"],
    analytics_messages: ["message_id", "tenant_id", "conversation_id", "direction", "author", "created_at"],
    analytics_appointments: ["appointment_id", "tenant_id", "contact_id", "conversation_id", "status", "attributed_to_agent", "start_at", "end_at", "created_at", "updated_at"],
    analytics_billable_events: ["billable_event_id", "tenant_id", "quantity", "appointment_id", "adjusts_event_id", "occurred_at"],
    analytics_conversation_step_events: ["event_id", "tenant_id", "conversation_id", "contact_id", "message_id", "step_key", "event_kind", "occurred_at"],
    analytics_billing_subscriptions: ["subscription_id", "tenant_id", "tier_id", "stripe_price_id", "status", "current_period_start", "current_period_end", "cancel_at_period_end", "provider_updated_at", "created_at"],
    analytics_commission_ledger: ["commission_ledger_id", "tenant_id", "referral_id", "entry_kind", "commission_cents", "invoice_paid_at", "created_at"],
  } as const;

  it("keeps the exact nine security-invoker schemas closed and unavailable to anon", async () => {
    for (const [view, columns] of Object.entries(expectedColumns)) {
      const actual = await db.query<{ column_name: string }>(`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by ordinal_position
      `, [view]);
      expect(actual.rows.map((row) => row.column_name), view).toEqual(columns);

      const security = await db.query<{ security_invoker: boolean; anon_select: boolean }>(`
        select coalesce('security_invoker=true' = any(class.reloptions), false) as security_invoker,
          has_table_privilege('anon', format('public.%I', class.relname), 'select') as anon_select
        from pg_class class join pg_namespace namespace on namespace.oid = class.relnamespace
        where namespace.nspname = 'public' and class.relname = $1
      `, [view]);
      expect(security.rows[0], view).toEqual({ security_invoker: true, anon_select: false });
    }
  });

  it("keeps demo and test exclusions inside the views rather than a caller fallback", async () => {
    const definitions = await db.query<{ viewname: string; definition: string }>(`
      select viewname, definition from pg_views
      where schemaname = 'public' and viewname = any($1::text[])
      order by viewname
    `, [Object.keys(expectedColumns)]);
    expect(definitions.rows).toHaveLength(Object.keys(expectedColumns).length);
    for (const row of definitions.rows) {
      expect(row.definition, row.viewname).toMatch(/NOT tenant\.is_demo/i);
      if (!["analytics_tenants", "analytics_billing_subscriptions", "analytics_commission_ledger"].includes(row.viewname)) {
        expect(row.definition, row.viewname).toMatch(/NOT [a-z_]+\.is_test/i);
      }
    }

  });
});
