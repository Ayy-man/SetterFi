-- Adds booked-call volume to the fixed coach composition calendar. Keeping this
-- in the existing reader means the dashboard receives its lead and booking series
-- from one scoped snapshot and cannot accidentally compare different month grids.

create or replace function public.read_coach_lead_composition(
  p_expected_tenant uuid,
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
  current_month date;
  months jsonb;
  booked_by_period jsonb;
begin
  perform app.phase7_session_actor(p_expected_tenant, false);
  select * into tenant_row from public.analytics_tenants tenant
  where tenant.tenant_id = p_expected_tenant;
  if tenant_row.tenant_id is null then raise exception 'PHASE7_COACH_TENANT_UNAVAILABLE'; end if;

  local_day := (as_of_value at time zone tenant_row.timezone)::date;
  current_month := date_trunc('month', local_day::timestamp)::date;

  select coalesce(jsonb_agg(jsonb_build_object(
    'month', grid.month_start,
    'label', to_char(grid.month_start, 'Mon YYYY'),
    'total', coalesce(counts.total, 0),
    'qualified', coalesce(counts.qualified, 0),
    'disqualified', coalesce(counts.disqualified, 0),
    'active', coalesce(counts.active, 0),
    'partial', grid.month_start = current_month
  ) order by grid.month_start), '[]'::jsonb)
  into months
  from (
    select generate_series(
      (current_month - interval '5 months')::timestamp,
      current_month::timestamp,
      interval '1 month'
    )::date month_start
  ) grid
  left join lateral (
    select count(*)::bigint total,
      count(*) filter (where classified.bucket = 'qualified')::bigint qualified,
      count(*) filter (where classified.bucket = 'disqualified')::bigint disqualified,
      count(*) filter (where classified.bucket = 'active')::bigint active
    from (
      select case
        when contact.pipeline_stage = 'disqualified' then 'disqualified'
        when contact.pipeline_stage in ('booked', 'qualified_no_buy') or contact.outcome = 'BOOK'
          then 'qualified'
        else 'active'
      end bucket
      from public.analytics_contacts contact
      where contact.tenant_id = p_expected_tenant
        and contact.merged_into_contact_id is null
        and contact.created_at >= (grid.month_start::timestamp at time zone tenant_row.timezone)
        and contact.created_at < ((grid.month_start + interval '1 month')::timestamp
          at time zone tenant_row.timezone)
    ) classified
  ) counts on true;

  -- `analytics_appointments` is the established analytics projection: it excludes
  -- test rows and demo tenants (except the authorized own-demo widening), while the
  -- canceled-status rule matches the existing booked-appointments metric.
  select coalesce(jsonb_agg(jsonb_build_object(
    'month', grid.month_start,
    'booked', coalesce(counts.booked, 0)
  ) order by grid.month_start), '[]'::jsonb)
  into booked_by_period
  from (
    select generate_series(
      (current_month - interval '5 months')::timestamp,
      current_month::timestamp,
      interval '1 month'
    )::date month_start
  ) grid
  left join lateral (
    select count(*)::bigint booked
    from public.analytics_appointments appointment
    where appointment.tenant_id = p_expected_tenant
      and appointment.status <> 'canceled'
      and appointment.created_at >= (grid.month_start::timestamp at time zone tenant_row.timezone)
      and appointment.created_at < ((grid.month_start + interval '1 month')::timestamp
        at time zone tenant_row.timezone)
  ) counts on true;

  return jsonb_build_object(
    'tenantId', p_expected_tenant,
    'timezone', tenant_row.timezone,
    'asOf', as_of_value,
    'months', months,
    'bookedByPeriod', booked_by_period
  );
end;
$$;

revoke execute on function public.read_coach_lead_composition(uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.read_coach_lead_composition(uuid,timestamptz) to service_role;

comment on function public.read_coach_lead_composition(uuid,timestamptz) is
  'Six calendar months of lead composition and booked-call counts, independent of the measurement picker. Both series use the tenant timezone and zero-filled month grid; booked calls use public.analytics_appointments, which applies the analytics test/demo exclusion and omits canceled appointments.';
