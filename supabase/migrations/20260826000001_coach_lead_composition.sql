-- The monthly lead composition a coach home bar chart is drawn from.
--
-- `20260823000001_phase7_measurement.sql:1171` already ships `read_coach_measurement`,
-- and every value in it is scoped to the `1d/1w/1m/3m/all/custom` picker. A monthly
-- bar chart is incoherent inside a one-day window, so this composition is a sibling
-- function rather than a twelfth key on that aggregate: it is fixed to the last six
-- calendar months in the tenant's own timezone and never reads the picker. Widening
-- the aggregate would also mean re-emitting ~250 lines of `create or replace` body,
-- which is the transcription-slip defect class Phase 7 already paid for twice.
--
-- Three properties the chart depends on, all enforced here rather than in the client:
--
-- 1. `generate_series` owns the month grid and the counts are left-joined onto it, so
--    a month with no leads emits a zero row instead of disappearing and silently
--    shrinking the chart to five bars.
-- 2. One CASE puts each contact in exactly one bucket. `read_coach_measurement`
--    counts qualified as `pipeline_stage in ('booked','qualified_no_buy') or
--    outcome = 'BOOK'` (`:1261`) and disqualified as `pipeline_stage = 'disqualified'`
--    (`:1262`), and a single contact can match both — three independent filters would
--    make qualified + disqualified exceed the total and drive the remainder negative.
--    Disqualified takes priority because it is the current pipeline truth. The
--    consequence is deliberate: this qualified count can sit below the
--    `coach.qualified_leads` KPI card by exactly that overlap.
-- 3. Test and demo segregation comes from `public.analytics_contacts`
--    (`20260823000001_phase7_measurement.sql:834`), which already carries
--    `where not contact.is_test and not tenant.is_demo`. There is no second
--    mechanism here and no read of `public.contacts`.

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

  return jsonb_build_object(
    'tenantId', p_expected_tenant,
    'timezone', tenant_row.timezone,
    'asOf', as_of_value,
    'months', months
  );
end;
$$;

revoke execute on function public.read_coach_lead_composition(uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.read_coach_lead_composition(uuid,timestamptz) to service_role;

comment on function public.read_coach_lead_composition(uuid,timestamptz) is
  'Six calendar months of lead composition, independent of the measurement picker. Excludes test and demo rows through public.analytics_contacts; each month sums to its own total by a single mutually exclusive CASE.';
