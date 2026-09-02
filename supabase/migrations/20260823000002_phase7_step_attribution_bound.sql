-- SetterFi Phase 7 reply-attribution repair.
--
-- Raw step evidence remains append-only, while analytics assigns each reply to the latest prior
-- same-conversation touch only until the earlier of seven days or the next same-channel touch.
-- Both coach and platform readers continue to traverse the demo/test exclusion views.

set search_path = public, extensions;

-- A stored answered key records the engine's turn fact. Reporting owns temporal attribution, so
-- a later asked touch supersedes that raw key without mutating the append-only evidence row.
create or replace view public.analytics_conversation_step_events
with (security_invoker = true)
as
select event.id as event_id, event.tenant_id, event.conversation_id, event.contact_id,
  event.message_id, event.step_key, event.event_kind, event.occurred_at
from public.conversation_step_events event
join public.tenants tenant on tenant.id = event.tenant_id
where event.event_kind = 'asked' and not event.is_test and not tenant.is_demo
union all
select answer.id as event_id, answer.tenant_id, answer.conversation_id, answer.contact_id,
  answer.message_id, owner.step_key, answer.event_kind, answer.occurred_at
from public.conversation_step_events answer
join public.tenants tenant on tenant.id = answer.tenant_id
join lateral (
  select asked.step_key
  from public.conversation_step_events asked
  where asked.conversation_id = answer.conversation_id
    and asked.event_kind = 'asked'
    and asked.occurred_at < answer.occurred_at
    and answer.occurred_at < asked.occurred_at + interval '7 days'
  order by asked.occurred_at desc, asked.id desc
  limit 1
) owner on true
where answer.event_kind = 'answered' and not answer.is_test and not tenant.is_demo;

-- One projection supplies both the headline reply rate and the per-touch breakdown. Its disjoint
-- intervals make one inbound message eligible for at most one sent touch on a conversation/channel.
create view public.analytics_followup_reply_attribution
with (security_invoker = true)
as
with sent as (
  select followup.followup_id, followup.tenant_id, followup.conversation_id,
    followup.touch_no, followup.sent_at, followup.created_at,
    coalesce(identity.channel, conversation.channel) as sent_channel
  from public.analytics_followups followup
  join public.analytics_conversations conversation
    on conversation.conversation_id = followup.conversation_id
  left join public.analytics_contact_identities identity
    on identity.identity_id = followup.resolved_identity_id
    and identity.tenant_id = followup.tenant_id
    and identity.contact_id = conversation.contact_id
  where followup.status = 'sent' and followup.sent_at is not null
), bounded as (
  select sent.*,
    lead(sent.sent_at) over (
      partition by sent.conversation_id, sent.sent_channel
      order by sent.sent_at, sent.followup_id
    ) as next_sent_at
  from sent
)
select bounded.followup_id, bounded.tenant_id, bounded.conversation_id,
  bounded.touch_no, bounded.sent_channel, bounded.sent_at, bounded.next_sent_at,
  bounded.created_at, reply.message_id as attributed_reply_message_id,
  reply.created_at as attributed_reply_at
from bounded
left join lateral (
  select message.message_id, message.created_at
  from public.analytics_messages message
  join public.analytics_conversations reply_conversation
    on reply_conversation.conversation_id = message.conversation_id
    and reply_conversation.channel = bounded.sent_channel
  where message.conversation_id = bounded.conversation_id
    and message.direction = 'in'
    and message.created_at > bounded.sent_at
    and message.created_at < least(
      bounded.sent_at + interval '7 days',
      coalesce(bounded.next_sent_at, 'infinity'::timestamptz)
    )
  order by message.created_at, message.message_id
  limit 1
) reply on true;

revoke all on public.analytics_followup_reply_attribution
from anon, authenticated, service_role;
grant select on public.analytics_followup_reply_attribution to authenticated, service_role;

-- Preserve the already-shipped platform snapshot implementation as an inaccessible base, then
-- replace only the two reply-attribution outputs through the bounded exclusion-view projection.
alter function public.read_platform_measurement(timestamptz) set schema app;
alter function app.read_platform_measurement(timestamptz)
  rename to phase7_platform_measurement_base;
revoke execute on function app.phase7_platform_measurement_base(timestamptz)
from public, anon, authenticated, service_role;

create function public.read_platform_measurement(p_as_of timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  as_of_value timestamptz := coalesce(p_as_of, now());
  window_start timestamptz := as_of_value - interval '30 days';
  snapshot jsonb;
  bounded_metrics jsonb;
  bounded_followup_performance jsonb;
  replies_by_touch jsonb;
  followup_sent bigint;
  followup_replied bigint;
begin
  snapshot := app.phase7_platform_measurement_base(as_of_value);

  select count(*)::bigint,
    count(*) filter (
      where attribution.attributed_reply_at is not null
        and attribution.attributed_reply_at <= as_of_value
    )::bigint
  into followup_sent, followup_replied
  from public.analytics_followup_reply_attribution attribution
  where attribution.sent_at >= window_start and attribution.sent_at < as_of_value;

  select coalesce(jsonb_agg(
    case when metric_row.metric ->> 'metricKey' = 'platform.followup_reply_rate' then
      metric_row.metric || jsonb_build_object(
        'numerator', followup_replied,
        'denominator', followup_sent,
        'value', case when followup_sent = 0 then null
          else followup_replied * 100.0 / followup_sent end,
        'state', case when followup_sent = 0 then 'unavailable' else 'available' end
      )
    else metric_row.metric end
    order by metric_row.ordinality
  ), '[]'::jsonb)
  into bounded_metrics
  from jsonb_array_elements(snapshot -> 'metrics') with ordinality
    as metric_row(metric, ordinality);

  select coalesce(jsonb_object_agg(reply_count.touch_no::text, reply_count.replied), '{}'::jsonb)
  into replies_by_touch
  from (
    select followup.touch_no,
      count(*) filter (
        where attribution.attributed_reply_at is not null
          and attribution.attributed_reply_at <= as_of_value
      )::bigint as replied
    from public.analytics_followups followup
    left join public.analytics_followup_reply_attribution attribution
      on attribution.followup_id = followup.followup_id
    where followup.created_at >= window_start and followup.created_at < as_of_value
    group by followup.touch_no
  ) reply_count;

  select coalesce(jsonb_agg(
    touch_row.value || jsonb_build_object(
      'replied', coalesce((replies_by_touch ->> (touch_row.value ->> 'touchNo'))::bigint, 0)
    ) order by touch_row.ordinality
  ), '[]'::jsonb)
  into bounded_followup_performance
  from jsonb_array_elements(snapshot -> 'followupPerformance') with ordinality
    as touch_row(value, ordinality);

  return jsonb_set(
    jsonb_set(snapshot, '{metrics}', bounded_metrics, false),
    '{followupPerformance}', bounded_followup_performance, false
  );
end;
$$;

revoke execute on function public.read_platform_measurement(timestamptz)
from public, anon, authenticated;
grant execute on function public.read_platform_measurement(timestamptz) to service_role;

comment on view public.analytics_followup_reply_attribution is
  'One reply owner per same-conversation/channel sent touch, bounded before seven days or the next sent touch.';
comment on function public.read_platform_measurement(timestamptz) is
  'Platform snapshot with reply attribution sourced from the bounded demo/test exclusion projection.';
