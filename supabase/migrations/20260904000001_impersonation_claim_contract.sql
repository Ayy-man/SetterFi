-- Restore the application half of the impersonation contract. The database resolves the active
-- tenant from impersonation_session_id on every RLS decision; application routes also need the
-- matching tenant claim so they can select the viewed workspace and refuse service-role writes.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  app_user record;
  active_session record;
  claims jsonb;
  metadata jsonb;
  has_affiliate_access boolean;
begin
  select role, tenant_id into app_user
  from public.users
  where id = (event ->> 'user_id')::uuid;
  if app_user.role is null then return event; end if;

  select exists (
    select 1 from public.affiliates where user_id = (event ->> 'user_id')::uuid
  ) into has_affiliate_access;
  claims := coalesce(event -> 'claims', '{}'::jsonb);
  metadata := coalesce(claims -> 'app_metadata', '{}'::jsonb)
    - 'role' - 'tenant_id' - 'affiliate_access'
    - 'impersonating_tenant' - 'impersonation_session_id';
  metadata := metadata || jsonb_strip_nulls(jsonb_build_object(
    'role', app_user.role,
    'tenant_id', app_user.tenant_id,
    'affiliate_access', has_affiliate_access
  ));

  if app_user.role in ('owner', 'admin', 'success') then
    select id, tenant_id into active_session
    from public.impersonation_sessions
    where actor_id = (event ->> 'user_id')::uuid
      and ended_at is null and expires_at > now()
    order by started_at desc, id desc limit 1;
    if active_session.id is not null then
      metadata := metadata || jsonb_build_object(
        'impersonating_tenant', active_session.tenant_id,
        'impersonation_session_id', active_session.id
      );
    end if;
  end if;
  claims := jsonb_set(claims, '{app_metadata}', metadata);
  return jsonb_set(event, '{claims}', claims);
end;
$$;

revoke execute on function public.custom_access_token_hook(jsonb)
  from public, anon, authenticated;
grant execute on function public.custom_access_token_hook(jsonb)
  to supabase_auth_admin;

-- A service-role RPC has no request JWT, so app.assert_not_impersonating() cannot protect an
-- explicit p_actor_id by itself. Resolve that actor against the live session table instead.
create or replace function app.assert_actor_not_impersonating(p_actor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor_id is null then raise exception 'IMPERSONATION_ACTOR_REQUIRED'; end if;
  if exists (
    select 1 from public.impersonation_sessions session
    where session.actor_id = p_actor_id
      and session.ended_at is null
      and session.expires_at > now()
  ) then raise exception 'IMPERSONATION_WRITE_FORBIDDEN'; end if;
end;
$$;

revoke execute on function app.assert_actor_not_impersonating(uuid)
  from public, anon, authenticated;
grant execute on function app.assert_actor_not_impersonating(uuid) to service_role;

-- These shared actor resolvers cover the service-role human write surfaces from phases 2, 4, 5,
-- 6 and 7 without duplicating the session-table check in every public RPC.
create or replace function app.phase2_assert_platform_actor(p_actor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_role public.user_role;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  select role into actor_role from public.users where id = p_actor_id;
  if actor_role is null or actor_role not in ('owner', 'admin', 'success') then
    raise exception 'PHASE2_PLATFORM_ACTOR_FORBIDDEN';
  end if;
end;
$$;

create or replace function app.phase4_assert_tenant_actor(
  p_expected_tenant uuid,
  p_actor_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_row public.users%rowtype;
  success_owner_id uuid;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  if p_expected_tenant is null then raise exception 'EXPECTED_TENANT_REQUIRED'; end if;
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null then raise exception 'PHASE4_ACTOR_REQUIRED'; end if;
  if actor_row.role = 'coach' and actor_row.tenant_id = p_expected_tenant then return; end if;
  if actor_row.role in ('owner', 'admin') then return; end if;
  if actor_row.role = 'success' then
    select success_owner into success_owner_id from public.tenants where id = p_expected_tenant;
    if success_owner_id = p_actor_id then return; end if;
  end if;
  raise exception 'PHASE4_ACTOR_NOT_AUTHORIZED';
end;
$$;

create or replace function app.assert_phase5_actor(
  p_actor_id uuid,
  p_tenant_id uuid,
  p_platform_only boolean default false
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_row public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null then raise exception 'PHASE5_ACTOR_NOT_FOUND'; end if;
  if p_platform_only then
    if actor_row.role not in ('owner', 'admin', 'success') then
      raise exception 'PHASE5_PLATFORM_ACTOR_REQUIRED';
    end if;
  elsif actor_row.tenant_id is distinct from p_tenant_id
    and actor_row.role not in ('owner', 'admin', 'success') then
    raise exception 'PHASE5_ACTOR_TENANT_MISMATCH';
  end if;
end;
$$;

create or replace function app.phase6_verified_actor(
  p_actor_id uuid,
  p_expected_tenant uuid,
  p_platform_only boolean,
  p_coach_only boolean
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_row public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null then raise exception 'PHASE6_ACTOR_REQUIRED'; end if;
  if p_platform_only and actor_row.role not in ('owner','admin') then
    raise exception 'PHASE6_OWNER_ADMIN_REQUIRED';
  end if;
  if p_coach_only and (
    actor_row.role not in ('coach','coach_member')
    or actor_row.tenant_id is distinct from p_expected_tenant
  ) then raise exception 'PHASE6_COACH_TENANT_REQUIRED'; end if;
  if not p_platform_only and not p_coach_only
    and actor_row.role not in ('owner','admin')
    and actor_row.tenant_id is distinct from p_expected_tenant then
    raise exception 'PHASE6_ACTOR_TENANT_MISMATCH';
  end if;
  return actor_row.id;
end;
$$;

create or replace function app.phase7_verified_test_actor(
  p_actor_id uuid,
  p_expected_tenant uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_row public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  select * into actor_row from public.users actor where actor.id = p_actor_id;
  if actor_row.id is null then raise exception 'PHASE7_TEST_ACTOR_REQUIRED'; end if;
  if actor_row.role in ('coach','coach_member') then
    if actor_row.tenant_id is distinct from p_expected_tenant then
      raise exception 'PHASE7_TEST_ACTOR_TENANT_MISMATCH';
    end if;
  elsif actor_row.role not in ('owner','admin','success') then
    raise exception 'PHASE7_TEST_ACTOR_ROLE_REQUIRED';
  end if;
  return actor_row.id;
end;
$$;

-- Audited human writes get a final transaction-wide backstop. If a service RPC missed one of the
-- shared helpers, raising from this trigger still rolls its preceding state changes back.
create or replace function app.enforce_active_impersonation_audit_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.actor_id is not null
    and new.action not in ('impersonation.started', 'impersonation.ended') then
    perform app.assert_actor_not_impersonating(new.actor_id);
  end if;
  return new;
end;
$$;

drop trigger if exists audit_log_active_impersonation_guard on public.audit_log;
create trigger audit_log_active_impersonation_guard
before insert on public.audit_log
for each row execute function app.enforce_active_impersonation_audit_guard();

revoke execute on function app.enforce_active_impersonation_audit_guard()
  from public, anon, authenticated, service_role;
