// Phase 1 schema contract. This suite deliberately uses live Postgres: catalog,
// RLS, trigger, and transactional behavior cannot be proven by a mocked client.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "10000000-0000-4000-8000-000000000010";
const TENANT_B = "10000000-0000-4000-8000-000000000020";
const TENANT_DEMO = "10000000-0000-4000-8000-000000000030";
const ADMIN = "20000000-0000-4000-8000-000000000010";
const SUCCESS = "20000000-0000-4000-8000-000000000020";
const COACH_A = "20000000-0000-4000-8000-000000000030";
const COACH_B = "20000000-0000-4000-8000-000000000040";
const BUILD = "20000000-0000-4000-8000-000000000050";
const AFFILIATE = "20000000-0000-4000-8000-000000000060";

// Phase 6: service-role custody signatures carrying a separately verified human actor.
const PHASE6_ACTOR_CUSTODY_FUNCTIONS = [
  "approve_commission_payout(uuid,uuid,uuid[],text)",
  "decide_billable_correction(uuid,uuid,uuid,text,text)",
  "record_commission_payout_sent(uuid,uuid,text,date)",
  "record_stripe_checkout_session(uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone)",
  "set_tenant_billing_status(uuid,uuid,tenant_status,text)",
  "set_tenant_price_override(uuid,uuid,integer,timestamp with time zone,timestamp with time zone,text)",
  "update_billing_tier(uuid,uuid,integer,integer,integer,text,text)",
] as const;

const PHASE6_PORTAL_READ_FUNCTIONS = [
  "affiliate_payout_history_projection()",
  "coach_billing_projection(uuid)",
] as const;

// The six outbound-gateway outcomes registered actor_kind = 'system': the policy engine's decision,
// not something the coach did, so the attempting coach belongs in payload.attemptedBy.
const SEND_GATEWAY_SYSTEM_ACTIONS = [
  "send.refused.suppressed",
  "send.refused.no_consent",
  "send.refused.window_expired",
  "followup.deferred.quiet_hours",
  "followup.discarded.window_closed",
  "followup.completed",
] as const;

const AUDIT_KEYS = [
  "account.terms.accepted",
  "account.terms.drafted",
  "account.terms.published",
  "auth.mfa.activated",
  "auth.mfa.disabled",
  "auth.mfa.enrolled",
  "auth.mfa.verification_failed",
  // Phase 6
  "affiliate.payout.approved",
  "affiliate.payout.sent",
  "appointment.attendance_set",
  "appointment.attendance_set.system",
  "appointment.cancel.confirmed",
  "appointment.cancel.failed",
  "appointment.cancel.requested",
  "appointment.canceled",
  "appointment.created",
  "appointment.reschedule.confirmed",
  "appointment.reschedule.failed",
  "appointment.reschedule.requested",
  "appointment.rescheduled",
  "auth.email_change.confirmed",
  "auth.email_change.diverged",
  "auth.email_change.refused",
  "auth.email_change.requested",
  "auth.email_verification.requested",
  "auth.password_reset.completed",
  "auth.password_reset.requested",
  "auth.password.changed",
  "auth.session.revoked",
  "auth.sessions.others_revoked",
  "auth.sessions.viewed",
  "auth.signed_out",
  "billing.checkout.created",
  "billing.correction.approved",
  "billing.correction.rejected",
  "billing.correction.requested",
  "billing.tenant_override.updated",
  "billing.tenant.suspended",
  "billing.tenant.unsuspended",
  "billing.tier.updated",
  "billing.tier_change.completed",
  "billing.tier_offer_term.closed",
  "billing.tier_offer_term.recorded",
  "brain.import.accepted",
  "brain.published",
  "brain.rolled_back",
  "calendar.connected",
  "calendar.disconnected",
  "capi.dataset.provisioned",
  "capi.event.sent",
  "channel.connect.completed",
  "channel.connect.started",
  "channel.connection.disconnected",
  "channel.connection.reconnect.started",
  "channel.connection.tested",
  "channel.disconnected",
  // Phase 9
  "channel.messaging_install.completed",
  "channel.messaging_install.declined",
  "channel.messaging_install.failed",
  "channel.messaging_install.reauthorization_required",
  "channel.messaging_install.start_refused",
  "channel.messaging_install.started",
  "channel.provider.switched",
  "channel.went_live",
  "coach.question.enabled.changed",
  "coach.question_order.saved",
  "compliance.control_reply.published",
  "consent.opt_in",
  "consent.opt_out",
  "consent.web_form_recorded",
  "consumer.conversation_started",
  "contact.created.manual",
  "contact.delete",
  "contact.delete.preview",
  "contact.delete.recovery_adopted",
  "contact.imported",
  "contact.merged",
  "contact.note.added",
  "contact.pipeline_stage.set",
  "contact.tag.added",
  "contact.tag.removed",
  "contact.unmerged",
  "conversation.channel_continued",
  "conversation.closed",
  "conversation.closed.stale",
  "conversation.escalated",
  "conversation.guardrail.cleared",
  "conversation.internal_note.added",
  "conversation.message.sent.human",
  "conversation.outbound_send.reconciled",
  "conversation.outbound_send.reconciliation_required",
  "conversation.rehearsal.played",
  "conversation.scope_blocked",
  "conversation.takeover.claimed",
  "conversation.takeover.released",
  "conversation.tripwire.refused",
  // Phase 7
  "eval.case.promoted",
  "eval.model_config.created",
  "export.finished",
  "export.started",
  "followup.canceled.inbound",
  "followup.claimed",
  "followup.completed",
  "followup.deferred.quiet_hours",
  "followup.discarded.window_closed",
  "followup_copy.approved",
  "followup_copy.draft.saved",
  "followup_copy.rejected",
  "followup_copy.submitted",
  "keyword_goal.deactivated",
  "keyword_goal.saved",
  "impersonation.ended",
  "impersonation.started",
  "message_template.rejected",
  "message_template.submitted",
  "message_template.synced",
  "notification.a2p.cleared",
  "notification.billing.payment_completed",
  "notification.channel.disconnected",
  "notification.inbox.read",
  "notification.inbox.read_all",
  "notification.onboarding.stalled",
  "notification.preference.changed",
  "offer.changed",
  "offer.draft.saved",
  "offer.published",
  "offer.review.cleared",
  "offer.review.rejected",
  "onboarding.a2p_blocked_permanent",
  "onboarding.a2p_filing_confirmed",
  "onboarding.artifact_confirmed",
  "onboarding.business_profile.saved",
  "onboarding.calendar_authorization.recorded",
  "onboarding.campaign_content_approved",
  "onboarding.content_acknowledged",
  "onboarding.content_admin_confirmed",
  "onboarding.signup_completed",
  "onboarding.signup.repair.already_healthy",
  "onboarding.signup.repair.cannot_resume",
  "onboarding.signup.repair.resumed",
  "onboarding.step_failed",
  "onboarding.step_retried",
  "onboarding.step_unblocked",
  "platform_export.finished",
  "platform_export.started",
  "platform.conversation_queue.read",
  "money.page.refused",
  // Phase 9
  "platform.provisioning_install.completed",
  "platform.provisioning_install.declined",
  "platform.provisioning_install.failed",
  "platform.provisioning_install.reauthorization_required",
  "provider.rotation.verified",
  "provisioning.command.undone",
  "provisioning.nudge.intent_recorded",
  "provisioning.owner.reassigned",
  "provisioning.resend.intent_recorded",
  "quiet_hours.window.change",
  "referral.code_rejected",
  "send.refused.no_consent",
  "send.refused.suppressed",
  "send.refused.window_expired",
  "support.thread.assignment.changed",
  "support.thread.status.changed",
  "suppression.clear.provider",
  "suppression.correct",
  "suppression.insert.keyword",
  "suppression.insert.manual",
  "suppression.provider.confirmed",
  "suppression.provider.unconfirmed",
  "suppression.push.failed",
  "suppression.push.provider",
  "tenant.billing_contact_changed",
  "tenant.archived",
  "tenant.command.undone",
  "tenant.demo_flag.changed",
  "tenant.internal_note.added",
  "tenant.lifecycle.paused",
  "tenant.lifecycle.resumed",
  "tenant.membership.accepted",
  "tenant.membership.declined",
  "tenant.membership.expired",
  "tenant.membership.invited",
  "notification.agent.inactive_72h",
  "notification.billing.tier_upgraded",
  "tenant.membership.revoked",
  "tenant.membership.switched",
  "tenant.ownership.accepted",
  "tenant.ownership.expired",
  "tenant.ownership.offered",
  "tenant.ownership.revoked",
  "tenant.onboarding.nudge.intent_recorded",
  "tenant.signup.resend.intent_recorded",
  // Phase 8
  "tenant.success_owner.reassigned",
  "tenant.went_live",
  "test_recipient.registered",
  "webhook.receipt.replayed",
].sort((left, right) => left.localeCompare(right));

const ALERT_KEYS = [
  "agent.inactive_72h:tenant",
  "appointment.booked:tenant",
  "appointment.canceled:tenant",
  "appointment.rescheduled:tenant",
  // Phase 6
  "billing.account_overdue:tenant",
  "billing.account_suspended:tenant",
  "billing.allowance_crossed:tenant",
  "billing.allowance_warning:tenant",
  "billing.payment_failed:tenant",
  "billing.payment_completed:tenant",
  "billing.tier_upgraded:tenant",
  "brain.no_published_snapshot:platform",
  "brain.publish_failed:platform",
  "calendar.connection_unhealthy:tenant",
  "channel.disconnected:tenant",
  "contact.deleted:tenant",
  "conversation.channel_continuation_unavailable:tenant",
  "conversation.needs_human:tenant",
  "conversation.needs_human.unclaimed_24h:tenant",
  "conversation.needs_human.unclaimed_4h:tenant",
  "conversation.outbound_send_unconfirmed:platform",
  "conversation.outbound_send_unconfirmed:tenant",
  "conversation.tripwire_escalated:platform",
  "conversation.tripwire_escalated:tenant",
  "message_template.rejected:tenant",
  "onboarding.a2p_blocked_permanent:platform",
  "onboarding.a2p_blocked_permanent:tenant",
  "onboarding.a2p_cleared:tenant",
  "onboarding.paying_not_live:tenant",
  "onboarding.stalled_coach:tenant",
  "onboarding.stalled_external:platform",
  "onboarding.stalled_external:tenant",
  "onboarding.stalled_system:platform",
  "onboarding.stalled:tenant",
  "send.refused.window_expired:tenant",
  "suppression.provider_unconfirmed:platform",
  "suppression.provider_unconfirmed:tenant",
].sort((left, right) => left.localeCompare(right));

const NEW_TABLES = [
  "a2p_probe_receipts",
  "alert_rules",
  "appointment_reschedules",
  "audit_actions",
  "calendar_connections",
  "calendar_connection_secrets",
  "contact_identities",
  "impersonation_sessions",
  "message_templates",
  "message_traces",
  "notification_deliveries",
  // Phase 8
  "notification_delivery_attempts",
  "notification_preferences",
  "onboarding_content_screens",
  "onboarding_optin_artifacts",
  "offer_cadence_purposes",
  "platform_settings",
  "provisioning_steps",
  "request_rate_limits",
  "signup_intents",
  "support_messages",
  "support_threads",
  "business_profiles",
].sort();

const IS_TEST_TABLES = [
  "appointment_reschedules",
  "appointments",
  "billable_events",
  "brain_knowledge_usage_events",
  // Phase 10
  "brain_objection_usage_events",
  "contact_notes",
  // Phase 7
  "conversation_step_events",
  "contacts",
  "conversations",
  "followups",
  "messages",
  "support_messages",
  "support_threads",
  "unmatched_objections",
].sort();

let db: Client;

async function actAs(
  pgRole: "authenticated" | "anon" | "service_role",
  claims: Record<string, string> = {},
) {
  await db.query(`set local role ${pgRole}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: claims.sub, app_metadata: claims }),
  ]);
}

async function resetRole() {
  await db.query("reset role");
  await db.query(`select set_config('request.jwt.claims', '{}', true)`);
}

async function insertContact(tenantId: string, suffix: string, isTest = false) {
  const result = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, last_channel, name, is_test)
     values ($1, 'sms', $2, $3) returning id`,
    [tenantId, `Lead ${suffix}`, isTest],
  );
  return result.rows[0].id;
}

async function insertConversation(tenantId: string, contactId: string) {
  const result = await db.query<{ id: string }>(
    `insert into public.conversations (tenant_id, contact_id, channel)
     values ($1, $2, 'sms') returning id`,
    [tenantId, contactId],
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 1 schema suite could not reach Postgres at ${DB_URL}. ` +
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
      ('${TENANT_A}', 'phase1-a', 'Phase 1 A', 'billing-a@phase1.test', false),
      ('${TENANT_B}', 'phase1-b', 'Phase 1 B', 'billing-b@phase1.test', false),
      ('${TENANT_DEMO}', 'phase1-demo', 'Phase 1 Demo', 'billing-demo@phase1.test', true);
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@phase1.test', 'admin', null),
      ('${SUCCESS}', 'success@phase1.test', 'success', null),
      ('${COACH_A}', 'coach-a@phase1.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@phase1.test', 'coach', '${TENANT_B}'),
      ('${BUILD}', 'build@phase1.test', 'build', null),
      ('${AFFILIATE}', 'affiliate@phase1.test', 'affiliate', null);
    update public.tenants set success_owner = '${SUCCESS}' where id = '${TENANT_A}';
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("active tenant selection", () => {
  it("lists only live memberships, audits a switch, and clears a revoked selection immediately", async () => {
    await expect(db.query(`
      select tenant_id::text from public.resolve_active_tenant_selection('${COACH_A}', '${TENANT_A}')
    `)).resolves.toMatchObject({ rows: [{ tenant_id: TENANT_A }] });
    await expect(db.query(`
      select count(*)::integer as count from public.tenant_active_selections
      where user_id = '${COACH_A}'
    `)).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await db.query(`
      update public.users
      set role = 'coach_member', tenant_id = '${TENANT_A}'
      where id = '${AFFILIATE}';
      insert into public.tenant_memberships (tenant_id, user_id, role, invited_by) values
        ('${TENANT_A}', '${AFFILIATE}', 'coach_member', '${COACH_A}'),
        ('${TENANT_B}', '${AFFILIATE}', 'coach_member', '${COACH_B}');
    `);

    const available = await db.query<{ tenant_id: string; tenant_name: string; active: boolean }>(`
      select tenant_id::text, tenant_name, active
      from public.list_active_tenants('${AFFILIATE}', '${TENANT_A}')
    `);
    expect(available.rows).toEqual([
      { tenant_id: TENANT_A, tenant_name: "Phase 1 A", active: true },
      { tenant_id: TENANT_B, tenant_name: "Phase 1 B", active: false },
    ]);

    const switched = await db.query<{ tenant_id: string; audit_id: string }>(`
      select tenant_id::text, audit_id::text
      from public.select_active_tenant('${AFFILIATE}', '${TENANT_A}', '${TENANT_B}')
    `);
    expect(switched.rows).toHaveLength(1);
    expect(switched.rows[0].tenant_id).toBe(TENANT_B);
    expect(Number(switched.rows[0].audit_id)).toBeGreaterThan(0);
    await expect(db.query(`
      select count(*)::integer as count from public.tenant_active_selections
      where user_id = '${AFFILIATE}' and tenant_id = '${TENANT_B}'
    `)).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(db.query(`
      select action from public.audit_log
      where actor_id = '${AFFILIATE}' and tenant_id = '${TENANT_B}'
      order by id desc limit 1
    `)).resolves.toMatchObject({ rows: [{ action: "tenant.membership.switched" }] });

    const membership = await db.query<{ id: string }>(`
      select membership.id::text as id
      from public.tenant_memberships as membership
      where membership.user_id = '${AFFILIATE}' and membership.tenant_id = '${TENANT_B}'
    `);
    await db.query(`
      select * from public.revoke_tenant_membership('${TENANT_B}', '${COACH_B}', '${membership.rows[0].id}')
    `);

    const selection = await db.query<{ count: number }>(`
      select count(*)::integer as count from public.tenant_active_selections
      where user_id = '${AFFILIATE}'
    `);
    expect(selection.rows).toEqual([{ count: 0 }]);
    await expect(db.query(`
      select tenant_id::text from public.resolve_active_tenant_selection('${AFFILIATE}', '${TENANT_A}')
    `)).resolves.toMatchObject({ rows: [{ tenant_id: TENANT_A }] });
    await expect(db.query(`
      select tenant_id::text, tenant_name from public.list_active_tenants('${AFFILIATE}', '${TENANT_A}')
    `)).resolves.toMatchObject({ rows: [{ tenant_id: TENANT_A, tenant_name: "Phase 1 A" }] });
    await expect(db.query(`
      select * from public.select_active_tenant('${AFFILIATE}', '${TENANT_A}', '${TENANT_B}')
    `)).rejects.toThrow(/ACTIVE_TENANT_MEMBERSHIP_REQUIRED/);
  });

  it("forces RLS on durable selections while keeping their table service-only", async () => {
    const guard = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; authenticated_select: boolean }>(`
      select c.relrowsecurity, c.relforcerowsecurity,
        has_table_privilege('authenticated', c.oid, 'select') as authenticated_select
      from pg_class as c
      join pg_namespace as n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'tenant_active_selections'
    `);
    expect(guard.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, authenticated_select: false }]);
  });
});

describe("catalog contract", () => {
  it("creates every required table with forced RLS and at least one explicit policy", async () => {
    const result = await db.query<{ relname: string; relforcerowsecurity: boolean; policies: string }>(`
      select c.relname, c.relforcerowsecurity, count(p.policyname)::text as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
      where n.nspname = 'public' and c.relname = any($1::text[])
      group by c.relname, c.relforcerowsecurity
      order by c.relname
    `, [NEW_TABLES]);
    expect(result.rows.map((row) => row.relname)).toEqual(NEW_TABLES);
    expect(result.rows.every((row) => row.relforcerowsecurity)).toBe(true);
    expect(result.rows.every((row) => Number(row.policies) > 0)).toBe(true);
  });

  it("installs every database-owned is_test trigger", async () => {
    const result = await db.query<{ table_name: string }>(`
      select distinct event_object_table as table_name
      from information_schema.triggers
      where trigger_schema = 'public' and trigger_name = 'inherit_is_test'
      order by event_object_table
    `);
    expect(result.rows.map((row) => row.table_name)).toEqual(IS_TEST_TABLES);
  });

  it("keeps narrow custody policies for lead, financial, trace, affiliate, and audit data", async () => {
    const result = await db.query<{ tablename: string; commands: string[] }>(`
      select tablename, array_agg(cmd order by cmd) as commands
      from pg_policies
      where schemaname = 'public'
        and tablename = any($1::text[])
      group by tablename
      order by tablename
    `, [[
      "audit_log", "billable_events", "commission_ledger", "contact_identities",
      "message_traces", "messages", "referrals", "suppression_entries", "tiers",
    ]]);
    const policies = Object.fromEntries(result.rows.map((row) => [row.tablename, row.commands]));
    expect(policies.audit_log).toEqual(["SELECT"]);
    expect(policies.billable_events).toEqual(["SELECT", "SELECT"]);
    expect(policies.commission_ledger).toEqual(["SELECT", "SELECT"]);
    expect(policies.contact_identities).toEqual(["SELECT", "SELECT"]);
    expect(policies.message_traces).toEqual(["SELECT"]);
    expect(policies.messages).toEqual(["SELECT", "SELECT"]);
    expect(policies.referrals).toEqual(["SELECT"]);
    expect(policies.suppression_entries).toEqual(["SELECT", "SELECT"]);
    expect(policies.tiers).toEqual(["SELECT"]);
  });

  it("denies anon table access and exposes service RPCs only to service_role", async () => {
    const anon = await db.query<{ count: string }>(`
      select count(*)::text from information_schema.role_table_grants
      where grantee = 'anon' and table_schema = 'public'
    `);
    expect(Number(anon.rows[0].count)).toBe(0);

    const custody = await db.query<{
      signature: string;
      auth_exec: boolean;
      service_exec: boolean;
    }>(`
      select p.oid::regprocedure::text as signature,
        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
        has_function_privilege('service_role', p.oid, 'execute') as service_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'persist_inbound_message'
      order by p.oid
    `);
    expect(custody.rows).toEqual([
      {
        signature: "persist_inbound_message(uuid,channel_provider,messaging_channel,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text)",
        auth_exec: false,
        service_exec: false,
      },
      {
        signature: "persist_inbound_message(uuid,channel_provider,messaging_channel,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text)",
        auth_exec: false,
        service_exec: true,
      },
      {
        signature: "persist_inbound_message(uuid,channel_provider,messaging_channel,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,text,text,text,jsonb,text)",
        auth_exec: false,
        service_exec: true,
      },
    ]);
  });

  it("keeps the idempotent pipeline stage signature in service-role custody", async () => {
    const result = await db.query<{
      signature: string;
      result_type: string;
      security_definer: boolean;
      config: string[];
      authenticated_exec: boolean;
      service_exec: boolean;
    }>(`
      select p.oid::regprocedure::text as signature,
        pg_get_function_result(p.oid) as result_type,
        p.prosecdef as security_definer,
        p.proconfig as config,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
        has_function_privilege('service_role', p.oid, 'execute') as service_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'set_contact_pipeline_stage'
    `);
    expect(result.rows).toEqual([{
      signature: "set_contact_pipeline_stage(uuid,uuid,pipeline_stage,pipeline_stage,text,uuid,text,uuid,text)",
      result_type: "bigint",
      security_definer: true,
      config: ['search_path=""'],
      authenticated_exec: false,
      service_exec: true,
    }]);
  });

  it("keeps Phase 6 verified-actor mutations service-role-only", async () => {
    const custody = await db.query<{ signature: string; auth_exec: boolean; service_exec: boolean }>(`
      select p.oid::regprocedure::text as signature,
        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
        has_function_privilege('service_role', p.oid, 'execute') as service_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
      order by signature
    `, [[...PHASE6_ACTOR_CUSTODY_FUNCTIONS].map((signature) => signature.slice(0, signature.indexOf("(")))]);
    expect(custody.rows.map((row) => row.signature)).toEqual([...PHASE6_ACTOR_CUSTODY_FUNCTIONS]);
    expect(custody.rows.every((row) => !row.auth_exec && row.service_exec)).toBe(true);
  });

  it("keeps the exact Phase 6 portal read functions authenticated and service-readable", async () => {
    const reads = await db.query<{
      signature: string;
      auth_exec: boolean;
      service_exec: boolean;
      security_definer: boolean;
      config: string[];
    }>(`
      select p.oid::regprocedure::text as signature,
        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
        has_function_privilege('service_role', p.oid, 'execute') as service_exec,
        p.prosecdef as security_definer,
        p.proconfig as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
      order by signature
    `, [[...PHASE6_PORTAL_READ_FUNCTIONS]
      .map((signature) => signature.slice(0, signature.indexOf("(")))]);
    expect(reads.rows.map((row) => row.signature)).toEqual([...PHASE6_PORTAL_READ_FUNCTIONS]);
    expect(reads.rows.every((row) =>
      row.auth_exec && row.service_exec && row.security_definer
      && row.config?.includes('search_path=""')
    )).toBe(true);
  });

  it("contains the required columns, constraints, and production-only aggregate predicate", async () => {
    const columns = await db.query<{ signature: string }>(`
      select table_name || '.' || column_name as signature
      from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'audit_log' and column_name in ('actor_ip', 'source')) or
        (table_name = 'conversations' and column_name = 'disclosure_pending') or
        (table_name = 'model_configs' and column_name in ('role', 'moderator_unavailable_count')) or
        (table_name = 'calendar_connections' and column_name in ('last_slot_fetch_ok', 'last_error', 'last_slot_fetch_at')) or
        (table_name = 'onboarding_optin_artifacts' and column_name in (
          'privacy_body', 'privacy_body_hash', 'terms_body', 'terms_body_hash'
        ))
      ) order by 1
    `);
    expect(columns.rows.map((row) => row.signature)).toEqual([
      "audit_log.actor_ip",
      "audit_log.source",
      "calendar_connections.last_error",
      "calendar_connections.last_slot_fetch_at",
      "calendar_connections.last_slot_fetch_ok",
      "conversations.disclosure_pending",
      "model_configs.moderator_unavailable_count",
      "model_configs.role",
      "onboarding_optin_artifacts.privacy_body",
      "onboarding_optin_artifacts.privacy_body_hash",
      "onboarding_optin_artifacts.terms_body",
      "onboarding_optin_artifacts.terms_body_hash",
    ]);
    const view = await db.query<{ definition: string }>(`
      select definition from pg_views
      where schemaname = 'public' and viewname = 'production_tenant_aggregate_source'
    `);
    expect(view.rows[0].definition.replace(/\s+/g, " ")).toMatch(/WHERE.*NOT.*is_demo/i);
  });

  it("keeps review-fix views, prompt content, and provider signatures narrowly scoped", async () => {
    const viewGrants = await db.query<{ table_name: string; privileges: string[] }>(`
      select table_name, array_agg(privilege_type::text order by privilege_type)::text[] as privileges
      from information_schema.role_table_grants
      where grantee = 'authenticated'
        and table_schema = 'public'
        and table_name in ('coach_support_messages', 'production_tenant_aggregate_source')
      group by table_name order by table_name
    `);
    expect(viewGrants.rows).toEqual([
      { table_name: "coach_support_messages", privileges: ["SELECT"] },
      { table_name: "production_tenant_aggregate_source", privileges: ["SELECT"] },
    ]);
    const settings = await db.query<{ approved: boolean; draft: boolean }>(`
      select approved,
        (agent_content ->> 'automatedExperienceDisclosure') like '[DRAFT]%' as draft
      from public.platform_settings where singleton
    `);
    expect(settings.rows[0]).toEqual({ approved: false, draft: true });
    const providerType = await db.query<{ type_name: string }>(`
      select pg_catalog.format_type(p.proargtypes[3], null) as type_name
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'record_agent_turn'
    `);
    expect(providerType.rows).toEqual([{ type_name: "channel_provider" }]);
  });
});

describe("exact registries", () => {
  it("seeds the exact sorted audit action key set", async () => {
    const result = await db.query<{ key: string }>("select key from public.audit_actions order by key");
    expect(result.rows.map((row) => row.key)).toEqual(AUDIT_KEYS);
  });

  it("registers the install completion keys for the human actor both callbacks pass", async () => {
    const result = await db.query<{ key: string; actor_kind: string }>(`
      select key, actor_kind::text as actor_kind from public.audit_actions
      where key in ('channel.messaging_install.completed', 'platform.provisioning_install.completed')
      order by key
    `);
    expect(result.rows).toEqual([
      { key: "channel.messaging_install.completed", actor_kind: "human" },
      { key: "platform.provisioning_install.completed", actor_kind: "human" },
    ]);
  });

  // The regression that would have caught the live defect: registered 'system' while both callbacks
  // insert the actor from the state row, so every successful install raised
  // AUDIT_SYSTEM_ACTOR_FORBIDDEN after its credentials had already been stored, and redirected error.
  it("accepts a completed install row carrying the actor who started it", async () => {
    for (const action of [
      "channel.messaging_install.completed",
      "platform.provisioning_install.completed",
    ]) {
      const inserted = await db.query<{ id: string }>(`
        insert into public.audit_log (actor_id, tenant_id, action, target_type, target_id, payload)
        values ('${ADMIN}', null, $1, 'ghl_install', 'install-1',
          '{"before": null, "after": {"install_state": "token_ok"}}'::jsonb)
        returning id::text
      `, [action]);
      expect(inserted.rows).toHaveLength(1);
    }
  });

  // The send gateway writes all six of these from both the coach-reply path (which carries an actor)
  // and the AI cadence path (which does not). Only 'system' satisfies both, so the actor must be
  // dropped on the write side; these three tests pin both halves of that contract.
  it("registers all six send-gateway outcomes for the system actor the gateway must pass", async () => {
    const result = await db.query<{ key: string; actor_kind: string }>(`
      select key, actor_kind::text as actor_kind from public.audit_actions
      where key in (
        'followup.completed',
        'followup.deferred.quiet_hours',
        'followup.discarded.window_closed',
        'send.refused.no_consent',
        'send.refused.suppressed',
        'send.refused.window_expired'
      )
      order by key
    `);
    expect(result.rows).toEqual([
      { key: "followup.completed", actor_kind: "system" },
      { key: "followup.deferred.quiet_hours", actor_kind: "system" },
      { key: "followup.discarded.window_closed", actor_kind: "system" },
      { key: "send.refused.no_consent", actor_kind: "system" },
      { key: "send.refused.suppressed", actor_kind: "system" },
      { key: "send.refused.window_expired", actor_kind: "system" },
    ]);
  });

  it("accepts each send-gateway outcome inserted without an actor", async () => {
    for (const action of SEND_GATEWAY_SYSTEM_ACTIONS) {
      const inserted = await db.query<{ id: string }>(`
        insert into public.audit_log (tenant_id, action, target_type, target_id, payload)
        values ('${TENANT_A}', $1, 'conversation', 'conversation-1',
          '{"attemptedBy": "${COACH_A}"}'::jsonb)
        returning id::text
      `, [action]);
      expect(inserted.rows).toHaveLength(1);
    }
  });

  it("rejects a send-gateway outcome carrying a human actor", async () => {
    for (const action of SEND_GATEWAY_SYSTEM_ACTIONS) {
      await db.query("savepoint send_gateway_actor");
      await expect(
        db.query(`
          insert into public.audit_log (tenant_id, actor_id, action, target_type, target_id)
          values ('${TENANT_A}', '${COACH_A}', $1, 'conversation', 'conversation-1')
        `, [action]),
      ).rejects.toThrow(/AUDIT_SYSTEM_ACTOR_FORBIDDEN/);
      await db.query("rollback to savepoint send_gateway_actor");
    }
  });

  // persist_outbound_send picks its audit action from p_purpose but passed p_actor_id through on
  // every purpose, so a coach-actored follow_up or control send would raise inside the RPC.
  it("nulls the actor on a system-keyed outbound send", async () => {
    const contactId = await insertContact(TENANT_A, "rpc-actor");
    const conversationId = await insertConversation(TENANT_A, contactId);
    const sent = await db.query<{ audit_id: string }>(`
      select audit_id::text from public.persist_outbound_send(
        '${TENANT_A}', $1, 'follow_up', '${COACH_A}', 'nudge body',
        'ghl', 'provider-message-rpc', 'idem-rpc-actor', false
      )
    `, [conversationId]);
    expect(sent.rows).toHaveLength(1);

    const logged = await db.query<{ action: string; actor_id: string | null }>(
      "select action, actor_id::text as actor_id from public.audit_log where id = $1",
      [sent.rows[0].audit_id],
    );
    expect(logged.rows[0]).toEqual({ action: "followup.completed", actor_id: null });
  });

  it("seeds the exact sorted scoped alert set", async () => {
    const result = await db.query<{ key: string }>(`
      select event_key || ':' || scope::text as key from public.alert_rules
      where category <> 'demo'
      order by 1
    `);
    expect(result.rows.map((row) => row.key)).toEqual(ALERT_KEYS);
  });

  it("seeds two distinct candidate model roles while leaving provider availability UNVERIFIED", async () => {
    const result = await db.query<{ key: string }>(`
      select role::text || ':' || openrouter_model as key
      from public.model_configs where active order by role
    `);
    expect(result.rows.map((row) => row.key)).toEqual([
      "generator:anthropic/claude-opus-4.1",
      "moderator:openai/gpt-5",
    ]);
    expect(new Set(result.rows.map((row) => row.key.split(":")[1].split("/")[0])).size).toBe(2);
    // UNVERIFIED: no credentialed OpenRouter real arm runs in this database suite.
  });
});

describe("offer change trail", () => {
  it("records database-computed draft keys, returns an empty history only for a valid untouched offer, and refuses a foreign offer", async () => {
    await actAs("service_role", { sub: COACH_A, role: "coach", tenant_id: TENANT_A });
    const savedA = await db.query<{ offer_id: string }>(
      `select public.save_offer_draft($1, $2, null, null, $3)::text as offer_id`,
      [TENANT_A, COACH_A, { programName: "Trail A", contentHash: "a".repeat(64) }],
    );
    const savedB = await db.query<{ offer_id: string }>(
      `select public.save_offer_draft($1, $2, null, null, $3)::text as offer_id`,
      [TENANT_B, COACH_B, { programName: "Trail B", contentHash: "b".repeat(64) }],
    );
    const untouched = await db.query<{ offer_id: string }>(
      `insert into public.offer_layers (id, tenant_id, status, version, content_hash)
       values (gen_random_uuid(), $1, 'superseded', 99, $2) returning id::text as offer_id`,
      [TENANT_A, "c".repeat(64)],
    );
    const rows = await db.query<{ event: string; changed_keys: string[]; actor_id: string; content_hash: string }>(
      `select event, changed_keys, actor_id::text, content_hash
       from public.list_offer_change_trail($1, $2, $3)`,
      [TENANT_A, COACH_A, savedA.rows[0].offer_id],
    );
    expect(rows.rows).toEqual([{
      event: "draft_saved", changed_keys: expect.arrayContaining(["programName"]),
      actor_id: COACH_A, content_hash: "a".repeat(64),
    }]);
    await expect(db.query(
      `select * from public.list_offer_change_trail($1, $2, $3)`,
      [TENANT_A, COACH_A, untouched.rows[0].offer_id],
    )).resolves.toMatchObject({ rows: [] });
    await expect(db.query(
      `select * from public.list_offer_change_trail($1, $2, $3)`,
      [TENANT_A, COACH_A, savedB.rows[0].offer_id],
    )).rejects.toThrow(/EXPECTED_TENANT_MISMATCH:offer_change_trail/);
  });
});

describe("audit enforcement", () => {
  it("records nullable audit origins with constrained source and inet types", async () => {
    const columns = await db.query<{
      column_name: string;
      type_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(`
      select attribute.attname as column_name,
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as type_name,
        case when attribute.attnotnull then 'NO' else 'YES' end as is_nullable,
        pg_get_expr(default_value.adbin, default_value.adrelid) as column_default
      from pg_attribute attribute
      join pg_class relation on relation.oid = attribute.attrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      left join pg_attrdef default_value
        on default_value.adrelid = relation.oid and default_value.adnum = attribute.attnum
      where namespace.nspname = 'public' and relation.relname = 'audit_log'
        and attribute.attname in ('actor_ip', 'source')
      order by attribute.attname
    `);
    expect(columns.rows).toEqual([
      { column_name: "actor_ip", type_name: "inet", is_nullable: "YES", column_default: null },
      { column_name: "source", type_name: "text", is_nullable: "YES", column_default: null },
    ]);
    const constraint = await db.query<{ definition: string }>(`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint where conname = 'audit_log_source_check'
    `);
    expect(constraint.rows[0].definition).toContain("dashboard");
    expect(constraint.rows[0].definition).toContain("api");
    expect(constraint.rows[0].definition).toContain("system");
    expect(constraint.rows[0].definition).toContain("job");
    const backfill = await db.query<{ count: string }>(
      "select count(*)::text from public.audit_log where source is not null",
    );
    expect(backfill.rows[0].count).toBe("0");
  });

  it("rejects an invalid audit source and malformed actor address", async () => {
    await db.query("savepoint invalid_audit_origin");
    await expect(db.query(`
      insert into public.audit_log (tenant_id, action, target_type, source)
      values ('${TENANT_A}', 'appointment.created', 'appointment', 'dashboard-ui')
    `)).rejects.toThrow(/audit_log_source_check/);
    await db.query("rollback to savepoint invalid_audit_origin");
    await expect(db.query(`
      insert into public.audit_log (tenant_id, action, target_type, actor_ip)
      values ('${TENANT_A}', 'appointment.created', 'appointment', 'not-an-ip')
    `)).rejects.toThrow(/invalid input syntax for type inet/);
    await db.query("rollback to savepoint invalid_audit_origin");
  });

  it("keeps one defaulted audit writer and prevents anon from executing it", async () => {
    const privileges = await db.query<{
      argument_count: number;
      default_count: number;
      executable: boolean;
    }>(`
      select p.pronargs as argument_count,
        p.pronargdefaults as default_count,
        has_function_privilege('anon', p.oid, 'execute') as executable
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'write_audit_row'
      order by p.pronargs
    `);
    expect(privileges.rows).toEqual([
      {
        argument_count: 11,
        default_count: 6,
        executable: false,
      },
    ]);

    await db.query("savepoint anon_audit_writer");
    await actAs("anon");
    await expect(db.query(`
      select app.write_audit_row(
        null::text, null::uuid, null::uuid, null::text, null::text,
        null::text, null::jsonb, null::uuid, null::uuid
      )
    `)).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint anon_audit_writer");
    await resetRole();

  });

  it("rejects missing human actors, supplied system actors, and missing required reasons", async () => {
    await db.query("savepoint audit_shapes");
    await expect(
      db.query(`insert into public.audit_log (action) values ('calendar.connected')`),
    ).rejects.toThrow(/AUDIT_HUMAN_ACTOR_REQUIRED/);
    await db.query("rollback to savepoint audit_shapes");
    await expect(
      db.query(`insert into public.audit_log (action, actor_id) values ('appointment.created', '${ADMIN}')`),
    ).rejects.toThrow(/AUDIT_SYSTEM_ACTOR_FORBIDDEN/);
    await db.query("rollback to savepoint audit_shapes");
    await expect(
      db.query(`insert into public.audit_log (action, actor_id) values ('contact.delete', '${ADMIN}')`),
    ).rejects.toThrow(/AUDIT_REASON_REQUIRED/);
  });

  it("prevents service_role from updating an audit row", async () => {
    const inserted = await db.query<{ id: string }>(`
      insert into public.audit_log (tenant_id, action, target_type)
      values ('${TENANT_A}', 'appointment.created', 'appointment') returning id::text
    `);
    await actAs("service_role");
    await expect(
      db.query("update public.audit_log set reason = 'changed' where id = $1", [inserted.rows[0].id]),
    ).rejects.toThrow(/permission denied|AUDIT_LOG_APPEND_ONLY/);
  });

  it("prevents service_role from deleting an audit row", async () => {
    const inserted = await db.query<{ id: string }>(`
      insert into public.audit_log (tenant_id, action, target_type)
      values ('${TENANT_A}', 'appointment.created', 'appointment') returning id::text
    `);
    await actAs("service_role");
    await expect(
      db.query("delete from public.audit_log where id = $1", [inserted.rows[0].id]),
    ).rejects.toThrow(/permission denied|AUDIT_LOG_APPEND_ONLY/);
  });

  it("rolls a domain mutation back when its audit insert is forced to fail", async () => {
    const contactId = await insertContact(TENANT_A, "atomic");
    await db.query(`
      create function pg_temp.force_appointment_audit_failure()
      returns trigger language plpgsql as $$
      begin
        if new.tenant_id = '${TENANT_A}' and new.action = 'appointment.created' then
          raise exception 'FORCED_AUDIT_FAILURE';
        end if;
        return new;
      end
      $$;
      create trigger phase1_test_force_appointment_audit_failure
      before insert on public.audit_log
      for each row execute function pg_temp.force_appointment_audit_failure();
    `);
    await db.query("savepoint forced_audit_failure");
    await expect(
      db.query(
        `select * from public.record_provider_appointment(
          $1, $2, null, null, 'ghl', 'atomic-provider-id',
          now() + interval '1 day', now() + interval '1 day 30 minutes',
          'America/New_York', 'agent', true
        )`,
        [TENANT_A, contactId],
      ),
    ).rejects.toThrow(/FORCED_AUDIT_FAILURE/);
    await db.query("rollback to savepoint forced_audit_failure");
    const result = await db.query<{ appointments: string; billables: string; stage: string }>(`
      select
        (select count(*)::text from public.appointments where tenant_id = '${TENANT_A}') as appointments,
        (select count(*)::text from public.billable_events where tenant_id = '${TENANT_A}') as billables,
        (select pipeline_stage::text from public.contacts where id = '${contactId}') as stage
    `);
    expect(result.rows[0]).toEqual({ appointments: "0", billables: "0", stage: "new_lead" });
  });
});

describe("identity, replay, and disclosure", () => {
  it("enforces identity ownership and tenant-scoped provider identity keys", async () => {
    const contactA = await insertContact(TENANT_A, "identity-a");
    const contactB = await insertContact(TENANT_B, "identity-b");
    await db.query(
      `insert into public.contact_identities
        (tenant_id, contact_id, provider, channel, provider_identity_id)
       values ($1, $2, 'meta_direct', 'sms', 'shared-provider-identity')`,
      [TENANT_A, contactA],
    );
    await db.query(
      `insert into public.contact_identities
        (tenant_id, contact_id, provider, channel, provider_identity_id)
       values ($1, $2, 'meta_direct', 'sms', 'shared-provider-identity')`,
      [TENANT_B, contactB],
    );
    await db.query("savepoint identity_tenant_mismatch");
    await expect(
      db.query(
        `insert into public.contact_identities
          (tenant_id, contact_id, provider, channel, provider_identity_id)
         values ($1, $2, 'meta_direct', 'sms', 'cross-tenant-contact')`,
        [TENANT_A, contactB],
      ),
    ).rejects.toThrow(/CONTACT_IDENTITY_TENANT_MISMATCH/);
  });

  it("replays one pipeline stage audit without a second update and scopes keys by contact", async () => {
    const firstContact = await insertContact(TENANT_A, "pipeline-replay-first");
    const secondContact = await insertContact(TENANT_A, "pipeline-replay-second");
    const key = "phase1-pipeline-replay";

    await db.query("set local role service_role");
    const first = await db.query<{ audit_id: string }>(
      `select public.set_contact_pipeline_stage(
        $1, $2, 'new_lead', 'qualifying', 'user', $3, 'Reviewed', null, $4
      )::text as audit_id`,
      [TENANT_A, firstContact, COACH_A, key],
    );
    const firstState = await db.query<{ row_location: string }>(
      "select ctid::text as row_location from public.contacts where id = $1",
      [firstContact],
    );
    const replay = await db.query<{ audit_id: string }>(
      `select public.set_contact_pipeline_stage(
        $1, $2, 'new_lead', 'qualifying', 'user', $3, 'Reviewed again', null, $4
      )::text as audit_id`,
      [TENANT_A, firstContact, COACH_A, key],
    );
    const replayState = await db.query<{ row_location: string }>(
      "select ctid::text as row_location from public.contacts where id = $1",
      [firstContact],
    );
    const scoped = await db.query<{ audit_id: string }>(
      `select public.set_contact_pipeline_stage(
        $1, $2, 'new_lead', 'qualifying', 'user', $3, 'Reviewed', null, $4
      )::text as audit_id`,
      [TENANT_A, secondContact, COACH_A, key],
    );
    await db.query("reset role");

    const audits = await db.query<{ contact_id: string; audit_count: string; key: string }>(`
      select target_id as contact_id, count(*)::text as audit_count,
        min(payload ->> 'idempotency_key') as key
      from public.audit_log
      where tenant_id = $1 and action = 'contact.pipeline_stage.set'
        and target_id = any($2::text[])
      group by target_id
      order by target_id
    `, [TENANT_A, [firstContact, secondContact]]);

    expect(replay.rows[0].audit_id).toBe(first.rows[0].audit_id);
    expect(replayState.rows[0].row_location).toBe(firstState.rows[0].row_location);
    expect(scoped.rows[0].audit_id).not.toBe(first.rows[0].audit_id);
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows.every((row) => row.audit_count === "1" && row.key === key)).toBe(true);
  });

  it("scopes provider message replay by tenant and consumes disclosure exactly once", async () => {
    await db.query(`
      insert into public.ghl_installs
        (tenant_id, location_id, company_id, token_expires_at)
      values
        ('${TENANT_A}', 'phase1-location-a', 'phase1-company-a', now() + interval '1 day'),
        ('${TENANT_B}', 'phase1-location-b', 'phase1-company-b', now() + interval '1 day')
    `);
    const inboundA = await db.query<{
      contact_id: string;
      conversation_id: string;
      message_id: string;
      message_inserted: boolean;
      disclosure_pending: boolean;
    }>(
      `select * from public.persist_inbound_message(
        $1, 'ghl', 'sms', 'lead-1', 'phase1-location-a', null, null, 'provider-msg-1', 'hello', 'Lead One',
        null, null, null
      )`,
      [TENANT_A],
    );
    expect(inboundA.rows[0].message_inserted).toBe(true);
    expect(inboundA.rows[0].disclosure_pending).toBe(true);

    const replayA = await db.query<{ message_id: string; message_inserted: boolean }>(
      `select message_id, message_inserted from public.persist_inbound_message(
        $1, 'ghl', 'sms', 'lead-1', 'phase1-location-a', null, null, 'provider-msg-1', 'hello', 'Lead One',
        null, null, null
      )`,
      [TENANT_A],
    );
    expect(replayA.rows[0]).toEqual({
      message_id: inboundA.rows[0].message_id,
      message_inserted: false,
    });

    const inboundB = await db.query<{ message_inserted: boolean }>(
      `select message_inserted from public.persist_inbound_message(
        $1, 'ghl', 'sms', 'lead-1', 'phase1-location-b', null, null, 'provider-msg-1', 'hello', 'Lead One',
        null, null, null
      )`,
      [TENANT_B],
    );
    expect(inboundB.rows[0].message_inserted).toBe(true);

    await db.query("savepoint disclosure_required");
    await expect(
      db.query(
        `select public.record_agent_turn($1, $2, 'reply', 'ghl', 'out-1', false)`,
        [TENANT_A, inboundA.rows[0].conversation_id],
      ),
    ).rejects.toThrow(/DISCLOSURE_REQUIRED/);
    await db.query("rollback to savepoint disclosure_required");

    await db.query(
      `select public.record_agent_turn($1, $2, 'disclosure + reply', 'ghl', 'out-1', true)`,
      [TENANT_A, inboundA.rows[0].conversation_id],
    );
    const state = await db.query<{ disclosure_pending: boolean; inbound_count: string }>(`
      select c.disclosure_pending,
        (select count(*)::text from public.messages where tenant_id = '${TENANT_A}' and direction = 'in') as inbound_count
      from public.conversations c where c.id = '${inboundA.rows[0].conversation_id}'
    `);
    expect(state.rows[0]).toEqual({ disclosure_pending: false, inbound_count: "1" });

    await expect(
      db.query(
        `select public.record_agent_turn($1, $2, 'duplicate disclosure', 'ghl', 'out-2', true)`,
        [TENANT_A, inboundA.rows[0].conversation_id],
      ),
    ).rejects.toThrow(/DISCLOSURE_ALREADY_CONSUMED/);
  });

  it("sets disclosure_pending again when a human releases a conversation", async () => {
    const contactId = await insertContact(TENANT_A, "release");
    const conversationId = await insertConversation(TENANT_A, contactId);
    await db.query(
      `update public.conversations
       set status = 'human', status_reason = 'lead_requested_human', taken_over_by = '${COACH_A}'
       where id = $1`,
      [conversationId],
    );
    await db.query(`select public.release_conversation($1, $2, $3, $3)`, [
      TENANT_A,
      conversationId,
      COACH_A,
    ]);
    const result = await db.query<{ status: string; disclosure_pending: boolean }>(
      "select status::text, disclosure_pending from public.conversations where id = $1",
      [conversationId],
    );
    expect(result.rows[0]).toEqual({ status: "agent", disclosure_pending: true });
  });

  it("persists human replies and internal notes with their audit rows atomically", async () => {
    const contactId = await insertContact(TENANT_A, "human-message");
    const conversationId = await insertConversation(TENANT_A, contactId);
    await db.query(
      `update public.conversations
       set status = 'human', status_reason = 'human_takeover', taken_over_by = $2
       where id = $1`,
      [conversationId, COACH_A],
    );
    const reply = await db.query<{ message_id: string; audit_id: string; action_key: string }>(
      `select * from public.send_human_message($1, $2, $3, 'reply', 'Coach reply', 'human')`,
      [TENANT_A, conversationId, COACH_A],
    );
    const note = await db.query<{ message_id: string; audit_id: string; action_key: string }>(
      `select * from public.send_human_message($1, $2, $3, 'internal_note', 'Coach note', 'human')`,
      [TENANT_A, conversationId, COACH_A],
    );
    const rows = await db.query<{ id: string; direction: string; author: string }>(
      `select id, direction::text, author from public.messages where id = any($1::uuid[]) order by id`,
      [[reply.rows[0].message_id, note.rows[0].message_id]],
    );
    expect(rows.rows.map((row) => row.author)).toEqual([
      `human:${COACH_A}`, `human:${COACH_A}`,
    ]);
    expect(rows.rows.map((row) => row.direction).sort()).toEqual(["out", "system"]);
    expect([reply.rows[0].action_key, note.rows[0].action_key].sort()).toEqual([
      "conversation.internal_note.added", "conversation.message.sent.human",
    ]);
    expect(reply.rows[0].audit_id).toBeTruthy();
    expect(note.rows[0].audit_id).toBeTruthy();
  });
});

describe("database-owned test segregation", () => {
  it("overrides caller false across every inherited table and excludes demo booking from billing", async () => {
    const contactId = await insertContact(TENANT_DEMO, "demo", false);
    const conversationId = await insertConversation(TENANT_DEMO, contactId);
    const message = await db.query<{ id: string }>(
      `insert into public.messages (tenant_id, conversation_id, direction, author, body, is_test)
       values ($1, $2, 'in', 'lead', 'demo', false) returning id`,
      [TENANT_DEMO, conversationId],
    );
    const agentMessage = await db.query<{ id: string }>(
      `insert into public.messages (tenant_id, conversation_id, direction, author, body, is_test)
       values ($1, $2, 'out', 'agent', 'synthetic demo reply', false) returning id`,
      [TENANT_DEMO, conversationId],
    );
    await db.query(
      `select * from public.record_conversation_step_events($1, $2, $3, $4, 'q1', 'q2')`,
      [TENANT_DEMO, conversationId, message.rows[0].id, agentMessage.rows[0].id],
    );
    await db.query(
      `insert into public.followups
        (tenant_id, conversation_id, touch_no, purpose, scheduled_at, channel_class, cadence_anchor_at, is_test)
       values ($1, $2, 1, 'value_nudge', now() + interval '1 day', 'durable', now(), false)`,
      [TENANT_DEMO, conversationId],
    );
    const appointment = await db.query<{ id: string }>(
      `insert into public.appointments
        (tenant_id, contact_id, conversation_id, provider, external_id, start_at, end_at, timezone, is_test)
       values ($1, $2, $3, 'ghl', 'demo-appointment', now() + interval '1 day',
         now() + interval '1 day 30 minutes', 'America/New_York', false) returning id`,
      [TENANT_DEMO, contactId, conversationId],
    );
    await db.query(
      `insert into public.appointment_reschedules
        (tenant_id, appointment_id, from_start_at, from_end_at, to_start_at, to_end_at, initiated_by, is_test)
       values ($1, $2, now(), now() + interval '30 minutes', now() + interval '1 hour',
         now() + interval '90 minutes', 'lead', false)`,
      [TENANT_DEMO, appointment.rows[0].id],
    );
    await db.query(
      `insert into public.billable_events (tenant_id, quantity, appointment_id, is_test)
       values ($1, 1, $2, false)`,
      [TENANT_DEMO, appointment.rows[0].id],
    );
    const knowledge = await db.query<{ id: string }>(`
      insert into public.brain_knowledge_entries (question, answer, category, response_template)
      values ('Q', 'A', 'test', 'A') returning id
    `);
    await db.query(
      `insert into public.brain_knowledge_usage_events
        (knowledge_entry_id, conversation_id, tenant_id, is_test)
       values ($1, $2, $3, false)`,
      [knowledge.rows[0].id, conversationId, TENANT_DEMO],
    );
    await db.query(
      `insert into public.unmatched_objections
        (tenant_id, conversation_id, message_id, body, is_test)
       values ($1, $2, $3, 'demo objection', false)`,
      [TENANT_DEMO, conversationId, message.rows[0].id],
    );
    await db.query(
      `insert into public.contact_notes (tenant_id, contact_id, body, created_by, is_test)
       values ($1, $2, 'Demo contact note', $3, false)`,
      [TENANT_DEMO, contactId, COACH_A],
    );
    const thread = await db.query<{ id: string }>(
      `insert into public.support_threads
        (tenant_id, subject, created_by, is_test)
       values ($1, 'Demo support', $2, false) returning id`,
      [TENANT_DEMO, COACH_A],
    );
    await db.query(
      `insert into public.support_messages
        (tenant_id, thread_id, author_id, body, is_test)
       values ($1, $2, $3, 'Demo message', false)`,
      [TENANT_DEMO, thread.rows[0].id, COACH_A],
    );

    // Phase 10. The composite FK means an objection id is only recordable paired with the
    // snapshot that carried it, so the fixture publishes a snapshot row directly rather than
    // going through the publish RPC. This case is about the inherited flag, not publication.
    const snapshot = await db.query<{ id: string }>(
      `insert into public.brain_snapshots
        (version, content_hash, source_hash, payload, compiled_platform, platform_tokens,
         knowledge_mode, published_by, reason)
       values ((select coalesce(max(version), 0) + 1 from public.brain_snapshots),
         repeat('a', 64), repeat('a', 64), '{}'::jsonb, 'Segregation', 1, 'inline',
         $1, 'Synthetic segregation snapshot') returning id`,
      [COACH_A],
    );
    const objectionId = "81000000-0000-4000-8000-0000000000f1";
    await db.query(
      `insert into public.brain_snapshot_objections
        (snapshot_id, objection_id, label, response, category, hard_gate)
       values ($1, $2, 'Demo objection', 'Demo response', 'pricing', true)`,
      [snapshot.rows[0].id, objectionId],
    );
    await db.query(
      `insert into public.brain_objection_usage_events
        (tenant_id, conversation_id, agent_message_id, snapshot_id, objection_id,
         handling_outcome, hard_gate, is_test)
       values ($1, $2, $3, $4, $5, 'held_safely', true, false)`,
      [TENANT_DEMO, conversationId, agentMessage.rows[0].id, snapshot.rows[0].id, objectionId],
    );

    const result = await db.query<{ table_name: string; is_test: boolean }>(`
      select 'contacts' as table_name, is_test from public.contacts where id = '${contactId}'
      union all select 'conversations', is_test from public.conversations where id = '${conversationId}'
      union all select 'conversation_step_events', bool_and(is_test) from public.conversation_step_events where conversation_id = '${conversationId}'
      union all select 'messages', is_test from public.messages where id = '${message.rows[0].id}'
      union all select 'followups', is_test from public.followups where conversation_id = '${conversationId}'
      union all select 'appointments', is_test from public.appointments where id = '${appointment.rows[0].id}'
      union all select 'appointment_reschedules', is_test from public.appointment_reschedules where appointment_id = '${appointment.rows[0].id}'
      union all select 'billable_events', is_test from public.billable_events where appointment_id = '${appointment.rows[0].id}'
      union all select 'brain_knowledge_usage_events', is_test from public.brain_knowledge_usage_events where conversation_id = '${conversationId}'
      union all select 'brain_objection_usage_events', is_test from public.brain_objection_usage_events where conversation_id = '${conversationId}'
      union all select 'contact_notes', is_test from public.contact_notes where contact_id = '${contactId}'
      union all select 'unmatched_objections', is_test from public.unmatched_objections where conversation_id = '${conversationId}'
      union all select 'support_threads', is_test from public.support_threads where id = '${thread.rows[0].id}'
      union all select 'support_messages', is_test from public.support_messages where thread_id = '${thread.rows[0].id}'
      order by table_name
    `);
    expect(result.rows.map((row) => row.table_name)).toEqual(IS_TEST_TABLES);
    expect(result.rows.every((row) => row.is_test)).toBe(true);

    const rpcContact = await insertContact(TENANT_DEMO, "rpc-demo", false);
    const booked = await db.query<{ billable_event_id: string | null }>(
      `select billable_event_id from public.record_provider_appointment(
        $1, $2, null, null, 'ghl', 'demo-rpc-appointment',
        now() + interval '2 days', now() + interval '2 days 30 minutes',
        'America/New_York', 'agent', true
      )`,
      [TENANT_DEMO, rpcContact],
    );
    expect(booked.rows[0].billable_event_id).toBeNull();
  });
});

describe("booking, calendar, and constraint behavior", () => {
  it("fails closed when a domain RPC receives a mismatched expected tenant", async () => {
    const contactId = await insertContact(TENANT_A, "wrong-tenant");
    await expect(
      db.query(
        `select * from public.record_provider_appointment(
          $1, $2, null, null, 'ghl', 'wrong-tenant-appointment',
          now() + interval '1 day', now() + interval '1 day 30 minutes',
          'America/New_York', 'agent', true
        )`,
        [TENANT_B, contactId],
      ),
    ).rejects.toThrow(/EXPECTED_TENANT_MISMATCH:contact/);
  });

  it("creates one billable event for an idempotent agent-attributed appointment", async () => {
    const contactId = await insertContact(TENANT_A, "book");
    const first = await db.query<{
      appointment_id: string;
      billable_event_id: string;
      audit_id: string;
    }>(
      `select * from public.record_provider_appointment(
        $1, $2, null, null, 'ghl', 'appointment-replay',
        now() + interval '1 day', now() + interval '1 day 30 minutes',
        'America/New_York', 'agent', true
      )`,
      [TENANT_A, contactId],
    );
    const replay = await db.query<{
      appointment_id: string;
      billable_event_id: string;
      audit_id: string | null;
    }>(
      `select * from public.record_provider_appointment(
        $1, $2, null, null, 'ghl', 'appointment-replay',
        now() + interval '1 day', now() + interval '1 day 30 minutes',
        'America/New_York', 'agent', true
      )`,
      [TENANT_A, contactId],
    );
    expect(replay.rows[0].appointment_id).toBe(first.rows[0].appointment_id);
    expect(replay.rows[0].billable_event_id).toBe(first.rows[0].billable_event_id);
    expect(replay.rows[0].audit_id).toBeNull();
    const counts = await db.query<{ appointments: string; billables: string; audits: string }>(`
      select
        (select count(*)::text from public.appointments where external_id = 'appointment-replay') as appointments,
        (select count(*)::text from public.billable_events where appointment_id = '${first.rows[0].appointment_id}') as billables,
        (select count(*)::text from public.audit_log where action = 'appointment.created' and target_id = '${first.rows[0].appointment_id}') as audits
    `);
    expect(counts.rows[0]).toEqual({ appointments: "1", billables: "1", audits: "1" });
  });

  it("bills an attributed provider-webhook booking exactly once", async () => {
    const contactId = await insertContact(TENANT_A, "provider-attributed");
    const booked = await db.query<{ billable_event_id: string | null }>(
      `select billable_event_id from public.record_provider_appointment(
        $1, $2, null, null, 'ghl', 'provider-attributed-booking',
        now() + interval '1 day', now() + interval '1 day 30 minutes',
        'America/New_York', 'provider_webhook', true
      )`,
      [TENANT_A, contactId],
    );
    expect(booked.rows[0].billable_event_id).not.toBeNull();
    const count = await db.query<{ count: string }>(
      `select count(*)::text from public.billable_events
       where id = $1 and tenant_id = $2 and not is_test`,
      [booked.rows[0].billable_event_id, TENANT_A],
    );
    expect(count.rows[0].count).toBe("1");
  });

  it("keeps billable events append-only even for a database owner", async () => {
    const contactId = await insertContact(TENANT_A, "append-only");
    const booked = await db.query<{ billable_event_id: string }>(
      `select billable_event_id from public.record_provider_appointment(
        $1, $2, null, null, 'ghl', 'append-only-appointment',
        now() + interval '1 day', now() + interval '1 day 30 minutes',
        'America/New_York', 'agent', true
      )`,
      [TENANT_A, contactId],
    );
    await expect(
      db.query("update public.billable_events set quantity = 2 where id = $1", [
        booked.rows[0].billable_event_id,
      ]),
    ).rejects.toThrow(/BILLABLE_EVENTS_APPEND_ONLY/);
  });

  it("records slot-fetch failure and recovery atomically and enforces one primary calendar", async () => {
    const calendar = await db.query<{ id: string }>(`
      insert into public.calendar_connections
        (tenant_id, provider, external_calendar_id, timezone, state, is_primary)
      values ('${TENANT_A}', 'ghl', 'calendar-a', 'America/New_York', 'ready', true)
      returning id
    `);
    expect(calendar.rows[0].id).toBeTruthy();
    await db.query("savepoint one_primary_calendar");
    await expect(
      db.query(`
        insert into public.calendar_connections
          (tenant_id, provider, external_calendar_id, timezone, state, is_primary)
        values ('${TENANT_A}', 'google', 'calendar-b', 'America/New_York', 'ready', true)
      `),
    ).rejects.toThrow(/calendar_connections_primary_idx/);
    await db.query("rollback to savepoint one_primary_calendar");

    const sharedExternal = await db.query<{ count: string }>(`
      with inserted as (
        insert into public.calendar_connections
          (tenant_id, provider, external_calendar_id, timezone, state, is_primary)
        values ('${TENANT_B}', 'ghl', 'calendar-a', 'America/New_York', 'ready', true)
        returning id
      ) select count(*)::text from inserted
    `);
    expect(sharedExternal.rows[0].count).toBe("1");
  });

  it("persists failed and successful calendar health shapes", async () => {
    const calendar = await db.query<{ id: string }>(`
      insert into public.calendar_connections
        (tenant_id, provider, external_calendar_id, timezone, state, is_primary)
      values ('${TENANT_A}', 'ghl', 'calendar-health', 'America/New_York', 'ready', true)
      returning id
    `);
    const failedAt = "2026-08-17T10:00:00.000Z";
    await db.query(`select public.record_calendar_slot_fetch($1, $2, false, 'provider timeout', $3)`, [
      TENANT_A,
      calendar.rows[0].id,
      failedAt,
    ]);
    let health = await db.query<{ last_slot_fetch_ok: boolean; last_error: string; at: string }>(
      `select last_slot_fetch_ok, last_error, to_char(last_slot_fetch_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
       from public.calendar_connections where id = $1`,
      [calendar.rows[0].id],
    );
    expect(health.rows[0]).toEqual({
      last_slot_fetch_ok: false,
      last_error: "provider timeout",
      at: failedAt,
    });

    const successAt = "2026-08-17T10:05:00.000Z";
    await db.query(`select public.record_calendar_slot_fetch($1, $2, true, null, $3)`, [
      TENANT_A,
      calendar.rows[0].id,
      successAt,
    ]);
    health = await db.query(
      `select last_slot_fetch_ok, last_error, to_char(last_slot_fetch_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
       from public.calendar_connections where id = $1`,
      [calendar.rows[0].id],
    );
    expect(health.rows[0]).toEqual({ last_slot_fetch_ok: true, last_error: null, at: successAt });
  });

  it("records provider attendance with a system audit actor and preserves coach authority", async () => {
    const contactId = await insertContact(TENANT_A, "attendance");
    const appointment = await db.query<{ id: string }>(
      `insert into public.appointments
        (tenant_id, contact_id, provider, external_id, start_at, end_at, timezone)
       values ($1, $2, 'ghl', 'attendance-provider', now() - interval '1 hour',
         now() - interval '30 minutes', 'America/New_York') returning id`,
      [TENANT_A, contactId],
    );
    const audit = await db.query<{ id: string }>(
      `select public.record_appointment_attendance_system($1, $2, 'completed', 'provider')::text as id`,
      [TENANT_A, appointment.rows[0].id],
    );
    const row = await db.query<{ source: string; actor: string | null; action: string }>(
      `select a.attendance_source as source, l.actor_id::text as actor, l.action
       from public.appointments a
       join public.audit_log l on l.id = $2
       where a.id = $1`,
      [appointment.rows[0].id, audit.rows[0].id],
    );
    expect(row.rows[0]).toEqual({
      source: "provider", actor: null, action: "appointment.attendance_set.system",
    });

    await db.query(
      `select public.record_appointment_attendance($1, $2, 'no_show', 'coach', $3)`,
      [TENANT_A, appointment.rows[0].id, COACH_A],
    );
    await expect(
      db.query(
        `select public.record_appointment_attendance_system($1, $2, 'completed', 'provider')`,
        [TENANT_A, appointment.rows[0].id],
      ),
    ).rejects.toThrow(/COACH_ATTENDANCE_IS_AUTHORITATIVE/);
  });

  it("marks a bell delivery delivered without fabricating a provider receipt", async () => {
    const notification = await db.query<{ id: string }>(`
      insert into public.notifications (tenant_id, user_id, kind, title)
      values ('${TENANT_A}', '${COACH_A}', 'test.bell', 'Bell test') returning id
    `);
    const delivery = await db.query<{ id: string }>(
      `insert into public.notification_deliveries
        (notification_id, destination, status, delivered_at)
       values ($1, 'bell', 'delivered', now()) returning id`,
      [notification.rows[0].id],
    );
    expect(delivery.rows[0].id).toBeTruthy();
  });

  it("retains appointment reschedule history and enforces state/reason and cadence bounds", async () => {
    const contactId = await insertContact(TENANT_A, "constraints");
    const conversationId = await insertConversation(TENANT_A, contactId);
    await db.query("savepoint constraint_checks");
    await expect(
      db.query(
        `update public.conversations set status = 'needs_human', status_reason = null where id = $1`,
        [conversationId],
      ),
    ).rejects.toThrow(/conversations_status_reason_chk/);
    await db.query("rollback to savepoint constraint_checks");
    await expect(
      db.query(
        `insert into public.followups
          (tenant_id, conversation_id, touch_no, purpose, scheduled_at, channel_class, cadence_anchor_at)
         values ($1, $2, 9, 'value_nudge', now() + interval '1 day', 'durable', now())`,
        [TENANT_A, conversationId],
      ),
    ).rejects.toThrow(/followups_touch_cap_chk/);
    await db.query("rollback to savepoint constraint_checks");

    const appointment = await db.query<{ id: string }>(
      `insert into public.appointments
        (tenant_id, contact_id, conversation_id, provider, external_id, start_at, end_at, timezone)
       values ($1, $2, $3, 'ghl', 'reschedule-history', now() + interval '1 day',
         now() + interval '1 day 30 minutes', 'America/New_York') returning id`,
      [TENANT_A, contactId, conversationId],
    );
    await db.query(
      `select public.reschedule_appointment(
        $1, $2, now() + interval '2 days', now() + interval '2 days 30 minutes', 'coach', $3
      )`,
      [TENANT_A, appointment.rows[0].id, COACH_A],
    );
    const history = await db.query<{ count: string }>(
      "select count(*)::text from public.appointment_reschedules where appointment_id = $1",
      [appointment.rows[0].id],
    );
    expect(history.rows[0].count).toBe("1");
  });

  it("derives commission month from a paid invoice and rejects invoice replay", async () => {
    const affiliate = await db.query<{ id: string }>(`
      insert into public.affiliates (user_id, referral_code)
      values ('${AFFILIATE}', 'PHASE1') returning id
    `);
    // Phase 5 freezes attribution at signup; this owner-only fixture seam models that transaction.
    await db.query(`select set_config('app.phase5_signup_referral', 'on', true)`);
    const referral = await db.query<{ id: string }>(
      `insert into public.referrals (affiliate_id, tenant_id)
       values ($1, '${TENANT_A}') returning id`,
      [affiliate.rows[0].id],
    );
    const ledger = await db.query<{ month: string }>(
      `insert into public.commission_ledger
        (referral_id, stripe_invoice_id, invoice_paid_at, base_cents, commission_cents, entry_kind)
       values ($1, 'invoice-phase1', '2026-08-17T23:30:00-04:00', 10000, 1000, 'accrual')
       returning month::text`,
      [referral.rows[0].id],
    );
    expect(ledger.rows[0].month).toBe("2026-08-01");
    await expect(
      db.query(
        `insert into public.commission_ledger
          (referral_id, stripe_invoice_id, invoice_paid_at, base_cents, commission_cents, entry_kind)
         values ($1, 'invoice-phase1', now(), 10000, 1000, 'accrual')`,
        [referral.rows[0].id],
      ),
    ).rejects.toThrow(/commission_ledger_accrual_invoice_uidx/);
  });
});

describe("role boundaries and demo aggregate", () => {
  it("blocks coach direct appointment and pipeline-stage writes and hides calendar secrets", async () => {
    const contactId = await insertContact(TENANT_A, "coach-custody");
    const appointment = await db.query<{ id: string }>(
      `insert into public.appointments
        (tenant_id, contact_id, provider, external_id, start_at, end_at, timezone)
       values ($1, $2, 'ghl', 'coach-custody', now() + interval '1 day',
         now() + interval '1 day 30 minutes', 'America/New_York') returning id`,
      [TENANT_A, contactId],
    );
    const calendar = await db.query<{ id: string }>(`
      insert into public.calendar_connections
        (tenant_id, provider, external_calendar_id, timezone)
      values ('${TENANT_A}', 'ghl', 'secret-calendar', 'America/New_York') returning id
    `);
    await db.query(
      `insert into public.calendar_connection_secrets (calendar_connection_id, access_token)
       values ($1, 'test-token')`,
      [calendar.rows[0].id],
    );

    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A, sub: COACH_A });
    await db.query("savepoint appointment_direct_write");
    await expect(
      db.query(`update public.appointments set status = 'completed' where id = $1`, [appointment.rows[0].id]),
    ).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint appointment_direct_write");

    await db.query("savepoint pipeline_direct_write");
    await expect(
      db.query(`update public.contacts set pipeline_stage = 'booked' where id = $1`, [contactId]),
    ).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint pipeline_direct_write");

    await db.query("savepoint calendar_secret_read");
    await expect(
      db.query(`select access_token from public.calendar_connection_secrets`),
    ).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint calendar_secret_read");

    const columns = await db.query<{ count: string }>(`
      select count(*)::text from information_schema.columns
      where table_schema = 'public' and table_name = 'calendar_connections'
        and column_name in ('access_token', 'refresh_token', 'token_expires_at')
    `);
    expect(columns.rows[0].count).toBe("0");
  });

  it("allows a coach to mark a notification read without rewriting its content", async () => {
    const notification = await db.query<{ id: string }>(`
      insert into public.notifications (tenant_id, user_id, kind, title, body)
      values ('${TENANT_A}', '${COACH_A}', 'test.read', 'Original', 'Immutable') returning id
    `);
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A, sub: COACH_A });
    await db.query("savepoint immutable_notification");
    await expect(
      db.query(`update public.notifications set title = 'Forged' where id = $1`, [notification.rows[0].id]),
    ).rejects.toThrow(/NOTIFICATION_IMMUTABLE|permission denied/);
    await db.query("rollback to savepoint immutable_notification");
    const marked = await db.query<{ read_at: string }>(
      `select * from public.mark_notification_read($1)`,
      [notification.rows[0].id],
    );
    expect(marked.rows[0].read_at).toBeTruthy();
  });

  it("lets success write only the assigned book and blocks impersonated writes", async () => {
    await actAs("authenticated", { role: "success", sub: SUCCESS });
    const own = await db.query(
      `insert into public.contacts (tenant_id, last_channel, name)
       values ('${TENANT_A}', 'sms', 'Assigned success lead') returning id`,
    );
    expect(own.rowCount).toBe(1);
    await db.query("savepoint success_other_book");
    await expect(
      db.query(
        `insert into public.contacts (tenant_id, last_channel, name)
         values ('${TENANT_B}', 'sms', 'Other success lead')`,
      ),
    ).rejects.toThrow(/row-level security/);
    await db.query("rollback to savepoint success_other_book");
    await resetRole();

    const session = await db.query<{ id: string }>(`
      insert into public.impersonation_sessions
        (actor_id, tenant_id, reason, started_at, expires_at)
      values ('${ADMIN}', '${TENANT_A}', 'Policy test', now(), now() + interval '30 minutes')
      returning id
    `);
    await actAs("authenticated", {
      role: "admin",
      sub: ADMIN,
      impersonation_session_id: session.rows[0].id,
    });
    await expect(
      db.query(
        `insert into public.contacts (tenant_id, last_channel, name)
         values ('${TENANT_A}', 'sms', 'Impersonated write')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("makes service RPC writes fail closed when an impersonation claim is present", async () => {
    const contactId = await insertContact(TENANT_A, "impersonated-rpc");
    const session = await db.query<{ id: string }>(`
      insert into public.impersonation_sessions
        (actor_id, tenant_id, reason, started_at, expires_at)
      values ('${ADMIN}', '${TENANT_A}', 'RPC test', now(), now() + interval '30 minutes')
      returning id
    `);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({
        sub: ADMIN,
        app_metadata: { role: "admin", impersonation_session_id: session.rows[0].id },
      }),
    ]);
    await expect(
      db.query(
        `select * from public.record_provider_appointment(
          $1, $2, null, null, 'ghl', 'impersonated-appointment',
          now() + interval '1 day', now() + interval '1 day 30 minutes',
          'America/New_York', 'agent', true
        )`,
        [TENANT_A, contactId],
      ),
    ).rejects.toThrow(/IMPERSONATION_WRITE_FORBIDDEN/);
  });

  it("keeps affiliate commission ownership while hiding referrals and filters demo aggregates", async () => {
    const affiliate = await db.query<{ id: string }>(`
      insert into public.affiliates (user_id, referral_code)
      values ('${AFFILIATE}', 'AFFILIATE-RLS') returning id
    `);
    // Phase 5 freezes attribution at signup; this owner-only fixture seam models that transaction.
    await db.query(`select set_config('app.phase5_signup_referral', 'on', true)`);
    const referral = await db.query<{ id: string }>(
      `insert into public.referrals (affiliate_id, tenant_id)
       values ($1, '${TENANT_A}') returning id`,
      [affiliate.rows[0].id],
    );
    await db.query(
      `insert into public.commission_ledger
        (referral_id, stripe_invoice_id, invoice_paid_at, base_cents, commission_cents, entry_kind)
       values ($1, 'affiliate-visible', now(), 10000, 1000, 'accrual')`,
      [referral.rows[0].id],
    );
    await actAs("authenticated", { role: "affiliate", sub: AFFILIATE });
    const affiliateRows = await db.query<{ referrals: string; commissions: string }>(`
      select
        (select count(*)::text from public.referrals) as referrals,
        (select count(*)::text from public.commission_ledger) as commissions
    `);
    expect(affiliateRows.rows[0]).toEqual({ referrals: "0", commissions: "1" });
    await resetRole();

    const visible = await db.query<{ id: string }>(
      "select id::text from public.production_tenant_aggregate_source order by id",
    );
    expect(visible.rows.map((row) => row.id)).toEqual([TENANT_A, TENANT_B]);
  });

  it("requires a reason for demo changes and updates the aggregate with its registry audit", async () => {
    await db.query("savepoint demo_reason");
    await expect(
      db.query(`select public.set_tenant_demo_flag($1, $2, true, '   ')`, [TENANT_A, ADMIN]),
    ).rejects.toThrow(/DEMO_FLAG_REASON_REQUIRED/);
    await db.query("rollback to savepoint demo_reason");

    await db.query("savepoint demo_audit");
    await db.query("delete from public.audit_actions where key = 'tenant.demo_flag.changed'");
    await expect(
      db.query(`select public.set_tenant_demo_flag($1, $2, true, 'Internal demonstration')`, [
        TENANT_A,
        ADMIN,
      ]),
    ).rejects.toThrow(/AUDIT_ACTION_NOT_REGISTERED/);
    await db.query("rollback to savepoint demo_audit");
    const unchanged = await db.query<{ is_demo: boolean }>(
      "select is_demo from public.tenants where id = $1",
      [TENANT_A],
    );
    expect(unchanged.rows[0].is_demo).toBe(false);

    const cascadeContact = await insertContact(TENANT_A, "demo-cascade");
    const cascadeConversation = await insertConversation(TENANT_A, cascadeContact);
    await db.query(
      `insert into public.messages (tenant_id, conversation_id, direction, author, body)
       values ($1, $2, 'in', 'lead', 'cascade')`,
      [TENANT_A, cascadeConversation],
    );
    const cascadeAppointment = await db.query<{ id: string }>(
      `insert into public.appointments
        (tenant_id, contact_id, conversation_id, provider, external_id, start_at, end_at, timezone)
       values ($1, $2, $3, 'ghl', 'demo-cascade', now() + interval '1 day',
         now() + interval '1 day 30 minutes', 'America/New_York') returning id`,
      [TENANT_A, cascadeContact, cascadeConversation],
    );
    await db.query(
      `insert into public.billable_events (tenant_id, appointment_id, quantity)
       values ($1, $2, 1)`,
      [TENANT_A, cascadeAppointment.rows[0].id],
    );

    await db.query(`select public.set_tenant_demo_flag($1, $2, true, 'Internal demonstration')`, [
      TENANT_A,
      ADMIN,
    ]);
    const result = await db.query<{ visible: boolean; audits: string; cascaded: boolean }>(`
      select
        exists(select 1 from public.production_tenant_aggregate_source where id = '${TENANT_A}') as visible,
        (select count(*)::text from public.audit_log
         where action = 'tenant.demo_flag.changed' and tenant_id = '${TENANT_A}') as audits,
        (
          (select is_test from public.contacts where id = '${cascadeContact}')
          and (select is_test from public.conversations where id = '${cascadeConversation}')
          and (select bool_and(is_test) from public.messages where conversation_id = '${cascadeConversation}')
          and (select is_test from public.appointments where id = '${cascadeAppointment.rows[0].id}')
          and (select bool_and(is_test) from public.billable_events where appointment_id = '${cascadeAppointment.rows[0].id}')
        ) as cascaded
    `);
    expect(result.rows[0]).toEqual({ visible: false, audits: "1", cascaded: true });
  });

  it("rejects build and cross-tenant coach export actors", async () => {
    await db.query("savepoint build_export");
    await expect(
      db.query(`select public.start_export($1, $2, 'contacts', '{}'::jsonb, array['id'])`, [
        TENANT_A,
        BUILD,
      ]),
    ).rejects.toThrow(/EXPORT_ROLE_FORBIDDEN:build/);
    await db.query("rollback to savepoint build_export");
    await expect(
      db.query(`select public.start_export($1, $2, 'contacts', '{}'::jsonb, array['id'])`, [
        TENANT_A,
        COACH_B,
      ]),
    ).rejects.toThrow(/EXPORT_ACTOR_NOT_AUTHORIZED/);
  });
});
