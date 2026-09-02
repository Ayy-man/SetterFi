-- Explainable, tenant-scoped health evidence.  The rollup stores the source value and the
-- threshold that was applied, so a later reader never has to infer why a colour was chosen.
set search_path = public, extensions;

create table public.tenant_health_signal_snapshots (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  observed_on date not null,
  signal_key text not null check (signal_key in ('channel', 'provisioning', 'carrier', 'subscription')),
  state text not null check (state in ('healthy', 'unhealthy', 'indeterminate')),
  observed_value jsonb,
  threshold jsonb not null,
  observed_at timestamptz,
  stale_after_at timestamptz,
  calculated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, observed_on, signal_key),
  constraint tenant_health_signal_snapshot_freshness_shape_chk check (
    (observed_at is null and stale_after_at is null)
    or (observed_at is not null and stale_after_at is not null and stale_after_at > observed_at)
  )
);

create index tenant_health_signal_snapshots_latest_idx
  on public.tenant_health_signal_snapshots (tenant_id, observed_on desc, calculated_at desc);

alter table public.tenant_health_signal_snapshots enable row level security;
alter table public.tenant_health_signal_snapshots force row level security;
revoke all on table public.tenant_health_signal_snapshots from public, anon, authenticated, service_role;

create function public.write_tenant_health_snapshot(p_day date)
returns table(tenants_written integer, signals_written integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_record public.tenants%rowtype;
  snapshot_at timestamptz := clock_timestamp();
  channel_count integer;
  channel_healthy_count integer;
  channel_failure_count integer;
  channel_observed_at timestamptz;
  channel_value jsonb;
  channel_signal_state text;
  provisioning_count integer;
  provisioning_done_count integer;
  provisioning_failure_count integer;
  provisioning_observed_at timestamptz;
  provisioning_value jsonb;
  provisioning_signal_state text;
  carrier_count integer;
  carrier_delivered_count integer;
  carrier_failure_count integer;
  carrier_observed_at timestamptz;
  carrier_value jsonb;
  carrier_signal_state text;
  subscription_status text;
  subscription_observed_at timestamptz;
  subscription_period_end timestamptz;
  subscription_value jsonb;
  subscription_signal_state text;
begin
  if p_day is null then
    raise exception 'TENANT_HEALTH_DAY_REQUIRED';
  end if;

  tenants_written := 0;
  signals_written := 0;
  for tenant_record in
    select tenant.*
    from public.tenants as tenant
    where tenant.is_demo is false
    order by tenant.id
  loop
    select
      count(connection.id)::integer,
      count(connection.id) filter (where connection.state::text in ('ready', 'live'))::integer,
      count(connection.id) filter (where connection.state::text in ('disconnected', 'error', 'expired', 'blocked_permanent', 'flagged', 'restricted'))::integer,
      max(coalesce(connection.last_heartbeat_at, connection.updated_at)),
      coalesce(jsonb_agg(jsonb_build_object(
        'channel', connection.channel::text,
        'state', connection.state::text,
        'lastHeartbeatAt', connection.last_heartbeat_at
      ) order by connection.channel::text), '[]'::jsonb)
    into channel_count, channel_healthy_count, channel_failure_count, channel_observed_at, channel_value
    from public.channel_connections as connection
    where connection.tenant_id = tenant_record.id;
    channel_signal_state := case
      when channel_count = 0 then 'indeterminate'
      when channel_observed_at < snapshot_at - interval '24 hours' then 'indeterminate'
      when channel_failure_count > 0 then 'unhealthy'
      when channel_healthy_count > 0 then 'healthy'
      else 'indeterminate'
    end;

    select
      count(step.id)::integer,
      count(step.id) filter (where step.state = 'done')::integer,
      count(step.id) filter (where step.state in ('failed', 'blocked'))::integer,
      max(coalesce(step.completed_at, step.last_attempt_at, step.updated_at)),
      jsonb_build_object(
        'steps', count(step.id),
        'done', count(step.id) filter (where step.state = 'done'),
        'failedOrBlocked', count(step.id) filter (where step.state in ('failed', 'blocked'))
      )
    into provisioning_count, provisioning_done_count, provisioning_failure_count,
      provisioning_observed_at, provisioning_value
    from public.provisioning_steps as step
    where step.tenant_id = tenant_record.id;
    provisioning_signal_state := case
      when provisioning_count = 0 then 'indeterminate'
      when provisioning_observed_at < snapshot_at - interval '24 hours' then 'indeterminate'
      when provisioning_failure_count > 0 then 'unhealthy'
      when provisioning_done_count = provisioning_count then 'healthy'
      else 'indeterminate'
    end;

    select
      count(probe.id)::integer,
      count(probe.id) filter (where probe.result = 'delivered')::integer,
      count(probe.id) filter (where probe.result in ('retryable_failure', 'terminal_rejection'))::integer,
      max(probe.observed_at),
      jsonb_build_object(
        'probes', count(probe.id),
        'delivered', count(probe.id) filter (where probe.result = 'delivered'),
        'failed', count(probe.id) filter (where probe.result in ('retryable_failure', 'terminal_rejection'))
      )
    into carrier_count, carrier_delivered_count, carrier_failure_count, carrier_observed_at, carrier_value
    from public.a2p_probe_receipts as probe
    where probe.tenant_id = tenant_record.id;
    carrier_signal_state := case
      when carrier_count = 0 then 'indeterminate'
      when carrier_observed_at < snapshot_at - interval '168 hours' then 'indeterminate'
      when carrier_failure_count > 0 then 'unhealthy'
      when carrier_delivered_count = carrier_count then 'healthy'
      else 'indeterminate'
    end;

    select subscription.status, subscription.provider_updated_at, subscription.current_period_end
    into subscription_status, subscription_observed_at, subscription_period_end
    from public.billing_subscriptions as subscription
    where subscription.tenant_id = tenant_record.id;
    subscription_value := case when subscription_status is null then null else jsonb_build_object(
      'status', subscription_status,
      'currentPeriodEnd', subscription_period_end
    ) end;
    subscription_signal_state := case
      when subscription_status is null then 'indeterminate'
      when subscription_observed_at < snapshot_at - interval '48 hours' then 'indeterminate'
      when subscription_status in ('trialing', 'active') and subscription_period_end >= snapshot_at then 'healthy'
      else 'unhealthy'
    end;

    insert into public.tenant_health_signal_snapshots as health (
      tenant_id, observed_on, signal_key, state, observed_value, threshold, observed_at, stale_after_at, calculated_at
    ) values
      (
        tenant_record.id, p_day, 'channel', channel_signal_state, channel_value,
        jsonb_build_object('freshWithinHours', 24, 'requiredStates', jsonb_build_array('ready', 'live')),
        channel_observed_at,
        case when channel_observed_at is null then null else channel_observed_at + interval '24 hours' end,
        snapshot_at
      ),
      (
        tenant_record.id, p_day, 'provisioning', provisioning_signal_state, provisioning_value,
        jsonb_build_object('freshWithinHours', 24, 'requiredState', 'done'),
        provisioning_observed_at,
        case when provisioning_observed_at is null then null else provisioning_observed_at + interval '24 hours' end,
        snapshot_at
      ),
      (
        tenant_record.id, p_day, 'carrier', carrier_signal_state, carrier_value,
        jsonb_build_object('freshWithinHours', 168, 'requiredResult', 'delivered'),
        carrier_observed_at,
        case when carrier_observed_at is null then null else carrier_observed_at + interval '168 hours' end,
        snapshot_at
      ),
      (
        tenant_record.id, p_day, 'subscription', subscription_signal_state, subscription_value,
        jsonb_build_object('freshWithinHours', 48, 'requiredStatuses', jsonb_build_array('trialing', 'active')),
        subscription_observed_at,
        case when subscription_observed_at is null then null else subscription_observed_at + interval '48 hours' end,
        snapshot_at
      )
    on conflict (tenant_id, observed_on, signal_key) do update
    set state = excluded.state,
      observed_value = excluded.observed_value,
      threshold = excluded.threshold,
      observed_at = excluded.observed_at,
      stale_after_at = excluded.stale_after_at,
      calculated_at = excluded.calculated_at;
    tenants_written := tenants_written + 1;
    signals_written := signals_written + 4;
  end loop;
  return next;
end;
$$;

-- Historical channel receipts do not carry the complete four-signal evidence required by this
-- projection.  Returning zero is intentional: a backfill must not manufacture a healthy state.
create function public.backfill_tenant_health_rollup(p_from date, p_to date)
returns table(rows_written integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'TENANT_HEALTH_BACKFILL_WINDOW_INVALID';
  end if;
  rows_written := 0;
  return next;
end;
$$;

create function public.read_tenant_health_detail(p_expected_tenant uuid, p_actor_id uuid)
returns table(
  tenant_id uuid,
  snapshot_day date,
  overall_state text,
  signal_key text,
  signal_state text,
  observed_value jsonb,
  threshold jsonb,
  observed_at timestamptz,
  stale_after_at timestamptz,
  calculated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_role public.user_role;
begin
  select user_row.role into actor_role
  from public.users as user_row
  where user_row.id = p_actor_id;
  if actor_role not in ('owner', 'admin', 'success') then
    raise exception 'TENANT_HEALTH_OPERATOR_FORBIDDEN';
  end if;
  if not exists (select 1 from public.tenants as tenant where tenant.id = p_expected_tenant) then
    raise exception 'TENANT_HEALTH_CLIENT_NOT_FOUND';
  end if;
  if actor_role = 'success' and not exists (
    select 1
    from public.tenants as tenant
    where tenant.id = p_expected_tenant
      and tenant.success_owner = p_actor_id
  ) then
    raise exception 'TENANT_HEALTH_CLIENT_NOT_IN_BOOK';
  end if;

  return query
  with expected_signal(signal_key, default_threshold) as (
    values
      ('channel'::text, jsonb_build_object('freshWithinHours', 24, 'requiredStates', jsonb_build_array('ready', 'live'))),
      ('provisioning'::text, jsonb_build_object('freshWithinHours', 24, 'requiredState', 'done')),
      ('carrier'::text, jsonb_build_object('freshWithinHours', 168, 'requiredResult', 'delivered')),
      ('subscription'::text, jsonb_build_object('freshWithinHours', 48, 'requiredStatuses', jsonb_build_array('trialing', 'active')))
  ), latest_day as (
    select max(snapshot.observed_on) as observed_on
    from public.tenant_health_signal_snapshots as snapshot
    where snapshot.tenant_id = p_expected_tenant
  ), latest_signal as (
    select snapshot.*
    from public.tenant_health_signal_snapshots as snapshot
    inner join latest_day on latest_day.observed_on = snapshot.observed_on
    where snapshot.tenant_id = p_expected_tenant
  ), summary as (
    select case
      when count(latest_signal.signal_key) = 4
        and bool_and(latest_signal.state = 'healthy') then 'healthy'
      when bool_or(latest_signal.state = 'unhealthy') then 'unhealthy'
      else 'indeterminate'
    end as derived_state
    from latest_signal
  )
  select
    p_expected_tenant,
    latest_day.observed_on,
    summary.derived_state,
    expected_signal.signal_key,
    coalesce(latest_signal.state, 'indeterminate'),
    latest_signal.observed_value,
    coalesce(latest_signal.threshold, expected_signal.default_threshold),
    latest_signal.observed_at,
    latest_signal.stale_after_at,
    latest_signal.calculated_at
  from expected_signal
  cross join latest_day
  cross join summary
  left join latest_signal on latest_signal.signal_key = expected_signal.signal_key
  order by expected_signal.signal_key;
  return;
end;
$$;

revoke all on function public.write_tenant_health_snapshot(date) from public, anon, authenticated;
revoke all on function public.backfill_tenant_health_rollup(date, date) from public, anon, authenticated;
revoke all on function public.read_tenant_health_detail(uuid, uuid) from public, anon, authenticated;
grant execute on function public.write_tenant_health_snapshot(date) to service_role;
grant execute on function public.backfill_tenant_health_rollup(date, date) to service_role;
grant execute on function public.read_tenant_health_detail(uuid, uuid) to service_role;
