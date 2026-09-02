-- The coach funnel's three steps did not nest, so the two figures it exists to divide could not be
-- divided.
--
-- `read_coach_measurement_pre_phase13` assembles Entered, Qualified and Booked as a funnel at the
-- bottom, but the two lower counts were drawn from different populations. Qualified counted
-- contacts whose pipeline stage is booked or qualified_no_buy, or whose outcome is BOOK. Booked
-- counted contacts carrying any appointment that is not canceled. Neither is a subset of the other,
-- so a contact with a booking still sitting in `qualifying` with a null outcome landed in Booked
-- and not in Qualified, and the panel printed more leads at Booked than at Ready to book. A
-- conversion rate between two such steps means nothing, and nothing caught it:
-- `src/lib/repositories/analytics.ts` rejects only completedContacts greater than enteredContacts,
-- and enteredContacts is the same new-lead count on all three rows.
--
-- Booking a call is the strongest evidence a lead was ready to book, so a contact with a live
-- appointment now counts at the Qualified step as well. That makes Booked a subset of Qualified by
-- construction rather than by hope, and it is the same fact the Booked step already reads, so the
-- two rows can only agree.
--
-- `coach.qualified_leads` and `coach.funnel.qualified` read the same count and move with it, which
-- is intended: a coach whose lead booked a call has a qualified lead whatever their pipeline column
-- happens to say.

set search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.read_coach_measurement_pre_phase13(p_expected_tenant uuid, p_window text, p_custom_from date, p_custom_to date, p_as_of timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    count(*) filter (where cohort.pipeline_stage in ('booked', 'qualified_no_buy')
      or cohort.outcome = 'BOOK' or appointment_facts.has_booking)::bigint,
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
$function$
;
