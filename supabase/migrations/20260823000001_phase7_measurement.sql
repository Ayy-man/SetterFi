-- SetterFi Phase 7 measurement, comparison, and persisted test-lane contract.
-- Every reported fact crosses a test/demo exclusion view, human mutations carry a verified actor,
-- and evidence rows are immutable unless a named finalization transition permits the change.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Fail-loud upstream contracts before any Phase 7 DDL
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('app.inherit_is_test()') is null
    or not exists (
      select 1 from pg_trigger
      where tgname = 'inherit_is_test' and tgrelid = 'public.messages'::regclass
        and not tgisinternal
    ) then
    raise exception 'PHASE3_IS_TEST_INHERITANCE_MISSING';
  end if;

  if to_regclass('public.conversations') is null
    or to_regclass('public.followups') is null
    or to_regclass('public.billable_events') is null
    or to_regclass('public.audit_log') is null
    or to_regprocedure(
      'public.persist_outbound_send(uuid,uuid,text,uuid,text,text,text,text,boolean)'
    ) is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'conversations'
        and column_name in ('status_reason', 'cadence_anchor_at', 'current_step')
      group by table_name having count(*) = 3
    ) then
    raise exception 'PHASE3_MEASUREMENT_INPUT_MISSING';
  end if;

  if to_regclass('public.message_traces') is null
    or to_regclass('public.messages') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'message_traces'
        and column_name = 'trace' and udt_name = 'jsonb'
    )
    or exists (
      select 1 from public.message_traces
      where trace is not null and jsonb_typeof(trace) <> 'object'
    ) then
    raise exception 'PHASE2_TRACE_OUTCOME_EVIDENCE_MISSING';
  end if;

  if to_regclass('public.referrals') is null
    or to_regclass('public.commission_ledger') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'referrals' and column_name = 'tenant_id'
    ) then
    raise exception 'PHASE1_REFERRAL_TENANT_LINK_MISSING';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'conversations'
      and column_name = 'first_touch_keyword'
  ) then
    raise exception 'PHASE4_KEYWORD_ATTRIBUTION_MISSING';
  end if;

  if to_regclass('public.contact_identities') is null
    or to_regclass('public.channel_connections') is null
    or to_regclass('public.appointment_reschedules') is null then
    raise exception 'PHASE4_MEASUREMENT_INPUT_MISSING';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tenant_settings'
      and column_name = 'timezone'
  ) then
    raise exception 'PHASE5_TENANT_TIMEZONE_MISSING';
  end if;

  if to_regclass('public.onboarding_runs') is null
    or to_regclass('public.provisioning_steps') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'onboarding_runs'
        and column_name in ('started_at', 'went_live_at')
      group by table_name having count(*) = 2
    ) then
    raise exception 'PHASE5_MEASUREMENT_INPUT_MISSING';
  end if;

  if to_regclass('public.billing_subscriptions') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'billing_subscriptions'
        and column_name in ('stripe_price_id', 'current_period_start', 'current_period_end')
      group by table_name having count(*) = 3
    ) then
    raise exception 'PHASE6_SUBSCRIPTION_MIRROR_MISSING';
  end if;

  if to_regclass('public.tier_price_versions') is null
    or to_regclass('public.tenant_price_overrides') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'tiers' and column_name = 'stripe_price_id'
    ) then
    raise exception 'PHASE6_PRICE_VERSION_MISSING';
  end if;

  if to_regclass('public.tenant_cost_rollups') is null
    or to_regclass('public.platform_margin_projection') is null then
    raise exception 'PHASE6_COST_ROLLUP_MISSING';
  end if;

  if exists (
    select 1 from public.flow_configs flow
    where flow.status = 'published' and (
      jsonb_typeof(flow.questions) <> 'array'
      or exists (
        select 1 from jsonb_array_elements(flow.questions) question
        where jsonb_typeof(question) <> 'object'
          or nullif(btrim(question ->> 'id'), '') is null
      )
    )
  ) then
    raise exception 'PHASE2_OFFER_QUESTION_LABEL_MISSING';
  end if;
end
$$;

-- Phase 2 backfilled legacy safety categories into three suite values that its two-value check
-- rejected. Preserve those legacy rows while all new database-authored cases remain restricted by
-- the promotion RPC to the two judgement suites.
alter table public.eval_cases drop constraint eval_cases_suite_chk;
alter table public.eval_cases add constraint eval_cases_suite_chk check (suite in (
  'compliance_guardrails', 'pricing_discipline', 'jailbreak_injection',
  'output_integrity', 'qualification_accuracy', 'voice_tone'
));

-- Phase 6 D-2: the replay lookup used an unqualified actor_id that collided with audit_log.actor_id.
-- The public signature and verified-actor custody remain unchanged.
create or replace function public.set_tenant_billing_status(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_status public.tenant_status,
  p_reason text
)
returns table (tenant_id uuid, status public.tenant_status, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_row public.tenants%rowtype;
  subscription_row public.billing_subscriptions%rowtype;
  verified_actor_id uuid;
  logged_id bigint;
  action_key text;
begin
  verified_actor_id := app.phase6_verified_actor(p_actor_id, p_expected_tenant, true, false);
  if nullif(btrim(p_reason), '') is null then
    raise exception 'TENANT_BILLING_STATUS_REASON_REQUIRED';
  end if;
  select * into tenant_row from public.tenants tenant
  where tenant.id = p_expected_tenant for update;
  if tenant_row.id is null then raise exception 'PHASE6_TENANT_NOT_FOUND'; end if;

  if tenant_row.status = p_status then
    select audit.id into logged_id
    from public.audit_log audit
    where audit.action = case
        when p_status = 'suspended' then 'billing.tenant.suspended'
        else 'billing.tenant.unsuspended'
      end
      and audit.actor_id = verified_actor_id
      and audit.tenant_id = p_expected_tenant
      and audit.target_type = 'tenant'
      and audit.target_id = p_expected_tenant::text
      and audit.reason = btrim(p_reason)
    order by audit.id desc
    limit 1;
    if logged_id is null then raise exception 'TENANT_BILLING_STATUS_REPLAY_MISMATCH'; end if;
    return query select p_expected_tenant, p_status, logged_id;
    return;
  end if;

  select subscription.* into subscription_row
  from public.billing_subscriptions subscription
  where subscription.tenant_id = p_expected_tenant for update;
  if p_status = 'suspended' then
    action_key := 'billing.tenant.suspended';
  elsif tenant_row.status = 'suspended' and (
    (p_status = 'active' and subscription_row.status in ('active', 'trialing'))
    or (p_status = 'overdue' and subscription_row.status in ('past_due', 'unpaid'))
  ) then
    action_key := 'billing.tenant.unsuspended';
  else
    raise exception 'TENANT_BILLING_STATUS_TRANSITION_INVALID';
  end if;

  update public.tenants set status = p_status where id = p_expected_tenant;
  logged_id := app.write_audit_row(
    action_key, verified_actor_id, p_expected_tenant, 'tenant', p_expected_tenant::text,
    p_reason, jsonb_build_object('prior_status', tenant_row.status, 'status', p_status)
  );
  return query select p_expected_tenant, p_status, logged_id;
end;
$$;

create or replace function public.read_platform_measurement(p_as_of timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  as_of_value timestamptz := coalesce(p_as_of, now());
  window_start timestamptz;
  previous_start timestamptz;
  metrics jsonb;
  subscriptions jsonb;
  tenant_performance jsonb;
  guardrail_rules jsonb;
  followup_performance jsonb;
  provisioning_performance jsonb;
  history jsonb;
  new_signups bigint;
  previous_signups bigint;
  active_subscriptions bigint;
  gross_mrr_cents bigint;
  gross_complete boolean;
  commission_cents bigint;
  booked_appointments bigint;
  churned_tenants bigint;
  subscription_population bigint;
  average_retention_days numeric;
  trace_count bigint;
  block_count bigint;
  rule_fire_count bigint;
  holding_count bigint;
  conversation_count bigint;
  escalation_count bigint;
  scope_block_count bigint;
  appointment_count bigint;
  no_show_count bigint;
  reschedule_count bigint;
  cadence_population bigint;
  cadence_exhausted bigint;
  followup_sent bigint;
  followup_replied bigint;
  cross_channel bigint;
  live_count bigint;
  launch_count bigint;
  median_live_days numeric;
  provision_terminal bigint;
  provision_failures bigint;
  a2p_terminal bigint;
  a2p_approved bigint;
  a2p_median_days numeric;
  sms_registering bigint;
  meta_live bigint;
  eval_case_count bigint;
  knowledge_usage_count bigint;
  margin_cents bigint;
  margin_complete boolean;
begin
  -- Authorization precedes every measurement query, including aggregate counts.
  perform app.phase7_session_actor(null, true);
  window_start := as_of_value - interval '30 days';
  previous_start := window_start - interval '30 days';

  select count(*) filter (where created_at >= window_start),
    count(*) filter (where created_at >= previous_start and created_at < window_start)
  into new_signups, previous_signups
  from public.analytics_tenants where created_at < as_of_value;

  select count(*) into active_subscriptions
  from public.analytics_billing_subscriptions subscription
  where subscription.status in ('active', 'trialing')
    and subscription.current_period_start <= as_of_value
    and subscription.current_period_end > as_of_value;

  with priced as (
    select subscription.tenant_id,
      coalesce(override_row.price_cents, price_version.price_cents) price_cents
    from public.analytics_billing_subscriptions subscription
    left join lateral (
      select override_row.price_cents
      from public.analytics_tenant_price_overrides override_row
      where override_row.tenant_id = subscription.tenant_id
        and override_row.effective_at <= as_of_value
        and (override_row.ends_at is null or override_row.ends_at > as_of_value)
      order by override_row.effective_at desc limit 1
    ) override_row on true
    left join lateral (
      select version.price_cents
      from public.analytics_tier_price_versions version
      where version.tier_id = subscription.tier_id and version.effective_at <= as_of_value
      order by version.effective_at desc limit 1
    ) price_version on true
    where subscription.status in ('active', 'trialing')
      and subscription.current_period_start <= as_of_value
      and subscription.current_period_end > as_of_value
  )
  select coalesce(sum(price_cents), 0)::bigint, coalesce(bool_and(price_cents is not null), true)
  into gross_mrr_cents, gross_complete from priced;

  select coalesce(sum(ledger.commission_cents), 0)::bigint into commission_cents
  from public.analytics_commission_ledger ledger
  where ledger.invoice_paid_at >= window_start and ledger.invoice_paid_at < as_of_value;
  select count(*) into booked_appointments from public.analytics_appointments
  where created_at >= window_start and created_at < as_of_value and status <> 'canceled';
  select count(*) filter (where status = 'churned'), count(*)
  into churned_tenants, subscription_population
  from public.analytics_tenants where created_at < as_of_value;
  select avg(extract(epoch from (least(current_period_end, as_of_value) - current_period_start)) / 86400.0)
  into average_retention_days from public.analytics_billing_subscriptions
  where status in ('active', 'trialing') and current_period_start < as_of_value;

  select count(*), count(*) filter (where outcome = 'refused'),
    count(*) filter (where rule_fired is not null), count(*) filter (where outcome = 'held')
  into trace_count, block_count, rule_fire_count, holding_count
  from public.analytics_message_traces where created_at >= window_start and created_at < as_of_value;
  select count(*) into conversation_count from public.analytics_conversations
  where created_at >= window_start and created_at < as_of_value;
  select count(*) filter (where action = 'conversation.escalated'),
    count(*) filter (where action = 'conversation.scope_blocked')
  into escalation_count, scope_block_count from public.analytics_audit_log
  where created_at >= window_start and created_at < as_of_value;
  select count(*), count(*) filter (where status = 'no_show')
  into appointment_count, no_show_count from public.analytics_appointments
  where start_at >= window_start and start_at < as_of_value;
  select count(*) into reschedule_count from public.analytics_appointment_reschedules
  where created_at >= window_start and created_at < as_of_value;
  select count(*), count(*) filter (where status = 'nurture' and status_reason = 'cadence_exhausted')
  into cadence_population, cadence_exhausted from public.analytics_conversations
  where created_at >= window_start and created_at < as_of_value;

  with sent as (
    select followup.*, conversation.contact_id, conversation.channel original_channel
    from public.analytics_followups followup
    join public.analytics_conversations conversation on conversation.conversation_id = followup.conversation_id
    where followup.status = 'sent' and followup.sent_at >= window_start and followup.sent_at < as_of_value
  ), results as (
    select sent.*,
      exists (select 1 from public.analytics_messages message
        where message.conversation_id = sent.conversation_id and message.direction = 'in'
          and message.created_at > sent.sent_at
          and message.created_at <= least(sent.sent_at + interval '7 days', as_of_value)) replied,
      exists (select 1 from public.analytics_contact_identities identity
        where identity.contact_id = sent.contact_id and identity.channel <> sent.original_channel
          and identity.created_at > sent.sent_at
          and identity.created_at <= least(sent.sent_at + interval '7 days', as_of_value)) crossed
    from sent
  ) select count(*), count(*) filter (where replied), count(*) filter (where crossed)
  into followup_sent, followup_replied, cross_channel from results;

  select count(*), count(*) filter (where went_live_at is not null),
    percentile_cont(0.5) within group (order by extract(epoch from (went_live_at - started_at))/86400.0)
      filter (where went_live_at is not null)
  into launch_count, live_count, median_live_days
  from public.analytics_onboarding_runs where started_at < as_of_value;
  select count(*) filter (where state not in ('pending','running','awaiting_coach','awaiting_platform','awaiting_provider')),
    count(*) filter (where state in ('failed','blocked'))
  into provision_terminal, provision_failures from public.analytics_provisioning_steps
  where created_at < as_of_value;
  select count(*) filter (where step_key = 'a2p_campaign' and state in ('done','failed','blocked')),
    count(*) filter (where step_key = 'a2p_campaign' and state = 'done'),
    percentile_cont(0.5) within group (order by extract(epoch from (completed_at - started_at))/86400.0)
      filter (where step_key = 'a2p_campaign' and state = 'done' and started_at is not null)
  into a2p_terminal, a2p_approved, a2p_median_days from public.analytics_provisioning_steps
  where created_at < as_of_value;
  select count(*) into sms_registering from public.analytics_provisioning_steps
  where step_key = 'sms_live' and state = 'awaiting_provider' and created_at < as_of_value;
  select count(*) into meta_live from public.analytics_channel_connections
  where channel in ('instagram','messenger','whatsapp') and state = 'live';
  select count(*) into eval_case_count from public.analytics_eval_cases where active;
  select count(*) into knowledge_usage_count from public.analytics_brain_knowledge_usage_events
  where used_at >= window_start and used_at < as_of_value;
  select coalesce(sum(margin.margin_cents), 0)::bigint,
    active_subscriptions > 0 and count(*) = active_subscriptions
  into margin_cents, margin_complete from public.platform_margin_projection margin
  where margin.window_start <= (as_of_value - interval '30 days')
    and margin.window_end >= as_of_value;

  metrics := jsonb_build_array(
    jsonb_build_object('metricKey','platform.new_signups','numerator',new_signups,'denominator',new_signups,'value',new_signups,'state','available'),
    jsonb_build_object('metricKey','platform.active_subscriptions','numerator',active_subscriptions,'denominator',active_subscriptions,'value',active_subscriptions,'state','available'),
    jsonb_build_object('metricKey','platform.gross_mrr','numerator',case when gross_complete then gross_mrr_cents end,'denominator',active_subscriptions,'value',case when gross_complete then gross_mrr_cents end,'state',case when gross_complete then 'available' else 'unavailable' end),
    jsonb_build_object('metricKey','platform.affiliate_commission','numerator',commission_cents,'denominator',commission_cents,'value',commission_cents,'state','available'),
    jsonb_build_object('metricKey','platform.booked_appointments','numerator',booked_appointments,'denominator',booked_appointments,'value',booked_appointments,'state','available'),
    jsonb_build_object('metricKey','platform.churn_rate','numerator',churned_tenants,'denominator',subscription_population,'value',case when subscription_population=0 then null else churned_tenants*100.0/subscription_population end,'state',case when subscription_population=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.ltv','numerator',case when gross_complete then gross_mrr_cents end,'denominator',churned_tenants,'value',case when not gross_complete or churned_tenants=0 then null else gross_mrr_cents::numeric/churned_tenants end,'state',case when not gross_complete or churned_tenants=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.average_retention','numerator',active_subscriptions,'denominator',active_subscriptions,'value',average_retention_days,'state',case when average_retention_days is null then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.growth_rate','numerator',new_signups-previous_signups,'denominator',previous_signups,'value',case when previous_signups=0 then null else (new_signups-previous_signups)*100.0/previous_signups end,'state',case when previous_signups=0 then 'needs_more_history' else 'available' end),
    jsonb_build_object('metricKey','platform.guardrail_block_rate','numerator',block_count,'denominator',trace_count,'value',case when trace_count=0 then null else block_count*100.0/trace_count end,'state',case when trace_count=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.guardrail_rule_fire_rate','numerator',rule_fire_count,'denominator',trace_count,'value',case when trace_count=0 then null else rule_fire_count*100.0/trace_count end,'state',case when trace_count=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.holding_reply_rate','numerator',holding_count,'denominator',trace_count,'value',case when trace_count=0 then null else holding_count*100.0/trace_count end,'state',case when trace_count=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.escalation_rate','numerator',escalation_count,'denominator',conversation_count,'value',case when conversation_count=0 then null else escalation_count*100.0/conversation_count end,'state',case when conversation_count=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.scope_block_rate','numerator',scope_block_count,'denominator',conversation_count,'value',case when conversation_count=0 then null else scope_block_count*100.0/conversation_count end,'state',case when conversation_count=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.no_show_rate','numerator',no_show_count,'denominator',appointment_count,'value',case when appointment_count=0 then null else no_show_count*100.0/appointment_count end,'state',case when appointment_count=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.reschedule_rate','numerator',reschedule_count,'denominator',appointment_count,'value',case when appointment_count=0 then null else reschedule_count*100.0/appointment_count end,'state',case when appointment_count=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.cadence_completion_rate','numerator',cadence_exhausted,'denominator',cadence_population,'value',case when cadence_population=0 then null else cadence_exhausted*100.0/cadence_population end,'state',case when cadence_population=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.followup_reply_rate','numerator',followup_replied,'denominator',followup_sent,'value',case when followup_sent=0 then null else followup_replied*100.0/followup_sent end,'state',case when followup_sent=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.cross_channel_continuation_rate','numerator',cross_channel,'denominator',followup_sent,'value',case when followup_sent=0 then null else cross_channel*100.0/followup_sent end,'state',case when followup_sent=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.time_to_live','numerator',live_count,'denominator',launch_count,'value',median_live_days,'state',case when median_live_days is null then 'needs_more_history' else 'available' end),
    jsonb_build_object('metricKey','platform.provisioning_step_failure_rate','numerator',provision_failures,'denominator',provision_terminal,'value',case when provision_terminal=0 then null else provision_failures*100.0/provision_terminal end,'state',case when provision_terminal=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.a2p_approval_rate','numerator',a2p_approved,'denominator',a2p_terminal,'value',case when a2p_terminal=0 then null else a2p_approved*100.0/a2p_terminal end,'state',case when a2p_terminal=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.a2p_median_days_to_clear','numerator',a2p_approved,'denominator',a2p_terminal,'value',a2p_median_days,'state',case when a2p_median_days is null then 'needs_more_history' else 'available' end),
    jsonb_build_object('metricKey','platform.meta_live_sms_registering_share','numerator',sms_registering,'denominator',meta_live+sms_registering,'value',case when meta_live+sms_registering=0 then null else sms_registering*100.0/(meta_live+sms_registering) end,'state',case when meta_live+sms_registering=0 then 'unavailable' else 'available' end),
    jsonb_build_object('metricKey','platform.eval_case_count','numerator',eval_case_count,'denominator',eval_case_count,'value',eval_case_count,'state','available'),
    jsonb_build_object('metricKey','platform.knowledge_usage_count','numerator',knowledge_usage_count,'denominator',knowledge_usage_count,'value',knowledge_usage_count,'state','available'),
    jsonb_build_object('metricKey','platform.margin','numerator',case when margin_complete then margin_cents end,'denominator',active_subscriptions,'value',case when margin_complete then margin_cents end,'state',case when margin_complete then 'available' else 'unavailable' end)
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'tenantId', tenant_id, 'subscriptionId', subscription_id, 'status', status,
    'stripePriceId', stripe_price_id, 'periodStart', current_period_start,
    'periodEnd', current_period_end) order by tenant_id, subscription_id), '[]'::jsonb)
  into subscriptions from public.analytics_billing_subscriptions;

  with tenant_rows as (
    select tenant.tenant_id,
      (select count(*) from public.analytics_appointments appointment
       where appointment.tenant_id=tenant.tenant_id and appointment.created_at>=window_start
         and appointment.created_at<as_of_value and appointment.status<>'canceled') booked,
      coalesce((select sum(ledger.commission_cents) from public.analytics_commission_ledger ledger
        where ledger.tenant_id=tenant.tenant_id and ledger.invoice_paid_at>=window_start
          and ledger.invoice_paid_at<as_of_value),0)::bigint commission,
      margin.margin_cents,
      price.price_cents gross
    from public.analytics_tenants tenant
    left join lateral (
      select projection.margin_cents from public.platform_margin_projection projection
      where projection.tenant_id=tenant.tenant_id
        and projection.window_start<=(as_of_value - interval '30 days')
        and projection.window_end>=as_of_value order by projection.window_end desc limit 1
    ) margin on true
    left join lateral (
      select coalesce(override_row.price_cents, version.price_cents) price_cents
      from public.analytics_billing_subscriptions subscription
      left join lateral (select price_cents from public.analytics_tenant_price_overrides override_row
        where override_row.tenant_id=subscription.tenant_id and override_row.effective_at<=as_of_value
          and (override_row.ends_at is null or override_row.ends_at>as_of_value)
        order by override_row.effective_at desc limit 1) override_row on true
      left join lateral (select price_cents from public.analytics_tier_price_versions version
        where version.tier_id=subscription.tier_id and version.effective_at<=as_of_value
        order by version.effective_at desc limit 1) version on true
      where subscription.tenant_id=tenant.tenant_id and subscription.status in ('active','trialing')
        and subscription.current_period_start<=as_of_value and subscription.current_period_end>as_of_value
      limit 1
    ) price on true
  )
  select coalesce(jsonb_agg(jsonb_build_object('tenantId',tenant_rows.tenant_id,
    'bookedAppointments',tenant_rows.booked,'grossMrrCents',tenant_rows.gross,
    'commissionCents',tenant_rows.commission,'marginCents',tenant_rows.margin_cents,
    'marginState',case when tenant_rows.margin_cents is null then 'unavailable' else 'available' end)
    order by tenant_rows.tenant_id), '[]'::jsonb)
  into tenant_performance from tenant_rows;

  select coalesce(jsonb_agg(jsonb_build_object('ruleKey',rule_key,'label',rule_key,
    'fires',fires,'blocks',blocks,'holds',holds) order by rule_key), '[]'::jsonb)
  into guardrail_rules from (
    select coalesce(rule_fired,'unavailable') rule_key, count(*) fires,
      count(*) filter(where outcome='refused') blocks, count(*) filter(where outcome='held') holds
    from public.analytics_message_traces where created_at>=window_start and created_at<as_of_value
      and rule_fired is not null group by rule_fired
  ) rule_rows;

  select coalesce(jsonb_agg(jsonb_build_object('touchNo',touch_no,'sent',sent,'replied',replied,
    'crossChannel',crossed,'exhausted',exhausted) order by touch_no), '[]'::jsonb)
  into followup_performance from (
    select followup.touch_no, count(*) filter(where followup.status='sent') sent,
      count(*) filter(where followup.status='sent' and exists(select 1 from public.analytics_messages message
        where message.conversation_id=followup.conversation_id and message.direction='in'
          and message.created_at>followup.sent_at and message.created_at<=least(followup.sent_at+interval '7 days',as_of_value))) replied,
      count(*) filter(where followup.status='sent' and exists(select 1
        from public.analytics_conversations conversation
        join public.analytics_contact_identities identity on identity.contact_id=conversation.contact_id
        where conversation.conversation_id=followup.conversation_id and identity.channel<>conversation.channel
          and identity.created_at>followup.sent_at and identity.created_at<=least(followup.sent_at+interval '7 days',as_of_value))) crossed,
      count(*) filter(where conversation.status='nurture' and conversation.status_reason='cadence_exhausted') exhausted
    from public.analytics_followups followup
    join public.analytics_conversations conversation on conversation.conversation_id=followup.conversation_id
    where followup.created_at>=window_start and followup.created_at<as_of_value group by followup.touch_no
  ) touch_rows;

  select coalesce(jsonb_agg(jsonb_build_object('stepKey',step_key,'state',state,'attempts',attempts,
    'failures',failures,'medianDaysToClear',median_days) order by step_key,state), '[]'::jsonb)
  into provisioning_performance from (
    select step_key, state, sum(attempts)::bigint attempts,
      count(*) filter(where state in ('failed','blocked')) failures,
      percentile_cont(0.5) within group(order by extract(epoch from (completed_at-started_at))/86400.0)
        filter(where completed_at is not null and started_at is not null) median_days
    from public.analytics_provisioning_steps where created_at<as_of_value group by step_key,state
  ) step_rows;

  history := jsonb_build_array(
    jsonb_build_object('periodStart',previous_start,'periodEnd',window_start,'value',previous_signups,
      'state',case when previous_signups=0 then 'needs_more_history' else 'available' end),
    jsonb_build_object('periodStart',window_start,'periodEnd',as_of_value,'value',new_signups,'state','available')
  );
  return jsonb_build_object('asOf',as_of_value,'metrics',metrics,'subscriptions',subscriptions,
    'tenantPerformance',tenant_performance,'guardrailRules',guardrail_rules,
    'followupPerformance',followup_performance,'provisioningPerformance',provisioning_performance,
    'history',history);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Measurement evidence, comparison, and test-session relations
-- ---------------------------------------------------------------------------

create table public.conversation_step_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  step_key text not null check (nullif(btrim(step_key), '') is not null),
  event_kind text not null check (event_kind in ('asked', 'answered')),
  is_test boolean not null default false,
  occurred_at timestamptz not null default now(),
  unique (conversation_id, message_id, step_key, event_kind)
);
create index conversation_step_events_tenant_occurred_idx
  on public.conversation_step_events (tenant_id, occurred_at desc);
create index conversation_step_events_step_idx
  on public.conversation_step_events (tenant_id, step_key, event_kind, occurred_at);

create table public.test_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  started_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint test_agent_sessions_closed_chk check (closed_at is null or closed_at >= created_at)
);
create index test_agent_sessions_tenant_created_idx
  on public.test_agent_sessions (tenant_id, created_at desc);

alter table public.contacts
  add column test_session_id uuid unique
    references public.test_agent_sessions(id) on delete restrict;

create table public.eval_comparisons (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.users(id) on delete restrict,
  brain_draft_version_id uuid not null references public.brain_draft_versions(id) on delete restrict,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  model_config_a_id uuid not null references public.model_configs(id) on delete restrict,
  model_config_b_id uuid not null references public.model_configs(id) on delete restrict,
  case_set_hash text not null check (case_set_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'completed')),
  run_a_id uuid,
  run_b_id uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint eval_comparisons_distinct_configs_chk check (model_config_a_id <> model_config_b_id),
  constraint eval_comparisons_distinct_runs_chk check (run_a_id is null or run_b_id is null or run_a_id <> run_b_id),
  constraint eval_comparisons_complete_shape_chk check (
    (status = 'pending' and run_a_id is null and run_b_id is null and finished_at is null)
    or (status = 'completed' and run_a_id is not null and run_b_id is not null and finished_at is not null)
  )
);
create index eval_comparisons_created_idx on public.eval_comparisons (created_at desc);

alter table public.eval_runs
  add column comparison_id uuid references public.eval_comparisons(id) on delete restrict,
  add column comparison_arm text check (comparison_arm in ('a', 'b')),
  add column case_set_hash text check (case_set_hash ~ '^[0-9a-f]{64}$'),
  add constraint eval_runs_comparison_shape_chk check (
    (comparison_id is null and comparison_arm is null and case_set_hash is null)
    or (comparison_id is not null and comparison_arm is not null and case_set_hash is not null)
  );
create unique index eval_runs_comparison_arm_uidx
  on public.eval_runs (comparison_id, comparison_arm)
  where comparison_id is not null;

alter table public.eval_comparisons
  add constraint eval_comparisons_run_a_fkey foreign key (run_a_id)
    references public.eval_runs(id) on delete restrict,
  add constraint eval_comparisons_run_b_fkey foreign key (run_b_id)
    references public.eval_runs(id) on delete restrict;

alter table public.eval_cases
  add column source_hash text check (source_hash is null or source_hash ~ '^[0-9a-f]{64}$'),
  add column confirmed_redacted_hash text check (
    confirmed_redacted_hash is null or confirmed_redacted_hash ~ '^[0-9a-f]{64}$'
  ),
  add column redaction_manifest jsonb check (
    redaction_manifest is null or jsonb_typeof(redaction_manifest) = 'object'
  ),
  add column promotion_audit_id bigint references public.audit_log(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- 3. Tenant integrity, inheritance, and immutable-evidence triggers
-- ---------------------------------------------------------------------------

create or replace function app.phase7_enforce_step_event_tenant()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  message_row public.messages%rowtype;
begin
  select * into conversation_row from public.conversations where id = new.conversation_id;
  if conversation_row.id is null
    or conversation_row.tenant_id <> new.tenant_id
    or conversation_row.contact_id <> new.contact_id then
    raise exception 'PHASE7_STEP_EVENT_TENANT_MISMATCH';
  end if;
  select * into message_row from public.messages where id = new.message_id;
  if message_row.id is null
    or message_row.tenant_id <> new.tenant_id
    or message_row.conversation_id <> new.conversation_id then
    raise exception 'PHASE7_STEP_EVENT_MESSAGE_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger conversation_step_events_tenant_guard
before insert or update of tenant_id, conversation_id, contact_id, message_id
on public.conversation_step_events
for each row execute function app.phase7_enforce_step_event_tenant();

create or replace function app.reject_phase7_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%_APPEND_ONLY', upper(tg_table_name);
end;
$$;

create trigger conversation_step_events_reject_mutation
before update or delete on public.conversation_step_events
for each row execute function app.reject_phase7_append_only();

create trigger test_agent_sessions_reject_mutation
before update or delete on public.test_agent_sessions
for each row execute function app.reject_phase7_append_only();

create or replace function app.guard_phase7_eval_comparison_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'EVAL_COMPARISONS_APPEND_ONLY'; end if;
  if old.status = 'pending' and new.status = 'completed'
    and (to_jsonb(new) - array['status', 'run_a_id', 'run_b_id', 'finished_at'])
      = (to_jsonb(old) - array['status', 'run_a_id', 'run_b_id', 'finished_at']) then
    return new;
  end if;
  raise exception 'EVAL_COMPARISON_FINALIZATION_ONLY';
end;
$$;

create trigger eval_comparisons_finalization_only
before update or delete on public.eval_comparisons
for each row execute function app.guard_phase7_eval_comparison_mutation();

create or replace function app.guard_phase7_eval_run_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'EVAL_RUNS_APPEND_ONLY'; end if;
  if old.pass_rate is null and new.pass_rate is not null
    and (to_jsonb(new) - 'pass_rate') = (to_jsonb(old) - 'pass_rate') then
    return new;
  end if;
  if old.comparison_id is null and old.comparison_arm is null and old.case_set_hash is null
    and new.comparison_id is not null and new.comparison_arm is not null
    and new.case_set_hash is not null
    and (to_jsonb(new) - array['comparison_id', 'comparison_arm', 'case_set_hash'])
      = (to_jsonb(old) - array['comparison_id', 'comparison_arm', 'case_set_hash']) then
    return new;
  end if;
  raise exception 'EVAL_RUN_FINALIZATION_ONLY';
end;
$$;

create trigger eval_runs_phase7_mutation_guard
before update or delete on public.eval_runs
for each row execute function app.guard_phase7_eval_run_mutation();

create or replace function app.inherit_is_test()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inherited boolean;
begin
  case tg_table_name
    when 'contacts' then
      if new.test_session_id is not null then
        select true into inherited from public.test_agent_sessions
        where id = new.test_session_id and tenant_id = new.tenant_id;
      else
        select is_demo into inherited from public.tenants where id = new.tenant_id;
      end if;
    when 'conversations' then
      select is_test into inherited from public.contacts where id = new.contact_id;
    when 'messages' then
      select is_test into inherited from public.conversations where id = new.conversation_id;
    when 'followups' then
      select is_test into inherited from public.conversations where id = new.conversation_id;
    when 'appointments' then
      if new.conversation_id is not null then
        select is_test into inherited from public.conversations where id = new.conversation_id;
      else
        select is_test into inherited from public.contacts where id = new.contact_id;
      end if;
    when 'billable_events' then
      if tg_op = 'UPDATE'
         and current_setting('app.contact_deletion_active', true) = 'true'
         and old.appointment_id is not null
         and new.appointment_id is null
         and new.appointment_detached_at is not null then
        inherited := old.is_test;
      elsif new.appointment_id is not null then
        select is_test into inherited from public.appointments where id = new.appointment_id;
      else
        select is_test into inherited from public.billable_events where id = new.adjusts_event_id;
      end if;
    when 'brain_knowledge_usage_events' then
      select is_test into inherited from public.conversations where id = new.conversation_id;
    when 'unmatched_objections' then
      if new.conversation_id is not null then
        select is_test into inherited from public.conversations where id = new.conversation_id;
      elsif new.message_id is not null then
        select is_test into inherited from public.messages where id = new.message_id;
      else
        inherited := false;
      end if;
    when 'appointment_reschedules' then
      select is_test into inherited from public.appointments where id = new.appointment_id;
    when 'support_threads' then
      select is_demo into inherited from public.tenants where id = new.tenant_id;
    when 'support_messages' then
      select is_test into inherited from public.support_threads where id = new.thread_id;
    when 'contact_notes' then
      select is_test into inherited from public.contacts where id = new.contact_id;
    when 'conversation_step_events' then
      select is_test into inherited from public.conversations where id = new.conversation_id;
    else
      raise exception 'IS_TEST_TRIGGER_UNSUPPORTED_TABLE:%', tg_table_name;
  end case;

  if inherited is null then raise exception 'IS_TEST_PARENT_NOT_FOUND:%', tg_table_name; end if;
  new.is_test := inherited;
  return new;
end;
$$;

create trigger inherit_is_test
before insert or update on public.conversation_step_events
for each row execute function app.inherit_is_test();

-- ---------------------------------------------------------------------------
-- 4. Forced RLS, narrow reads, and no direct evidence writes
-- ---------------------------------------------------------------------------

alter table public.conversation_step_events enable row level security;
alter table public.conversation_step_events force row level security;
alter table public.test_agent_sessions enable row level security;
alter table public.test_agent_sessions force row level security;
alter table public.eval_comparisons enable row level security;
alter table public.eval_comparisons force row level security;

create policy conversation_step_events_tenant_read on public.conversation_step_events
  for select to authenticated using (app.owns_tenant(tenant_id));
create policy conversation_step_events_platform_read on public.conversation_step_events
  for select to authenticated using (app.is_platform_user());
create policy test_agent_sessions_tenant_read on public.test_agent_sessions
  for select to authenticated using (app.owns_tenant(tenant_id));
create policy test_agent_sessions_platform_read on public.test_agent_sessions
  for select to authenticated using (app.is_platform_user());
create policy eval_comparisons_platform_read on public.eval_comparisons
  for select to authenticated using (app.is_platform_user());

revoke all on public.conversation_step_events, public.test_agent_sessions,
  public.eval_comparisons from anon, authenticated, service_role;
grant select on public.conversation_step_events, public.test_agent_sessions,
  public.eval_comparisons to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Phase 7 audit registry
-- ---------------------------------------------------------------------------

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('eval.case.promoted', 'human', 'platform', false, false,
   'Eval case promotion logged', 'Eval case promotion recorded in the audit log'),
  ('eval.model_config.created', 'human', 'platform', false, false,
   'Challenger model configuration created', 'Challenger model configuration creation recorded in the audit log');

-- All product tiers are monthly by product decision.

-- ---------------------------------------------------------------------------
-- 6. Security-invoker exclusion boundary
-- ---------------------------------------------------------------------------

create view public.analytics_tenants
with (security_invoker = true)
as
select tenant.id as tenant_id, tenant.created_at, tenant.status, tenant.tier_id,
  coalesce(settings.timezone, 'America/New_York') as timezone
from public.tenants tenant
left join public.tenant_settings settings on settings.tenant_id = tenant.id
where not tenant.is_demo;

create view public.analytics_contacts
with (security_invoker = true)
as
select contact.id as contact_id, contact.tenant_id, contact.created_at, contact.updated_at,
  contact.pipeline_stage, contact.stage_set_at, contact.outcome, contact.merged_into_contact_id
from public.contacts contact
join public.tenants tenant on tenant.id = contact.tenant_id
where not contact.is_test and not tenant.is_demo;

create view public.analytics_conversations
with (security_invoker = true)
as
select conversation.id as conversation_id, conversation.tenant_id, conversation.contact_id,
  conversation.channel, conversation.first_touch_keyword, conversation.status,
  conversation.status_reason, conversation.current_step, conversation.cadence_anchor_at,
  conversation.created_at, conversation.last_message_at
from public.conversations conversation
join public.tenants tenant on tenant.id = conversation.tenant_id
where not conversation.is_test and not tenant.is_demo;

create view public.analytics_messages
with (security_invoker = true)
as
select message.id as message_id, message.tenant_id, message.conversation_id,
  message.direction, message.author, message.created_at
from public.messages message
join public.tenants tenant on tenant.id = message.tenant_id
where not message.is_test and not tenant.is_demo;

create view public.analytics_appointments
with (security_invoker = true)
as
select appointment.id as appointment_id, appointment.tenant_id, appointment.contact_id,
  appointment.conversation_id, appointment.status, appointment.attributed_to_agent,
  appointment.start_at, appointment.end_at, appointment.created_at, appointment.updated_at
from public.appointments appointment
join public.tenants tenant on tenant.id = appointment.tenant_id
where not appointment.is_test and not tenant.is_demo;

create view public.analytics_billable_events
with (security_invoker = true)
as
select event.id as billable_event_id, event.tenant_id, event.quantity,
  event.appointment_id, event.adjusts_event_id, event.occurred_at
from public.billable_events event
join public.tenants tenant on tenant.id = event.tenant_id
where not event.is_test and not tenant.is_demo;

create view public.analytics_conversation_step_events
with (security_invoker = true)
as
select event.id as event_id, event.tenant_id, event.conversation_id, event.contact_id,
  event.message_id, event.step_key, event.event_kind, event.occurred_at
from public.conversation_step_events event
join public.tenants tenant on tenant.id = event.tenant_id
where not event.is_test and not tenant.is_demo;

create view public.analytics_message_traces
with (security_invoker = true)
as
select trace.message_id, trace.tenant_id,
  case
    when trace.trace ->> 'outcome' in (
      'successful', 'refused', 'regenerated', 'held', 'moderator_unavailable'
    ) then trace.trace ->> 'outcome'
    else 'unavailable'
  end as outcome,
  trace.rule_fired, trace.checks, trace.violations, trace.latency_ms, trace.created_at
from public.message_traces trace
join public.messages message on message.id = trace.message_id
  and message.tenant_id = trace.tenant_id
join public.tenants tenant on tenant.id = trace.tenant_id
where not message.is_test and not tenant.is_demo;

create view public.analytics_billing_subscriptions
with (security_invoker = true)
as
select subscription.id as subscription_id, subscription.tenant_id, tier.id as tier_id,
  subscription.stripe_price_id, subscription.status, subscription.current_period_start,
  subscription.current_period_end, subscription.cancel_at_period_end,
  subscription.provider_updated_at, subscription.created_at
from public.billing_subscriptions subscription
join public.tenants tenant on tenant.id = subscription.tenant_id
left join public.tiers tier on tier.stripe_price_id = subscription.stripe_price_id
where not tenant.is_demo;

create view public.analytics_tier_price_versions
with (security_invoker = true)
as
select version.id as price_version_id, version.tier_id, version.price_cents, version.effective_at
from public.tier_price_versions version;

create view public.analytics_tenant_price_overrides
with (security_invoker = true)
as
select override_row.id as override_id, override_row.tenant_id, override_row.price_cents,
  override_row.effective_at, override_row.ends_at
from public.tenant_price_overrides override_row
join public.tenants tenant on tenant.id = override_row.tenant_id
where not tenant.is_demo;

create view public.analytics_commission_ledger
with (security_invoker = true)
as
select ledger.id as commission_ledger_id, referral.tenant_id, ledger.referral_id,
  ledger.entry_kind, ledger.commission_cents, ledger.invoice_paid_at, ledger.created_at
from public.commission_ledger ledger
join public.referrals referral on referral.id = ledger.referral_id
join public.tenants tenant on tenant.id = referral.tenant_id
where not tenant.is_demo;

create view public.analytics_followups
with (security_invoker = true)
as
select followup.id as followup_id, followup.tenant_id, followup.conversation_id,
  followup.touch_no, followup.status, followup.canceled_reason,
  followup.resolved_identity_id, followup.sent_at, followup.created_at, followup.updated_at
from public.followups followup
join public.tenants tenant on tenant.id = followup.tenant_id
where not followup.is_test and not tenant.is_demo;

create view public.analytics_contact_identities
with (security_invoker = true)
as
select identity.id as identity_id, identity.tenant_id, identity.contact_id,
  identity.channel, identity.provider, identity.created_at
from public.contact_identities identity
join public.contacts contact on contact.id = identity.contact_id
  and contact.tenant_id = identity.tenant_id
join public.tenants tenant on tenant.id = identity.tenant_id
where not contact.is_test and not tenant.is_demo;

create view public.analytics_appointment_reschedules
with (security_invoker = true)
as
select reschedule.id as reschedule_id, reschedule.tenant_id,
  reschedule.appointment_id, reschedule.created_at
from public.appointment_reschedules reschedule
join public.tenants tenant on tenant.id = reschedule.tenant_id
where not reschedule.is_test and not tenant.is_demo;

create view public.analytics_audit_log
with (security_invoker = true)
as
select audit.id as audit_id, audit.tenant_id, audit.action, audit.target_type,
  audit.target_id, audit.payload, audit.created_at
from public.audit_log audit
left join public.tenants tenant on tenant.id = audit.tenant_id
where audit.tenant_id is null or not tenant.is_demo;

create view public.analytics_onboarding_runs
with (security_invoker = true)
as
select run.id as run_id, run.tenant_id, run.started_at, run.went_live_at, run.created_at
from public.onboarding_runs run
join public.tenants tenant on tenant.id = run.tenant_id
where not tenant.is_demo;

create view public.analytics_provisioning_steps
with (security_invoker = true)
as
select step.id as step_id, step.tenant_id, step.step_key, step.state, step.attempts,
  step.started_at, step.completed_at, step.created_at
from public.provisioning_steps step
join public.tenants tenant on tenant.id = step.tenant_id
where not tenant.is_demo;

create view public.analytics_channel_connections
with (security_invoker = true)
as
select connection.id as connection_id, connection.tenant_id, connection.channel,
  connection.provider, connection.state, connection.created_at, connection.updated_at
from public.channel_connections connection
join public.tenants tenant on tenant.id = connection.tenant_id
where not tenant.is_demo;

create view public.analytics_brain_knowledge_usage_events
with (security_invoker = true)
as
select event.id as event_id, event.tenant_id, event.knowledge_entry_id,
  event.conversation_id, event.used_at
from public.brain_knowledge_usage_events event
join public.tenants tenant on tenant.id = event.tenant_id
where not event.is_test and not tenant.is_demo;

create view public.analytics_eval_cases
with (security_invoker = true)
as
select eval_case.id as eval_case_id, eval_case.source_tenant_id,
  eval_case.suite, eval_case.active, eval_case.created_at
from public.eval_cases eval_case
left join public.tenants tenant on tenant.id = eval_case.source_tenant_id
where coalesce(tenant.is_demo, false) = false;

revoke all on public.analytics_tenants, public.analytics_contacts,
  public.analytics_conversations, public.analytics_messages, public.analytics_appointments,
  public.analytics_billable_events, public.analytics_conversation_step_events,
  public.analytics_message_traces, public.analytics_billing_subscriptions,
  public.analytics_tier_price_versions, public.analytics_tenant_price_overrides,
  public.analytics_commission_ledger, public.analytics_followups,
  public.analytics_contact_identities, public.analytics_appointment_reschedules,
  public.analytics_audit_log, public.analytics_onboarding_runs,
  public.analytics_provisioning_steps, public.analytics_channel_connections,
  public.analytics_brain_knowledge_usage_events, public.analytics_eval_cases
from anon, authenticated, service_role;

grant select on public.analytics_tenants, public.analytics_contacts,
  public.analytics_conversations, public.analytics_messages, public.analytics_appointments,
  public.analytics_billable_events, public.analytics_conversation_step_events,
  public.analytics_message_traces, public.analytics_billing_subscriptions,
  public.analytics_tier_price_versions, public.analytics_tenant_price_overrides,
  public.analytics_commission_ledger, public.analytics_followups,
  public.analytics_contact_identities, public.analytics_appointment_reschedules,
  public.analytics_audit_log, public.analytics_onboarding_runs,
  public.analytics_provisioning_steps, public.analytics_channel_connections,
  public.analytics_brain_knowledge_usage_events, public.analytics_eval_cases
to authenticated, service_role;

comment on view public.analytics_message_traces is
  'Unknown or missing trace outcomes remain visible as unavailable and are excluded by every denominator.';
comment on view public.analytics_billing_subscriptions is
  'An unmatched Stripe Price leaves tier_id null, so gross MRR is unavailable instead of guessed.';

-- ---------------------------------------------------------------------------
-- 7. Step-event writer and session-scoped measurement readers
-- ---------------------------------------------------------------------------

create or replace function app.phase7_session_actor(
  p_expected_tenant uuid,
  p_platform_only boolean
)
returns public.users
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_row public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  select * into actor_row from public.users actor where actor.id = app.current_user_id();
  if actor_row.id is null
    or actor_row.role::text is distinct from app.current_user_role()::text then
    raise exception 'PHASE7_SESSION_ACTOR_REQUIRED';
  end if;
  if p_platform_only then
    if actor_row.role not in ('owner', 'admin', 'success') then
      raise exception 'PHASE7_PLATFORM_READER_REQUIRED';
    end if;
  elsif actor_row.role not in ('coach', 'coach_member')
    or actor_row.tenant_id is distinct from p_expected_tenant then
    raise exception 'PHASE7_COACH_READER_TENANT_MISMATCH';
  end if;
  return actor_row;
end;
$$;

create or replace function public.record_conversation_step_events(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_lead_message_id uuid,
  p_agent_message_id uuid,
  p_answered_step_key text,
  p_asked_step_key text
)
returns table (answered_event_id uuid, asked_event_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  lead_row public.messages%rowtype;
  agent_row public.messages%rowtype;
begin
  if nullif(btrim(coalesce(p_answered_step_key, '')), '') is null
    and nullif(btrim(coalesce(p_asked_step_key, '')), '') is null then
    return query select null::uuid, null::uuid;
    return;
  end if;

  select * into conversation_row from public.conversations conversation
  where conversation.id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(
    p_expected_tenant, conversation_row.tenant_id, 'conversation_step_event'
  );

  select * into lead_row from public.messages message
  where message.id = p_lead_message_id for share;
  if lead_row.id is null
    or lead_row.tenant_id <> p_expected_tenant
    or lead_row.conversation_id <> p_conversation_id
    or lead_row.direction <> 'in' then
    raise exception 'PHASE7_LEAD_MESSAGE_SCOPE_MISMATCH';
  end if;

  select * into agent_row from public.messages message
  where message.id = p_agent_message_id for share;
  if agent_row.id is null
    or agent_row.tenant_id <> p_expected_tenant
    or agent_row.conversation_id <> p_conversation_id
    or agent_row.direction <> 'out' then
    raise exception 'PHASE7_AGENT_MESSAGE_SCOPE_MISMATCH';
  end if;

  answered_event_id := null;
  asked_event_id := null;
  if nullif(btrim(coalesce(p_answered_step_key, '')), '') is not null then
    insert into public.conversation_step_events (
      tenant_id, conversation_id, contact_id, message_id, step_key, event_kind, occurred_at
    ) values (
      p_expected_tenant, p_conversation_id, conversation_row.contact_id, lead_row.id,
      btrim(p_answered_step_key), 'answered', lead_row.created_at
    )
    on conflict (conversation_id, message_id, step_key, event_kind) do nothing
    returning id into answered_event_id;
    if answered_event_id is null then
      select event.id into answered_event_id from public.conversation_step_events event
      where event.conversation_id = p_conversation_id and event.message_id = lead_row.id
        and event.step_key = btrim(p_answered_step_key) and event.event_kind = 'answered';
    end if;
  end if;

  if nullif(btrim(coalesce(p_asked_step_key, '')), '') is not null then
    insert into public.conversation_step_events (
      tenant_id, conversation_id, contact_id, message_id, step_key, event_kind, occurred_at
    ) values (
      p_expected_tenant, p_conversation_id, conversation_row.contact_id, agent_row.id,
      btrim(p_asked_step_key), 'asked', agent_row.created_at
    )
    on conflict (conversation_id, message_id, step_key, event_kind) do nothing
    returning id into asked_event_id;
    if asked_event_id is null then
      select event.id into asked_event_id from public.conversation_step_events event
      where event.conversation_id = p_conversation_id and event.message_id = agent_row.id
        and event.step_key = btrim(p_asked_step_key) and event.event_kind = 'asked';
    end if;
  end if;
  return next;
end;
$$;

create or replace function public.read_coach_measurement(
  p_expected_tenant uuid,
  p_window text,
  p_custom_from date,
  p_custom_to date,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tenant_row record;
  as_of_value timestamptz := coalesce(p_as_of, now());
  local_day date;
  window_start timestamptz;
  window_end timestamptz;
  cohort_state text;
  new_count bigint := 0;
  active_count bigint := 0;
  qualified_count bigint := 0;
  disqualified_count bigint := 0;
  booked_count bigint := 0;
  agent_booked_count bigint := 0;
  terminal_count bigint := 0;
  shown_count bigint := 0;
  show_denominator bigint := 0;
  average_seconds numeric;
  asked_count bigint := 0;
  answered_count bigint := 0;
  conversation_count bigint := 0;
  keyword_qualified bigint := 0;
  keyword_responded bigint := 0;
  keyword_booked bigint := 0;
  allowance_used bigint;
  allowance_limit integer;
  allowance_period_start timestamptz;
  allowance_period_end timestamptz;
  allowance_state text := 'unavailable';
  metrics jsonb;
  funnel jsonb;
  responses jsonb;
  keywords jsonb;
  pipeline jsonb;
begin
  perform app.phase7_session_actor(p_expected_tenant, false);
  select * into tenant_row from public.analytics_tenants tenant
  where tenant.tenant_id = p_expected_tenant;
  if tenant_row.tenant_id is null then raise exception 'PHASE7_COACH_TENANT_UNAVAILABLE'; end if;
  if p_window not in ('1d', '1w', '1m', '3m', 'all', 'custom') then
    raise exception 'PHASE7_MEASUREMENT_WINDOW_INVALID';
  end if;
  if (p_window = 'custom') <> (p_custom_from is not null and p_custom_to is not null)
    or (p_window = 'custom' and p_custom_to < p_custom_from) then
    raise exception 'PHASE7_CUSTOM_WINDOW_INVALID';
  end if;

  local_day := (as_of_value at time zone tenant_row.timezone)::date;
  window_end := ((local_day + 1)::timestamp at time zone tenant_row.timezone);
  window_start := case p_window
    when '1d' then local_day::timestamp at time zone tenant_row.timezone
    when '1w' then (local_day - 6)::timestamp at time zone tenant_row.timezone
    when '1m' then (local_day - interval '1 month' + interval '1 day') at time zone tenant_row.timezone
    when '3m' then (local_day - interval '3 months' + interval '1 day') at time zone tenant_row.timezone
    when 'custom' then p_custom_from::timestamp at time zone tenant_row.timezone
    else tenant_row.created_at
  end;
  if p_window = 'custom' then
    window_end := (p_custom_to + 1)::timestamp at time zone tenant_row.timezone;
  end if;
  cohort_state := case when as_of_value < window_end then 'still_filling' else 'available' end;

  with cohort as (
    select contact.*
    from public.analytics_contacts contact
    where contact.tenant_id = p_expected_tenant
      and contact.created_at >= window_start and contact.created_at < window_end
      and contact.merged_into_contact_id is null
  ), appointment_facts as (
    select cohort.contact_id,
      min(appointment.created_at) filter (where appointment.status <> 'canceled') first_booked_at,
      bool_or(appointment.status <> 'canceled') as has_booking,
      bool_or(appointment.status <> 'canceled' and appointment.attributed_to_agent) as agent_booking
    from cohort
    left join public.analytics_appointments appointment
      on appointment.contact_id = cohort.contact_id and appointment.tenant_id = p_expected_tenant
    group by cohort.contact_id
  )
  select count(*)::bigint,
    count(*) filter (where cohort.pipeline_stage not in ('booked', 'qualified_no_buy', 'disqualified'))::bigint,
    count(*) filter (where cohort.pipeline_stage in ('booked', 'qualified_no_buy') or cohort.outcome = 'BOOK')::bigint,
    count(*) filter (where cohort.pipeline_stage = 'disqualified')::bigint,
    count(*) filter (where appointment_facts.has_booking)::bigint,
    count(*) filter (where appointment_facts.agent_booking)::bigint,
    count(*) filter (where cohort.pipeline_stage in ('booked', 'qualified_no_buy', 'disqualified'))::bigint,
    avg(extract(epoch from (appointment_facts.first_booked_at - cohort.created_at)))
      filter (where appointment_facts.first_booked_at is not null)
  into new_count, active_count, qualified_count, disqualified_count, booked_count,
    agent_booked_count, terminal_count, average_seconds
  from cohort join appointment_facts using (contact_id);

  select count(*) filter (where appointment.status = 'completed')::bigint,
    count(*) filter (where appointment.status in ('completed', 'no_show'))::bigint
  into shown_count, show_denominator
  from public.analytics_appointments appointment
  where appointment.tenant_id = p_expected_tenant
    and appointment.end_at < as_of_value and appointment.status <> 'canceled';

  select count(distinct event.contact_id) filter (where event.event_kind = 'asked')::bigint,
    count(distinct event.contact_id) filter (where event.event_kind = 'answered')::bigint
  into asked_count, answered_count
  from public.analytics_conversation_step_events event
  join public.analytics_contacts contact on contact.contact_id = event.contact_id
  where event.tenant_id = p_expected_tenant
    and contact.created_at >= window_start and contact.created_at < window_end;

  with eligible as (
    select conversation.*
    from public.analytics_conversations conversation
    where conversation.tenant_id = p_expected_tenant
      and conversation.created_at >= window_start and conversation.created_at < window_end
  )
  select count(*)::bigint,
    count(*) filter (where contact.pipeline_stage in ('booked', 'qualified_no_buy') or contact.outcome = 'BOOK')::bigint,
    count(*) filter (where exists (
      select 1 from public.analytics_messages message
      where message.conversation_id = eligible.conversation_id and message.direction = 'in'
        and message.created_at > eligible.created_at
    ))::bigint,
    count(*) filter (where exists (
      select 1 from public.analytics_appointments appointment
      where appointment.contact_id = eligible.contact_id and appointment.status <> 'canceled'
    ))::bigint
  into conversation_count, keyword_qualified, keyword_responded, keyword_booked
  from eligible join public.analytics_contacts contact on contact.contact_id = eligible.contact_id;

  select subscription.current_period_start, subscription.current_period_end,
    sum(event.quantity)::bigint,
    tier.call_allowance
  into allowance_period_start, allowance_period_end, allowance_used, allowance_limit
  from public.analytics_billing_subscriptions subscription
  left join public.analytics_billable_events event
    on event.tenant_id = subscription.tenant_id
    and event.occurred_at >= subscription.current_period_start
    and event.occurred_at < subscription.current_period_end
  left join public.tiers tier on tier.id = subscription.tier_id
  where subscription.tenant_id = p_expected_tenant
    and subscription.status in ('trialing', 'active', 'past_due')
    and subscription.current_period_start <= as_of_value
    and subscription.current_period_end > as_of_value
  group by subscription.current_period_start, subscription.current_period_end, tier.call_allowance;
  if allowance_period_start is not null and allowance_limit is not null then
    allowance_used := coalesce(allowance_used, 0);
    allowance_state := 'available';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'stepKey', label.step_key, 'stepLabel', label.step_label,
    'askedContacts', label.asked_contacts, 'answeredContacts', label.answered_contacts
  ) order by label.step_order, label.step_key), '[]'::jsonb)
  into responses
  from (
    with flow_questions as (
      select question ->> 'id' step_key,
        coalesce(nullif(btrim(question ->> 'label'), ''), 'Step ' || ordinality::text) step_label,
        ordinality::bigint step_order
      from public.flow_configs flow,
        jsonb_array_elements(flow.questions) with ordinality as item(question, ordinality)
      where flow.tenant_id = p_expected_tenant and flow.status = 'published'
    ), counts as (
      select event.step_key,
        count(distinct event.contact_id) filter (where event.event_kind = 'asked')::bigint asked_contacts,
        count(distinct event.contact_id) filter (where event.event_kind = 'answered')::bigint answered_contacts
      from public.analytics_conversation_step_events event
      join public.analytics_contacts contact on contact.contact_id = event.contact_id
      where event.tenant_id = p_expected_tenant
        and contact.created_at >= window_start and contact.created_at < window_end
      group by event.step_key
    )
    select counts.step_key, coalesce(flow_questions.step_label, 'Step ' ||
      dense_rank() over (order by counts.step_key)::text) step_label,
      coalesce(flow_questions.step_order, 10000 + dense_rank() over (order by counts.step_key)) step_order,
      counts.asked_contacts, counts.answered_contacts
    from counts left join flow_questions using (step_key)
  ) label;

  select coalesce(jsonb_agg(jsonb_build_object(
    'stepKey', row.step_key, 'stepLabel', row.step_label,
    'enteredContacts', row.entered_contacts, 'completedContacts', row.completed_contacts
  ) order by row.step_order), '[]'::jsonb)
  into funnel
  from (values
    ('entered', 'Entered', 1, new_count, new_count),
    ('qualified', 'Qualified', 2, new_count, qualified_count),
    ('booked', 'Booked', 3, new_count, booked_count)
  ) row(step_key, step_label, step_order, entered_contacts, completed_contacts);

  select coalesce(jsonb_agg(jsonb_build_object(
    'keyword', row.keyword, 'conversations', row.conversations,
    'qualifiedContacts', row.qualified_contacts,
    'respondedConversations', row.responded_conversations,
    'bookedContacts', row.booked_contacts, 'dataLabel', 'Database truth'
  ) order by case when row.keyword = 'No keyword' then 1 else 0 end, row.keyword), '[]'::jsonb)
  into keywords
  from (
    select coalesce(nullif(btrim(conversation.first_touch_keyword), ''), 'No keyword') keyword,
      count(*)::bigint conversations,
      count(distinct conversation.contact_id) filter (
        where contact.pipeline_stage in ('booked', 'qualified_no_buy') or contact.outcome = 'BOOK'
      )::bigint qualified_contacts,
      count(*) filter (where exists (
        select 1 from public.analytics_messages message
        where message.conversation_id = conversation.conversation_id and message.direction = 'in'
          and message.created_at > conversation.created_at
      ))::bigint responded_conversations,
      count(distinct conversation.contact_id) filter (where exists (
        select 1 from public.analytics_appointments appointment
        where appointment.contact_id = conversation.contact_id and appointment.status <> 'canceled'
      ))::bigint booked_contacts
    from public.analytics_conversations conversation
    join public.analytics_contacts contact on contact.contact_id = conversation.contact_id
    where conversation.tenant_id = p_expected_tenant
      and conversation.created_at >= window_start and conversation.created_at < window_end
    group by 1
  ) row;

  select coalesce(jsonb_agg(jsonb_build_object(
    'contactId', contact.contact_id, 'displayName', coalesce(nullif(base.name, ''), 'Unnamed lead'),
    'stage', contact.pipeline_stage, 'attributedToAgent', coalesce(facts.attributed, false),
    'latestAppointmentStatus', facts.latest_status, 'changedAt', contact.stage_set_at,
    'dataLabel', 'Database truth'
  ) order by contact.stage_set_at desc, contact.contact_id), '[]'::jsonb)
  into pipeline
  from public.analytics_contacts contact
  join public.contacts base on base.id = contact.contact_id
  left join lateral (
    select appointment.status::text latest_status, appointment.attributed_to_agent attributed
    from public.analytics_appointments appointment
    where appointment.contact_id = contact.contact_id and appointment.status <> 'canceled'
    order by appointment.start_at desc, appointment.created_at desc limit 1
  ) facts on true
  where contact.tenant_id = p_expected_tenant
    and contact.created_at >= window_start and contact.created_at < window_end;

  metrics := jsonb_build_array(
    jsonb_build_object('metricKey','coach.new_leads','numerator',new_count,'denominator',new_count,'value',new_count,'state',cohort_state,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.active_leads','numerator',active_count,'denominator',new_count,'value',active_count,'state',cohort_state,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.qualified_leads','numerator',qualified_count,'denominator',new_count,'value',qualified_count,'state',cohort_state,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.disqualified_leads','numerator',disqualified_count,'denominator',new_count,'value',disqualified_count,'state',cohort_state,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.booked_contacts','numerator',booked_count,'denominator',new_count,'value',booked_count,'state',cohort_state,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.conversion_rate','numerator',booked_count,'denominator',new_count,'value',case when new_count=0 then null else booked_count*100.0/new_count end,'state',case when new_count=0 then 'still_filling' else cohort_state end,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.average_time_to_book','numerator',booked_count,'denominator',new_count,'value',average_seconds,'state',case when average_seconds is null then 'unavailable' else cohort_state end,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.pipeline_win_rate','numerator',booked_count,'denominator',terminal_count,'value',case when terminal_count=0 then null else booked_count*100.0/terminal_count end,'state',case when terminal_count=0 then 'still_filling' else cohort_state end,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.agent_win_rate','numerator',agent_booked_count,'denominator',terminal_count,'value',case when terminal_count=0 then null else agent_booked_count*100.0/terminal_count end,'state',case when terminal_count=0 then 'still_filling' else cohort_state end,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.show_rate','numerator',shown_count,'denominator',show_denominator,'value',case when show_denominator=0 then null else shown_count*100.0/show_denominator end,'state',case when show_denominator=0 then 'unavailable' else 'available' end,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.allowance_used','numerator',allowance_used,'denominator',allowance_limit,'value',allowance_used,'state',allowance_state,'windowStart',allowance_period_start,'windowEnd',allowance_period_end),
    jsonb_build_object('metricKey','coach.allowance_limit','numerator',allowance_limit,'denominator',allowance_limit,'value',allowance_limit,'state',allowance_state,'windowStart',allowance_period_start,'windowEnd',allowance_period_end),
    jsonb_build_object('metricKey','coach.funnel.entered','numerator',new_count,'denominator',new_count,'value',new_count,'state',cohort_state,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.funnel.qualified','numerator',qualified_count,'denominator',new_count,'value',qualified_count,'state',cohort_state,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.funnel.booked','numerator',booked_count,'denominator',new_count,'value',booked_count,'state',cohort_state,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.step.response_rate','numerator',answered_count,'denominator',asked_count,'value',case when asked_count=0 then null else least(answered_count,asked_count)*100.0/asked_count end,'state',case when asked_count=0 then 'unavailable' else cohort_state end,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.keyword.conversations','numerator',conversation_count,'denominator',conversation_count,'value',conversation_count,'state',cohort_state,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.keyword.qualified_rate','numerator',keyword_qualified,'denominator',conversation_count,'value',case when conversation_count=0 then null else keyword_qualified*100.0/conversation_count end,'state',case when conversation_count=0 then 'unavailable' else cohort_state end,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.keyword.response_rate','numerator',keyword_responded,'denominator',conversation_count,'value',case when conversation_count=0 then null else keyword_responded*100.0/conversation_count end,'state',case when conversation_count=0 then 'unavailable' else cohort_state end,'windowStart',window_start,'windowEnd',window_end),
    jsonb_build_object('metricKey','coach.keyword.booked_rate','numerator',keyword_booked,'denominator',conversation_count,'value',case when conversation_count=0 then null else keyword_booked*100.0/conversation_count end,'state',case when conversation_count=0 then 'unavailable' else cohort_state end,'windowStart',window_start,'windowEnd',window_end)
  );

  return jsonb_build_object(
    'tenantId', p_expected_tenant, 'window', p_window, 'timezone', tenant_row.timezone,
    'windowStart', window_start, 'windowEnd', window_end, 'metrics', metrics,
    'funnel', funnel, 'responses', responses, 'keywords', keywords, 'pipeline', pipeline,
    'allowance', jsonb_build_object(
      'used', allowance_used, 'limit', allowance_limit, 'periodStart', allowance_period_start,
      'periodEnd', allowance_period_end, 'state', allowance_state
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Challenger comparisons and auditable evaluation promotion
-- ---------------------------------------------------------------------------

create or replace function public.create_challenger_model_config(
  p_actor_id uuid,
  p_model text,
  p_params jsonb
)
returns table (model_config_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  verified_actor_id uuid;
  new_config_id uuid := gen_random_uuid();
  written_audit_id bigint;
begin
  verified_actor_id := app.phase6_verified_actor(p_actor_id, null, true, false);
  if nullif(btrim(coalesce(p_model, '')), '') is null
    or coalesce(jsonb_typeof(p_params), '') <> 'object' then
    raise exception 'EVAL_CHALLENGER_CONFIG_INVALID';
  end if;
  insert into public.model_configs (
    id, label, openrouter_model, params, is_default, active, role
  ) values (
    new_config_id, 'Challenger', btrim(p_model), p_params, false, false, 'generator'
  );
  written_audit_id := app.write_audit_row(
    'eval.model_config.created', verified_actor_id, null, 'model_config',
    new_config_id::text, null,
    jsonb_build_object('role', 'generator', 'active', false, 'model', btrim(p_model))
  );
  return query select new_config_id, written_audit_id;
end;
$$;

create or replace function public.start_eval_comparison(
  p_actor_id uuid,
  p_brain_draft_version_id uuid,
  p_content_hash text,
  p_model_config_a_id uuid,
  p_model_config_b_id uuid,
  p_case_set_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  verified_actor_id uuid;
  draft_row public.brain_draft_versions%rowtype;
  config_a public.model_configs%rowtype;
  config_b public.model_configs%rowtype;
  comparison_id uuid;
begin
  verified_actor_id := app.phase6_verified_actor(p_actor_id, null, true, false);
  if p_model_config_a_id is null or p_model_config_b_id is null
    or p_model_config_a_id = p_model_config_b_id then
    raise exception 'EVAL_COMPARISON_CONFIGS_MUST_DIFFER';
  end if;
  if p_case_set_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'EVAL_COMPARISON_CASE_SET_HASH_INVALID';
  end if;
  select * into draft_row from public.brain_draft_versions draft
  where draft.id = p_brain_draft_version_id for share;
  if draft_row.id is null then raise exception 'EVAL_COMPARISON_DRAFT_NOT_FOUND'; end if;
  if draft_row.content_hash <> p_content_hash then
    raise exception 'EVAL_COMPARISON_DRAFT_HASH_MISMATCH';
  end if;
  select * into config_a from public.model_configs config
  where config.id = p_model_config_a_id for share;
  select * into config_b from public.model_configs config
  where config.id = p_model_config_b_id for share;
  if config_a.id is null or config_b.id is null
    or config_a.role <> 'generator' or config_b.role <> 'generator' then
    raise exception 'EVAL_COMPARISON_GENERATOR_CONFIG_REQUIRED';
  end if;
  insert into public.eval_comparisons (
    created_by, brain_draft_version_id, content_hash,
    model_config_a_id, model_config_b_id, case_set_hash
  ) values (
    verified_actor_id, draft_row.id, draft_row.content_hash,
    config_a.id, config_b.id, p_case_set_hash
  ) returning id into comparison_id;
  return comparison_id;
end;
$$;

create or replace function public.finish_eval_comparison(
  p_comparison_id uuid,
  p_run_a_id uuid,
  p_run_b_id uuid,
  p_case_set_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  comparison_row public.eval_comparisons%rowtype;
  run_a public.eval_runs%rowtype;
  run_b public.eval_runs%rowtype;
  cases_a text[];
  cases_b text[];
begin
  perform app.assert_not_impersonating();
  if p_run_a_id is null or p_run_b_id is null or p_run_a_id = p_run_b_id then
    raise exception 'EVAL_COMPARISON_RUNS_MUST_DIFFER';
  end if;
  select * into comparison_row from public.eval_comparisons comparison
  where comparison.id = p_comparison_id for update;
  if comparison_row.id is null then raise exception 'EVAL_COMPARISON_NOT_FOUND'; end if;
  if comparison_row.status <> 'pending' then raise exception 'EVAL_COMPARISON_ALREADY_FINISHED'; end if;
  if p_case_set_hash is distinct from comparison_row.case_set_hash then
    raise exception 'EVAL_COMPARISON_CASE_SET_HASH_MISMATCH';
  end if;
  select * into run_a from public.eval_runs run where run.id = p_run_a_id for update;
  select * into run_b from public.eval_runs run where run.id = p_run_b_id for update;
  if run_a.id is null or run_b.id is null then raise exception 'EVAL_COMPARISON_RUN_NOT_FOUND'; end if;
  if run_a.comparison_id is not null or run_b.comparison_id is not null then
    raise exception 'EVAL_COMPARISON_RUN_ALREADY_ATTACHED';
  end if;
  if run_a.model_config_id <> comparison_row.model_config_a_id
    or run_b.model_config_id <> comparison_row.model_config_b_id then
    raise exception 'EVAL_COMPARISON_ARM_CONFIG_MISMATCH';
  end if;
  if run_a.brain_draft_version_id <> comparison_row.brain_draft_version_id
    or run_b.brain_draft_version_id <> comparison_row.brain_draft_version_id
    or run_a.content_hash <> comparison_row.content_hash
    or run_b.content_hash <> comparison_row.content_hash then
    raise exception 'EVAL_COMPARISON_DRAFT_MISMATCH';
  end if;
  if run_a.kind <> 'engine' or run_b.kind <> 'engine'
    or not run_a.suites_complete or not run_b.suites_complete
    or run_a.finished_at is null or run_b.finished_at is null then
    raise exception 'EVAL_COMPARISON_RUN_INCOMPLETE';
  end if;
  if run_a.brain_version is distinct from run_b.brain_version
    or run_a.offer_version is distinct from run_b.offer_version
    or run_a.rules_version is distinct from run_b.rules_version
    or run_a.knowledge_mode is distinct from run_b.knowledge_mode
    or run_a.corpus_revision is distinct from run_b.corpus_revision
    or run_a.tenant_id is distinct from run_b.tenant_id
    or run_a.source is distinct from run_b.source then
    raise exception 'EVAL_COMPARISON_RUN_CONTEXT_MISMATCH';
  end if;
  select array_agg(result.suite || ':' || coalesce(result.case_key, result.case_id::text)
    order by result.suite, coalesce(result.case_key, result.case_id::text))
  into cases_a from public.eval_case_results result where result.run_id = run_a.id;
  select array_agg(result.suite || ':' || coalesce(result.case_key, result.case_id::text)
    order by result.suite, coalesce(result.case_key, result.case_id::text))
  into cases_b from public.eval_case_results result where result.run_id = run_b.id;
  if cases_a is null or cases_a is distinct from cases_b then
    raise exception 'EVAL_COMPARISON_CASE_SET_MISMATCH';
  end if;
  update public.eval_runs set comparison_id = comparison_row.id,
    comparison_arm = 'a', case_set_hash = p_case_set_hash where id = run_a.id;
  update public.eval_runs set comparison_id = comparison_row.id,
    comparison_arm = 'b', case_set_hash = p_case_set_hash where id = run_b.id;
  update public.eval_comparisons set status = 'completed', run_a_id = run_a.id,
    run_b_id = run_b.id, finished_at = now() where id = comparison_row.id;
  return comparison_row.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Segregated test-agent persistence
-- ---------------------------------------------------------------------------

create or replace function app.phase7_verified_test_actor(
  p_actor_id uuid,
  p_expected_tenant uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_row public.users%rowtype;
begin
  if p_actor_id is null then raise exception 'PHASE7_TEST_ACTOR_REQUIRED'; end if;
  select * into actor_row from public.users actor where actor.id = p_actor_id;
  if actor_row.id is null then raise exception 'PHASE7_TEST_ACTOR_REQUIRED'; end if;
  if actor_row.role in ('coach','coach_member') then
    if actor_row.tenant_id is distinct from p_expected_tenant then
      raise exception 'PHASE7_TEST_ACTOR_TENANT_MISMATCH';
    end if;
  elsif actor_row.role not in ('owner','admin','success') then
    raise exception 'PHASE7_TEST_ACTOR_ROLE_REQUIRED';
  end if;
  return actor_row.id;
end;
$$;

create or replace function public.create_test_agent_session(
  p_expected_tenant uuid,
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  verified_actor_id uuid;
  session_id uuid;
begin
  verified_actor_id := app.phase7_verified_test_actor(p_actor_id, p_expected_tenant);
  if not exists (select 1 from public.tenants tenant where tenant.id = p_expected_tenant) then
    raise exception 'PHASE7_TEST_TENANT_NOT_FOUND';
  end if;
  insert into public.test_agent_sessions (tenant_id, started_by)
  values (p_expected_tenant, verified_actor_id) returning id into session_id;
  return session_id;
end;
$$;

create or replace function public.persist_test_agent_turn(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_session_id uuid,
  p_lead_body text,
  p_agent_body text,
  p_trace jsonb,
  p_resolved_driver_arm text,
  p_answered_step_key text,
  p_asked_step_key text
)
returns table (
  contact_id uuid,
  conversation_id uuid,
  lead_message_id uuid,
  agent_message_id uuid,
  resolved_driver_arm text,
  contact_is_test boolean,
  conversation_is_test boolean,
  lead_is_test boolean,
  agent_is_test boolean,
  trace_is_test boolean,
  step_rows_is_test boolean,
  appointment_rows bigint,
  billable_rows bigint,
  followup_rows bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.test_agent_sessions%rowtype;
  trace_test boolean;
  step_test boolean;
  new_contact_id uuid;
  new_conversation_id uuid;
  new_lead_message_id uuid;
  new_agent_message_id uuid;
begin
  perform app.phase7_verified_test_actor(p_actor_id, p_expected_tenant);
  select * into session_row from public.test_agent_sessions session
  where session.id = p_session_id for update;
  if session_row.id is null then raise exception 'PHASE7_TEST_SESSION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, session_row.tenant_id, 'test_agent_session');
  if session_row.closed_at is not null then raise exception 'PHASE7_TEST_SESSION_CLOSED'; end if;
  if nullif(btrim(coalesce(p_lead_body,'')), '') is null
    or nullif(btrim(coalesce(p_agent_body,'')), '') is null then
    raise exception 'PHASE7_TEST_TURN_BODY_REQUIRED';
  end if;
  if p_resolved_driver_arm not in ('mock','real') then
    raise exception 'PHASE7_TEST_DRIVER_ARM_INVALID';
  end if;
  if coalesce(jsonb_typeof(p_trace),'') <> 'object' then
    raise exception 'PHASE7_TEST_TRACE_REQUIRED';
  end if;

  select contact.id into new_contact_id from public.contacts contact
  where contact.test_session_id = p_session_id for update;
  if new_contact_id is null then
    insert into public.contacts (
      tenant_id, last_channel, name, test_session_id
    ) values (
      p_expected_tenant, 'webchat', 'Test lead', p_session_id
    ) returning id into new_contact_id;
  end if;
  select conversation.id into new_conversation_id from public.conversations conversation
  where conversation.contact_id = new_contact_id order by conversation.created_at limit 1 for update;
  if new_conversation_id is null then
    insert into public.conversations (tenant_id, contact_id, channel, status)
    values (p_expected_tenant, new_contact_id, 'webchat', 'agent')
    returning id into new_conversation_id;
  end if;
  insert into public.messages (tenant_id, conversation_id, direction, author, body, provider)
  values (p_expected_tenant, new_conversation_id, 'in', 'lead', p_lead_body, 'test_agent')
  returning id into new_lead_message_id;
  insert into public.messages (tenant_id, conversation_id, direction, author, body, provider)
  values (p_expected_tenant, new_conversation_id, 'out', 'agent', p_agent_body, 'test_agent')
  returning id into new_agent_message_id;
  insert into public.message_traces (message_id, tenant_id, trace, model, params)
  values (new_agent_message_id, p_expected_tenant,
    p_trace || jsonb_build_object('driverArm', p_resolved_driver_arm),
    p_trace ->> 'model', coalesce(p_trace -> 'params','{}'::jsonb));
  perform * from public.record_conversation_step_events(
    p_expected_tenant, new_conversation_id, new_lead_message_id, new_agent_message_id,
    p_answered_step_key, p_asked_step_key
  );

  select contact.is_test, conversation.is_test, lead.is_test, agent.is_test
  into contact_is_test, conversation_is_test, lead_is_test, agent_is_test
  from public.contacts contact
  join public.conversations conversation on conversation.id = new_conversation_id
  join public.messages lead on lead.id = new_lead_message_id
  join public.messages agent on agent.id = new_agent_message_id
  where contact.id = new_contact_id;
  trace_test := agent_is_test;
  select coalesce(bool_and(event.is_test), true) into step_test
  from public.conversation_step_events event
  where event.message_id in (new_lead_message_id, new_agent_message_id);
  trace_is_test := trace_test;
  step_rows_is_test := step_test;
  select count(*) into appointment_rows from public.appointments appointment
    where appointment.contact_id = new_contact_id;
  select count(*) into billable_rows from public.billable_events event
    join public.appointments appointment on appointment.id = event.appointment_id
    where appointment.contact_id = new_contact_id;
  select count(*) into followup_rows from public.followups followup
    where followup.conversation_id = new_conversation_id;
  contact_id := new_contact_id;
  conversation_id := new_conversation_id;
  lead_message_id := new_lead_message_id;
  agent_message_id := new_agent_message_id;
  resolved_driver_arm := p_resolved_driver_arm;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Source-locked, redaction-confirmed eval promotion
-- ---------------------------------------------------------------------------

create or replace function public.promote_eval_case(
  p_actor_id uuid,
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_message_id uuid,
  p_contact_id uuid,
  p_redacted_turns jsonb,
  p_expectation jsonb,
  p_suite text,
  p_redaction_manifest jsonb,
  p_source_hash text,
  p_confirmed_redacted_hash text,
  p_notes text
)
returns table (eval_case_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  verified_actor_id uuid;
  conversation_row public.conversations%rowtype;
  message_row public.messages%rowtype;
  contact_row public.contacts%rowtype;
  new_case_id uuid := gen_random_uuid();
  written_audit_id bigint;
  category_value text;
  rendered_redacted text;
begin
  verified_actor_id := app.phase6_verified_actor(p_actor_id, null, true, false);
  if p_suite not in ('qualification_accuracy','voice_tone') then
    raise exception 'EVAL_PROMOTION_SUITE_INVALID';
  end if;
  category_value := case p_suite when 'qualification_accuracy' then 'qualification' else 'voice' end;
  if jsonb_typeof(p_redacted_turns) <> 'array' or jsonb_array_length(p_redacted_turns)=0
    or jsonb_typeof(p_expectation) <> 'object'
    or jsonb_typeof(p_redaction_manifest) <> 'object' then
    raise exception 'EVAL_PROMOTION_PAYLOAD_INVALID';
  end if;
  select * into conversation_row from public.conversations conversation
    where conversation.id=p_conversation_id for share;
  select * into message_row from public.messages message where message.id=p_message_id for share;
  select * into contact_row from public.contacts contact where contact.id=p_contact_id for share;
  if conversation_row.id is null or message_row.id is null or contact_row.id is null then
    raise exception 'EVAL_PROMOTION_SOURCE_NOT_FOUND';
  end if;
  if conversation_row.tenant_id<>p_expected_tenant or contact_row.tenant_id<>p_expected_tenant
    or message_row.tenant_id<>p_expected_tenant
    or conversation_row.contact_id<>contact_row.id
    or message_row.conversation_id<>conversation_row.id then
    raise exception 'EVAL_PROMOTION_TENANT_MISMATCH';
  end if;
  if p_source_hash !~ '^[0-9a-f]{64}$'
    or p_source_hash <> app.phase2_json_hash(to_jsonb(message_row.body)) then
    raise exception 'EVAL_PROMOTION_SOURCE_HASH_MISMATCH';
  end if;
  if p_confirmed_redacted_hash !~ '^[0-9a-f]{64}$'
    or p_confirmed_redacted_hash <> app.phase2_json_hash(p_redacted_turns) then
    raise exception 'EVAL_PROMOTION_REDACTED_HASH_MISMATCH';
  end if;
  rendered_redacted := p_redacted_turns::text;
  if rendered_redacted ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
    or rendered_redacted ~* 'https?://[^[:space:]"}]+'
    or rendered_redacted ~ '([+][0-9][0-9 ()-]{7,}|[0-9]{3}[-. ()][0-9]{3}[-. ][0-9]{4})' then
    raise exception 'EVAL_PROMOTION_RESIDUAL_PII';
  end if;
  written_audit_id := app.write_audit_row(
    'eval.case.promoted', verified_actor_id, null, 'eval_case', new_case_id::text,
    null, jsonb_build_object('source_tenant_id',p_expected_tenant,
      'source_conversation_id',conversation_row.id,'source_message_id',message_row.id,
      'suite',p_suite,'source_hash',p_source_hash,
      'confirmed_redacted_hash',p_confirmed_redacted_hash)
  );
  insert into public.eval_cases (
    id, category, notes, active, created_by, turns, expectation, suite, kind,
    source_tenant_id, source_conversation_id, source_message_id, source_contact_id,
    promoted_by, source_hash, confirmed_redacted_hash, redaction_manifest,
    promotion_audit_id
  ) values (
    new_case_id, category_value, p_notes, true, verified_actor_id,
    p_redacted_turns, p_expectation, p_suite, 'engine', p_expected_tenant,
    conversation_row.id, message_row.id, contact_row.id, verified_actor_id,
    p_source_hash, p_confirmed_redacted_hash, p_redaction_manifest, written_audit_id
  );
  return query select new_case_id, written_audit_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Service-only execution boundary
-- ---------------------------------------------------------------------------

revoke execute on function app.phase7_session_actor(uuid,boolean),
  app.phase7_verified_test_actor(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.record_conversation_step_events(uuid,uuid,uuid,uuid,text,text),
  public.read_coach_measurement(uuid,text,date,date,timestamptz),
  public.read_platform_measurement(timestamptz),
  public.create_challenger_model_config(uuid,text,jsonb),
  public.start_eval_comparison(uuid,uuid,text,uuid,uuid,text),
  public.finish_eval_comparison(uuid,uuid,uuid,text),
  public.create_test_agent_session(uuid,uuid),
  public.persist_test_agent_turn(uuid,uuid,uuid,text,text,jsonb,text,text,text),
  public.promote_eval_case(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,jsonb,text,text,text)
from public, anon, authenticated;
grant execute on function public.record_conversation_step_events(uuid,uuid,uuid,uuid,text,text),
  public.read_coach_measurement(uuid,text,date,date,timestamptz),
  public.read_platform_measurement(timestamptz),
  public.create_challenger_model_config(uuid,text,jsonb),
  public.start_eval_comparison(uuid,uuid,text,uuid,uuid,text),
  public.finish_eval_comparison(uuid,uuid,uuid,text),
  public.create_test_agent_session(uuid,uuid),
  public.persist_test_agent_turn(uuid,uuid,uuid,text,text,jsonb,text,text,text),
  public.promote_eval_case(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,jsonb,text,text,text)
to service_role;

comment on table public.conversation_step_events is
  'Append-only asked/answered evidence. Test inheritance and demo exclusion are mandatory.';
comment on table public.test_agent_sessions is
  'Test-only root. contacts.test_session_id is the sole link into ordinary conversation storage.';
comment on table public.eval_comparisons is
  'Immutable comparison request until one guarded atomic finalization attaches two equivalent eval runs.';
comment on function public.read_platform_measurement(timestamptz) is
  'Platform snapshot sourced only from local exclusion views and complete Phase 6 money evidence; never queries Stripe.';
