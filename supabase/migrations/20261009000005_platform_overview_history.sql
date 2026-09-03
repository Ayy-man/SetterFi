-- The owner overview needs one comparable year of platform evidence. Signup history already
-- supplies the fixed 30-day grid; this adds the two other series to the same actor-scoped
-- snapshot without changing any existing measurement key.

-- ---------------------------------------------------------------------------
-- 1. Money projection with the same tenant segregation as platform analytics
-- ---------------------------------------------------------------------------

-- Subscription mirrors and cost-rollup receipts are tenant-scoped records rather than
-- conversation-derived rows, so neither source has an `is_test` column. The established
-- analytics exclusion for those sources is the tenant's demo flag; this view applies it before a
-- platform aggregate can read recognised subscription revenue.
create or replace view public.analytics_tenant_cost_rollups
with (security_invoker = true)
as
select rollup.id as rollup_id, rollup.tenant_id, rollup.window_start, rollup.window_end,
  rollup.recognized_subscription_cents, rollup.computed_at
from public.tenant_cost_rollups rollup
join public.tenants tenant on tenant.id = rollup.tenant_id
where not tenant.is_demo;

revoke all on public.analytics_tenant_cost_rollups from public, anon, authenticated, service_role;
grant select on public.analytics_tenant_cost_rollups to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Overview series builders
-- ---------------------------------------------------------------------------

create or replace function app.phase7_platform_active_subscription_history(
  p_as_of timestamptz,
  p_periods integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  as_of_value timestamptz := coalesce(p_as_of, now());
  periods integer := least(greatest(coalesce(p_periods, 12), 2), 12);
  series jsonb;
begin
  perform app.phase7_session_actor(null, true);

  select coalesce(jsonb_agg(jsonb_build_object(
    'periodStart', period.window_start,
    'periodEnd', period.window_end,
    'value', period.active_subscriptions,
    'state', 'available'
  ) order by period.window_start), '[]'::jsonb)
  into series
  from (
    select
      as_of_value - ((offset_index + 1) * interval '30 days') as window_start,
      as_of_value - (offset_index * interval '30 days') as window_end,
      (
        select count(*)::bigint
        from public.analytics_billing_subscriptions subscription
        where subscription.status = 'active'
          and subscription.current_period_start <= as_of_value - (offset_index * interval '30 days')
          and subscription.current_period_end > as_of_value - (offset_index * interval '30 days')
      ) as active_subscriptions
    from generate_series(periods - 1, 0, -1) as offset_index
  ) period;

  return series;
end;
$$;

create or replace function app.phase7_platform_recognized_revenue_history(
  p_as_of timestamptz,
  p_periods integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  as_of_value timestamptz := coalesce(p_as_of, now());
  periods integer := least(greatest(coalesce(p_periods, 12), 2), 12);
  series jsonb;
begin
  perform app.phase7_session_actor(null, true);

  select coalesce(jsonb_agg(jsonb_build_object(
    'periodStart', period.window_start,
    'periodEnd', period.window_end,
    'value', period.recognized_revenue_cents,
    -- A missing receipt is not evidence that the platform earned zero. It is the same honest
    -- historical gap state the signup series uses before it has a measured population.
    'state', case when period.receipt_count = 0 then 'needs_more_history' else 'available' end
  ) order by period.window_start), '[]'::jsonb)
  into series
  from (
    select
      as_of_value - ((offset_index + 1) * interval '30 days') as window_start,
      as_of_value - (offset_index * interval '30 days') as window_end,
      (
        select count(*)::bigint
        from public.analytics_tenant_cost_rollups receipt
        where receipt.window_start >= as_of_value - ((offset_index + 1) * interval '30 days')
          and receipt.window_start < as_of_value - (offset_index * interval '30 days')
      ) as receipt_count,
      (
        select coalesce(sum(receipt.recognized_subscription_cents), 0)::bigint
        from public.analytics_tenant_cost_rollups receipt
        where receipt.window_start >= as_of_value - ((offset_index + 1) * interval '30 days')
          and receipt.window_start < as_of_value - (offset_index * interval '30 days')
      ) as recognized_revenue_cents
    from generate_series(periods - 1, 0, -1) as offset_index
  ) period;

  return series;
end;
$$;

revoke execute on function app.phase7_platform_active_subscription_history(timestamptz, integer)
from public, anon, authenticated;
revoke execute on function app.phase7_platform_recognized_revenue_history(timestamptz, integer)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Add the histories to the existing owner-only reader
-- ---------------------------------------------------------------------------

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
  snapshot jsonb;
begin
  if p_actor_id is null then
    raise exception 'PHASE7_SESSION_ACTOR_REQUIRED';
  end if;
  perform set_config('app.phase7_reader_actor', p_actor_id::text, true);
  perform set_config('app.phase7_demo_tenant', '', true);
  snapshot := public.read_platform_measurement(p_as_of);
  snapshot := jsonb_set(
    snapshot,
    '{history}',
    app.phase7_platform_signup_history(coalesce(p_as_of, now()), p_history_periods),
    false
  );
  snapshot := jsonb_set(
    snapshot,
    '{activeSubscriptionsByPeriod}',
    app.phase7_platform_active_subscription_history(coalesce(p_as_of, now()), p_history_periods),
    true
  );
  return jsonb_set(
    snapshot,
    '{revenueByPeriod}',
    app.phase7_platform_recognized_revenue_history(coalesce(p_as_of, now()), p_history_periods),
    true
  );
end;
$$;

revoke execute on function public.read_platform_measurement_for_actor(uuid, timestamptz, integer)
from public, anon, authenticated;
grant execute on function public.read_platform_measurement_for_actor(uuid, timestamptz, integer)
to service_role;

comment on view public.analytics_tenant_cost_rollups is
  'Recognised subscription revenue receipts excluding demo tenants, for platform analytics only.';
comment on function app.phase7_platform_active_subscription_history(timestamptz, integer) is
  'N contiguous 30-day periods ending at the as-of instant, oldest first, with active-only subscriptions counted at each period end.';
comment on function app.phase7_platform_recognized_revenue_history(timestamptz, integer) is
  'N contiguous 30-day periods ending at the as-of instant, oldest first, with recognised subscription revenue receipts grouped by their period start.';
comment on function public.read_platform_measurement_for_actor(uuid, timestamptz, integer) is
  'Platform measurement for a named reader. The id must come from a server-validated session, never from a request parameter the browser controls; the database re-verifies the owner/admin/success audience against public.users. Clears the demo-tenant widening before reading, so a platform aggregate never contains a demo tenant, and returns contiguous signup, active-subscription, and recognised-revenue histories.';
