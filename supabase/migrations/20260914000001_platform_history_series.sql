-- The platform snapshot's signup history becomes a real series.
--
-- `app.phase7_platform_measurement_base` builds `history` as a hardcoded two-element array: the
-- current 30-day window and the one before it. Two numbers is a comparison, not a trend, and the
-- Overview could only ever draw two bars from it (admin-overview.tsx documents exactly that). Any
-- trend the console wants is a migration before it is a chart.
--
-- The base function is left alone. This adds one builder that emits N contiguous 30-day periods
-- over the same source the base counts from, and re-creates the actor wrapper so the caller can
-- ask for a period count. Every other key in the snapshot is untouched.

-- ---------------------------------------------------------------------------
-- 1. The series builder
-- ---------------------------------------------------------------------------

create or replace function app.phase7_platform_signup_history(
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
  -- One period is not a series and the growth comparison needs two; anything past a year of
  -- 30-day windows is a chart nobody reads at the width this panel gets.
  periods integer := least(greatest(coalesce(p_periods, 6), 2), 12);
  first_signup_at timestamptz;
  series jsonb;
begin
  -- Authorization precedes every measurement query, exactly as the base snapshot does it.
  perform app.phase7_session_actor(null, true);

  select min(created_at) into first_signup_at from public.analytics_tenants
  where created_at < as_of_value;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'periodStart', period.window_start,
      'periodEnd', period.window_end,
      'value', period.signups,
      -- A period that closed before the platform had its first tenant is not a zero anybody
      -- measured, it is a period with no population to sign up into, and it says so. A zero after
      -- that first tenant exists is a real count of a real period and reads as available.
      'state', case
        when first_signup_at is null or first_signup_at >= period.window_end
          then 'needs_more_history'
        else 'available'
      end
    ) order by period.window_start
  ), '[]'::jsonb)
  into series
  from (
    select
      as_of_value - ((offset_index + 1) * interval '30 days') as window_start,
      as_of_value - (offset_index * interval '30 days') as window_end,
      (
        select count(*) from public.analytics_tenants tenant
        where tenant.created_at >= as_of_value - ((offset_index + 1) * interval '30 days')
          and tenant.created_at < as_of_value - (offset_index * interval '30 days')
      ) as signups
    from generate_series(periods - 1, 0, -1) as offset_index
  ) period;

  return series;
end;
$$;

revoke execute on function app.phase7_platform_signup_history(timestamptz, integer)
from public, anon, authenticated;

comment on function app.phase7_platform_signup_history(timestamptz, integer) is
  'N contiguous 30-day signup periods ending at the as-of instant, oldest first. A period that closed before the first tenant existed reports needs_more_history rather than a zero nobody measured.';

-- ---------------------------------------------------------------------------
-- 2. The actor wrapper carries the period count
-- ---------------------------------------------------------------------------

-- The wrapper is dropped rather than replaced: a defaulted third parameter is a new signature, and
-- leaving the two-argument form in place would make every existing two-argument call ambiguous.
drop function if exists public.read_platform_measurement_for_actor(uuid, timestamptz);

create function public.read_platform_measurement_for_actor(
  p_actor_id uuid,
  p_as_of timestamptz,
  p_history_periods integer default 6
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
  -- A platform aggregate cannot run widened, whatever else happened in this transaction. One
  -- missed view or one caller that forgot to clear the GUC is all it would take to leak demo
  -- rows into a number the client reads as real (20260830000001:231).
  perform set_config('app.phase7_demo_tenant', '', true);
  snapshot := public.read_platform_measurement(p_as_of);
  return jsonb_set(
    snapshot,
    '{history}',
    app.phase7_platform_signup_history(coalesce(p_as_of, now()), p_history_periods),
    false
  );
end;
$$;

revoke execute on function public.read_platform_measurement_for_actor(uuid, timestamptz, integer)
from public, anon, authenticated;
grant execute on function public.read_platform_measurement_for_actor(uuid, timestamptz, integer)
to service_role;

comment on function public.read_platform_measurement_for_actor(uuid, timestamptz, integer) is
  'Platform measurement for a named reader. The id must come from a server-validated session, never from a request parameter the browser controls; the database re-verifies the owner/admin/success audience against public.users. Clears the demo-tenant widening before reading, so a platform aggregate never contains a demo tenant, and replaces the base two-period history with the requested number of contiguous 30-day signup periods.';
