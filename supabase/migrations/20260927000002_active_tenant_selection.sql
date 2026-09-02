-- A durable workspace choice is deliberately additive: absent a row, callers retain the tenant
-- from their current JWT. The service-only RPCs enforce live membership at every read and write.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('tenant.membership.switched', 'human', 'tenant', false, true, 'Workspace switch logged', 'Workspace switch recorded in the audit log')
on conflict (key) do nothing;

create table public.tenant_active_selections (
  user_id uuid primary key references public.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  selected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tenant_active_selections_tenant_idx on public.tenant_active_selections (tenant_id);
create trigger tenant_active_selections_set_updated_at before update on public.tenant_active_selections
  for each row execute function app.set_updated_at();

alter table public.tenant_active_selections enable row level security;
alter table public.tenant_active_selections force row level security;
revoke all on public.tenant_active_selections from public, anon, authenticated, service_role;
grant select on public.tenant_active_selections to service_role;

-- A user can always retain the workspace attached to their account, while additional workspaces
-- must have a live delegated membership row. This helper is private because memberships are
-- revoked from client roles and every caller needs the same live check.
create function app.has_active_tenant_membership(p_actor_id uuid, p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_actor_id is not null and p_tenant_id is not null and (
    exists (
      select 1
      from public.users as account
      where account.id = p_actor_id
        and account.tenant_id = p_tenant_id
        and account.role = 'coach'
    )
    or exists (
      select 1
      from public.tenant_memberships as membership
      where membership.user_id = p_actor_id
        and membership.tenant_id = p_tenant_id
        and membership.role = 'coach_member'
        and membership.revoked_at is null
    )
  );
$$;

-- Membership revocation must remove the choice immediately, so a revoked workspace cannot remain
-- as a stale durable pointer even if an application process has not yet refreshed its JWT.
create function app.clear_revoked_active_tenant_selection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    delete from public.tenant_active_selections as selection
    where selection.user_id = new.user_id
      and selection.tenant_id = new.tenant_id;
  end if;
  return new;
end;
$$;

create trigger tenant_memberships_clear_active_selection_after_revoke
after update of revoked_at on public.tenant_memberships
for each row execute function app.clear_revoked_active_tenant_selection();

-- The resolver deliberately falls back to the exact JWT value when no selection exists. It also
-- self-heals any legacy/inconsistent row that no longer has a live membership authority.
create function public.resolve_active_tenant_selection(p_actor_id uuid, p_claim_tenant_id uuid)
returns table(tenant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare selected_tenant_id uuid;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  select selection.tenant_id into selected_tenant_id
  from public.tenant_active_selections as selection
  where selection.user_id = p_actor_id
  for update;

  if selected_tenant_id is not null then
    if app.has_active_tenant_membership(p_actor_id, selected_tenant_id) then
      return query select selected_tenant_id;
      return;
    end if;
    delete from public.tenant_active_selections as selection
    where selection.user_id = p_actor_id;
  end if;

  return query select p_claim_tenant_id;
  return;
end;
$$;

-- The only workspace names this routine can return are the actor's account tenant and currently
-- active membership tenants; a caller cannot pass another tenant id to probe its existence.
create function public.list_active_tenants(p_actor_id uuid, p_claim_tenant_id uuid)
returns table(tenant_id uuid, tenant_name text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare selected_tenant_id uuid;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  select selection.tenant_id into selected_tenant_id
  from public.tenant_active_selections as selection
  where selection.user_id = p_actor_id
  for update;

  if selected_tenant_id is not null and not app.has_active_tenant_membership(p_actor_id, selected_tenant_id) then
    delete from public.tenant_active_selections as selection
    where selection.user_id = p_actor_id;
    selected_tenant_id := null;
  end if;

  return query
  with available_tenants as (
    select account.tenant_id
    from public.users as account
    where account.id = p_actor_id
      and account.tenant_id is not null
      and account.role = 'coach'
    union
    select membership.tenant_id
    from public.tenant_memberships as membership
    where membership.user_id = p_actor_id
      and membership.role = 'coach_member'
      and membership.revoked_at is null
  )
  select workspace.id, workspace.name,
    workspace.id = coalesce(selected_tenant_id, p_claim_tenant_id)
  from public.tenants as workspace
  join available_tenants as available on available.tenant_id = workspace.id
  order by workspace.name, workspace.id;
  return;
end;
$$;

create function public.select_active_tenant(p_actor_id uuid, p_claim_tenant_id uuid, p_tenant_id uuid)
returns table(tenant_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare written_audit_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  if not app.has_active_tenant_membership(p_actor_id, p_tenant_id) then
    raise exception 'ACTIVE_TENANT_MEMBERSHIP_REQUIRED';
  end if;

  insert into public.tenant_active_selections as selection (user_id, tenant_id)
  values (p_actor_id, p_tenant_id)
  on conflict (user_id) do update
  set tenant_id = excluded.tenant_id, updated_at = now();

  written_audit_id := app.write_audit_row(
    'tenant.membership.switched', p_actor_id, p_tenant_id, 'tenant_active_selection',
    p_actor_id::text, null,
    jsonb_build_object('claim_tenant_id', p_claim_tenant_id, 'selected_tenant_id', p_tenant_id)
  );
  return query select p_tenant_id, written_audit_id;
  return;
end;
$$;

revoke all on function app.has_active_tenant_membership(uuid,uuid) from public, anon, authenticated;
revoke all on function app.clear_revoked_active_tenant_selection() from public, anon, authenticated;
revoke execute on function public.resolve_active_tenant_selection(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.list_active_tenants(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.select_active_tenant(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.resolve_active_tenant_selection(uuid,uuid) to service_role;
grant execute on function public.list_active_tenants(uuid,uuid) to service_role;
grant execute on function public.select_active_tenant(uuid,uuid,uuid) to service_role;
