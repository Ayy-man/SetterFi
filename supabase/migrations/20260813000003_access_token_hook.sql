-- Custom access token hook (BUILD-PLAN B3): stamp role + tenant into every JWT.
--
-- The init migration's RLS helpers read app_metadata.role / app_metadata.tenant_id
-- from the JWT and deliberately resolve to NULL tenant (see nothing) until this
-- hook exists. This closes that gap: on every token issue/refresh, Supabase Auth
-- calls the hook, which copies the user's role and tenant from public.users into
-- the token's app_metadata. public.users is the single source of truth — a role
-- or tenant change takes effect on the next token refresh (<= 1h), and deleting
-- the users row severs access on the same clock.
--
-- Runs as supabase_auth_admin (Supabase convention), which needs a narrow read
-- path into public.users; everyone else is revoked from executing it.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  u record;
  claims jsonb;
begin
  select role, tenant_id into u
  from public.users
  where id = (event ->> 'user_id')::uuid;

  -- No app user row: return the event untouched. The token then carries no role
  -- or tenant claim, and every RLS helper resolves to "sees nothing" — the safe
  -- failure direction for a half-provisioned signup.
  if u.role is null then
    return event;
  end if;

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  claims := jsonb_set(
    claims,
    '{app_metadata}',
    coalesce(claims -> 'app_metadata', '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
           'role', u.role,
           'tenant_id', u.tenant_id
         ))
  );

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- Only the auth server may call the hook or read users through it.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, public;

grant select on public.users to supabase_auth_admin;
create policy users_auth_admin_read on public.users
  as permissive for select
  to supabase_auth_admin
  using (true);
