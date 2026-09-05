-- A provisioning step whose completion precedes its start is bad evidence, not a negative clearing
-- time. The per-step median used to include such rows, the reader rejected the negative figure,
-- and the whole platform Overview failed to load over four inverted demo rows. Inverted intervals
-- are now left out of that median; the rest of the function is the live definition, unchanged.

CREATE OR REPLACE FUNCTION app.phase7_platform_measurement_base(p_as_of timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
        filter(where completed_at is not null and started_at is not null and completed_at >= started_at) median_days
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
$function$

;
