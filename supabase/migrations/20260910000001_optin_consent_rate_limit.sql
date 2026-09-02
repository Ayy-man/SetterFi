-- The public consent form needs one fixed window across serverless instances. A process-local
-- counter gives each instance an independent allowance, so the database owns this tenant, route,
-- and caller-scoped counter instead. It records throttling state only; it is never consent evidence.

create table public.tenant_request_rate_limits (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  route_key text not null check (
    route_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
  ),
  caller_key text not null check (
    nullif(btrim(caller_key), '') is not null and char_length(caller_key) <= 512
  ),
  window_started_at timestamptz not null,
  hits integer not null check (hits >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, route_key, caller_key)
);

alter table public.tenant_request_rate_limits enable row level security;
alter table public.tenant_request_rate_limits force row level security;
revoke all on table public.tenant_request_rate_limits from public, anon, authenticated, service_role;
grant select, insert, update on table public.tenant_request_rate_limits to service_role;

create or replace function public.consume_tenant_rate_limit(
  p_tenant_id uuid,
  p_route_key text,
  p_caller_key text,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz default now()
)
returns table (allowed boolean, remaining integer, retry_after integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  limiter public.tenant_request_rate_limits%rowtype;
  elapsed_seconds integer;
begin
  if p_tenant_id is null
    or nullif(btrim(p_route_key), '') is null
    or nullif(btrim(p_caller_key), '') is null
    or p_limit <= 0
    or p_window_seconds <= 0
    or p_now is null then
    raise exception 'TENANT_RATE_LIMIT_CONFIGURATION_INVALID';
  end if;

  insert into public.tenant_request_rate_limits (
    tenant_id, route_key, caller_key, window_started_at, hits
  ) values (
    p_tenant_id, p_route_key, p_caller_key, p_now, 0
  ) on conflict (tenant_id, route_key, caller_key) do nothing;

  select * into limiter
  from public.tenant_request_rate_limits
  where tenant_id = p_tenant_id
    and route_key = p_route_key
    and caller_key = p_caller_key
  for update;
  if limiter.tenant_id is null then
    raise exception 'TENANT_RATE_LIMIT_ROW_MISSING';
  end if;

  if p_now >= limiter.window_started_at + make_interval(secs => p_window_seconds) then
    limiter.window_started_at := p_now;
    limiter.hits := 0;
  end if;
  elapsed_seconds := greatest(0, extract(epoch from (p_now - limiter.window_started_at))::integer);

  if limiter.hits >= p_limit then
    update public.tenant_request_rate_limits
    set window_started_at = limiter.window_started_at,
        hits = limiter.hits,
        updated_at = now()
    where tenant_id = p_tenant_id
      and route_key = p_route_key
      and caller_key = p_caller_key;
    return query select false, 0, greatest(1, p_window_seconds - elapsed_seconds);
  end if;

  limiter.hits := limiter.hits + 1;
  update public.tenant_request_rate_limits
  set window_started_at = limiter.window_started_at,
      hits = limiter.hits,
      updated_at = now()
  where tenant_id = p_tenant_id
    and route_key = p_route_key
    and caller_key = p_caller_key;
  return query select true, greatest(0, p_limit - limiter.hits), 0;
end;
$$;

revoke all on function public.consume_tenant_rate_limit(
  uuid, text, text, integer, integer, timestamptz
) from public, anon, authenticated;
grant execute on function public.consume_tenant_rate_limit(
  uuid, text, text, integer, integer, timestamptz
) to service_role;

comment on table public.tenant_request_rate_limits is
  'Service-written fixed-window counters for public routes. These rows are throttling state, never consent evidence.';
comment on function public.consume_tenant_rate_limit(uuid, text, text, integer, integer, timestamptz) is
  'Atomically consumes one tenant, route, and caller-scoped fixed-window request allowance for service-role routes.';
