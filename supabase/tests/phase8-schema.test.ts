// Phase 8 schema contract. Catalog and function-definition assertions stay live-Postgres-only:
// enum ordering, grants, queue locks, and old-overload removal are database properties.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import {
  ALERT_RULES_WITHOUT_EMITTER,
  EMITTED_ALERT_RULE_KEYS,
} from "../../src/lib/notifications/source-contract";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const PHASE8_FUNCTIONS = [
  "append_support_message(uuid,uuid,uuid,text,boolean)",
  "apply_resend_delivery_receipt(text,text,text,timestamp with time zone)",
  "claim_notification_deliveries(uuid,integer,integer,timestamp with time zone)",
  "create_support_thread(uuid,uuid,text,text)",
  "finish_notification_delivery_attempt(uuid,uuid,integer,text,text,text,text,timestamp with time zone,timestamp with time zone)",
  "finish_platform_export(uuid,bigint,bigint,bigint,text,uuid)",
  "reassign_success_owner(uuid,uuid,uuid,text)",
  "set_notification_preference(uuid,uuid,notification_destination,boolean)",
  "start_platform_export(uuid,text,jsonb,text[],text,uuid)",
] as const;

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 8 schema suite could not reach Postgres at ${DB_URL}. ` +
        "Start the local stack with `supabase start`; this suite fails rather than skips.",
      { cause },
    );
  }
});

afterAll(async () => {
  await db?.end();
});

describe("Phase 8 catalog contract", () => {
  it("adds the exact notification columns while keeping notifications outside inherited test triggers", async () => {
    const columns = await db.query<{ signature: string }>(`
      select table_name || '.' || column_name || ':' || udt_name || ':' || is_nullable as signature
      from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'notifications' and column_name in
          ('rule_id','source_event_id','content','is_test','recipient_email'))
        or (table_name = 'alert_rules' and column_name in
          ('email_subject','email_body','slack_text'))
        or (table_name = 'notification_deliveries' and column_name in
          ('next_attempt_at','lease_token','lease_expires_at','terminal_at','last_error_code'))
      ) order by 1
    `);
    expect(columns.rows.map((row) => row.signature)).toEqual([
      "alert_rules.email_body:text:YES",
      "alert_rules.email_subject:text:YES",
      "alert_rules.slack_text:text:YES",
      "notification_deliveries.last_error_code:text:YES",
      "notification_deliveries.lease_expires_at:timestamptz:YES",
      "notification_deliveries.lease_token:uuid:YES",
      "notification_deliveries.next_attempt_at:timestamptz:YES",
      "notification_deliveries.terminal_at:timestamptz:YES",
      "notifications.content:jsonb:NO",
      "notifications.is_test:bool:NO",
      "notifications.recipient_email:text:YES",
      "notifications.rule_id:uuid:YES",
      "notifications.source_event_id:text:YES",
    ]);
    const inherited = await db.query<{ count: string }>(`
      select count(*)::text from pg_trigger trigger
      join pg_proc function on function.oid = trigger.tgfoid
      where trigger.tgrelid = 'public.notifications'::regclass
        and function.proname = 'inherit_is_test'
    `);
    expect(inherited.rows[0].count).toBe("0");
  });

  it("orders the new enum values and removes exactly the five legacy columns", async () => {
    const enums = await db.query<{ type: string; values: string[] }>(`
      select type.typname as type, array_agg(value.enumlabel order by value.enumsortorder)::text[] as values
      from pg_type type join pg_enum value on value.enumtypid = type.oid
      where type.typname in ('notification_delivery_status','webhook_provider')
      group by type.typname order by type.typname
    `);
    expect(enums.rows).toEqual([
      { type: "notification_delivery_status", values: ["pending", "sending", "accepted", "delivered", "failed", "unavailable"] },
      { type: "webhook_provider", values: ["ghl", "meta", "stripe", "notion", "internal", "resend"] },
    ]);
    const legacy = await db.query<{ signature: string }>(`
      select table_name || '.' || column_name as signature from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'commission_ledger' and column_name in ('status','paid_by','paid_at','updated_at'))
        or (table_name = 'referrals' and column_name = 'clawback')
      ) order by 1
    `);
    expect(legacy.rows).toEqual([]);
    const trigger = await db.query<{ count: string }>(`
      select count(*)::text from pg_trigger
      where tgrelid = 'public.commission_ledger'::regclass and tgname = 'set_updated_at'
    `);
    expect(trigger.rows[0].count).toBe("0");
    const index = await db.query<{ count: string }>(`
      select count(*)::text from pg_indexes
      where schemaname = 'public' and indexname = 'commission_ledger_status_idx'
    `);
    expect(index.rows[0].count).toBe("0");
  });

  it("pins the immutable attempt table, constraints, indexes, and read-only grants", async () => {
    const columns = await db.query<{ signature: string }>(`
      select column_name || ':' || udt_name || ':' || is_nullable as signature
      from information_schema.columns
      where table_schema = 'public' and table_name = 'notification_delivery_attempts'
      order by ordinal_position
    `);
    expect(columns.rows.map((row) => row.signature)).toEqual([
      "id:uuid:NO", "delivery_id:uuid:NO", "attempt_number:int4:NO", "worker_id:uuid:NO",
      "destination:notification_destination:NO", "recipient_email:text:YES", "destination_url:text:YES",
      "started_at:timestamptz:NO", "finished_at:timestamptz:YES", "outcome:text:YES",
      "provider_reference:text:YES", "error_code:text:YES", "error_detail:text:YES", "created_at:timestamptz:NO",
    ]);
    const constraints = await db.query<{ name: string }>(`
      select conname as name from pg_constraint
      where conrelid in (
        'public.notifications'::regclass,
        'public.notification_deliveries'::regclass,
        'public.notification_delivery_attempts'::regclass
      ) order by conname
    `);
    expect(constraints.rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      "notification_delivery_active_lease_chk",
      "notification_delivery_attempt_finish_chk",
      "notification_delivery_attempt_number_key",
      "notification_delivery_attempt_outcome_chk",
      "notification_delivery_attempt_target_chk",
      "notification_delivery_due_chk",
      "notification_delivery_lease_chk",
      "notifications_recipient_chk",
    ]));
    const indexes = await db.query<{ name: string }>(`
      select indexname as name from pg_indexes where schemaname = 'public'
        and indexname in (
          'notifications_rule_recipient_source_uidx','notifications_bell_idx',
          'notification_deliveries_due_idx','notification_delivery_attempts_delivery_idx'
        ) order by indexname
    `);
    expect(indexes.rows.map((row) => row.name)).toEqual([
      "notification_deliveries_due_idx",
      "notification_delivery_attempts_delivery_idx",
      "notifications_bell_idx",
      "notifications_rule_recipient_source_uidx",
    ]);
    const writes = await db.query<{ grantee: string; privilege_type: string }>(`
      select grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'notification_delivery_attempts'
        and grantee in ('anon','authenticated')
        and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
    `);
    expect(writes.rows).toEqual([]);
  });

  it("keeps every Phase 8 writer SECURITY DEFINER, service-only, and search-path pinned", async () => {
    const functions = await db.query<{
      signature: string; security_definer: boolean; config: string[];
      auth_exec: boolean; service_exec: boolean;
    }>(`
      select procedure.oid::regprocedure::text as signature,
        procedure.prosecdef as security_definer, procedure.proconfig as config,
        has_function_privilege('authenticated', procedure.oid, 'execute') as auth_exec,
        has_function_privilege('service_role', procedure.oid, 'execute') as service_exec
      from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public' and procedure.oid::regprocedure::text = any($1::text[])
      order by signature
    `, [[...PHASE8_FUNCTIONS]]);
    expect(functions.rows.map((row) => row.signature)).toEqual([...PHASE8_FUNCTIONS]);
    expect(functions.rows.every((row) => row.security_definer)).toBe(true);
    expect(functions.rows.every((row) => row.config?.includes('search_path=""'))).toBe(true);
    expect(functions.rows.every((row) => !row.auth_exec && row.service_exec)).toBe(true);
    const old = await db.query<{ old_start: string | null; old_finish: string | null }>(`
      select to_regprocedure('public.start_platform_export(uuid,text,jsonb,text[],text)')::text as old_start,
        to_regprocedure('public.finish_platform_export(uuid,bigint,bigint,bigint,text)')::text as old_finish
    `);
    expect(old.rows[0]).toEqual({ old_start: null, old_finish: null });
  });

  it("uses text comparisons for the new enum values and preserves the sole migration rule", () => {
    const migrationDir = resolve(process.cwd(), "supabase/migrations");
    const source = readFileSync(resolve(migrationDir, "20260824000001_phase8_operate_handover.sql"), "utf8");
    expect(source).toContain("status::text in ('pending', 'failed')");
    expect(source).toContain("provider::text = 'resend'");
    expect(source).not.toMatch(/status\s*=\s*'accepted'/);
    expect(source).not.toMatch(/provider\s*=\s*'resend'/);
    expect(source).toContain("for update of delivery skip locked");
    expect(source).toContain("nulls not distinct");
  });

  it("keeps Phase 8 seed copy visibly unapproved and registers only the reassignment audit action", async () => {
    const copy = await db.query<{ count: string; placeholder: string; rendered: string }>(`
      select count(*) filter (where event_key <> 'conversation.outbound_send_unconfirmed')::text as count,
        count(*) filter (where email_subject like 'SETTERFI_DEMO_PLACEHOLDER_%'
          and email_body like 'SETTERFI_DEMO_PLACEHOLDER_%'
          and slack_text like 'SETTERFI_DEMO_PLACEHOLDER_%'
          and event_key <> 'conversation.outbound_send_unconfirmed')::text as placeholder,
        count(*) filter (where event_key = 'conversation.outbound_send_unconfirmed'
          and email_subject not like 'SETTERFI_DEMO_PLACEHOLDER_%'
          and email_body not like 'SETTERFI_DEMO_PLACEHOLDER_%'
          and slack_text not like 'SETTERFI_DEMO_PLACEHOLDER_%')::text as rendered
      from public.alert_rules
    `);
    expect(copy.rows[0].count).toBe("35");
    expect(copy.rows[0].placeholder).toBe("35");
    expect(copy.rows[0].rendered).toBe("2");
    const audit = await db.query(`
      select key, actor_kind::text as actor_kind, scope::text as scope,
        reason_required, coach_visible, microcopy, aria_label
      from public.audit_actions where key = 'tenant.success_owner.reassigned'
    `);
    expect(audit.rows).toEqual([{
      key: "tenant.success_owner.reassigned",
      actor_kind: "human",
      scope: "tenant",
      reason_required: true,
      coach_visible: false,
      microcopy: "Reassignment logged",
      aria_label: "Success owner reassignment recorded in the audit log",
    }]);
  });

  it("makes the alert catalog exactly the emitted union with no exceptions", async () => {
    const catalog = await db.query<{ key: string }>(`
      select event_key || ':' || scope::text as key from public.alert_rules
      where category <> 'demo'
      order by 1
    `);
    const catalogKeys = catalog.rows.map((row) => row.key).sort();
    const exceptionKeys = [
      "calendar.connection_unhealthy:tenant",
      "conversation.needs_human:tenant",
      "message_template.rejected:tenant",
      "onboarding.a2p_blocked_permanent:platform",
      "onboarding.a2p_blocked_permanent:tenant",
      "onboarding.paying_not_live:tenant",
      "onboarding.stalled_coach:tenant",
      "onboarding.stalled_external:platform",
      "onboarding.stalled_external:tenant",
      "onboarding.stalled_system:platform",
      "send.refused.window_expired:tenant",
    ];
    expect(ALERT_RULES_WITHOUT_EMITTER).toEqual([]);
    const emitted = new Set(EMITTED_ALERT_RULE_KEYS);
    const exceptions = new Set<string>(exceptionKeys);
    expect(emitted.size).toBe(EMITTED_ALERT_RULE_KEYS.length);
    expect(exceptions.size).toBe(exceptionKeys.length);
    expect(exceptionKeys.every((key) => !emitted.has(key))).toBe(true);

    const expected = [...EMITTED_ALERT_RULE_KEYS, ...exceptionKeys].sort();
    const orphan = catalogKeys.find((key) => !emitted.has(key) && !exceptions.has(key));
    if (orphan) throw new Error(`ALERT_RULE_WITHOUT_EMITTER:${orphan}`);
    expect(catalogKeys).toEqual(expected);
  });
});
