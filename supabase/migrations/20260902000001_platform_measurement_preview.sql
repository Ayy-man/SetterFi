-- A review-only snapshot must never be mistaken for platform analytics.  Real platform
-- measurements continue to read the analytics_* views; this table is selected only by the
-- server when the explicit staging/demo preview gate is enabled.

create table if not exists public.platform_measurement_preview_snapshots (
  key text primary key check (key = 'staging-demo'),
  snapshot jsonb not null,
  is_demo boolean not null default true check (is_demo),
  seeded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(snapshot) = 'object')
);

alter table public.platform_measurement_preview_snapshots enable row level security;

revoke all on table public.platform_measurement_preview_snapshots from anon, authenticated;

create or replace function public.read_platform_measurement_preview_for_actor(
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.users
    where id = p_actor_id and role in ('owner', 'admin', 'success')
  ) then
    raise exception 'PLATFORM_PREVIEW_ACTOR_FORBIDDEN';
  end if;
  return (
    select snapshot from public.platform_measurement_preview_snapshots
    where key = 'staging-demo' and is_demo = true
  );
end;
$$;

revoke all on function public.read_platform_measurement_preview_for_actor(uuid) from public;
grant execute on function public.read_platform_measurement_preview_for_actor(uuid) to service_role;
