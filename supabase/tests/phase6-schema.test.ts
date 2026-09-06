// Phase 6 money contract. These tests use migrated Postgres because catalog custody,
// append-only enforcement, and transaction-level idempotency cannot be proved with mocks.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "61000000-0000-4000-8000-000000000001";
const TENANT_B = "61000000-0000-4000-8000-000000000002";
const TENANT_DEMO = "61000000-0000-4000-8000-000000000003";
const TIER_A = "62000000-0000-4000-8000-000000000001";
const TIER_B = "62000000-0000-4000-8000-000000000002";
const ADMIN = "63000000-0000-4000-8000-000000000001";
const COACH_A = "63000000-0000-4000-8000-000000000002";
const COACH_B = "63000000-0000-4000-8000-000000000003";
const AFFILIATE_USER = "63000000-0000-4000-8000-000000000004";

const PHASE6_TABLES = [
  "allowance_actions",
  "billing_correction_decisions",
  "billing_correction_requests",
  "billing_subscriptions",
  "commission_payout_events",
  "commission_payout_items",
  "commission_payouts",
  "referral_commission_windows",
  "stripe_checkout_sessions",
  "tenant_cost_rollups",
  "tenant_price_overrides",
  "tier_price_versions",
] as const;

const PHASE6_FUNCTIONS = [
  "accrue_invoice_commission(uuid,text,timestamp with time zone,bigint,bigint)",
  "affiliate_payout_history_projection()",
  "affiliate_referral_projection()",
  "apply_billing_subscription_snapshot(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,timestamp with time zone)",
  "apply_stripe_invoice_failed(uuid,text,text,timestamp with time zone)",
  "apply_stripe_invoice_paid(uuid,text,text,timestamp with time zone,bigint,bigint,timestamp with time zone)",
  "approve_commission_payout(uuid,uuid,uuid[],text)",
  "coach_billing_projection(uuid)",
  "decide_billable_correction(uuid,uuid,uuid,text,text)",
  "record_allowance_action(uuid,timestamp with time zone,timestamp with time zone,text,integer,integer,uuid,timestamp with time zone,uuid,text,text)",
  "record_commission_payout_sent(uuid,uuid,text,date)",
  "record_stripe_checkout_session(uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone)",
  "request_billable_correction(uuid,uuid,integer,text)",
  "reverse_invoice_commission(uuid,text,text,text,bigint,timestamp with time zone)",
  "set_tenant_billing_status(uuid,uuid,tenant_status,text)",
  "set_tenant_price_override(uuid,uuid,integer,timestamp with time zone,timestamp with time zone,text)",
  "update_billing_tier(uuid,uuid,integer,integer,integer,text,text)",
  "write_tenant_cost_rollup(uuid,timestamp with time zone,timestamp with time zone,bigint,bigint,bigint,bigint,text[],jsonb)",
] as const;

let db: Client;

async function actAs(
  role: "authenticated" | "service_role",
  claims: Record<string, string>,
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

async function createBillableEvent(tenantId = TENANT_A, suffix = "a") {
  const contact = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, last_channel, name)
     values ($1, 'sms', $2) returning id`,
    [tenantId, `Money lead ${suffix}`],
  );
  const appointment = await db.query<{ id: string }>(
    `insert into public.appointments
      (tenant_id, contact_id, provider, external_id, start_at, end_at, timezone)
     values ($1, $2, 'ghl', $3, now() + interval '1 day',
       now() + interval '1 day 30 minutes', 'America/New_York') returning id`,
    [tenantId, contact.rows[0].id, `money-${suffix}`],
  );
  const event = await db.query<{ id: string }>(
    `insert into public.billable_events (tenant_id, appointment_id, quantity)
     values ($1, $2, 1) returning id`,
    [tenantId, appointment.rows[0].id],
  );
  return event.rows[0].id;
}

async function createReferral() {
  const affiliate = await db.query<{ id: string }>(`
    insert into public.affiliates (user_id, referral_code)
    values ('${AFFILIATE_USER}', 'PHASE6-AFFILIATE') returning id
  `);
  await db.query(`select set_config('app.phase5_signup_referral', 'on', true)`);
  const referral = await db.query<{ id: string }>(
    `insert into public.referrals (affiliate_id, tenant_id)
     values ($1, '${TENANT_A}') returning id`,
    [affiliate.rows[0].id],
  );
  await db.query(`select set_config('app.phase5_signup_referral', 'off', true)`);
  return { affiliateId: affiliate.rows[0].id, referralId: referral.rows[0].id };
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 6 schema suite could not reach Postgres at ${DB_URL}. ` +
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
    insert into public.tiers
      (id, name, price_cents, call_allowance, fair_use_cap, fair_use_note, stripe_price_id)
    values
      ('${TIER_A}', 'Test Seed A', 111, 3, 6, 'Synthetic test tier', 'price_test_a'),
      ('${TIER_B}', 'Test Seed B', 222, 6, 12, 'Synthetic test tier', 'price_test_b');
    insert into public.tenants
      (id, slug, name, status, tier_id, billing_contact_email, is_demo)
    values
      ('${TENANT_A}', 'phase6-a', 'Phase 6 A', 'active', '${TIER_A}', 'billing-a@phase6.test', false),
      ('${TENANT_B}', 'phase6-b', 'Phase 6 B', 'suspended', '${TIER_A}', 'billing-b@phase6.test', false),
      ('${TENANT_DEMO}', 'phase6-demo', 'Phase 6 Demo', 'active', '${TIER_A}', 'billing-demo@phase6.test', true);
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@phase6.test', 'admin', null),
      ('${COACH_A}', 'coach-a@phase6.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@phase6.test', 'coach', '${TENANT_B}'),
      ('${AFFILIATE_USER}', 'affiliate@phase6.test', 'affiliate', null);
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("Phase 6 catalog contract", () => {
  it("pins every table column, type, and nullability", async () => {
    const result = await db.query<{ signature: string }>(`
      select table_name || '.' || column_name || ':' || udt_name || ':' || is_nullable as signature
      from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])
      order by table_name, ordinal_position
    `, [[...PHASE6_TABLES]]);
    expect(result.rows.map((row) => row.signature)).toEqual([
      "allowance_actions.id:uuid:NO", "allowance_actions.tenant_id:uuid:NO",
      "allowance_actions.billing_period_start:timestamptz:NO",
      "allowance_actions.billing_period_end:timestamptz:NO", "allowance_actions.kind:text:NO",
      "allowance_actions.threshold:int4:NO", "allowance_actions.observed_count:int4:NO",
      "allowance_actions.pending_tier_id:uuid:YES", "allowance_actions.effective_at:timestamptz:YES",
      "allowance_actions.notice_event_id:uuid:YES", "allowance_actions.stripe_schedule_id:text:YES",
      "allowance_actions.state:text:NO", "allowance_actions.created_at:timestamptz:NO",
      "allowance_actions.provider_confirmed_at:timestamptz:YES",
      "allowance_actions.terminal_reason:text:YES",
      "allowance_actions.completion_notice_event_id:uuid:YES",
      "billing_correction_decisions.id:uuid:NO", "billing_correction_decisions.request_id:uuid:NO",
      "billing_correction_decisions.decision:text:NO", "billing_correction_decisions.decided_by:uuid:NO",
      "billing_correction_decisions.reason:text:NO", "billing_correction_decisions.offset_event_id:uuid:YES",
      "billing_correction_decisions.audit_id:int8:NO", "billing_correction_decisions.created_at:timestamptz:NO",
      "billing_correction_requests.id:uuid:NO", "billing_correction_requests.tenant_id:uuid:NO",
      "billing_correction_requests.billable_event_id:uuid:YES", "billing_correction_requests.quantity_delta:int4:YES",
      "billing_correction_requests.requested_by:uuid:NO", "billing_correction_requests.reason:text:NO",
      "billing_correction_requests.audit_id:int8:NO", "billing_correction_requests.created_at:timestamptz:NO",
      "billing_correction_requests.period_start:timestamptz:YES", "billing_correction_requests.period_end:timestamptz:YES",
      "billing_subscriptions.id:uuid:NO", "billing_subscriptions.tenant_id:uuid:NO",
      "billing_subscriptions.stripe_customer_id:text:NO", "billing_subscriptions.stripe_subscription_id:text:NO",
      "billing_subscriptions.stripe_price_id:text:NO", "billing_subscriptions.status:text:NO",
      "billing_subscriptions.current_period_start:timestamptz:NO",
      "billing_subscriptions.current_period_end:timestamptz:NO",
      "billing_subscriptions.cancel_at_period_end:bool:NO",
      "billing_subscriptions.provider_updated_at:timestamptz:NO",
      "billing_subscriptions.created_at:timestamptz:NO", "billing_subscriptions.updated_at:timestamptz:NO",
      "commission_payout_events.id:uuid:NO", "commission_payout_events.payout_id:uuid:NO",
      "commission_payout_events.kind:text:NO", "commission_payout_events.reference:text:YES",
      "commission_payout_events.paid_on:date:YES", "commission_payout_events.actor_id:uuid:NO",
      "commission_payout_events.audit_id:int8:NO", "commission_payout_events.created_at:timestamptz:NO",
      "commission_payout_items.payout_id:uuid:NO", "commission_payout_items.ledger_id:uuid:NO",
      "commission_payout_items.commission_cents:int8:NO", "commission_payout_items.created_at:timestamptz:NO",
      "commission_payouts.id:uuid:NO", "commission_payouts.affiliate_id:uuid:NO",
      "commission_payouts.total_cents:int8:NO", "commission_payouts.created_by:uuid:NO",
      "commission_payouts.created_at:timestamptz:NO",
      "referral_commission_windows.referral_id:uuid:NO", "referral_commission_windows.first_invoice_id:text:NO",
      "referral_commission_windows.started_at:timestamptz:NO", "referral_commission_windows.expires_at:timestamptz:NO",
      "referral_commission_windows.created_at:timestamptz:NO",
      "stripe_checkout_sessions.id:uuid:NO", "stripe_checkout_sessions.tenant_id:uuid:NO",
      "stripe_checkout_sessions.tier_id:uuid:NO", "stripe_checkout_sessions.idempotency_key:text:NO",
      "stripe_checkout_sessions.stripe_session_id:text:NO", "stripe_checkout_sessions.stripe_customer_id:text:NO",
      "stripe_checkout_sessions.stripe_subscription_id:text:YES", "stripe_checkout_sessions.state:text:NO",
      "stripe_checkout_sessions.expires_at:timestamptz:NO", "stripe_checkout_sessions.completed_at:timestamptz:YES",
      "stripe_checkout_sessions.created_at:timestamptz:NO", "stripe_checkout_sessions.updated_at:timestamptz:NO",
      "tenant_cost_rollups.id:uuid:NO", "tenant_cost_rollups.tenant_id:uuid:NO",
      "tenant_cost_rollups.window_start:timestamptz:NO", "tenant_cost_rollups.window_end:timestamptz:NO",
      "tenant_cost_rollups.recognized_subscription_cents:int8:NO", "tenant_cost_rollups.model_cents:int8:YES",
      "tenant_cost_rollups.messaging_cents:int8:YES", "tenant_cost_rollups.embedding_cents:int8:YES",
      "tenant_cost_rollups.total_cost_cents:int8:YES", "tenant_cost_rollups.complete:bool:NO",
      "tenant_cost_rollups.missing_sources:_text:NO", "tenant_cost_rollups.source_evidence:jsonb:NO",
      "tenant_cost_rollups.computed_at:timestamptz:NO",
      "tenant_price_overrides.id:uuid:NO", "tenant_price_overrides.tenant_id:uuid:NO",
      "tenant_price_overrides.price_cents:int4:NO", "tenant_price_overrides.effective_at:timestamptz:NO",
      "tenant_price_overrides.ends_at:timestamptz:YES", "tenant_price_overrides.actor_id:uuid:NO",
      "tenant_price_overrides.reason:text:NO", "tenant_price_overrides.audit_id:int8:NO",
      "tenant_price_overrides.created_at:timestamptz:NO",
      "tier_price_versions.id:uuid:NO", "tier_price_versions.tier_id:uuid:NO",
      "tier_price_versions.price_cents:int4:NO", "tier_price_versions.call_allowance:int4:NO",
      "tier_price_versions.fair_use_cap:int4:YES", "tier_price_versions.fair_use_note:text:YES",
      "tier_price_versions.effective_at:timestamptz:NO", "tier_price_versions.actor_id:uuid:NO",
      "tier_price_versions.reason:text:NO", "tier_price_versions.audit_id:int8:NO",
      "tier_price_versions.created_at:timestamptz:NO",
    ]);
  });

  it("pins named constraints, indexes, forced RLS policies, and zero browser writes", async () => {
    const constraints = await db.query<{ name: string }>(`
      select conname as name from pg_constraint
      where connamespace = 'public'::regnamespace
        and conrelid::regclass::text = any($1::text[])
      order by conname
    `, [[...PHASE6_TABLES, "commission_ledger"]]);
    expect(constraints.rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      "allowance_actions_counts_chk", "allowance_actions_kind_chk",
      "allowance_actions_period_kind_key", "allowance_actions_period_chk",
      "allowance_actions_schedule_shape_chk", "allowance_actions_state_chk",
      "billing_correction_decisions_reason_chk", "billing_correction_decisions_request_fk",
      "billing_correction_decisions_request_key", "billing_correction_decisions_shape_chk",
      "billing_correction_decisions_value_chk", "billing_correction_requests_shape_chk",
      "billing_correction_requests_reason_chk", "billing_subscriptions_customer_key",
      "billing_subscriptions_period_chk", "billing_subscriptions_status_chk",
      "billing_subscriptions_subscription_key", "billing_subscriptions_tenant_key",
      "commission_ledger_entry_kind_chk", "commission_ledger_entry_shape_chk",
      "commission_payout_items_amount_chk", "commission_payout_items_ledger_key",
      "commission_payout_events_kind_chk", "commission_payout_events_shape_chk",
      "commission_payouts_total_chk",
      "referral_commission_windows_period_chk", "stripe_checkout_sessions_completion_chk",
      "stripe_checkout_sessions_idempotency_key", "stripe_checkout_sessions_session_key",
      "stripe_checkout_sessions_state_chk", "tenant_cost_rollups_complete_chk",
      "tenant_cost_rollups_values_chk", "tenant_cost_rollups_window_chk",
      "tenant_cost_rollups_window_key", "tenant_price_overrides_price_chk",
      "tenant_price_overrides_reason_chk", "tenant_price_overrides_tenant_effective_key",
      "tenant_price_overrides_window_chk", "tier_price_versions_reason_chk",
      "tier_price_versions_tier_effective_key", "tier_price_versions_values_chk",
    ]));
    const indexes = await db.query<{ indexname: string }>(`
      select indexname from pg_indexes where schemaname = 'public'
        and (tablename = any($1::text[]) or tablename = 'commission_ledger')
      order by indexname
    `, [[...PHASE6_TABLES]]);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "allowance_actions_due_idx", "billing_subscriptions_price_idx",
      "billing_subscriptions_status_idx", "commission_ledger_accrual_invoice_uidx",
      "commission_ledger_reverses_idx", "commission_ledger_stripe_adjustment_uidx",
      "commission_payout_events_approved_uidx", "commission_payout_events_sent_uidx",
      "commission_payout_events_payout_idx", "commission_payouts_affiliate_idx",
      "billing_correction_decisions_created_idx", "billing_correction_requests_tenant_open_idx",
      "referral_commission_windows_first_invoice_uidx", "stripe_checkout_sessions_tenant_state_idx",
      "tenant_cost_rollups_latest_idx", "tenant_price_overrides_current_idx",
      "tier_price_versions_latest_idx",
    ]));
    const rls = await db.query<{ relname: string; forced: boolean; commands: string[] }>(`
      select class.relname, class.relforcerowsecurity as forced,
        array_agg(policy.cmd order by policy.cmd) as commands
      from pg_class class join pg_namespace namespace on namespace.oid = class.relnamespace
      left join pg_policies policy on policy.schemaname = namespace.nspname
        and policy.tablename = class.relname
      where namespace.nspname = 'public' and class.relname = any($1::text[])
      group by class.relname, class.relforcerowsecurity order by class.relname
    `, [[...PHASE6_TABLES]]);
    expect(rls.rows.map((row) => row.relname)).toEqual([...PHASE6_TABLES]);
    expect(rls.rows.every((row) => row.forced)).toBe(true);
    expect(rls.rows.every((row) => row.commands.join(",") === "SELECT")).toBe(true);
    const writes = await db.query<{ grantee: string; table_name: string; privilege_type: string }>(`
      select grantee, table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = any($1::text[])
        and grantee in ('anon','authenticated','service_role')
        and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
      order by 1,2,3
    `, [[...PHASE6_TABLES]]);
    expect(writes.rows).toEqual([]);
  });

  it("pins SECURITY DEFINER signatures, returns, search paths, and execute grantees", async () => {
    const result = await db.query<{
      signature: string;
      result: string;
      security_definer: boolean;
      config: string[];
      auth_exec: boolean;
      service_exec: boolean;
    }>(`
      select p.oid::regprocedure::text as signature,
        pg_get_function_result(p.oid) as result,
        p.prosecdef as security_definer,
        p.proconfig as config,
        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
        has_function_privilege('service_role', p.oid, 'execute') as service_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
      order by signature
`, [[...PHASE6_FUNCTIONS].map((signature) => signature.slice(0, signature.indexOf("(")))]);
    expect(result.rows.map((row) => row.signature)).toEqual([...PHASE6_FUNCTIONS]);
    expect(result.rows.every((row) => row.security_definer)).toBe(true);
    expect(result.rows.every((row) => row.config?.includes("search_path=\"\""))).toBe(true);
    expect(result.rows.every((row) => row.service_exec)).toBe(true);
    expect(result.rows.filter((row) => row.auth_exec).map((row) => row.signature)).toEqual([
      "affiliate_payout_history_projection()",
      "affiliate_referral_projection()",
      "coach_billing_projection(uuid)",
      "request_billable_correction(uuid,uuid,integer,text)",
    ]);
    expect(Object.fromEntries(result.rows.map((row) => [row.signature, row.result]))).toEqual({
      "accrue_invoice_commission(uuid,text,timestamp with time zone,bigint,bigint)":
        "TABLE(ledger_id uuid, referral_id uuid, window_started boolean, commission_cents bigint)",
      "affiliate_payout_history_projection()":
        "TABLE(amount_cents bigint, state text, reference text, recorded_on date)",
      "affiliate_referral_projection()":
        "TABLE(business_name text, account_status text, commission_earned_cents bigint)",
      "apply_billing_subscription_snapshot(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,timestamp with time zone)":
        "TABLE(subscription_row_id uuid, status text)",
      "apply_stripe_invoice_failed(uuid,text,text,timestamp with time zone)":
        "TABLE(subscription_row_id uuid, tenant_status tenant_status)",
      "apply_stripe_invoice_paid(uuid,text,text,timestamp with time zone,bigint,bigint,timestamp with time zone)":
        "TABLE(subscription_row_id uuid, tenant_status tenant_status, commission_ledger_id uuid)",
      "approve_commission_payout(uuid,uuid,uuid[],text)":
        "TABLE(payout_id uuid, event_id uuid, audit_id bigint)",
      "coach_billing_projection(uuid)":
        "TABLE(tier_name text, price_cents integer, period_start timestamp with time zone, period_end timestamp with time zone, timezone text, booked_count bigint, call_allowance integer, subscription_state text, invoice_state text, account_state text, pending_tier_name text, pending_price_cents integer, pending_effective_at timestamp with time zone, notices jsonb, correction_candidates jsonb, outcome_prompts jsonb, settled_attendance jsonb, is_demo boolean)",
      "decide_billable_correction(uuid,uuid,uuid,text,text)":
        "TABLE(decision_id uuid, offset_event_id uuid, audit_id bigint)",
      "record_allowance_action(uuid,timestamp with time zone,timestamp with time zone,text,integer,integer,uuid,timestamp with time zone,uuid,text,text)":
        "TABLE(allowance_action_id uuid)",
      "record_commission_payout_sent(uuid,uuid,text,date)": "TABLE(event_id uuid, audit_id bigint)",
      "record_stripe_checkout_session(uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone)":
        "TABLE(checkout_session_id uuid, state text)",
      "request_billable_correction(uuid,uuid,integer,text)":
        "TABLE(request_id uuid, audit_id bigint)",
      "reverse_invoice_commission(uuid,text,text,text,bigint,timestamp with time zone)":
        "TABLE(ledger_id uuid, reversed_cents bigint, entry_kind text)",
      "set_tenant_billing_status(uuid,uuid,tenant_status,text)":
        "TABLE(tenant_id uuid, status tenant_status, audit_id bigint)",
      "set_tenant_price_override(uuid,uuid,integer,timestamp with time zone,timestamp with time zone,text)":
        "TABLE(override_id uuid, audit_id bigint)",
      "update_billing_tier(uuid,uuid,integer,integer,integer,text,text)":
        "TABLE(price_version_id uuid, audit_id bigint)",
      "write_tenant_cost_rollup(uuid,timestamp with time zone,timestamp with time zone,bigint,bigint,bigint,bigint,text[],jsonb)":
        "TABLE(rollup_id uuid, complete boolean)",
    });
  });

  /**
   * The four states the affiliate table renders, pinned against the enum they come from.
   *
   * `affiliate_referral_projection`'s `case` has no `else` arm on purpose, so a seventh
   * `tenant_status` maps to nothing, arrives as null, and fails the repository's receipt check --
   * the portal says "could not load" rather than quietly reading a new state as "Paying". That is
   * the right failure, but it is a failure a reader discovers. This asserts the collapse against
   * the live enum so the same mistake reddens here first, at the moment the seventh value is
   * added, with the four states and the mapping spelled out for whoever has to extend them.
   */
  it("collapses all six tenant statuses to exactly the four states the affiliate can read", async () => {
    const enumValues = await db.query<{ label: string }>(
      `select unnest(enum_range(null::public.tenant_status))::text as label order by 1`,
    );
    expect(enumValues.rows.map((row) => row.label).sort()).toEqual([
      "active", "churned", "onboarding", "overdue", "paused", "suspended",
    ]);

    const mapped = await db.query<{ status: string; state: string | null }>(`
      select status, case status
        when 'onboarding' then 'setting_up'
        when 'active' then 'paying'
        when 'paused' then 'payment_problem'
        when 'overdue' then 'payment_problem'
        when 'suspended' then 'payment_problem'
        when 'churned' then 'cancelled'
      end as state
      from unnest(enum_range(null::public.tenant_status)) as status
    `);
    // Every enum value maps, and to one of exactly four states -- no null, no fifth label.
    expect(mapped.rows.filter((row) => row.state === null)).toEqual([]);
    expect([...new Set(mapped.rows.map((row) => row.state))].sort()).toEqual([
      "cancelled", "paying", "payment_problem", "setting_up",
    ]);
    // The one the round-3 change exists to fix: a stalled account must never read as paying.
    expect(mapped.rows.filter((row) => row.state === "paying").map((row) => row.status))
      .toEqual(["active"]);
  });

  it("keeps the commission backfill before NOT NULL and the partial index swap", () => {
    const migration = readFileSync(
      `${process.cwd()}/supabase/migrations/20260822000001_phase6_money.sql`,
      "utf8",
    );
    const addNullable = migration.indexOf("add column entry_kind text,");
    const backfill = migration.indexOf("update public.commission_ledger set entry_kind = 'accrual';");
    const notNull = migration.indexOf("alter column entry_kind set not null;");
    const oldUniqueDrop = migration.indexOf(
      "drop constraint commission_ledger_referral_invoice_key;",
    );
    const partialUnique = migration.indexOf("create unique index commission_ledger_accrual_invoice_uidx");
    expect([addNullable, backfill, notNull, oldUniqueDrop, partialUnique].every((index) => index >= 0))
      .toBe(true);
    expect(addNullable).toBeLessThan(backfill);
    expect(backfill).toBeLessThan(notNull);
    expect(notNull).toBeLessThan(oldUniqueDrop);
    expect(oldUniqueDrop).toBeLessThan(partialUnique);
  });

  it("pins triggers, exact registry rows, LEGACY-DEAD comments, and referral non-writers", async () => {
    const triggers = await db.query<{ signature: string }>(`
      select event_object_table || ':' || trigger_name as signature
      from information_schema.triggers
      where trigger_schema = 'public' and (
        event_object_table = any($1::text[])
        or trigger_name = 'tenants_reject_phase6_demo_reclassification_with_money'
      ) order by 1
    `, [[...PHASE6_TABLES, "commission_ledger"]]);
    for (const table of [
      "allowance_actions", "billing_correction_decisions", "billing_correction_requests",
      "commission_ledger", "commission_payout_events", "commission_payout_items",
      "commission_payouts", "referral_commission_windows", "tenant_cost_rollups",
      "tenant_price_overrides", "tier_price_versions",
    ]) {
      expect(triggers.rows.map((row) => row.signature)).toContain(`${table}:${table}_reject_mutation`);
    }
    expect(triggers.rows.map((row) => row.signature)).toContain(
      "tenants:tenants_reject_phase6_demo_reclassification_with_money",
    );
    const audit = await db.query<{
      key: string; actor_kind: string; scope: string; reason_required: boolean;
      coach_visible: boolean; microcopy: string; aria_label: string;
    }>(`
      select key, actor_kind::text, scope::text, reason_required, coach_visible,
        microcopy, aria_label
      from public.audit_actions where key like 'billing.%' or key like 'affiliate.payout.%'
      order by key
    `);
    expect(audit.rows).toEqual([
      { key: "affiliate.payout.approved", actor_kind: "human", scope: "platform", reason_required: true, coach_visible: false, microcopy: "Payout approval logged", aria_label: "Affiliate payout approval recorded in the audit log" },
      { key: "affiliate.payout.sent", actor_kind: "human", scope: "platform", reason_required: false, coach_visible: false, microcopy: "Payout sent record logged", aria_label: "Affiliate payout sent record recorded in the audit log" },
      { key: "billing.checkout.created", actor_kind: "human", scope: "tenant", reason_required: false, coach_visible: true, microcopy: "Checkout logged", aria_label: "Billing checkout creation recorded in the audit log" },
      { key: "billing.correction.approved", actor_kind: "human", scope: "tenant", reason_required: true, coach_visible: true, microcopy: "Correction approval logged", aria_label: "Billing correction approval recorded in the audit log" },
      { key: "billing.correction.rejected", actor_kind: "human", scope: "tenant", reason_required: true, coach_visible: true, microcopy: "Correction rejection logged", aria_label: "Billing correction rejection recorded in the audit log" },
      { key: "billing.correction.requested", actor_kind: "human", scope: "tenant", reason_required: true, coach_visible: true, microcopy: "Correction request logged", aria_label: "Billing correction request recorded in the audit log" },
      { key: "billing.tenant_override.updated", actor_kind: "human", scope: "tenant", reason_required: true, coach_visible: true, microcopy: "Price override logged", aria_label: "Tenant price override recorded in the audit log" },
      { key: "billing.tenant.suspended", actor_kind: "human", scope: "tenant", reason_required: true, coach_visible: true, microcopy: "Suspension logged", aria_label: "Tenant billing suspension recorded in the audit log" },
      { key: "billing.tenant.unsuspended", actor_kind: "human", scope: "tenant", reason_required: true, coach_visible: true, microcopy: "Reactivation logged", aria_label: "Tenant billing reactivation recorded in the audit log" },
      { key: "billing.tier_change.completed", actor_kind: "system", scope: "tenant", reason_required: false, coach_visible: true, microcopy: "Scheduled tier change completed", aria_label: "Scheduled tier change completion recorded in the audit log" },
      { key: "billing.tier_offer_term.closed", actor_kind: "human", scope: "platform", reason_required: true, coach_visible: false, microcopy: "Term close logged", aria_label: "Commercial term close recorded in the audit log" },
      { key: "billing.tier_offer_term.recorded", actor_kind: "human", scope: "platform", reason_required: true, coach_visible: false, microcopy: "Commercial term logged", aria_label: "Commercial term recorded in the audit log" },
      { key: "billing.tier.updated", actor_kind: "human", scope: "platform", reason_required: true, coach_visible: false, microcopy: "Tier update logged", aria_label: "Billing tier update recorded in the audit log" },
    ]);
    const alerts = await db.query<{
      key: string; name: string; description: string; category: string; audience: string[];
      success_owner: boolean; billing: boolean; destinations: string[];
      suppressible: boolean; enabled: boolean;
    }>(`
      select event_key || ':' || scope::text as key, name, description, category,
        audience_roles::text[] as audience, include_success_owner as success_owner,
        include_billing_contact as billing, default_destinations::text[] as destinations,
        suppressible, default_enabled as enabled
      from public.alert_rules where event_key like 'billing.%' order by 1
    `);
    expect(alerts.rows).toEqual([
      { key: "billing.account_overdue:tenant", name: "Account overdue", description: "The latest subscription invoice remains unpaid.", category: "billing", audience: ["coach"], success_owner: false, billing: true, destinations: ["bell", "email"], suppressible: false, enabled: true },
      { key: "billing.account_suspended:tenant", name: "Account suspended", description: "The platform suspended new billing activity for this account.", category: "billing", audience: ["coach"], success_owner: false, billing: true, destinations: ["bell", "email"], suppressible: false, enabled: true },
      { key: "billing.allowance_crossed:tenant", name: "Allowance crossed", description: "The booked-call allowance was crossed for this billing period.", category: "billing", audience: ["coach"], success_owner: false, billing: true, destinations: ["bell", "email"], suppressible: false, enabled: true },
      { key: "billing.allowance_warning:tenant", name: "Allowance warning", description: "The booked-call allowance reached its warning threshold.", category: "billing", audience: ["coach"], success_owner: false, billing: true, destinations: ["bell", "email"], suppressible: false, enabled: true },
      { key: "billing.payment_completed:tenant", name: "Payment completed", description: "A subscription invoice was paid.", category: "billing", audience: ["coach"], success_owner: false, billing: true, destinations: ["bell"], suppressible: true, enabled: true },
      { key: "billing.payment_failed:tenant", name: "Payment failed", description: "A subscription invoice payment failed.", category: "billing", audience: ["coach"], success_owner: false, billing: true, destinations: ["bell", "email"], suppressible: false, enabled: true },
      { key: "billing.tier_upgraded:tenant", name: "Client upgraded to next tier", description: "Stripe confirmed the scheduled subscription Price change.", category: "billing", audience: ["coach"], success_owner: false, billing: true, destinations: ["bell"], suppressible: true, enabled: true },
    ]);
    const retiredColumns = await db.query<{ column_name: string }>(`
      select table_name || '.' || column_name as column_name
      from information_schema.columns where table_schema = 'public' and (
        (table_name = 'commission_ledger' and column_name in ('status','paid_by','paid_at','updated_at'))
        or (table_name = 'referrals' and column_name = 'clawback')
      ) order by 1
    `);
    // Phase 8 removes only the legacy columns after proving the event-ledger replacements.
    expect(retiredColumns.rows).toEqual([]);
    const definitions = await db.query<{ definition: string }>(`
      select pg_get_functiondef(p.oid) as definition from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
`, [[...PHASE6_FUNCTIONS].map((signature) => signature.slice(0, signature.indexOf("(")))]);
    const source = definitions.rows.map((row) => row.definition).join("\n");
    expect(source).not.toMatch(/(?:insert into|update|delete from) public\.referrals/i);
    expect(source).not.toMatch(/update public\.commission_ledger/i);
    expect(source).not.toMatch(
      /insert into public\.commission_ledger\s*\([^)]*\b(?:status|paid_by|paid_at|updated_at)\b/i,
    );
  });
});

describe("Phase 6 guarded behavior", () => {
  it("rejects non-platform actor ids and authenticated execution for platform mutations", async () => {
    await actAs("service_role", {});
    await db.query("savepoint non_platform_actor");
    await expect(db.query(`select * from public.update_billing_tier(
      '${COACH_A}', '${TIER_A}', 300, 10, 20, 'Synthetic', 'Unauthorized attempt'
    )`)).rejects.toThrow(/PHASE6_OWNER_ADMIN_REQUIRED/);
    await db.query("rollback to savepoint non_platform_actor");
    await resetRole();
    await actAs("authenticated", { role: "admin", sub: ADMIN });
    await db.query("savepoint authenticated_execute");
    await expect(db.query(`select * from public.update_billing_tier(
      '${ADMIN}', '${TIER_A}', 300, 10, 20, 'Synthetic', 'Unauthorized grant attempt'
    )`)).rejects.toThrow(/permission denied for function update_billing_tier/);
    await db.query("rollback to savepoint authenticated_execute");
  });

  it("keeps checkout, subscription, price history, and tenant status actor-checked and idempotent", async () => {
    await actAs("service_role", { role: "admin", sub: ADMIN });
    const checkout = await db.query<{ checkout_session_id: string; state: string }>(`
      select * from public.record_stripe_checkout_session(
        '${TENANT_A}', '${ADMIN}', '${TIER_A}', 'checkout:test:a', 'cs_test_a', 'cus_test_a', null,
        'open', now() + interval '1 hour', null
      )
    `);
    const replay = await db.query<{ checkout_session_id: string }>(`
      select * from public.record_stripe_checkout_session(
        '${TENANT_A}', '${ADMIN}', '${TIER_A}', 'checkout:test:a', 'cs_test_a', 'cus_test_a', null,
        'open', now() + interval '1 hour', null
      )
    `);
    expect(replay.rows[0].checkout_session_id).toBe(checkout.rows[0].checkout_session_id);
    await db.query(`
      select * from public.record_stripe_checkout_session(
        '${TENANT_A}', null, '${TIER_A}', 'checkout:test:a', 'cs_test_a', 'cus_test_a', 'sub_test_a',
        'completed', now() + interval '1 hour', now()
      )
    `);
    await db.query(`
      select * from public.apply_billing_subscription_snapshot(
        '${TENANT_A}', 'cus_test_a', 'sub_test_a', 'price_test_a', 'active',
        '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', false, '2026-08-01T00:00:01Z'
      )
    `);
    await db.query("savepoint stale_subscription");
    await expect(db.query(`
      select * from public.apply_billing_subscription_snapshot(
        '${TENANT_A}', 'cus_test_a', 'sub_test_a', 'price_test_a', 'active',
        '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', false, '2026-07-31T23:59:59Z'
      )
    `)).rejects.toThrow(/STRIPE_SUBSCRIPTION_STALE_SNAPSHOT/);
    await db.query("rollback to savepoint stale_subscription");
    await resetRole();
    const evidence = await db.query<{ checkout_audits: string; subscription_rows: string }>(`
      select
        (select count(*)::text from public.audit_log
          where tenant_id = '${TENANT_A}' and action = 'billing.checkout.created')
          as checkout_audits,
        (select count(*)::text from public.billing_subscriptions
          where tenant_id = '${TENANT_A}') as subscription_rows
    `);
    expect(evidence.rows[0]).toEqual({ checkout_audits: "1", subscription_rows: "1" });
  });

  it("writes append-only tier and override receipts in the audit transaction", async () => {
    await actAs("service_role", { role: "admin", sub: ADMIN });
    const tier = await db.query<{ price_version_id: string; audit_id: string }>(`
      select * from public.update_billing_tier(
        '${ADMIN}', '${TIER_A}', 333, 9, 18, 'Synthetic revised tier', 'Synthetic approval reason'
      )
    `);
    const override = await db.query<{ override_id: string; audit_id: string }>(`
      select * from public.set_tenant_price_override(
        '${TENANT_A}', '${ADMIN}', 123, now(), now() + interval '1 month', 'Synthetic exception'
      )
    `);
    expect(tier.rows[0].price_version_id).toBeTruthy();
    expect(override.rows[0].override_id).toBeTruthy();
    await resetRole();
    const state = await db.query<{ price: number; audits: string }>(`
      select (select price_cents from public.tiers where id = '${TIER_A}') as price,
        (select count(*)::text from public.audit_log where action in (
          'billing.tier.updated','billing.tenant_override.updated'
        )) as audits
    `);
    expect(state.rows[0]).toEqual({ price: 333, audits: "2" });
    await db.query("savepoint immutable_tier_history");
    await expect(db.query(
      `update public.tier_price_versions set price_cents = 444 where id = $1`,
      [tier.rows[0].price_version_id],
    )).rejects.toThrow(/TIER_PRICE_VERSIONS_APPEND_ONLY/);
    await db.query("rollback to savepoint immutable_tier_history");
  });

  it("creates one coach request and one owner decision with its signed offset", async () => {
    const eventId = await createBillableEvent();
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A, sub: COACH_A });
    const request = await db.query<{ request_id: string; audit_id: string }>(
      `select * from public.request_billable_correction($1, $2, -1, 'Duplicate appointment')`,
      [TENANT_A, eventId],
    );
    await db.query("savepoint duplicate_request");
    await expect(db.query(
      `select * from public.request_billable_correction($1, $2, -1, 'Try twice')`,
      [TENANT_A, eventId],
    )).rejects.toThrow(/BILLING_CORRECTION_ALREADY_OPEN/);
    await db.query("rollback to savepoint duplicate_request");
    await resetRole();

    await actAs("service_role", { role: "admin", sub: ADMIN });
    const decision = await db.query<{
      decision_id: string; offset_event_id: string; audit_id: string;
    }>(
      `select * from public.decide_billable_correction($1, $2, $3, 'approved', 'Verified duplicate')`,
      [TENANT_A, ADMIN, request.rows[0].request_id],
    );
    const replay = await db.query<{ decision_id: string; offset_event_id: string }>(
      `select * from public.decide_billable_correction($1, $2, $3, 'approved', 'Verified duplicate')`,
      [TENANT_A, ADMIN, request.rows[0].request_id],
    );
    expect(replay.rows[0]).toMatchObject({
      decision_id: decision.rows[0].decision_id,
      offset_event_id: decision.rows[0].offset_event_id,
    });
    await resetRole();
    const rows = await db.query<{ quantities: number[]; audits: string }>(`
      select array_agg(quantity order by quantity)::int[] as quantities,
        (select count(*)::text from public.audit_log
          where tenant_id = '${TENANT_A}' and action like 'billing.correction.%') as audits
      from public.billable_events where id = '${eventId}' or adjusts_event_id = '${eventId}'
    `);
    expect(rows.rows[0]).toEqual({ quantities: [-1, 1], audits: "2" });
  });

  it("rejects a cross-tenant correction requester before any financial write", async () => {
    const eventId = await createBillableEvent();
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_B, sub: COACH_B });
    await expect(db.query(
      `select * from public.request_billable_correction($1, $2, -1, 'Wrong tenant')`,
      [TENANT_A, eventId],
    )).rejects.toThrow(/PHASE6_COACH_TENANT_REQUIRED/);
  });

  it("accrues two same-month invoices, freezes the window, and writes capped offsets and recovery", async () => {
    const { referralId } = await createReferral();
    await actAs("service_role", {});
    const first = await db.query<{
      ledger_id: string; window_started: boolean; commission_cents: string;
    }>(`
      select * from public.accrue_invoice_commission(
        '${TENANT_A}', 'in_test_1', '2026-08-05T00:00:00Z', 1100, 1000
      )
    `);
    const replay = await db.query<{ ledger_id: string }>(`
      select * from public.accrue_invoice_commission(
        '${TENANT_A}', 'in_test_1', '2026-08-05T00:00:00Z', 1100, 1000
      )
    `);
    const second = await db.query<{ ledger_id: string }>(`
      select * from public.accrue_invoice_commission(
        '${TENANT_A}', 'in_test_2', '2026-08-20T00:00:00Z', 2200, 2000
      )
    `);
    expect(first.rows[0]).toMatchObject({ window_started: true, commission_cents: "100" });
    expect(replay.rows[0].ledger_id).toBe(first.rows[0].ledger_id);
    expect(second.rows[0].ledger_id).not.toBe(first.rows[0].ledger_id);
    const offset = await db.query<{ ledger_id: string; reversed_cents: string; entry_kind: string }>(`
      select * from public.reverse_invoice_commission(
        '${TENANT_A}', 'in_test_1', 're_test_1', 'refund', 70, '2026-08-21T00:00:00Z'
      )
    `);
    const capped = await db.query<{ reversed_cents: string }>(`
      select * from public.reverse_invoice_commission(
        '${TENANT_A}', 'in_test_1', 'dp_test_1', 'dispute_loss', 70, '2026-08-22T00:00:00Z'
      )
    `);
    const recovery = await db.query<{ reversed_cents: string; entry_kind: string }>(`
      select * from public.reverse_invoice_commission(
        '${TENANT_A}', 'in_test_1', 'dp_test_recovery', 'dispute_recovery', 40, '2026-08-23T00:00:00Z'
      )
    `);
    expect(offset.rows[0]).toMatchObject({ reversed_cents: "70", entry_kind: "offset" });
    expect(capped.rows[0].reversed_cents).toBe("30");
    expect(recovery.rows[0]).toMatchObject({ reversed_cents: "40", entry_kind: "recovery" });
    await resetRole();
    const window = await db.query<{ referral_id: string; months: string }>(`
      select referral_id, extract(year from age(expires_at, started_at))::text as months
      from public.referral_commission_windows where referral_id = '${referralId}'
    `);
    expect(window.rows[0]).toEqual({ referral_id: referralId, months: "1" });
    const entries = await db.query<{ kinds: string[]; total: string }>(`
      select array_agg(entry_kind order by created_at, id) as kinds,
        sum(commission_cents)::text as total
      from public.commission_ledger where referral_id = '${referralId}'
    `);
    expect(entries.rows[0].kinds.sort()).toEqual(["accrual", "accrual", "offset", "offset", "recovery"]);
    expect(entries.rows[0].total).toBe("240");
    await db.query("savepoint duplicate_accrual");
    await expect(db.query(`
      insert into public.commission_ledger (
        referral_id, stripe_invoice_id, invoice_paid_at, base_cents, commission_cents, entry_kind
      ) values ('${referralId}', 'in_test_1', now(), 1000, 100, 'accrual')
    `)).rejects.toThrow(/commission_ledger_accrual_invoice_uidx/);
    await db.query("rollback to savepoint duplicate_accrual");
    await db.query("savepoint duplicate_adjustment");
    await expect(db.query(`
      insert into public.commission_ledger (
        referral_id, stripe_invoice_id, invoice_paid_at, base_cents, commission_cents,
        entry_kind, reverses_ledger_id, stripe_adjustment_id
      ) values (
        '${referralId}', 'in_test_1', now(), 0, -1, 'offset',
        '${first.rows[0].ledger_id}', 're_test_1'
      )
    `)).rejects.toThrow(/commission_ledger_stripe_adjustment_uidx/);
    await db.query("rollback to savepoint duplicate_adjustment");
    await db.query("savepoint mutate_ledger");
    await expect(db.query(
      `update public.commission_ledger set commission_cents = 999 where id = $1`,
      [first.rows[0].ledger_id],
    )).rejects.toThrow(/COMMISSION_LEDGER_APPEND_ONLY/);
    await db.query("rollback to savepoint mutate_ledger");
  });

  it("records payout approval and sent evidence without mutating the append-only ledger row", async () => {
    await createReferral();
    await actAs("service_role", {});
    const accrual = await db.query<{ ledger_id: string }>(`
      select * from public.accrue_invoice_commission(
        '${TENANT_A}', 'in_payout', '2026-08-05T00:00:00Z', 1100, 1000
      )
    `);
    await resetRole();
    const affiliate = await db.query<{ id: string }>(
      `select id from public.affiliates where user_id = '${AFFILIATE_USER}'`,
    );
    await actAs("service_role", { role: "admin", sub: ADMIN });
    const payout = await db.query<{ payout_id: string; event_id: string }>(
      `select * from public.approve_commission_payout($1, $2, $3, 'Synthetic approval')`,
      [ADMIN, affiliate.rows[0].id, [accrual.rows[0].ledger_id]],
    );
    const sent = await db.query<{ event_id: string }>(
      `select * from public.record_commission_payout_sent($1, $2, 'TEST-REFERENCE', '2026-08-25')`,
      [ADMIN, payout.rows[0].payout_id],
    );
    expect(sent.rows[0].event_id).toBeTruthy();
    await resetRole();
    const state = await db.query<{
      kinds: string[]; ledger_id: string; entry_kind: string; commission_cents: string;
    }>(`
      select array_agg(event.kind order by event.created_at) as kinds,
        (select id::text from public.commission_ledger where id = '${accrual.rows[0].ledger_id}') as ledger_id,
        (select entry_kind::text from public.commission_ledger where id = '${accrual.rows[0].ledger_id}') as entry_kind,
        (select commission_cents::text from public.commission_ledger where id = '${accrual.rows[0].ledger_id}') as commission_cents
      from public.commission_payout_events event where event.payout_id = '${payout.rows[0].payout_id}'
    `);
    expect(state.rows[0]).toEqual({
      kinds: ["approved", "sent"],
      ledger_id: accrual.rows[0].ledger_id,
      entry_kind: "accrual",
      commission_cents: "100",
    });
  });

  it("keeps incomplete production margin absent while allowing complete labelled demo evidence", async () => {
    await actAs("service_role", {});
    const production = await db.query<{ complete: boolean }>(`
      select * from public.write_tenant_cost_rollup(
        '${TENANT_A}', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z',
        1000, 10, 20, 30, '{}', '{"source":"synthetic"}'
      )
    `);
    const demo = await db.query<{ complete: boolean }>(`
      select * from public.write_tenant_cost_rollup(
        '${TENANT_DEMO}', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z',
        1000, 10, 20, 30, '{}', '{"source":"synthetic"}'
      )
    `);
    expect(production.rows[0].complete).toBe(false);
    expect(demo.rows[0].complete).toBe(true);
    await resetRole();
    const projection = await db.query<{ tenant_id: string; margin_cents: string }>(
      `select tenant_id, margin_cents::text from public.platform_margin_projection
       where tenant_id = '${TENANT_DEMO}' order by tenant_id`,
    );
    expect(projection.rows).toEqual([{ tenant_id: TENANT_DEMO, margin_cents: "940" }]);
    await db.query("savepoint demo_reclassification");
    await expect(db.query(
      `update public.tenants set is_demo = false where id = '${TENANT_DEMO}'`,
    )).rejects.toThrow(/PHASE6_DEMO_RECLASSIFICATION_WITH_MONEY_FORBIDDEN/);
    await db.query("rollback to savepoint demo_reclassification");
  });

  it("makes allowance actions replay-safe and immutable", async () => {
    await actAs("service_role", {});
    const first = await db.query<{ allowance_action_id: string }>(`
      select * from public.record_allowance_action(
        '${TENANT_A}', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z',
        'warning', 3, 3, null, null, null, null, 'pending'
      )
    `);
    const replay = await db.query<{ allowance_action_id: string }>(`
      select * from public.record_allowance_action(
        '${TENANT_A}', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z',
        'warning', 3, 3, null, null, null, null, 'pending'
      )
    `);
    expect(replay.rows[0].allowance_action_id).toBe(first.rows[0].allowance_action_id);
    const crossing = await db.query<{ allowance_action_id: string }>(`
      select * from public.record_allowance_action(
        '${TENANT_A}', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z',
        'crossing', 3, 4, null, null, null, null, 'awaiting_consent'
      )
    `);
    expect(crossing.rows[0].allowance_action_id).not.toBe(first.rows[0].allowance_action_id);
    await db.query("savepoint allowance_mismatch");
    await expect(db.query(`
      select * from public.record_allowance_action(
        '${TENANT_A}', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z',
        'warning', 3, 4, null, null, null, null, 'pending'
      )
    `)).rejects.toThrow(/ALLOWANCE_ACTION_REPLAY_MISMATCH/);
    await db.query("rollback to savepoint allowance_mismatch");
  });

  it("claims overdue follow-ups while leaving identical suspended work untouched", async () => {
    await db.query(`update public.tenants set status = 'overdue' where id = '${TENANT_A}'`);
    for (const [tenantId, coachId, suffix] of [
      [TENANT_A, COACH_A, "overdue"],
      [TENANT_B, COACH_B, "suspended"],
    ]) {
      const contact = await db.query<{ id: string }>(
        `insert into public.contacts (tenant_id, last_channel, name)
         values ($1, 'sms', $2) returning id`,
        [tenantId, `Follow-up ${suffix}`],
      );
      const conversation = await db.query<{ id: string }>(
        `insert into public.conversations (tenant_id, contact_id, channel)
         values ($1, $2, 'sms') returning id`,
        [tenantId, contact.rows[0].id],
      );
      await db.query(
        `insert into public.followups (
          tenant_id, conversation_id, touch_no, purpose, scheduled_at,
          channel_class, cadence_anchor_at
        ) values ($1, $2, 1, 'value_nudge', now() - interval '1 minute', 'durable', now())`,
        [tenantId, conversation.rows[0].id],
      );
      expect(coachId).toBeTruthy();
    }
    await actAs("service_role", {});
    const overdue = await db.query(`
      select * from public.claim_due_followups('${TENANT_A}', 'phase6-worker', 10, 60, now())
    `);
    const suspended = await db.query(`
      select * from public.claim_due_followups('${TENANT_B}', 'phase6-worker', 10, 60, now())
    `);
    expect(overdue.rowCount).toBe(1);
    expect(suspended.rowCount).toBe(0);
  });

  it("moves active to overdue, never unsuspends from Stripe, and restores only overdue", async () => {
    await actAs("service_role", {});
    await db.query(`
      select * from public.apply_billing_subscription_snapshot(
        '${TENANT_A}', 'cus_state', 'sub_state', 'price_test_a', 'active',
        '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', false, '2026-08-01T00:00:01Z'
      )
    `);
    const failed = await db.query<{ tenant_status: string }>(`
      select * from public.apply_stripe_invoice_failed(
        '${TENANT_A}', 'sub_state', 'in_failed', '2026-08-02T00:00:00Z'
      )
    `);
    expect(failed.rows[0].tenant_status).toBe("overdue");
    await resetRole();
    await actAs("service_role", { role: "admin", sub: ADMIN });
    await db.query(`select * from public.set_tenant_billing_status(
      '${TENANT_A}', '${ADMIN}', 'suspended', 'Synthetic manual suspension'
    )`);
    await resetRole();
    await actAs("service_role", {});
    const paid = await db.query<{ tenant_status: string }>(`
      select * from public.apply_stripe_invoice_paid(
        '${TENANT_A}', 'sub_state', 'in_paid', '2026-08-03T00:00:00Z', 1000, 900,
        '2026-08-03T00:00:00Z'
      )
    `);
    expect(paid.rows[0].tenant_status).toBe("suspended");
  });
});
