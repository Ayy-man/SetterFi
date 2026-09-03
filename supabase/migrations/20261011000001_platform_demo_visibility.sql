-- Platform-wide demo visibility for the analytics projection.
--
-- Every analytics_* view filters demo tenants out (`not tenant.is_demo`) and, inside them, the
-- rows that inherited `is_test` from the tenant. That rule is right for a platform serving real
-- customers: seeded numbers must never leak into a real book. It also means a demo-only platform,
-- which is what the owner reviews today, reads zeros on every surface the projection feeds,
-- Money above all, however much was seeded.
--
-- This adds one switch. `platform_review_settings` holds a single row; `platform_demo_visible()`
-- reads it; every analytics view admits demo tenants (and their inherited test rows) when it is
-- on. It defaults off, so nothing changes until somebody flips it, and the coach's own-tenant
-- widening (`app.phase7_demo_tenant`) is untouched. Test rows inside a real tenant stay hidden
-- whatever the switch says: the relaxed predicate is `tenant.is_demo and platform_demo_visible()`,
-- never `is_test` alone.
--
-- The view bodies below are the live definitions as Postgres prints them, with only the two
-- predicates rewritten, so this migration changes nothing else about any projection.

create table if not exists public.platform_review_settings (
  singleton boolean primary key default true check (singleton),
  demo_visible boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.platform_review_settings enable row level security;
insert into public.platform_review_settings (singleton, demo_visible)
values (true, false)
on conflict (singleton) do nothing;
revoke all on public.platform_review_settings from anon, authenticated;

create or replace function public.platform_demo_visible()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select demo_visible from public.platform_review_settings where singleton), false);
$$;
revoke all on function public.platform_demo_visible() from public;
grant execute on function public.platform_demo_visible() to anon, authenticated, service_role;

create or replace view public.analytics_appointment_reschedules
with (security_invoker = true)
as
 SELECT reschedule.id AS reschedule_id,
    reschedule.tenant_id,
    reschedule.appointment_id,
    reschedule.created_at
   FROM appointment_reschedules reschedule
     JOIN tenants tenant ON tenant.id = reschedule.tenant_id
  WHERE (NOT reschedule.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_appointments
with (security_invoker = true)
as
 SELECT appointment.id AS appointment_id,
    appointment.tenant_id,
    appointment.contact_id,
    appointment.conversation_id,
    appointment.status,
    appointment.attributed_to_agent,
    appointment.start_at,
    appointment.end_at,
    appointment.created_at,
    appointment.updated_at
   FROM appointments appointment
     JOIN tenants tenant ON tenant.id = appointment.tenant_id
  WHERE (NOT appointment.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible()) OR tenant.id = NULLIF(current_setting('app.phase7_demo_tenant'::text, true), ''::text)::uuid;

create or replace view public.analytics_audit_log
with (security_invoker = true)
as
 SELECT audit.id AS audit_id,
    audit.tenant_id,
    audit.action,
    audit.target_type,
    audit.target_id,
    audit.payload,
    audit.created_at
   FROM audit_log audit
     LEFT JOIN tenants tenant ON tenant.id = audit.tenant_id
  WHERE audit.tenant_id IS NULL OR (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_billable_events
with (security_invoker = true)
as
 SELECT event.id AS billable_event_id,
    event.tenant_id,
    event.quantity,
    event.appointment_id,
    event.adjusts_event_id,
    event.occurred_at
   FROM billable_events event
     JOIN tenants tenant ON tenant.id = event.tenant_id
  WHERE (NOT event.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible()) OR tenant.id = NULLIF(current_setting('app.phase7_demo_tenant'::text, true), ''::text)::uuid;

create or replace view public.analytics_billing_subscriptions
with (security_invoker = true)
as
 SELECT subscription.id AS subscription_id,
    subscription.tenant_id,
    tier.id AS tier_id,
    subscription.stripe_price_id,
    subscription.status,
    subscription.current_period_start,
    subscription.current_period_end,
    subscription.cancel_at_period_end,
    subscription.provider_updated_at,
    subscription.created_at
   FROM billing_subscriptions subscription
     JOIN tenants tenant ON tenant.id = subscription.tenant_id
     LEFT JOIN tiers tier ON tier.stripe_price_id = subscription.stripe_price_id
  WHERE (NOT tenant.is_demo OR public.platform_demo_visible()) OR tenant.id = NULLIF(current_setting('app.phase7_demo_tenant'::text, true), ''::text)::uuid;

create or replace view public.analytics_brain_knowledge_usage_events
with (security_invoker = true)
as
 SELECT event.id AS event_id,
    event.tenant_id,
    event.knowledge_entry_id,
    event.conversation_id,
    event.used_at
   FROM brain_knowledge_usage_events event
     JOIN tenants tenant ON tenant.id = event.tenant_id
  WHERE (NOT event.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_brain_objection_usage_events
with (security_invoker = true)
as
 SELECT event.id AS event_id,
    event.tenant_id,
    event.conversation_id,
    event.agent_message_id,
    event.snapshot_id,
    event.objection_id,
    event.handling_outcome,
    event.hard_gate,
    event.used_at
   FROM brain_objection_usage_events event
     JOIN tenants tenant ON tenant.id = event.tenant_id
  WHERE (NOT event.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_channel_connections
with (security_invoker = true)
as
 SELECT connection.id AS connection_id,
    connection.tenant_id,
    connection.channel,
    connection.provider,
    connection.state,
    connection.created_at,
    connection.updated_at
   FROM channel_connections connection
     JOIN tenants tenant ON tenant.id = connection.tenant_id
  WHERE (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_commission_ledger
with (security_invoker = true)
as
 SELECT ledger.id AS commission_ledger_id,
    referral.tenant_id,
    ledger.referral_id,
    ledger.entry_kind,
    ledger.commission_cents,
    ledger.invoice_paid_at,
    ledger.created_at
   FROM commission_ledger ledger
     JOIN referrals referral ON referral.id = ledger.referral_id
     JOIN tenants tenant ON tenant.id = referral.tenant_id
  WHERE (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_contact_identities
with (security_invoker = true)
as
 SELECT identity.id AS identity_id,
    identity.tenant_id,
    identity.contact_id,
    identity.channel,
    identity.provider,
    identity.created_at
   FROM contact_identities identity
     JOIN contacts contact ON contact.id = identity.contact_id AND contact.tenant_id = identity.tenant_id
     JOIN tenants tenant ON tenant.id = identity.tenant_id
  WHERE (NOT contact.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_contacts
with (security_invoker = true)
as
 SELECT contact.id AS contact_id,
    contact.tenant_id,
    contact.created_at,
    contact.updated_at,
    contact.pipeline_stage,
    contact.stage_set_at,
    contact.outcome,
    contact.merged_into_contact_id
   FROM contacts contact
     JOIN tenants tenant ON tenant.id = contact.tenant_id
  WHERE (NOT contact.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible()) OR tenant.id = NULLIF(current_setting('app.phase7_demo_tenant'::text, true), ''::text)::uuid;

create or replace view public.analytics_conversation_step_events
with (security_invoker = true)
as
 SELECT event.id AS event_id,
    event.tenant_id,
    event.conversation_id,
    event.contact_id,
    event.message_id,
    event.step_key,
    event.event_kind,
    event.occurred_at
   FROM conversation_step_events event
     JOIN tenants tenant ON tenant.id = event.tenant_id
  WHERE event.event_kind = 'asked'::text AND ((NOT event.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible()) OR tenant.id = NULLIF(current_setting('app.phase7_demo_tenant'::text, true), ''::text)::uuid)
UNION ALL
 SELECT answer.id AS event_id,
    answer.tenant_id,
    answer.conversation_id,
    answer.contact_id,
    answer.message_id,
    owner.step_key,
    answer.event_kind,
    answer.occurred_at
   FROM conversation_step_events answer
     JOIN tenants tenant ON tenant.id = answer.tenant_id
     JOIN LATERAL ( SELECT asked.step_key
           FROM conversation_step_events asked
          WHERE asked.conversation_id = answer.conversation_id AND asked.event_kind = 'asked'::text AND asked.occurred_at < answer.occurred_at AND answer.occurred_at < (asked.occurred_at + '7 days'::interval)
          ORDER BY asked.occurred_at DESC, asked.id DESC
         LIMIT 1) owner ON true
  WHERE answer.event_kind = 'answered'::text AND ((NOT answer.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible()) OR tenant.id = NULLIF(current_setting('app.phase7_demo_tenant'::text, true), ''::text)::uuid);

create or replace view public.analytics_conversations
with (security_invoker = true)
as
 SELECT conversation.id AS conversation_id,
    conversation.tenant_id,
    conversation.contact_id,
    conversation.channel,
    conversation.first_touch_keyword,
    conversation.status,
    conversation.status_reason,
    conversation.current_step,
    conversation.cadence_anchor_at,
    conversation.created_at,
    conversation.last_message_at
   FROM conversations conversation
     JOIN tenants tenant ON tenant.id = conversation.tenant_id
  WHERE (NOT conversation.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible()) OR tenant.id = NULLIF(current_setting('app.phase7_demo_tenant'::text, true), ''::text)::uuid;

create or replace view public.analytics_eval_cases
with (security_invoker = true)
as
 SELECT eval_case.id AS eval_case_id,
    eval_case.source_tenant_id,
    eval_case.suite,
    eval_case.active,
    eval_case.created_at
   FROM eval_cases eval_case
     LEFT JOIN tenants tenant ON tenant.id = eval_case.source_tenant_id
  WHERE (COALESCE(tenant.is_demo, false) = false OR public.platform_demo_visible());

create or replace view public.analytics_followups
with (security_invoker = true)
as
 SELECT followup.id AS followup_id,
    followup.tenant_id,
    followup.conversation_id,
    followup.touch_no,
    followup.status,
    followup.canceled_reason,
    followup.resolved_identity_id,
    followup.sent_at,
    followup.created_at,
    followup.updated_at
   FROM followups followup
     JOIN tenants tenant ON tenant.id = followup.tenant_id
  WHERE (NOT followup.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_message_traces
with (security_invoker = true)
as
 SELECT trace.message_id,
    trace.tenant_id,
        CASE
            WHEN (trace.trace ->> 'outcome'::text) = ANY (ARRAY['successful'::text, 'refused'::text, 'regenerated'::text, 'held'::text, 'moderator_unavailable'::text]) THEN trace.trace ->> 'outcome'::text
            ELSE 'unavailable'::text
        END AS outcome,
    trace.rule_fired,
    trace.checks,
    trace.violations,
    trace.latency_ms,
    trace.created_at
   FROM message_traces trace
     JOIN messages message ON message.id = trace.message_id AND message.tenant_id = trace.tenant_id
     JOIN tenants tenant ON tenant.id = trace.tenant_id
  WHERE (NOT message.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_messages
with (security_invoker = true)
as
 SELECT message.id AS message_id,
    message.tenant_id,
    message.conversation_id,
    message.direction,
    message.author,
    message.created_at
   FROM messages message
     JOIN tenants tenant ON tenant.id = message.tenant_id
  WHERE (NOT message.is_test OR (tenant.is_demo AND public.platform_demo_visible())) AND (NOT tenant.is_demo OR public.platform_demo_visible()) OR tenant.id = NULLIF(current_setting('app.phase7_demo_tenant'::text, true), ''::text)::uuid;

create or replace view public.analytics_onboarding_runs
with (security_invoker = true)
as
 SELECT run.id AS run_id,
    run.tenant_id,
    run.started_at,
    run.went_live_at,
    run.created_at
   FROM onboarding_runs run
     JOIN tenants tenant ON tenant.id = run.tenant_id
  WHERE (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_provisioning_steps
with (security_invoker = true)
as
 SELECT step.id AS step_id,
    step.tenant_id,
    step.step_key,
    step.state,
    step.attempts,
    step.started_at,
    step.completed_at,
    step.created_at
   FROM provisioning_steps step
     JOIN tenants tenant ON tenant.id = step.tenant_id
  WHERE (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_tenant_cost_rollups
with (security_invoker = true)
as
 SELECT rollup.id AS rollup_id,
    rollup.tenant_id,
    rollup.window_start,
    rollup.window_end,
    rollup.recognized_subscription_cents,
    rollup.computed_at
   FROM tenant_cost_rollups rollup
     JOIN tenants tenant ON tenant.id = rollup.tenant_id
  WHERE (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_tenant_price_overrides
with (security_invoker = true)
as
 SELECT override_row.id AS override_id,
    override_row.tenant_id,
    override_row.price_cents,
    override_row.effective_at,
    override_row.ends_at
   FROM tenant_price_overrides override_row
     JOIN tenants tenant ON tenant.id = override_row.tenant_id
  WHERE (NOT tenant.is_demo OR public.platform_demo_visible());

create or replace view public.analytics_tenants
with (security_invoker = true)
as
 SELECT tenant.id AS tenant_id,
    tenant.created_at,
    tenant.status,
    tenant.tier_id,
    COALESCE(settings.timezone, 'America/New_York'::text) AS timezone
   FROM tenants tenant
     LEFT JOIN tenant_settings settings ON settings.tenant_id = tenant.id
  WHERE (NOT tenant.is_demo OR public.platform_demo_visible()) OR tenant.id = NULLIF(current_setting('app.phase7_demo_tenant'::text, true), ''::text)::uuid;
