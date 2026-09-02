-- Ownership transfer is a two-person workflow. A coach may offer the one workspace-owner role to
-- an active teammate, but the role changes only when that teammate accepts the current offer.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('tenant.ownership.offered', 'human', 'tenant', false, true, 'Ownership offer logged', 'Workspace ownership offer recorded in the audit log'),
  ('tenant.ownership.accepted', 'human', 'tenant', false, true, 'Ownership transfer logged', 'Workspace ownership transfer recorded in the audit log'),
  ('tenant.ownership.revoked', 'human', 'tenant', false, true, 'Ownership offer revocation logged', 'Workspace ownership offer revocation recorded in the audit log'),
  ('tenant.ownership.expired', 'system', 'tenant', false, true, 'Ownership offer expiry logged', 'Workspace ownership offer expiry recorded in the audit log')
on conflict (key) do nothing;

create table public.tenant_ownership_transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  offered_by uuid not null references public.users(id) on delete restrict,
  recipient_user_id uuid not null references public.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.users(id) on delete restrict,
  expired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_ownership_transfers_distinct_people check (offered_by <> recipient_user_id),
  constraint tenant_ownership_transfers_expiry_future check (expires_at > created_at),
  constraint tenant_ownership_transfers_resolution_shape check (
    (status = 'pending' and accepted_at is null and revoked_at is null and revoked_by is null and expired_at is null)
    or (status = 'accepted' and accepted_at is not null and revoked_at is null and revoked_by is null and expired_at is null)
    or (status = 'revoked' and accepted_at is null and revoked_at is not null and revoked_by is not null and expired_at is null)
    or (status = 'expired' and accepted_at is null and revoked_at is null and revoked_by is null and expired_at is not null)
  )
);
create unique index tenant_ownership_transfers_one_pending_per_tenant_idx
  on public.tenant_ownership_transfers (tenant_id) where status = 'pending';
create index tenant_ownership_transfers_recipient_idx
  on public.tenant_ownership_transfers (tenant_id, recipient_user_id, created_at desc);
create trigger tenant_ownership_transfers_set_updated_at before update on public.tenant_ownership_transfers
  for each row execute function app.set_updated_at();

alter table public.tenant_ownership_transfers enable row level security;
alter table public.tenant_ownership_transfers force row level security;
revoke all on public.tenant_ownership_transfers from public, anon, authenticated, service_role;
grant select on public.tenant_ownership_transfers to service_role;

-- This private helper gives expired offers a durable terminal state and audit row the next time
-- any ownership command reads the tenant. Acceptance always invokes it before considering an offer.
create function app.expire_tenant_ownership_transfers(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare transfer_row public.tenant_ownership_transfers%rowtype;
begin
  for transfer_row in
    update public.tenant_ownership_transfers as ownership_transfer
    set status = 'expired', expired_at = now()
    where ownership_transfer.tenant_id = p_tenant_id
      and ownership_transfer.status = 'pending'
      and ownership_transfer.expires_at <= now()
    returning ownership_transfer.*
  loop
    perform app.write_audit_row(
      'tenant.ownership.expired', null, transfer_row.tenant_id, 'tenant_ownership_transfer',
      transfer_row.id::text, null, jsonb_build_object('expired_at', transfer_row.expired_at)
    );
  end loop;
end;
$$;

create function public.offer_tenant_ownership_transfer(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_recipient_membership_id uuid
)
returns table(transfer_id uuid, tenant_id uuid, recipient_user_id uuid, status text, expires_at timestamptz, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_membership public.tenant_memberships%rowtype;
  transfer_row public.tenant_ownership_transfers%rowtype;
  owner_count integer;
  logged_id bigint;
begin
  perform app.assert_tenant_membership_coach(p_expected_tenant, p_actor_id);
  select count(*) into owner_count
  from public.users as workspace_user
  where workspace_user.tenant_id = p_expected_tenant and workspace_user.role = 'coach';
  if owner_count <> 1 then raise exception 'TENANT_OWNERSHIP_OWNER_INVARIANT_FAILED'; end if;

  perform app.expire_tenant_ownership_transfers(p_expected_tenant);
  select * into recipient_membership
  from public.tenant_memberships as membership
  where membership.id = p_recipient_membership_id
    and membership.tenant_id = p_expected_tenant
    and membership.role = 'coach_member'
    and membership.revoked_at is null
  for update;
  if recipient_membership.id is null then raise exception 'TENANT_OWNERSHIP_RECIPIENT_NOT_ACTIVE'; end if;

  insert into public.tenant_ownership_transfers (tenant_id, offered_by, recipient_user_id, expires_at)
  values (p_expected_tenant, p_actor_id, recipient_membership.user_id, now() + interval '7 days')
  returning * into transfer_row;
  logged_id := app.write_audit_row(
    'tenant.ownership.offered', p_actor_id, p_expected_tenant, 'tenant_ownership_transfer',
    transfer_row.id::text, null,
    jsonb_build_object('recipient_user_id', transfer_row.recipient_user_id, 'expires_at', transfer_row.expires_at)
  );
  return query select transfer_row.id, transfer_row.tenant_id, transfer_row.recipient_user_id,
    transfer_row.status, transfer_row.expires_at, logged_id;
end;
$$;

create function public.accept_tenant_ownership_transfer(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_transfer_id uuid
)
returns table(transfer_id uuid, tenant_id uuid, recipient_user_id uuid, status text, expires_at timestamptz, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  transfer_row public.tenant_ownership_transfers%rowtype;
  recipient_membership public.tenant_memberships%rowtype;
  previous_owner public.users%rowtype;
  owner_count integer;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  perform app.expire_tenant_ownership_transfers(p_expected_tenant);

  select * into transfer_row
  from public.tenant_ownership_transfers as ownership_transfer
  where ownership_transfer.id = p_transfer_id
    and ownership_transfer.tenant_id = p_expected_tenant
  for update;
  if transfer_row.id is null or transfer_row.status <> 'pending' then raise exception 'TENANT_OWNERSHIP_TRANSFER_UNAVAILABLE'; end if;
  if transfer_row.recipient_user_id <> p_actor_id then raise exception 'TENANT_OWNERSHIP_RECIPIENT_REQUIRED'; end if;

  select * into recipient_membership
  from public.tenant_memberships as membership
  where membership.tenant_id = p_expected_tenant
    and membership.user_id = p_actor_id
    and membership.role = 'coach_member'
    and membership.revoked_at is null
  for update;
  if recipient_membership.id is null then raise exception 'TENANT_OWNERSHIP_RECIPIENT_NOT_ACTIVE'; end if;

  -- Re-check at acceptance time: the offeror must still be this tenant's sole current coach.
  select * into previous_owner from public.users as workspace_user
  where workspace_user.id = transfer_row.offered_by
    and workspace_user.tenant_id = p_expected_tenant
    and workspace_user.role = 'coach'
  for update;
  select count(*) into owner_count
  from public.users as workspace_user
  where workspace_user.tenant_id = p_expected_tenant and workspace_user.role = 'coach';
  if previous_owner.id is null or owner_count <> 1 then raise exception 'TENANT_OWNERSHIP_OFFEROR_NO_LONGER_OWNER'; end if;

  update public.tenant_memberships as membership
  set revoked_at = now(), revoked_by = previous_owner.id
  where membership.id = recipient_membership.id;
  insert into public.tenant_memberships (tenant_id, user_id, role, invited_by)
  values (p_expected_tenant, previous_owner.id, 'coach_member', p_actor_id)
  on conflict (tenant_id, user_id) do update set role = excluded.role, invited_by = excluded.invited_by,
    accepted_at = now(), revoked_at = null, revoked_by = null, updated_at = now();
  update public.users as workspace_user
  set role = case
    when workspace_user.id = p_actor_id then 'coach'::public.user_role
    when workspace_user.id = previous_owner.id then 'coach_member'::public.user_role
    else workspace_user.role
  end,
  updated_at = now()
  where workspace_user.id in (p_actor_id, previous_owner.id);

  select count(*) into owner_count
  from public.users as workspace_user
  where workspace_user.tenant_id = p_expected_tenant and workspace_user.role = 'coach';
  if owner_count <> 1 then raise exception 'TENANT_OWNERSHIP_OWNER_INVARIANT_FAILED'; end if;
  update public.tenant_ownership_transfers as ownership_transfer
  set status = 'accepted', accepted_at = now()
  where ownership_transfer.id = transfer_row.id;
  transfer_row.status := 'accepted';
  logged_id := app.write_audit_row(
    'tenant.ownership.accepted', p_actor_id, p_expected_tenant, 'tenant_ownership_transfer',
    transfer_row.id::text, null,
    jsonb_build_object('previous_owner_id', previous_owner.id, 'recipient_user_id', p_actor_id)
  );
  return query select transfer_row.id, transfer_row.tenant_id, transfer_row.recipient_user_id,
    transfer_row.status, transfer_row.expires_at, logged_id;
end;
$$;

create function public.revoke_tenant_ownership_transfer(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_transfer_id uuid
)
returns table(transfer_id uuid, tenant_id uuid, recipient_user_id uuid, status text, expires_at timestamptz, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare transfer_row public.tenant_ownership_transfers%rowtype; logged_id bigint;
begin
  perform app.assert_tenant_membership_coach(p_expected_tenant, p_actor_id);
  perform app.expire_tenant_ownership_transfers(p_expected_tenant);
  select * into transfer_row
  from public.tenant_ownership_transfers as ownership_transfer
  where ownership_transfer.id = p_transfer_id
    and ownership_transfer.tenant_id = p_expected_tenant
    and ownership_transfer.offered_by = p_actor_id
  for update;
  if transfer_row.id is null or transfer_row.status <> 'pending' then raise exception 'TENANT_OWNERSHIP_TRANSFER_UNAVAILABLE'; end if;
  update public.tenant_ownership_transfers as ownership_transfer
  set status = 'revoked', revoked_at = now(), revoked_by = p_actor_id
  where ownership_transfer.id = transfer_row.id;
  transfer_row.status := 'revoked';
  logged_id := app.write_audit_row(
    'tenant.ownership.revoked', p_actor_id, p_expected_tenant, 'tenant_ownership_transfer',
    transfer_row.id::text, null, jsonb_build_object('recipient_user_id', transfer_row.recipient_user_id)
  );
  return query select transfer_row.id, transfer_row.tenant_id, transfer_row.recipient_user_id,
    transfer_row.status, transfer_row.expires_at, logged_id;
end;
$$;

create function public.list_tenant_ownership_transfers(
  p_expected_tenant uuid,
  p_actor_id uuid
)
returns table(transfer_id uuid, tenant_id uuid, recipient_user_id uuid, status text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare actor_membership public.tenant_memberships%rowtype; actor_user public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  select * into actor_user from public.users as workspace_user
  where workspace_user.id = p_actor_id and workspace_user.tenant_id = p_expected_tenant;
  select * into actor_membership from public.tenant_memberships as membership
  where membership.tenant_id = p_expected_tenant and membership.user_id = p_actor_id
    and membership.role = 'coach_member' and membership.revoked_at is null;
  if actor_user.id is null or (actor_user.role <> 'coach' and actor_membership.id is null) then
    raise exception 'TENANT_OWNERSHIP_MEMBERSHIP_REQUIRED';
  end if;
  perform app.expire_tenant_ownership_transfers(p_expected_tenant);
  return query
  select ownership_transfer.id, ownership_transfer.tenant_id, ownership_transfer.recipient_user_id,
    ownership_transfer.status, ownership_transfer.expires_at
  from public.tenant_ownership_transfers as ownership_transfer
  where ownership_transfer.tenant_id = p_expected_tenant
    and (ownership_transfer.offered_by = p_actor_id or ownership_transfer.recipient_user_id = p_actor_id)
  order by ownership_transfer.created_at desc;
end;
$$;

revoke all on function app.expire_tenant_ownership_transfers(uuid) from public, anon, authenticated;
revoke execute on function public.offer_tenant_ownership_transfer(uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.accept_tenant_ownership_transfer(uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.revoke_tenant_ownership_transfer(uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.list_tenant_ownership_transfers(uuid,uuid) from public, anon, authenticated;
grant execute on function public.offer_tenant_ownership_transfer(uuid,uuid,uuid) to service_role;
grant execute on function public.accept_tenant_ownership_transfer(uuid,uuid,uuid) to service_role;
grant execute on function public.revoke_tenant_ownership_transfer(uuid,uuid,uuid) to service_role;
grant execute on function public.list_tenant_ownership_transfers(uuid,uuid) to service_role;
