-- System delivery and texting-registration evidence belongs to the platform snapshot so the
-- owner console reads one authorized, demo/test-excluding projection rather than assembling
-- operational facts in the browser.

create or replace function public.read_platform_measurement_for_actor(
  p_actor_id uuid,
  p_as_of timestamptz,
  p_history_periods integer default 12
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  as_of_value timestamptz := coalesce(p_as_of, now());
  snapshot jsonb;
  deliveries_by_day jsonb;
  texting_registration_by_tenant jsonb;
begin
  if p_actor_id is null then
    raise exception 'PHASE7_SESSION_ACTOR_REQUIRED';
  end if;
  perform set_config('app.phase7_reader_actor', p_actor_id::text, true);
  -- Platform aggregates never inherit the authorized own-demo widening that coach readers use.
  perform set_config('app.phase7_demo_tenant', '', true);
  snapshot := public.read_platform_measurement(p_as_of);
  snapshot := jsonb_set(
    snapshot,
    '{history}',
    app.phase7_platform_signup_history(as_of_value, p_history_periods),
    false
  );
  snapshot := jsonb_set(
    snapshot,
    '{activeSubscriptionsByPeriod}',
    app.phase7_platform_active_subscription_history(as_of_value, p_history_periods),
    true
  );
  snapshot := jsonb_set(
    snapshot,
    '{revenueByPeriod}',
    app.phase7_platform_recognized_revenue_history(as_of_value, p_history_periods),
    true
  );

  -- Delivery attempts are the immutable outcome ledger. A delivery can retry, so this counts
  -- every completed provider attempt on the UTC day its outcome was recorded, rather than
  -- inferring success or failure from the mutable delivery queue row.
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', to_char(day_grid.day_start, 'YYYY-MM-DD'),
    'delivered', coalesce(counts.delivered, 0),
    'failed', coalesce(counts.failed, 0)
  ) order by day_grid.day_start), '[]'::jsonb)
  into deliveries_by_day
  from generate_series(
    ((as_of_value at time zone 'UTC')::date - 29)::timestamp,
    (as_of_value at time zone 'UTC')::date::timestamp,
    interval '1 day'
  ) as day_grid(day_start)
  left join lateral (
    select
      count(*) filter (where attempt.outcome = 'delivered')::bigint as delivered,
      count(*) filter (
        where attempt.outcome in ('retryable', 'failed', 'unavailable')
      )::bigint as failed
    from public.notification_delivery_attempts attempt
    join public.notification_deliveries delivery on delivery.id = attempt.delivery_id
    join public.notifications notification on notification.id = delivery.notification_id
    join public.tenants tenant on tenant.id = notification.tenant_id
    where not notification.is_test
      and not tenant.is_demo
      and attempt.finished_at >= (day_grid.day_start at time zone 'UTC')
      and attempt.finished_at < least(
        ((day_grid.day_start + interval '1 day') at time zone 'UTC'),
        as_of_value
      )
  ) counts on true;

  -- Keep the same source as read_coach_a2p_registration: the state is stored on sms_live and
  -- the filing timestamp lives on the a2p_campaign step. Invalid legacy timestamps stay absent;
  -- no fallback date, completion estimate, or client-side clock is introduced.
  with registration_rows as (
    select
      tenant.id as tenant_id,
      sms.state::text as registration_state,
      case
        when coalesce(campaign.external_ref ->> 'submittedAt', campaign.external_ref ->> 'submitted_at')
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          then coalesce(campaign.external_ref ->> 'submittedAt', campaign.external_ref ->> 'submitted_at')::timestamptz
        else null
      end as submitted_at
    from public.tenants tenant
    left join public.provisioning_steps sms
      on sms.tenant_id = tenant.id and sms.step_key = 'sms_live'
    left join public.provisioning_steps campaign
      on campaign.tenant_id = tenant.id and campaign.step_key = 'a2p_campaign'
    where not tenant.is_demo
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'tenantId', tenant_id,
    'registrationState', registration_state,
    'submittedAt', submitted_at,
    'daysElapsed', case
      when submitted_at is null then null
      else greatest(
        0,
        floor(extract(epoch from (as_of_value - submitted_at)) / 86400.0)::integer
      )
    end
  ) order by tenant_id), '[]'::jsonb)
  into texting_registration_by_tenant
  from registration_rows;

  return jsonb_set(
    jsonb_set(snapshot, '{deliveriesByDay}', deliveries_by_day, true),
    '{textingRegistrationByTenant}', texting_registration_by_tenant, true
  );
end;
$$;

revoke execute on function public.read_platform_measurement_for_actor(uuid, timestamptz, integer)
from public, anon, authenticated;
grant execute on function public.read_platform_measurement_for_actor(uuid, timestamptz, integer)
to service_role;

comment on function public.read_platform_measurement_for_actor(uuid, timestamptz, integer) is
  'Platform measurement for a named reader, including UTC daily delivery outcomes and per-tenant texting registration evidence. Test notifications and demo tenants are excluded.';
