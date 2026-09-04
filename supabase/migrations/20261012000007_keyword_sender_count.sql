-- Round-2 backend gap: the Home keyword table needs to suppress a row's rates when the sample is
-- thin (fewer than ten senders), and the repository had no distinct-sender count to gate on --
-- only `conversations`, a row count that can over-count a single lead who opened more than one
-- conversation under the same keyword. `read_coach_measurement`'s keyword array is actually
-- produced by `app.phase13_keyword_measurement` (its result unconditionally overwrites the
-- `keywords` key `read_coach_measurement` builds from `read_coach_measurement_pre_phase13` --
-- see that function body, 20261007000001_keyword_goals_capi.sql:1053-1057), so this is the
-- function that has to carry the new field for it to reach the coach dashboard.
--
-- (Note for the team: this overwrite also means the keyword table actually rendered today is
-- scoped to keyword-goal-attributed conversations only and carries no "No keyword" row, which
-- disagrees with the round-1 gap audit's claim that `read_coach_measurement`'s own grouping
-- already emits that row. That claim is true of `read_coach_measurement_pre_phase13` in
-- isolation, but not of what the wrapper actually returns. Flagged in the round-2 gaps doc as a
-- separate finding; not fixed here since it needs a product decision on the keyword table's
-- intended scope, and this migration only adds the sender count the suppression rule needs.)

set search_path = public, extensions;

create or replace function app.phase13_keyword_measurement(
  p_expected_tenant uuid,
  p_window_start timestamptz,
  p_window_end timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with attributed as (
    select analytics.conversation_id, analytics.created_at, analytics.contact_id,
      btrim(conversation.first_touch_keyword) keyword
    from public.analytics_conversations analytics
    join public.conversations conversation on conversation.id = analytics.conversation_id
    join public.keyword_goals goal on goal.id = conversation.keyword_goal_id
      and goal.tenant_id = conversation.tenant_id
    join public.tenants tenant on tenant.id = conversation.tenant_id
    where analytics.tenant_id = p_expected_tenant
      and analytics.created_at >= p_window_start and analytics.created_at < p_window_end
      and not conversation.is_test and not tenant.is_demo
      and nullif(btrim(conversation.first_touch_keyword), '') is not null
  ), grouped as (
    select attributed.keyword,
      count(*)::bigint conversations,
      count(distinct attributed.contact_id)::bigint sender_count,
      count(*) filter (where exists (
        select 1 from public.capi_events event
        where event.conversation_id = attributed.conversation_id
          and event.tenant_id = p_expected_tenant
          and event.event_name = 'QualifiedLead'
          and not event.is_test and not event.is_demo
      ))::bigint qualified_contacts,
      count(*) filter (where exists (
        select 1 from public.analytics_messages message
        where message.conversation_id = attributed.conversation_id
          and message.direction = 'in' and message.created_at > attributed.created_at
      ))::bigint responded_conversations,
      count(*) filter (where exists (
        select 1 from public.capi_events event
        where event.conversation_id = attributed.conversation_id
          and event.tenant_id = p_expected_tenant
          and event.event_name = 'Purchase'
          and not event.is_test and not event.is_demo
      ))::bigint booked_contacts
    from attributed group by attributed.keyword
  ), totals as (
    select coalesce(sum(conversations), 0)::bigint conversations,
      coalesce(sum(qualified_contacts), 0)::bigint qualified,
      coalesce(sum(responded_conversations), 0)::bigint responded,
      coalesce(sum(booked_contacts), 0)::bigint booked
    from grouped
  )
  select jsonb_build_object(
    'keywords', coalesce((
      select jsonb_agg(jsonb_build_object(
        'keyword', grouped.keyword,
        'conversations', grouped.conversations,
        'senderCount', grouped.sender_count,
        'qualifiedContacts', grouped.qualified_contacts,
        'respondedConversations', grouped.responded_conversations,
        'bookedContacts', grouped.booked_contacts,
        'dataLabel', 'Database truth'
      ) order by grouped.keyword) from grouped
    ), '[]'::jsonb),
    'conversations', totals.conversations,
    'qualified', totals.qualified,
    'responded', totals.responded,
    'booked', totals.booked
  ) from totals;
$$;
