-- Round 3 backend gap (docs/plans/2026-09-04-coach-backend-gaps.md, "Round 3 intake"): the coach
-- Home keyword table's denominator is every conversation in the window, grouped by first-touch
-- keyword with the "No keyword" row last -- matching docs/PRODUCT.md's measurement section -- not
-- only the conversations attributed to an active keyword goal.
--
-- app.phase13_keyword_measurement (20261007000001_keyword_goals_capi.sql,
-- 20261012000007_keyword_sender_count.sql) is scoped to keyword-goal-attributed conversations only
-- and carries no "No keyword" row. That scoping is correct for its own CAPI dataset use and is left
-- unchanged here. The defect is in public.read_coach_measurement, which unconditionally overwrote
-- its `keywords` output with that scoped result. This migration replaces read_coach_measurement so
-- `keywords` covers the whole population instead: every first-touch keyword in the window, "No
-- keyword" last, with the phase 13 CAPI-attributed figures and senderCount kept for rows that have
-- an active keyword goal, and senderCount populated on every row.
--
-- read_coach_measurement_pre_phase13 already groups the whole population by first-touch keyword in
-- exactly this shape, but it does not carry senderCount, so that grouping is reproduced here rather
-- than re-emitting the ~250-line function to add one field to it (the same tradeoff the original
-- migration's own comment records for why it split the function in the first place).

set search_path = public, extensions;

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
  snapshot jsonb;
  keyword_snapshot jsonb;
  keyword_metrics jsonb;
  whole_population_keywords jsonb;
  keyword_conversation_total bigint;
  window_start timestamptz;
  window_end timestamptz;
  opt_ins bigint;
  qualified bigint;
  responded bigint;
  booked bigint;
begin
  snapshot := public.read_coach_measurement_pre_phase13(
    p_expected_tenant, p_window, p_custom_from, p_custom_to, p_as_of
  );
  window_start := (snapshot ->> 'windowStart')::timestamptz;
  window_end := (snapshot ->> 'windowEnd')::timestamptz;

  keyword_snapshot := app.phase13_keyword_measurement(
    p_expected_tenant, window_start, window_end
  );
  opt_ins := (keyword_snapshot ->> 'conversations')::bigint;
  qualified := (keyword_snapshot ->> 'qualified')::bigint;
  responded := (keyword_snapshot ->> 'responded')::bigint;
  booked := (keyword_snapshot ->> 'booked')::bigint;

  -- The coach.keyword.* metric tiles stay scoped to keyword-goal-attributed conversations, as
  -- before; only the per-row `keywords` table below changes scope. Not part of this round's ruling.
  select jsonb_agg(case metric ->> 'metricKey'
    when 'coach.keyword.conversations' then metric || jsonb_build_object(
      'numerator', opt_ins, 'denominator', opt_ins, 'value', opt_ins
    )
    when 'coach.keyword.qualified_rate' then metric || jsonb_build_object(
      'numerator', qualified, 'denominator', opt_ins,
      'value', case when opt_ins = 0 then null else qualified * 100.0 / opt_ins end,
      'state', case when opt_ins = 0 then 'unavailable' else metric ->> 'state' end
    )
    when 'coach.keyword.response_rate' then metric || jsonb_build_object(
      'numerator', responded, 'denominator', opt_ins,
      'value', case when opt_ins = 0 then null else responded * 100.0 / opt_ins end,
      'state', case when opt_ins = 0 then 'unavailable' else metric ->> 'state' end
    )
    when 'coach.keyword.booked_rate' then metric || jsonb_build_object(
      'numerator', booked, 'denominator', opt_ins,
      'value', case when opt_ins = 0 then null else booked * 100.0 / opt_ins end,
      'state', case when opt_ins = 0 then 'unavailable' else metric ->> 'state' end
    ) else metric end)
  into keyword_metrics from jsonb_array_elements(snapshot -> 'metrics') metric;

  with population as (
    select coalesce(nullif(btrim(conversation.first_touch_keyword), ''), 'No keyword') keyword,
      count(*)::bigint conversations,
      count(distinct conversation.contact_id)::bigint sender_count,
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
  ), goal_rows as (
    select row ->> 'keyword' keyword,
      (row ->> 'senderCount')::bigint sender_count,
      (row ->> 'qualifiedContacts')::bigint qualified_contacts,
      (row ->> 'respondedConversations')::bigint responded_conversations,
      (row ->> 'bookedContacts')::bigint booked_contacts
    from jsonb_array_elements(keyword_snapshot -> 'keywords') row
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'keyword', population.keyword,
    'conversations', population.conversations,
    'senderCount', coalesce(goal_rows.sender_count, population.sender_count),
    'qualifiedContacts', coalesce(goal_rows.qualified_contacts, population.qualified_contacts),
    'respondedConversations',
      coalesce(goal_rows.responded_conversations, population.responded_conversations),
    'bookedContacts', coalesce(goal_rows.booked_contacts, population.booked_contacts),
    'dataLabel', 'Database truth'
  ) order by case when population.keyword = 'No keyword' then 1 else 0 end, population.keyword),
  '[]'::jsonb)
  into whole_population_keywords
  from population left join goal_rows on goal_rows.keyword = population.keyword;

  -- The `keywords` table now covers the whole population, so it can no longer be checked for
  -- conservation against the still goal-scoped `coach.keyword.conversations` metric tile above.
  -- This total is the independent, honest cross-check the repository validates the row sum
  -- against instead (src/lib/repositories/analytics.ts).
  select coalesce(sum((row ->> 'conversations')::bigint), 0)
  into keyword_conversation_total
  from jsonb_array_elements(whole_population_keywords) row;

  return snapshot || jsonb_build_object(
    'keywords', whole_population_keywords,
    'metrics', keyword_metrics,
    'keywordConversationTotal', keyword_conversation_total
  );
end;
$$;
