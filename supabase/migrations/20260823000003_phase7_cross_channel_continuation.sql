-- SetterFi Phase 7 cross-channel continuation repair.
--
-- A resolved identity makes a sent touch eligible, but continuation requires an inbound message
-- on another persisted conversation channel. The reply window reuses the disjoint touch bounds
-- from the prior attribution repair so identity discovery and superseded touches cannot score.

set search_path = public, extensions;

create view public.analytics_cross_channel_continuation_attribution
with (security_invoker = true)
as
select attribution.followup_id, attribution.tenant_id, attribution.conversation_id,
  attribution.touch_no, attribution.sent_channel, attribution.sent_at,
  attribution.next_sent_at, attribution.created_at,
  reply.message_id as attributed_reply_message_id,
  reply.created_at as attributed_reply_at,
  reply.channel as attributed_reply_channel
from public.analytics_followup_reply_attribution attribution
join public.analytics_followups followup
  on followup.followup_id = attribution.followup_id
join public.analytics_conversations conversation
  on conversation.conversation_id = attribution.conversation_id
  and conversation.tenant_id = attribution.tenant_id
left join lateral (
  select message.message_id, message.created_at, reply_conversation.channel
  from public.analytics_messages message
  join public.analytics_conversations reply_conversation
    on reply_conversation.conversation_id = message.conversation_id
    and reply_conversation.tenant_id = attribution.tenant_id
    and reply_conversation.contact_id = conversation.contact_id
    and reply_conversation.channel <> attribution.sent_channel
  where message.tenant_id = attribution.tenant_id
    and message.direction = 'in'
    and message.created_at > attribution.sent_at
    and message.created_at < least(
      attribution.sent_at + interval '7 days',
      coalesce(attribution.next_sent_at, 'infinity'::timestamptz)
    )
  order by message.created_at, message.message_id
  limit 1
) reply on true
where followup.resolved_identity_id is not null;

revoke all on public.analytics_cross_channel_continuation_attribution
from anon, authenticated, service_role;
grant select on public.analytics_cross_channel_continuation_attribution
to authenticated, service_role;

-- Keep the public payload stable while replacing both visible cross-channel outputs and retaining
-- the reply repair. The original Phase 7 snapshot body remains isolated in the inaccessible base.
create or replace function public.read_platform_measurement(p_as_of timestamptz)
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
  continuations_by_touch jsonb;
  followup_sent bigint;
  followup_replied bigint;
  continuation_sent bigint;
  continuation_replied bigint;
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

  select count(*)::bigint,
    count(*) filter (
      where attribution.attributed_reply_at is not null
        and attribution.attributed_reply_at <= as_of_value
    )::bigint
  into continuation_sent, continuation_replied
  from public.analytics_cross_channel_continuation_attribution attribution
  where attribution.sent_at >= window_start and attribution.sent_at < as_of_value;

  select coalesce(jsonb_agg(
    case
      when metric_row.metric ->> 'metricKey' = 'platform.followup_reply_rate' then
        metric_row.metric || jsonb_build_object(
          'numerator', followup_replied,
          'denominator', followup_sent,
          'value', case when followup_sent = 0 then null
            else followup_replied * 100.0 / followup_sent end,
          'state', case when followup_sent = 0 then 'unavailable' else 'available' end
        )
      when metric_row.metric ->> 'metricKey' = 'platform.cross_channel_continuation_rate' then
        metric_row.metric || jsonb_build_object(
          'numerator', continuation_replied,
          'denominator', continuation_sent,
          'value', case when continuation_sent = 0 then null
            else continuation_replied * 100.0 / continuation_sent end,
          'state', case when continuation_sent = 0 then 'unavailable' else 'available' end
        )
      else metric_row.metric
    end
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

  select coalesce(jsonb_object_agg(
    continuation_count.touch_no::text, continuation_count.replied
  ), '{}'::jsonb)
  into continuations_by_touch
  from (
    select followup.touch_no,
      count(*) filter (
        where attribution.attributed_reply_at is not null
          and attribution.attributed_reply_at <= as_of_value
      )::bigint as replied
    from public.analytics_followups followup
    left join public.analytics_cross_channel_continuation_attribution attribution
      on attribution.followup_id = followup.followup_id
    where followup.created_at >= window_start and followup.created_at < as_of_value
    group by followup.touch_no
  ) continuation_count;

  select coalesce(jsonb_agg(
    touch_row.value || jsonb_build_object(
      'replied', coalesce((replies_by_touch ->> (touch_row.value ->> 'touchNo'))::bigint, 0),
      'crossChannel', coalesce(
        (continuations_by_touch ->> (touch_row.value ->> 'touchNo'))::bigint,
        0
      )
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

comment on view public.analytics_cross_channel_continuation_attribution is
  'Resolved-identity sent touches with one different-channel inbound owner before seven days or the next sent touch.';
comment on function public.read_platform_measurement(timestamptz) is
  'Platform snapshot with reply and cross-channel continuation sourced from bounded demo/test exclusion projections.';
